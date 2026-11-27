import { now, type Env } from "../env";
import { ACTIVE_STATUSES } from "./billing";
import { latestResume } from "./cv";
import { sendMail, type Mail } from "./email";
import {
  COMPANY_COOLDOWN_DAYS,
  LetterError,
  companyKey,
  draftLetter,
  findApplyEmail,
  getMatchDetail,
  markSent,
  saveDraft,
  type ApplicationRow,
} from "./letters";
import { getProfile, type Profile } from "./profile";

/**
 * Автопилот: «солдат спит, служба идёт». Человек один раз включает его в /app/autopilot, дальше система сама:
 *  1. раз в сутки после PLAN_HOUR по Кипру выбирает лучшие совпадения, у которых есть адрес для отклика,
 *     пишет письма и ставит в очередь (с окном отмены или сразу);
 *  2. каждый запуск Cron отправляет созревшие письма через Resend: From — имя человека на нашем поддомене,
 *     Reply-To — его почта, CV во вложении;
 *  3. в момент отбора шлёт человеку отчёт: что ушло со вчерашнего отчёта и что уйдёт сегодня.
 */

export const TIMEZONE = "Europe/Nicosia";
export const PLAN_HOUR = 7;
/** Окно отмены: письма автопилота уходят через столько часов после отбора. */
export const REVIEW_WINDOW_HOURS = 3;
/** Сколько людей обрабатываем за один запуск Cron (письма пишет модель, это секунды на письмо). */
export const MAX_PLANS_PER_RUN = 3;
export const MAX_SENDS_PER_RUN = 40;
export const MAX_ATTEMPTS = 3;
export const LIMITS = { dailyMin: 1, dailyMax: 30, scoreMin: 35, scoreMax: 100 };

export interface AutopilotSettings {
  enabled: boolean;
  review_window: boolean;
  daily_limit: number;
  min_score: number;
  last_planned_day: string | null;
}

export const DEFAULT_SETTINGS: AutopilotSettings = { enabled: false, review_window: true, daily_limit: 10, min_score: 60, last_planned_day: null };

export function localDay(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-CA", { timeZone: TIMEZONE }); // YYYY-MM-DD
}
export function localHour(ts: number): number {
  return Number(new Date(ts * 1000).toLocaleString("en-GB", { timeZone: TIMEZONE, hour: "2-digit", hourCycle: "h23" }));
}
export function localTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString("ru-RU", { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit" });
}

export async function getSettings(db: D1Database, userId: string): Promise<AutopilotSettings> {
  const row = await db
    .prepare("SELECT enabled, review_window, daily_limit, min_score, last_planned_day FROM autopilot WHERE user_id = ?")
    .bind(userId)
    .first<{ enabled: number; review_window: number; daily_limit: number; min_score: number; last_planned_day: string | null }>();
  if (!row) return { ...DEFAULT_SETTINGS };
  return { ...row, enabled: !!row.enabled, review_window: !!row.review_window };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

export async function saveSettings(db: D1Database, userId: string, s: Omit<AutopilotSettings, "last_planned_day">, ts = now()) {
  await db
    .prepare(
      `INSERT INTO autopilot (user_id, enabled, review_window, daily_limit, min_score, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled, review_window = excluded.review_window,
         daily_limit = excluded.daily_limit, min_score = excluded.min_score, updated_at = excluded.updated_at`,
    )
    .bind(
      userId,
      s.enabled ? 1 : 0,
      s.review_window ? 1 : 0,
      clamp(s.daily_limit, LIMITS.dailyMin, LIMITS.dailyMax),
      clamp(s.min_score, LIMITS.scoreMin, LIMITS.scoreMax),
      ts,
    )
    .run();
}

// ---------------------------------------------------------------------------
// 1. Отбор и черновики

interface Candidate {
  seq: number;
  company: string;
  description: string;
  score: number;
}

/**
 * Лучшие новые совпадения с адресом для отклика: балл не ниже порога, ещё нет письма,
 * одна вакансия на компанию и не в компанию, куда уже писали за две недели.
 */
export async function pickCandidates(db: D1Database, userId: string, minScore: number, limit: number, ts = now()): Promise<Candidate[]> {
  if (limit <= 0) return [];
  const [rows, recent] = await Promise.all([
    db
      .prepare(
        `SELECT v.seq, v.company, v.description, m.score FROM matches m JOIN vacancies v ON v.seq = m.vacancy_seq
         WHERE m.user_id = ? AND m.status = 'new' AND m.score >= ?
           AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.user_id = m.user_id AND a.vacancy_seq = m.vacancy_seq)
         ORDER BY m.score DESC, v.seq DESC LIMIT 300`,
      )
      .bind(userId, minScore)
      .all<Candidate>(),
    db
      .prepare(
        `SELECT DISTINCT company_key FROM applications WHERE user_id = ?
         AND (status = 'queued' OR (status = 'sent' AND sent_at >= ?))`,
      )
      .bind(userId, ts - COMPANY_COOLDOWN_DAYS * 86400)
      .all<{ company_key: string }>(),
  ]);
  const taken = new Set(recent.results.map((r) => r.company_key));
  const out: Candidate[] = [];
  for (const r of rows.results) {
    const key = companyKey(r.company);
    if (taken.has(key) || !findApplyEmail(r.description)) continue;
    taken.add(key);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

/** Сколько писем автопилот уже поставил или отправил за последние сутки. */
async function usedToday(db: D1Database, userId: string, ts: number): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM applications WHERE user_id = ? AND source = 'autopilot' AND created_at >= ? AND status IN ('queued', 'sent')")
    .bind(userId, ts - 86400)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export interface PlanResult {
  queued: number;
  review: number; // письма с непроверенными цифрами: оставлены черновиками, не уходят сами
  errors: number;
}

export async function planUser(env: Env, userId: string, s: AutopilotSettings, ts = now()): Promise<PlanResult> {
  const res: PlanResult = { queued: 0, review: 0, errors: 0 };
  const profile = await getProfile(env.DB, userId);
  if (!profile) return res;
  const limit = s.daily_limit - (await usedToday(env.DB, userId, ts));
  const scheduledAt = ts + (s.review_window ? REVIEW_WINDOW_HOURS * 3600 : 0);
  for (const c of await pickCandidates(env.DB, userId, s.min_score, limit, ts)) {
    const match = await getMatchDetail(env.DB, userId, c.seq);
    if (!match) continue;
    try {
      const draft = await draftLetter(env, profile.profile, match);
      if (draft.unverified.length) {
        // Модель дважды вписала цифры, которых нет в данных: само такое не отправляем, ждём человека.
        await saveDraft(env.DB, userId, match, draft, ts, { source: "autopilot" });
        res.review++;
      } else {
        await saveDraft(env.DB, userId, match, draft, ts, { source: "autopilot", scheduledAt });
        res.queued++;
      }
    } catch (e) {
      res.errors++;
      if (!(e instanceof LetterError)) console.error("[autopilot] draft failed:", e instanceof Error ? `${e.name}: ${e.message}` : e);
    }
  }
  return res;
}

// ---------------------------------------------------------------------------
// 2. Отправка через Resend

function b64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Локальная часть адреса отправителя из имени: «Anna Petrova» → anna.petrova; кириллица и пусто → applicant. */
export function senderLocal(name: string | null): string {
  const s = (name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 40);
  return s || "applicant";
}

/** Имя в From: без кавычек и угловых скобок, чтобы не сломать заголовок. */
const displayName = (name: string | null, fallback: string) => (name ?? "").replace(/["<>\r\n]/g, "").trim() || fallback;

interface QueuedRow extends ApplicationRow {
  account_email: string;
}

export async function sendOne(env: Env, a: QueuedRow, profile: Profile): Promise<string> {
  const replyTo = profile.contacts.email || a.account_email;
  const resume = await latestResume(env.DB, a.user_id);
  const file = resume ? await env.CV_BUCKET.get(resume.r2_key) : null;
  const attachments = resume && file ? [{ filename: resume.filename, content: b64(new Uint8Array(await file.arrayBuffer())) }] : [];
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      // Повтор после сбоя сети не отправит письмо второй раз.
      "Idempotency-Key": `application/${a.user_id}/${a.vacancy_seq}/${a.created_at}`,
    },
    body: JSON.stringify({
      from: `${displayName(profile.full_name, "Applicant")} <${senderLocal(profile.full_name)}@${env.APPLY_FROM_DOMAIN}>`,
      to: [a.to_email],
      reply_to: replyTo,
      subject: a.subject,
      text: a.body,
      attachments,
      tags: [{ name: "kind", value: "application" }],
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return ((await res.json()) as { id?: string }).id ?? "";
}

export interface SendReport {
  sent: number;
  failed: number;
  waiting: number; // отложены: нет подписки или автопилот на паузе
}

/**
 * Отправляет письма из очереди, у которых подошло время. Письма автопилота уходят, только пока он включён;
 * любые — только при активной подписке. Сбой — повтор через 20·n минут, после MAX_ATTEMPTS — failed.
 */
export async function sendQueued(env: Env, ts = now()): Promise<SendReport> {
  const report: SendReport = { sent: 0, failed: 0, waiting: 0 };
  if (!env.RESEND_API_KEY || !env.APPLY_FROM_DOMAIN) return report;
  const statuses = ACTIVE_STATUSES.map(() => "?").join(", ");
  const rows = (
    await env.DB.prepare(
      `SELECT a.*, u.email AS account_email,
         (EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = a.user_id AND s.status IN (${statuses}))
          AND (a.source != 'autopilot' OR EXISTS (SELECT 1 FROM autopilot p WHERE p.user_id = a.user_id AND p.enabled = 1))) AS allowed
       FROM applications a JOIN users u ON u.id = a.user_id
       WHERE a.status = 'queued' AND a.scheduled_at <= ? AND a.to_email IS NOT NULL
       ORDER BY a.scheduled_at LIMIT ?`,
    )
      .bind(...ACTIVE_STATUSES, ts, MAX_SENDS_PER_RUN)
      .all<QueuedRow & { allowed: number }>()
  ).results;
  const profiles = new Map<string, Profile | null>();
  for (const a of rows) {
    if (!a.allowed) {
      report.waiting++;
      continue;
    }
    if (!profiles.has(a.user_id)) profiles.set(a.user_id, (await getProfile(env.DB, a.user_id))?.profile ?? null);
    const profile = profiles.get(a.user_id);
    if (!profile) continue;
    try {
      const id = await sendOne(env, a, profile);
      await markSent(env.DB, a.user_id, a.vacancy_seq, "resend", ts, id);
      report.sent++;
    } catch (e) {
      const attempts = a.attempts + 1;
      const error = e instanceof Error ? e.message : String(e);
      console.error(`[autopilot] send failed user=${a.user_id} seq=${a.vacancy_seq} attempt=${attempts}: ${error}`);
      await env.DB.prepare("UPDATE applications SET attempts = ?, send_error = ?, status = ?, scheduled_at = ?, updated_at = ? WHERE user_id = ? AND vacancy_seq = ?")
        .bind(attempts, error.slice(0, 500), attempts >= MAX_ATTEMPTS ? "failed" : "queued", ts + 1200 * attempts, ts, a.user_id, a.vacancy_seq)
        .run();
      report.failed++;
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// 3. Ежедневный отчёт

interface ReportItem {
  vacancy_seq: number;
  title: string;
  company: string;
  to_email: string | null;
  status: string;
  scheduled_at: number | null;
}

export function reportMail(
  appUrl: string,
  to: string,
  sent: ReportItem[],
  queued: ReportItem[],
  review: ReportItem[],
  failed: ReportItem[],
  ts = now(),
): Mail | null {
  if (!sent.length && !queued.length && !review.length && !failed.length) return null;
  const line = (i: ReportItem) => `• ${i.title} — ${i.company}${i.to_email ? ` (${i.to_email})` : ""}`;
  const parts: string[] = [];
  if (sent.length) parts.push(`Отправили с прошлого отчёта (${sent.length}):\n${sent.map(line).join("\n")}`);
  if (queued.length) {
    const at = Math.max(...queued.map((q) => q.scheduled_at ?? 0));
    parts.push(
      `Подготовили сегодня (${queued.length}), уйдут ${at > ts + 60 ? `в ${localTime(at)} по Кипру` : "в ближайшие минуты"}:\n${queued.map(line).join("\n")}\n` +
        `Отменить или поправить письмо: ${appUrl}/app/autopilot`,
    );
  }
  if (review.length) parts.push(`Ждут вашей проверки — в письме цифры, которых нет в анкете (${review.length}):\n${review.map(line).join("\n")}`);
  if (failed.length) parts.push(`Не удалось отправить (${failed.length}):\n${failed.map(line).join("\n")}`);
  const n = sent.length + queued.length;
  return {
    to,
    subject: n ? `Автопилот: ${n} ${plural(n, "отклик", "отклика", "откликов")} — Otklikator` : "Автопилот: нужна ваша проверка — Otklikator",
    text: `${parts.join("\n\n")}\n\nОтветы работодателей придут вам на почту напрямую.\nНастройки автопилота: ${appUrl}/app/autopilot`,
  };
}

function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
}

/** Собирает и отправляет отчёт; отправленные письма помечаются, чтобы не попасть в отчёт дважды. */
async function sendReport(env: Env, userId: string, email: string, ts: number) {
  const rows = (
    await env.DB.prepare(
      `SELECT a.vacancy_seq, v.title, v.company, a.to_email, a.status, a.scheduled_at, a.source, a.created_at, a.reported_at
       FROM applications a JOIN vacancies v ON v.seq = a.vacancy_seq
       WHERE a.user_id = ? AND a.reported_at IS NULL AND a.status IN ('sent', 'queued', 'draft', 'failed')
         AND (a.status != 'draft' OR (a.source = 'autopilot' AND a.created_at >= ?))
       ORDER BY v.company`,
    )
      .bind(userId, ts - 3600)
      .all<ReportItem & { source: string; created_at: number }>()
  ).results;
  const sent = rows.filter((r) => r.status === "sent");
  const queued = rows.filter((r) => r.status === "queued");
  const review = rows.filter((r) => r.status === "draft");
  const failed = rows.filter((r) => r.status === "failed");
  const mail = reportMail(env.APP_URL, email, sent, queued, review, failed, ts);
  if (!mail) return;
  await sendMail(env, mail);
  const done = [...sent, ...failed, ...review].map((r) => r.vacancy_seq);
  if (done.length) {
    await env.DB.prepare("UPDATE applications SET reported_at = ? WHERE user_id = ? AND vacancy_seq IN (SELECT value FROM json_each(?))")
      .bind(ts, userId, JSON.stringify(done))
      .run();
  }
}

// ---------------------------------------------------------------------------
// Запуск из Cron

export interface AutopilotReport extends SendReport {
  planned: number;
  queued: number;
  review: number;
}

/** Каждые 20 минут: отправить созревшее; после PLAN_HOUR по Кипру — отбор для тех, кому сегодня ещё не делали. */
export async function runAutopilot(env: Env, ts = now()): Promise<AutopilotReport> {
  const out: AutopilotReport = { ...(await sendQueued(env, ts)), planned: 0, queued: 0, review: 0 };
  if (localHour(ts) < PLAN_HOUR) return out;
  const day = localDay(ts);
  const statuses = ACTIVE_STATUSES.map(() => "?").join(", ");
  const users = (
    await env.DB.prepare(
      `SELECT p.user_id, u.email FROM autopilot p JOIN users u ON u.id = p.user_id
       WHERE p.enabled = 1 AND (p.last_planned_day IS NULL OR p.last_planned_day < ?)
         AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = p.user_id AND s.status IN (${statuses}))
         AND EXISTS (SELECT 1 FROM profiles pr WHERE pr.user_id = p.user_id)
       ORDER BY p.last_planned_day LIMIT ?`,
    )
      .bind(day, ...ACTIVE_STATUSES, MAX_PLANS_PER_RUN)
      .all<{ user_id: string; email: string }>()
  ).results;
  for (const u of users) {
    // Сначала отмечаем день: если запуск упадёт посередине, не будем писать письма по кругу.
    await env.DB.prepare("UPDATE autopilot SET last_planned_day = ? WHERE user_id = ?").bind(day, u.user_id).run();
    const s = await getSettings(env.DB, u.user_id);
    const r = await planUser(env, u.user_id, s, ts);
    out.planned++;
    out.queued += r.queued;
    out.review += r.review;
    // Без окна отмены письма уходят сразу, до отчёта.
    if (!s.review_window && r.queued) {
      const sent = await sendQueued(env, ts);
      out.sent += sent.sent;
      out.failed += sent.failed;
    }
    try {
      await sendReport(env, u.user_id, u.email, ts);
    } catch (e) {
      console.error("[autopilot] report failed:", e instanceof Error ? e.message : e);
    }
  }
  return out;
}
