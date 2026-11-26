import { z } from "zod";
import { now, type Env } from "../env";
import type { CvFile } from "./cv";
import { callJson, extractJsonObject } from "./llm";

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

const SYSTEM = `Ты переносишь данные из резюме соискателя в анкету для откликов на вакансии.
Резюме дано текстом внутри <resume>. Верни только JSON по заданной схеме.
Главное правило: каждое значение должно дословно или по смыслу следовать из текста резюме.
Ничего не придумывай: не сочиняй имя, город, телефон, ссылки, компании, даты, уровни языков и цифры.
Если чего-то в тексте нет, ставь null или пустой список. Пустая анкета лучше выдуманной.
- Имя, телефон, email, ссылки копируй символ в символ из текста.
- Формат работы, тип занятости, переезд и зарплату заполняй, только если они прямо указаны.
- target_roles: 2–5 ролей, куда человек подходит по опыту из резюме, на английском, как в названиях вакансий.
- skills: технологии и инструменты из резюме, важные первыми, без дублей.
- years_experience: только если число лет есть в резюме или однозначно следует из дат.
- experience: только места работы из резюме, с их названиями и периодами.
- facts: 4–10 коротких вопросов и ответов в стиле форм откликов, только с цифрами и фактами из резюме.
- summary и highlights пиши на языке резюме, коротко и по делу.`;

/** Ошибка, которую можно показать человеку как есть. */
export class ProfileExtractError extends Error {}

const PROFILE_JSON_SCHEMA = z.toJSONSchema(ProfileSchema, { target: "draft-7" });

/**
 * Заполняет анкету через OpenRouter по тексту CV (текст достаём в воркере, см. cv.ts).
 * Ответ всегда проверяем схемой, даже если провайдер поддерживает structured outputs.
 */
export async function extractProfile(env: Env, cv: CvFile): Promise<Profile> {
  if (!env.OPENROUTER_API_KEY) throw new ProfileExtractError("Автозаполнение пока не настроено. Заполните анкету вручную.");
  const { content, finishReason } = await callJson(env, {
    system: SYSTEM,
    user: `<resume>\n${cv.text}\n</resume>\n\nЗаполни анкету строго по этому резюме.`,
    name: "profile",
    schema: PROFILE_JSON_SCHEMA,
    maxTokens: 8000,
  });
  const parsed = parseProfileJson(content);
  if (!parsed) {
    if (finishReason === "length") {
      throw new ProfileExtractError("Резюме разобралось не полностью. Проверьте анкету и допишите недостающее.");
    }
    throw new ProfileExtractError("Не удалось разобрать резюме. Попробуйте ещё раз или заполните анкету вручную.");
  }
  return groundProfile(parsed, cv.text);
}

/**
 * Страховка от выдумок: то, что можно проверить по тексту CV (имя, контакты, компании),
 * оставляем, только если оно в тексте есть.
 */
export function groundProfile(p: Profile, cvText: string): Profile {
  const text = cvText.toLowerCase().replace(/\s+/g, " ");
  const compact = text.replace(/[\s-]/g, "");
  const digits = cvText.replace(/\D/g, "");
  const has = (v: string) => {
    const t = v.toLowerCase().trim();
    return !!t && (text.includes(t.replace(/\s+/g, " ")) || compact.includes(t.replace(/[\s-]/g, "")));
  };
  const keep = (v: string | null, test: (v: string) => boolean) => (v && test(v) ? v : null);
  const handle = (v: string) => has(v.replace(/^@/, "").replace(/^https?:\/\/(www\.)?/, "").replace(/\/+$/, ""));
  const phone = (v: string) => {
    const d = v.replace(/\D/g, "");
    return d.length >= 7 && digits.includes(d);
  };
  const name = (v: string) => v.split(/\s+/).filter(Boolean).every((w) => has(w));
  return {
    ...p,
    full_name: keep(p.full_name, name),
    location: keep(p.location, (v) => has(v.split(/,\s*/)[0])), // город должен быть в тексте
    experience: p.experience.filter((e) => has(e.company)),
    contacts: {
      email: keep(p.contacts.email, has),
      phone: keep(p.contacts.phone, phone),
      telegram: keep(p.contacts.telegram, handle),
      linkedin: keep(p.contacts.linkedin, handle),
      github: keep(p.contacts.github, handle),
      website: keep(p.contacts.website, handle),
    },
  };
}

/** Достаёт JSON из ответа модели (бывает в ```json ...```), дополняет пропущенные поля и проверяет схемой. */
export function parseProfileJson(content: string): Profile | null {
  const obj = extractJsonObject(content);
  if (!obj) return null;
  const result = ProfileSchema.safeParse({
    ...emptyProfile(),
    ...obj,
    contacts: { ...emptyProfile().contacts, ...((obj.contacts as object | null) ?? {}) },
  });
  return result.success ? result.data : null;
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

/** Поля, которых в CV обычно нет и которые человек указывает сам. */
const USER_FIELDS = ["work_formats", "employment_types", "relocation", "salary_min", "salary_currency", "avoid"] as const;

/**
 * Новая анкета по CV поверх старой. Всё, что берётся из резюме (имя, контакты, опыт, языки…), заменяется целиком,
 * чтобы повторное заполнение исправляло ошибки прошлого разбора. Сохраняются только настройки человека (USER_FIELDS),
 * если в новом CV их нет.
 */
export function mergeProfiles(fresh: Profile, previous: Profile | null): Profile {
  if (!previous) return fresh;
  const out = { ...fresh } as Record<string, unknown>;
  const isEmpty = (v: unknown) => v === null || (Array.isArray(v) && v.length === 0);
  for (const k of USER_FIELDS) if (isEmpty(out[k]) && !isEmpty(previous[k])) out[k] = previous[k];
  return out as Profile;
}
