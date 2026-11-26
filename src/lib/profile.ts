import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { now, type Env } from "../env";
import type { CvFile } from "./cv";

/**
 * Анкета-портрет. По ней дальше подбираем и оцениваем вакансии и пишем письма,
 * поэтому поля — то, что спрашивают работодатели и формы откликов.
 * Схема же уходит в модель как формат ответа (structured outputs).
 */
export const WORK_FORMATS = ["remote", "hybrid", "onsite"] as const;
export const SENIORITY = ["junior", "middle", "senior", "lead"] as const;
export const EMPLOYMENT = ["full_time", "part_time", "contract"] as const;

const nullableString = () => z.string().nullable();

export const ProfileSchema = z.object({
  full_name: nullableString().describe("Имя и фамилия как в CV"),
  headline: nullableString().describe("Кто человек в одной строке, например «Backend-разработчик (Python)»"),
  summary: nullableString().describe("2–3 предложения о сильных сторонах, на языке CV"),
  target_roles: z.array(z.string()).describe("Роли, на которые стоит откликаться, по опыту из CV (2–5 штук)"),
  seniority: z.enum(SENIORITY).nullable(),
  years_experience: z.number().nullable().describe("Лет коммерческого опыта в основной профессии"),
  skills: z.array(z.string()).describe("Стек и инструменты, самые важные первыми"),
  location: nullableString().describe("Город и страна проживания, если указаны"),
  work_formats: z.array(z.enum(WORK_FORMATS)).describe("Только если в CV прямо сказано; иначе пусто"),
  employment_types: z.array(z.enum(EMPLOYMENT)).describe("Только если в CV прямо сказано; иначе пусто"),
  relocation: z.boolean().nullable().describe("Готовность к переезду, только если сказано в CV"),
  salary_min: z.number().nullable().describe("Только если в CV есть ожидания по деньгам; иначе null"),
  salary_currency: nullableString().describe("EUR, USD, RUB… — только вместе с salary_min"),
  languages: z.array(z.object({ language: z.string(), level: z.string() })),
  experience: z.array(
    z.object({
      company: z.string(),
      title: z.string(),
      period: z.string().describe("Например «2022 – 2026»"),
      highlights: z.array(z.string()).describe("Достижения с цифрами из CV, 1–4 штуки"),
    }),
  ),
  facts: z
    .array(z.object({ question: z.string(), answer: z.string() }))
    .describe(
      "Готовые ответы на типичные вопросы форм откликов: годы опыта с ключевыми технологиями, размер команды, " +
        "образование, главные результаты. Только факты из CV, без выдумок.",
    ),
  contacts: z.object({
    email: nullableString(),
    phone: nullableString(),
    telegram: nullableString(),
    linkedin: nullableString(),
    github: nullableString(),
    website: nullableString(),
  }),
  avoid: z.array(z.string()).describe("Чего человек не хочет (роли, стек, домены). Из CV обычно пусто."),
});

export type Profile = z.infer<typeof ProfileSchema>;

export function emptyProfile(): Profile {
  return {
    full_name: null,
    headline: null,
    summary: null,
    target_roles: [],
    seniority: null,
    years_experience: null,
    skills: [],
    location: null,
    work_formats: [],
    employment_types: [],
    relocation: null,
    salary_min: null,
    salary_currency: null,
    languages: [],
    experience: [],
    facts: [],
    contacts: { email: null, phone: null, telegram: null, linkedin: null, github: null, website: null },
    avoid: [],
  };
}

export interface ProfileRow {
  user_id: string;
  data: string;
  source: "ai" | "user";
  resume_id: string | null;
  parse_error: string | null;
  updated_at: number;
}

export interface StoredProfile {
  profile: Profile;
  source: "ai" | "user";
  resumeId: string | null;
  parseError: string | null;
  updatedAt: number;
}

export async function getProfile(db: D1Database, userId: string): Promise<StoredProfile | null> {
  const row = await db.prepare("SELECT * FROM profiles WHERE user_id = ?").bind(userId).first<ProfileRow>();
  if (!row) return null;
  // Старые записи могут не знать о новых полях — дополняем пустыми значениями.
  const parsed = ProfileSchema.safeParse({ ...emptyProfile(), ...JSON.parse(row.data) });
  return {
    profile: parsed.success ? parsed.data : emptyProfile(),
    source: row.source,
    resumeId: row.resume_id,
    parseError: row.parse_error,
    updatedAt: row.updated_at,
  };
}

export async function saveProfile(
  db: D1Database,
  userId: string,
  profile: Profile,
  source: "ai" | "user",
  resumeId: string | null,
  parseError: string | null = null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO profiles (user_id, data, source, resume_id, parse_error, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, source = excluded.source,
         resume_id = COALESCE(excluded.resume_id, profiles.resume_id), parse_error = excluded.parse_error,
         updated_at = excluded.updated_at`,
    )
    .bind(userId, JSON.stringify(profile), source, resumeId, parseError, now())
    .run();
}

// ---------------------------------------------------------------------------
// Автозаполнение по CV

export const PROFILE_MODEL = "claude-opus-5-5";

const SYSTEM = `Ты помогаешь соискателю заполнить анкету для автоматических откликов на вакансии.
Тебе дают его резюме. Заполни анкету строго по фактам из резюме.
Правила:
- Ничего не выдумывай и не завышай: нет данных — null или пустой список.
- Формат работы, тип занятости, переезд и зарплату заполняй, только если они прямо указаны в резюме.
- target_roles: 2–5 ролей, куда человек реально подходит по опыту, на английском, как в названиях вакансий.
- skills: технологии и инструменты из резюме, важные первыми, без дублей.
- facts: 4–10 коротких вопросов и ответов в стиле форм откликов («Years of commercial Python experience» → «6+»),
  на языке резюме. Числа бери из резюме.
- summary и highlights пиши на языке резюме, коротко и по делу.`;

/** Ошибка, которую можно показать человеку как есть. */
export class ProfileExtractError extends Error {}

export async function extractProfile(env: Env, cv: CvFile): Promise<Profile> {
  if (!env.ANTHROPIC_API_KEY) throw new ProfileExtractError("Автозаполнение пока не настроено. Заполните анкету вручную.");
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 90_000 });

  const cvBlock: Anthropic.Beta.BetaContentBlockParam =
    cv.kind === "pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: toBase64(cv.bytes) } }
      : { type: "text", text: `<resume>\n${cv.text}\n</resume>` };

  const response = await client.beta.messages.parse({
    model: PROFILE_MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: betaZodOutputFormat(ProfileSchema) },
    system: SYSTEM,
    messages: [{ role: "user", content: [cvBlock, { type: "text", text: "Заполни анкету по этому резюме." }] }],
  });

  if (response.stop_reason === "refusal") throw new ProfileExtractError("Не удалось разобрать резюме. Заполните анкету вручную.");
  if (response.stop_reason === "max_tokens" || !response.parsed_output) {
    throw new ProfileExtractError("Резюме разобралось не полностью. Проверьте анкету и допишите недостающее.");
  }
  return response.parsed_output;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// ---------------------------------------------------------------------------
// Форма редактирования: списки — по строке на элемент, опыт — блоками через пустую строку.

const lines = (v: unknown) =>
  String(v ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
const str = (v: unknown) => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, 2000) : null;
};
const num = (v: unknown) => {
  const s = String(v ?? "").replace(",", ".").replace(/\s/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const pick = <T extends string>(allowed: readonly T[], v: unknown): T[] => {
  const arr = Array.isArray(v) ? v : v == null ? [] : [v];
  return allowed.filter((a) => arr.includes(a));
};

export function profileToForm(p: Profile) {
  return {
    skills: p.skills.join("\n"),
    target_roles: p.target_roles.join("\n"),
    avoid: p.avoid.join("\n"),
    languages: p.languages.map((l) => `${l.language} — ${l.level}`).join("\n"),
    facts: p.facts.map((f) => `${f.question}: ${f.answer}`).join("\n"),
    experience: p.experience
      .map((e) => [`${e.title} | ${e.company} | ${e.period}`, ...e.highlights.map((h) => `- ${h}`)].join("\n"))
      .join("\n\n"),
  };
}

export function profileFromForm(form: Record<string, unknown>): Profile {
  const seniority = String(form.seniority ?? "");
  const relocation = String(form.relocation ?? "");
  const salaryMin = num(form.salary_min);
  return {
    full_name: str(form.full_name),
    headline: str(form.headline),
    summary: str(form.summary),
    target_roles: lines(form.target_roles),
    seniority: (SENIORITY as readonly string[]).includes(seniority) ? (seniority as Profile["seniority"]) : null,
    years_experience: num(form.years_experience),
    skills: lines(form.skills),
    location: str(form.location),
    work_formats: pick(WORK_FORMATS, form.work_formats),
    employment_types: pick(EMPLOYMENT, form.employment_types),
    relocation: relocation === "yes" ? true : relocation === "no" ? false : null,
    salary_min: salaryMin,
    salary_currency: salaryMin === null ? null : (str(form.salary_currency)?.toUpperCase() ?? "EUR"),
    languages: lines(form.languages).map((l) => {
      const [language, ...rest] = l.split(/\s+[—–-]\s+|:\s*/);
      return { language: language.trim(), level: rest.join(" ").trim() };
    }),
    experience: String(form.experience ?? "")
      .split(/\r?\n\s*\r?\n/)
      .map((block) => lines(block))
      .filter((b) => b.length)
      .map(([head, ...rest]) => {
        const [title = "", company = "", period = ""] = head.split("|").map((s) => s.trim());
        return { title, company, period, highlights: rest.map((h) => h.replace(/^[-•*]\s*/, "")).filter(Boolean) };
      }),
    facts: lines(form.facts).map((l) => {
      const i = l.indexOf(":");
      return i > 0 ? { question: l.slice(0, i).trim(), answer: l.slice(i + 1).trim() } : { question: l, answer: "" };
    }),
    contacts: {
      email: str(form.contact_email),
      phone: str(form.contact_phone),
      telegram: str(form.contact_telegram),
      linkedin: str(form.contact_linkedin),
      github: str(form.contact_github),
      website: str(form.contact_website),
    },
    avoid: lines(form.avoid),
  };
}

/** Свежие данные из CV поверх старой анкеты: пустые поля нового разбора не затирают заполненные раньше. */
export function mergeProfiles(fresh: Profile, previous: Profile | null): Profile {
  if (!previous) return fresh;
  const isEmpty = (v: unknown) => v === null || (Array.isArray(v) && v.length === 0);
  const out = { ...fresh } as Record<string, unknown>;
  for (const [k, v] of Object.entries(previous)) {
    if (k === "contacts") continue;
    if (isEmpty(out[k]) && !isEmpty(v)) out[k] = v;
  }
  const contacts = { ...fresh.contacts };
  for (const [k, v] of Object.entries(previous.contacts) as [keyof Profile["contacts"], string | null][]) {
    if (!contacts[k] && v) contacts[k] = v;
  }
  return { ...(out as Profile), contacts };
}
