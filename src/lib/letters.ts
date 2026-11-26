import { z } from "zod";
import { now, type Env } from "../env";
import { fingerprint } from "./jobs/text";
import { callJson, extractJsonObject } from "./llm";
import type { Profile } from "./profile";

/**
 * Письмо-отклик под вакансию. Правила из PoC (mrfilldev/resume): 3–4 предложения,
 * «что знаю про компанию → кейс с цифрой → конкретный ask», без выдумок и без оправданий за нехватку опыта.
 * Модель пишет только смысловую часть; приветствие и подпись собираем сами из анкеты, чтобы там нечего было выдумать.
 */

/** Не больше стольких черновиков на человека в сутки: страховка от расходов на модель. */
export const DAILY_LETTER_LIMIT = 30;
/** В одну компанию — не чаще раза в столько дней. */
export const COMPANY_COOLDOWN_DAYS = 14;

export class LetterError extends Error {}

// ---------------------------------------------------------------------------
// Вакансия глазами человека

export interface MatchDetail {
  seq: number;
  title: string;
  company: string;
  location: string;
  url: string;
  description: string;
  flags: string;
  score: number;
  reasons: string[];
  status: string; // статус совпадения: new | hidden | applied
}

export async function getMatchDetail(db: D1Database, userId: string, seq: number): Promise<MatchDetail | null> {
  const row = await db
    .prepare(
      `SELECT v.seq, v.title, v.company, v.location, v.url, v.description, v.flags, m.score, m.reasons, m.status
       FROM matches m JOIN vacancies v ON v.seq = m.vacancy_seq WHERE m.user_id = ? AND m.vacancy_seq = ?`,
    )
    .bind(userId, seq)
    .first<Omit<MatchDetail, "reasons"> & { reasons: string }>();
  return row ? { ...row, reasons: JSON.parse(row.reasons) as string[] } : null;
}

/** Ключ компании для правила двух недель: то же, что левая часть fingerprint дедупа. */
export function companyKey(company: string): string {
  return fingerprint(company, "").split("|")[0];
}

const EMAIL_RX = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
const BAD_EMAIL =
  /^(no-?reply|do-?not-?reply|donotreply|privacy|gdpr|dpo|legal|abuse|security|support|help|info@.*sentry|unsubscribe|billing|press|media|accessibility)@|@(example\.(com|org|net)|sentry\.io|.*wixpress\.com)$|\.(png|jpe?g|gif|svg|webp)$/i;
const GOOD_LOCAL = /^(jobs?|careers?|hr|hiring|recruit\w*|talent|apply|cv|resumes?|people|work|team|vacanc\w*)@/i;
const APPLY_NEAR = /apply|send|cv|resume|résumé|reach out|email us|contact|write to|отклик|резюме|пишите|присылайте|направляйте/i;

/**
 * Адрес для отклика из текста вакансии. В PoC адрес нашёлся лишь у ~5 % вакансий, остальным нужна форма на сайте.
 * Предпочитаем jobs@/careers@/hr@… или адрес рядом со словами «apply / send CV / присылайте резюме».
 */
export function findApplyEmail(text: string): string | null {
  const found: { email: string; score: number }[] = [];
  for (const m of text.matchAll(EMAIL_RX)) {
    const email = m[0].replace(/\.+$/, "").toLowerCase();
    if (BAD_EMAIL.test(email) || found.some((f) => f.email === email)) continue;
    const before = text.slice(Math.max(0, (m.index ?? 0) - 100), m.index ?? 0);
    found.push({ email, score: (GOOD_LOCAL.test(email) ? 2 : 0) + (APPLY_NEAR.test(before) ? 1 : 0) });
  }
  found.sort((a, b) => b.score - a.score);
  return found[0]?.email ?? null;
}

/** Язык письма — язык вакансии: русский, если в тексте заметная доля кириллицы. */
export function letterLanguage(v: { title: string; description: string }): "ru" | "en" {
  const text = `${v.title} ${v.description}`.slice(0, 2000);
  const cyr = (text.match(/[а-яё]/gi) ?? []).length;
  const lat = (text.match(/[a-z]/gi) ?? []).length;
  return cyr > 0 && cyr >= lat * 0.5 ? "ru" : "en";
}

// ---------------------------------------------------------------------------
// Черновик моделью

const LetterSchema = z.object({
  subject: z.string().describe("Тема письма, до 80 символов"),
  body: z.string().describe("3–4 предложения, без приветствия и без подписи"),
});
const LETTER_JSON_SCHEMA = z.toJSONSchema(LetterSchema, { target: "draft-7" });

const SYSTEM = `Ты пишешь короткое письмо-отклик на вакансию от имени соискателя.
Даны анкета соискателя (<profile>, JSON) и вакансия (<vacancy>). Верни JSON: subject и body.
body — ровно 3–4 предложения, обычный текст без markdown, без приветствия и без подписи (их добавят отдельно):
1) Одна конкретная деталь о компании или задаче из текста вакансии и почему она откликается соискателю.
2) Один кейс из опыта соискателя, ближе всего к задачам вакансии, с цифрой из анкеты.
3) Конкретный следующий шаг: например, предложить короткий созвон на этой или следующей неделе.
Правила:
- Только факты из анкеты и вакансии. Не придумывай цифры, компании, проекты, технологии, имена и детали о компании.
  Цифры бери только те, что есть в данных, символ в символ.
- Не упоминай, чего у соискателя нет или чего не хватает (лет опыта, стека, домена). Не оправдывайся.
- Без штампов вроде «I am writing to express my interest», «I believe I would be a great fit».
- Без заглушек вроде [Name] или [Company].
- subject: должность из вакансии и кто соискатель, например «Senior Backend Engineer — Anna, Python backend, 6 years».`;

export interface LetterDraft {
  subject: string;
  body: string; // целиком: приветствие + текст модели + подпись
  unverified: string[];
  model: string;
}

function profileForLetter(p: Profile) {
  return {
    full_name: p.full_name,
    headline: p.headline,
    summary: p.summary,
    seniority: p.seniority,
    years_experience: p.years_experience,
    skills: p.skills.slice(0, 20),
    languages: p.languages,
    experience: p.experience.slice(0, 5),
    facts: p.facts,
  };
}

/** Цифры из письма, которых нет ни в анкете, ни в вакансии: вероятно выдуманы, человек должен их проверить. */
export function unverifiedNumbers(letter: string, sources: string): string[] {
  const src = sources.replace(/\s+/g, " ");
  const nums = new Set(letter.match(/\d+(?:[.,]\d+)?/g) ?? []);
  return [...nums].filter((n) => !src.includes(n));
}

export function greeting(company: string, lang: "ru" | "en"): string {
  return lang === "ru" ? "Здравствуйте!" : `Hi ${company} team,`;
}

/** Подпись из анкеты: имя и до двух контактов (не email — он и так в «От кого»). */
export function signature(p: Profile): string {
  const c = p.contacts;
  const links = [c.linkedin, c.github, c.telegram, c.website, c.phone].filter((v): v is string => !!v).slice(0, 2);
  return [p.full_name, ...links].filter(Boolean).join("\n");
}

export async function draftLetter(env: Env, profile: Profile, v: MatchDetail): Promise<LetterDraft> {
  if (!env.OPENROUTER_API_KEY) throw new LetterError("Генерация писем пока не настроена.");
  const lang = letterLanguage(v);
  const prof = profileForLetter(profile);
  const vacancy = { title: v.title, company: v.company, location: v.location, description: v.description.slice(0, 3000) };
  const sources = `${JSON.stringify(prof)} ${JSON.stringify(vacancy)}`;
  const base = `<profile>\n${JSON.stringify(prof)}\n</profile>\n<vacancy>\n${JSON.stringify(vacancy)}\n</vacancy>\n\nЯзык письма: ${lang === "ru" ? "русский" : "английский"}.`;

  let last: { subject: string; text: string; unverified: string[]; model: string } | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const hint = last?.unverified.length
      ? `\n\nВ прошлом варианте были цифры, которых нет в данных: ${last.unverified.join(", ")}. Не используй их.`
      : "";
    const res = await callJson(env, { system: SYSTEM, user: base + hint, name: "letter", schema: LETTER_JSON_SCHEMA, maxTokens: 1500, temperature: 0.4, timeoutMs: 60_000 });
    const parsed = LetterSchema.safeParse(extractJsonObject(res.content));
    if (!parsed.success || !parsed.data.body.trim()) continue;
    const subject = parsed.data.subject.trim().slice(0, 150);
    const text = parsed.data.body.trim();
    last = { subject, text, unverified: unverifiedNumbers(`${subject} ${text}`, sources), model: res.model };
    if (!last.unverified.length) break;
  }
  if (!last) throw new LetterError("Не удалось написать письмо. Попробуйте ещё раз.");
  const sig = signature(profile);
  return {
    subject: last.subject,
    body: [greeting(v.company, lang), last.text, sig].filter(Boolean).join("\n\n"),
    unverified: last.unverified,
    model: last.model,
  };
}

// ---------------------------------------------------------------------------
// Хранилище откликов

export interface ApplicationRow {
  user_id: string;
  vacancy_seq: number;
  company_key: string;
  to_email: string | null;
  subject: string;
  body: string;
  status: "draft" | "sent" | "skipped";
  channel: string | null;
  model: string | null;
  unverified: string;
  created_at: number;
  updated_at: number;
  sent_at: number | null;
}

export function getApplication(db: D1Database, userId: string, seq: number) {
  return db.prepare("SELECT * FROM applications WHERE user_id = ? AND vacancy_seq = ?").bind(userId, seq).first<ApplicationRow>();
}

/** Сохраняет новый черновик. Отправленный отклик не трогаем. */
export async function saveDraft(db: D1Database, userId: string, v: MatchDetail, d: LetterDraft, ts = now()): Promise<void> {
  await db
    .prepare(
      `INSERT INTO applications (user_id, vacancy_seq, company_key, to_email, subject, body, status, model, unverified, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'draft', ?7, ?8, ?9, ?9)
       ON CONFLICT(user_id, vacancy_seq) DO UPDATE SET subject = excluded.subject, body = excluded.body, status = 'draft',
         model = excluded.model, unverified = excluded.unverified, created_at = excluded.created_at, updated_at = excluded.updated_at,
         to_email = COALESCE(applications.to_email, excluded.to_email)
       WHERE applications.status != 'sent'`,
    )
    .bind(userId, v.seq, companyKey(v.company), findApplyEmail(v.description), d.subject, d.body, d.model, JSON.stringify(d.unverified), ts)
    .run();
}

/** Правки человека: адрес, тема, текст. Только у черновика. */
export async function updateDraft(db: D1Database, userId: string, seq: number, f: { to_email: string | null; subject: string; body: string }) {
  await db
    .prepare(
      `UPDATE applications SET to_email = ?, subject = ?, body = ?, unverified = '[]', updated_at = ?
       WHERE user_id = ? AND vacancy_seq = ? AND status = 'draft'`,
    )
    .bind(f.to_email, f.subject, f.body, now(), userId, seq)
    .run();
}

/** Человек отправил письмо сам (или позже — через Gmail). Совпадение переходит в applied. */
export async function markSent(db: D1Database, userId: string, seq: number, channel: "manual" | "gmail", ts = now()) {
  await db.batch([
    db
      .prepare("UPDATE applications SET status = 'sent', channel = ?, sent_at = ?, updated_at = ? WHERE user_id = ? AND vacancy_seq = ? AND status = 'draft'")
      .bind(channel, ts, ts, userId, seq),
    db.prepare("UPDATE matches SET status = 'applied' WHERE user_id = ? AND vacancy_seq = ?").bind(userId, seq),
  ]);
}

/** «Пропустить»: черновик в skipped, вакансия скрывается из подбора. */
export async function markSkipped(db: D1Database, userId: string, seq: number, ts = now()) {
  await db.batch([
    db.prepare("UPDATE applications SET status = 'skipped', updated_at = ? WHERE user_id = ? AND vacancy_seq = ? AND status = 'draft'").bind(ts, userId, seq),
    db.prepare("UPDATE matches SET status = 'hidden' WHERE user_id = ? AND vacancy_seq = ? AND status = 'new'").bind(userId, seq),
  ]);
}

/** Отклик в ту же компанию за последние две недели (по другой вакансии), если был. */
export function recentCompanyApplication(db: D1Database, userId: string, company: string, exceptSeq: number, ts = now()) {
  return db
    .prepare(
      `SELECT a.sent_at, v.title FROM applications a JOIN vacancies v ON v.seq = a.vacancy_seq
       WHERE a.user_id = ? AND a.company_key = ? AND a.status = 'sent' AND a.sent_at >= ? AND a.vacancy_seq != ?
       ORDER BY a.sent_at DESC LIMIT 1`,
    )
    .bind(userId, companyKey(company), ts - COMPANY_COOLDOWN_DAYS * 86400, exceptSeq)
    .first<{ sent_at: number; title: string }>();
}

export async function lettersToday(db: D1Database, userId: string, ts = now()): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM applications WHERE user_id = ? AND created_at >= ?")
    .bind(userId, ts - 86400)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** mailto: для ручной отправки (пока нет Gmail или если человек хочет отправить со своего клиента). */
export function mailtoLink(a: Pick<ApplicationRow, "to_email" | "subject" | "body">): string {
  return `mailto:${a.to_email ?? ""}?subject=${encodeURIComponent(a.subject)}&body=${encodeURIComponent(a.body)}`;
}
