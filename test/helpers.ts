import { SELF, env } from "cloudflare:test";
import { vi } from "vitest";

export const BASE = "http://localhost:8787";

/** Регистрирует/логинит пользователя через настоящие эндпоинты, возвращает cookie сессии. */
export async function signIn(email: string): Promise<{ cookie: string; userId: string }> {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await SELF.fetch(`${BASE}/auth/start`, { method: "POST", body: new URLSearchParams({ email }) });
  const printed = log.mock.calls.map((c) => String(c[0])).join("\n");
  log.mockRestore();
  const token = /token=([\w%-]+)/.exec(printed)?.[1];
  if (!token) throw new Error("no login link printed");
  const res = await SELF.fetch(`${BASE}/auth/verify?token=${token}`, { redirect: "manual" });
  const cookie = res.headers.get("set-cookie")!.split(";")[0];
  const user = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>();
  return { cookie, userId: user!.id };
}
