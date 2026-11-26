import type { Env } from "../env";

/** Модель по умолчанию; меняется переменной OPENROUTER_MODEL в wrangler.toml без правки кода. */
export const DEFAULT_MODEL = "z-ai/glm-5.3";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface JsonCallResult {
  content: string;
  finishReason: string | undefined;
  model: string;
}

/**
 * Один запрос к OpenRouter (OpenAI-совместимый API) с ответом JSON по схеме (structured outputs).
 * Ответ здесь не проверяется: это делает вызывающий код своей zod-схемой.
 */
export async function callJson(
  env: Env,
  opts: { system: string; user: string; name: string; schema: unknown; maxTokens: number; temperature?: number; timeoutMs?: number },
): Promise<JsonCallResult> {
  const model = env.OPENROUTER_MODEL || DEFAULT_MODEL;
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": env.APP_URL,
      "X-Title": "Otklikator",
    },
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature ?? 0,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
      response_format: { type: "json_schema", json_schema: { name: opts.name, strict: true, schema: opts.schema } },
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const data = (await res.json()) as {
    choices?: { message?: { content?: string | null }; finish_reason?: string }[];
    error?: { message?: string };
  };
  if (data.error) throw new Error(`OpenRouter error: ${data.error.message ?? "unknown"}`);
  const choice = data.choices?.[0];
  return { content: choice?.message?.content ?? "", finishReason: choice?.finish_reason, model };
}

/** Достаёт JSON-объект из ответа модели (бывает обёрнут в ```json ...```). null, если не JSON-объект. */
export function extractJsonObject(content: string): Record<string, unknown> | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const raw = JSON.parse(content.slice(start, end + 1));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
