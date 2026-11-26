/**
 * Cron-конвейер: собрать вакансии из части источников → сохранить с дедупом → посчитать подбор для людей с анкетой.
 *
 * Лимиты Workers: подзапросов (fetch) и запросов к D1 на один запуск немного, поэтому
 *  - источники обходим по кругу, по FEEDS_PER_RUN за запуск (курсор в feed_state);
 *  - вставки делаем одним запросом на пачку через json_each (а не по строке на вакансию);
 *  - вакансии для подбора грузим один раз на всех пользователей.
 */
import { now } from "../../env";
import { ProfileSchema, emptyProfile, type Profile } from "../profile";
import { MIN_SCORE, scoreVacancy } from "./score";
import { FEED_TASKS, httpFetcher, type FeedTask, type Fetcher, type RawVacancy } from "./sources";
import { fingerprint } from "./text";

export const FEEDS_PER_RUN = 12;
const FEED_CONCURRENCY = 6;
/** Окно свежести: старше — не берём из фидов и не подбираем впервые. */
export const FRESH_DAYS = 14;
/** Сколько держим вакансию после того, как она пропала из фидов. */
export const RETENTION_DAYS = 45;
const MATCH_BATCH = 2000;
const MATCH_USERS_PER_RUN = 100;
/** Не больше стольких новых совпадений от одной компании за один пересчёт (как per[k] ≤ 4 в PoC). */
const PER_COMPANY = 3;
/** Ограничение D1 на размер одного значения — режем JSON на пачки поменьше. */
const JSON_CHUNK = 800_000;

function chunksByJson<T>(rows: T[]): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let size = 2;
  for (const r of rows) {
    const s = JSON.stringify(r);
    if (cur.length && size + s.length + 1 > JSON_CHUNK) {
      out.push(`[${cur.join(",")}]`);
      cur = [];
      size = 2;
    }
    cur.push(s);
    size += s.length + 1;
  }
  if (cur.length) out.push(`[${cur.join(",")}]`);
  return out;
}

// ---------------------------------------------------------------------------
// Хранилище

export async function saveVacancies(db: D1Database, items: RawVacancy[], ts = now()): Promise<number> {
  if (!items.length) return 0;
  // Дубли внутри пачки (одна вакансия в двух запросах к тому же агрегатору) убираем заранее.
  const seen = new Set<string>();
  const rows = [];
  for (const v of items) {
    const fp = fingerprint(v.company, v.title);
    if (seen.has(v.id) || seen.has(fp)) continue;
    seen.add(v.id);
    seen.add(fp);
    rows.push({ ...v, fingerprint: fp });
  }
  let inserted = 0;
  for (const chunk of chunksByJson(rows)) {
    const res = await db
      .prepare(
        `INSERT INTO vacancies (id, source, title, company, location, url, description, flags, fingerprint, posted_at, first_seen_at, last_seen_at)
         SELECT j.value ->> 'id', j.value ->> 'source', j.value ->> 'title', j.value ->> 'company', j.value ->> 'location', j.value ->> 'url',
                j.value ->> 'description', j.value ->> 'flags', j.value ->> 'fingerprint', j.value ->> 'posted_at', ?2, ?2
         FROM json_each(?1) AS j WHERE true
         ON CONFLICT DO NOTHING`,
      )
      .bind(chunk, ts)
      .run();
    inserted += res.meta.changes ?? 0;
    // Уже известные вакансии (по id или по дублю из другого источника) — отмечаем, что они ещё живы.
    await db
      .prepare(
        `UPDATE vacancies SET last_seen_at = ?2
         WHERE last_seen_at < ?2 AND (id IN (SELECT value ->> 'id' FROM json_each(?1)) OR fingerprint IN (SELECT value ->> 'fingerprint' FROM json_each(?1)))`,
      )
      .bind(chunk, ts)
      .run();
  }
  return inserted;
}

async function getState(db: D1Database, key: string): Promise<string | null> {
  const r = await db.prepare("SELECT value FROM feed_state WHERE key = ?").bind(key).first<{ value: string }>();
  return r?.value ?? null;
}
async function setState(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare("INSERT INTO feed_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(key, value, now())
    .run();
}

// ---------------------------------------------------------------------------
// Сбор

export interface CollectReport {
  tasks: { task: string; fetched: number; inserted: number; error?: string }[];
  inserted: number;
}

export async function collect(
  db: D1Database,
  opts: { get?: Fetcher; tasks?: FeedTask[]; perRun?: number; ts?: number } = {},
): Promise<CollectReport> {
  const all = opts.tasks ?? FEED_TASKS;
  const perRun = Math.min(opts.perRun ?? FEEDS_PER_RUN, all.length);
  const get = opts.get ?? httpFetcher;
  const ts = opts.ts ?? now();
  const since = ts - FRESH_DAYS * 86400;

  const cursor = Number((await getState(db, "feed_cursor")) ?? 0) % all.length || 0;
  const slice = Array.from({ length: perRun }, (_, i) => all[(cursor + i) % all.length]);

  const results: { task: string; items: RawVacancy[]; error?: string }[] = [];
  for (let i = 0; i < slice.length; i += FEED_CONCURRENCY) {
    const part = slice.slice(i, i + FEED_CONCURRENCY);
    const done = await Promise.all(
      part.map(async (t) => {
        try {
          return { task: t.key, items: await t.run(get, since) };
        } catch (e) {
          return { task: t.key, items: [], error: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
        }
      }),
    );
    results.push(...done);
  }

  const report: CollectReport = { tasks: [], inserted: 0 };
  for (const r of results) {
    const inserted = r.items.length ? await saveVacancies(db, r.items, ts) : 0;
    report.inserted += inserted;
    report.tasks.push({ task: r.task, fetched: r.items.length, inserted, ...(r.error ? { error: r.error } : {}) });
  }
  await db
    .prepare(
      `INSERT INTO feed_runs (task, fetched, inserted, error, ran_at)
       SELECT j.value ->> 'task', j.value ->> 'fetched', j.value ->> 'inserted', j.value ->> 'error', ?2 FROM json_each(?1) AS j`,
    )
    .bind(JSON.stringify(report.tasks), ts)
    .run();
  await setState(db, "feed_cursor", String((cursor + perRun) % all.length));
  return report;
}

// ---------------------------------------------------------------------------
// Подбор

interface UserRow {
  user_id: string;
  data: string;
  updated_at: number;
  last_seq: number | null;
  state_profile_at: number | null;
}
interface VacRow {
  seq: number;
  title: string;
  company: string;
  location: string;
  description: string;
  flags: string;
  posted_at: number | null;
  first_seen_at: number;
}

export interface MatchReport {
  users: number;
  scored: number;
  matched: number;
}

function parseProfile(data: string): Profile | null {
  try {
    const r = ProfileSchema.safeParse({ ...emptyProfile(), ...JSON.parse(data) });
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export async function matchUsers(db: D1Database, ts = now()): Promise<MatchReport> {
  const users = (
    await db
      .prepare(
        `SELECT p.user_id, p.data, p.updated_at, m.last_seq, m.profile_updated_at AS state_profile_at
         FROM profiles p
         JOIN users u ON u.id = p.user_id AND u.email_verified_at IS NOT NULL
         LEFT JOIN match_state m ON m.user_id = p.user_id
         ORDER BY COALESCE(m.updated_at, 0) LIMIT ?`,
      )
      .bind(MATCH_USERS_PER_RUN)
      .all<UserRow>()
  ).results;
  if (!users.length) return { users: 0, scored: 0, matched: 0 };

  // С какой вакансии считать каждому: продолжить с курсора, а если анкета изменилась (или впервые) — заново по свежим.
  const windowStart = ts - FRESH_DAYS * 86400;
  const firstFresh =
    (await db.prepare("SELECT MIN(seq) AS s FROM vacancies WHERE first_seen_at >= ?").bind(windowStart).first<{ s: number | null }>())?.s ?? null;
  const maxSeq = (await db.prepare("SELECT MAX(seq) AS s FROM vacancies").first<{ s: number | null }>())?.s ?? 0;
  const plan = users.map((u) => {
    const restart = u.last_seq === null || u.state_profile_at !== u.updated_at;
    const from = restart ? (firstFresh ?? maxSeq + 1) - 1 : u.last_seq!;
    return { u, restart, from, profile: parseProfile(u.data) };
  });

  const minFrom = Math.min(...plan.map((p) => p.from));
  const vacs = (
    await db
      .prepare(
        `SELECT seq, title, company, location, description, flags, posted_at, first_seen_at FROM vacancies
         WHERE seq > ? ORDER BY seq LIMIT ?`,
      )
      .bind(minFrom, MATCH_BATCH)
      .all<VacRow>()
  ).results;
  const lastLoaded = vacs.length ? vacs[vacs.length - 1].seq : maxSeq;
  // Если пачка упёрлась в лимит, дальше этой вакансии не продвигаемся — догоним в следующий запуск.
  const reached = vacs.length === MATCH_BATCH ? lastLoaded : Math.max(lastLoaded, maxSeq);

  const matchRows: { u: string; s: number; sc: number; r: string }[] = [];
  const stateRows: { u: string; seq: number; p: number }[] = [];
  const restartUsers: string[] = [];
  let scored = 0;

  for (const { u, restart, from, profile } of plan) {
    if (restart) restartUsers.push(u.user_id);
    if (profile) {
      const hits: { seq: number; score: number; reasons: string[]; co: string }[] = [];
      for (const v of vacs) {
        if (v.seq <= from) continue;
        if (restart && v.first_seen_at < windowStart) continue;
        scored++;
        const r = scoreVacancy(v, profile, ts);
        if ("score" in r && r.score >= MIN_SCORE) hits.push({ seq: v.seq, score: r.score, reasons: r.reasons, co: v.company.toLowerCase() });
      }
      hits.sort((a, b) => b.score - a.score);
      const perCo = new Map<string, number>();
      for (const h of hits) {
        const n = perCo.get(h.co) ?? 0;
        if (n >= PER_COMPANY) continue;
        perCo.set(h.co, n + 1);
        matchRows.push({ u: u.user_id, s: h.seq, sc: h.score, r: JSON.stringify(h.reasons) });
      }
    }
    stateRows.push({ u: u.user_id, seq: Math.max(from, reached), p: u.updated_at });
  }

  // Анкета поменялась — новые (не просмотренные) совпадения пересчитываем с нуля; скрытые и отправленные не трогаем.
  if (restartUsers.length) {
    await db
      .prepare("DELETE FROM matches WHERE status = 'new' AND user_id IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(restartUsers))
      .run();
  }
  let matched = 0;
  for (const chunk of chunksByJson(matchRows)) {
    const res = await db
      .prepare(
        `INSERT INTO matches (user_id, vacancy_seq, score, reasons, status, created_at)
         SELECT j.value ->> 'u', j.value ->> 's', j.value ->> 'sc', j.value ->> 'r', 'new', ?2 FROM json_each(?1) AS j WHERE true
         ON CONFLICT(user_id, vacancy_seq) DO UPDATE SET score = excluded.score, reasons = excluded.reasons`,
      )
      .bind(chunk, ts)
      .run();
    matched += res.meta.changes ?? 0;
  }
  await db
    .prepare(
      `INSERT INTO match_state (user_id, last_seq, profile_updated_at, updated_at)
       SELECT j.value ->> 'u', j.value ->> 'seq', j.value ->> 'p', ?2 FROM json_each(?1) AS j WHERE true
       ON CONFLICT(user_id) DO UPDATE SET last_seq = excluded.last_seq, profile_updated_at = excluded.profile_updated_at, updated_at = excluded.updated_at`,
    )
    .bind(JSON.stringify(stateRows), ts)
    .run();

  return { users: users.length, scored, matched };
}

/** Старые вакансии (давно пропали из фидов) и их совпадения удаляем, журнал опросов держим неделю. */
export async function cleanup(db: D1Database, ts = now()): Promise<void> {
  const cutoff = ts - RETENTION_DAYS * 86400;
  await db.batch([
    db.prepare("DELETE FROM matches WHERE vacancy_seq IN (SELECT seq FROM vacancies WHERE last_seen_at < ?) AND status = 'new'").bind(cutoff),
    db.prepare("DELETE FROM vacancies WHERE last_seen_at < ? AND seq NOT IN (SELECT vacancy_seq FROM matches)").bind(cutoff),
    db.prepare("DELETE FROM feed_runs WHERE ran_at < ?").bind(ts - 7 * 86400),
  ]);
}

export async function runJobsCron(db: D1Database, opts: { get?: Fetcher } = {}) {
  const collected = await collect(db, opts);
  const matched = await matchUsers(db);
  await cleanup(db);
  const errors = collected.tasks.filter((t) => t.error).map((t) => `${t.task}: ${t.error}`);
  console.log(
    `[jobs] feeds=${collected.tasks.length} new=${collected.inserted} users=${matched.users} scored=${matched.scored} matched=${matched.matched}` +
      (errors.length ? ` errors=${errors.join("; ")}` : ""),
  );
  return { collected, matched };
}

// ---------------------------------------------------------------------------
// Для страницы «Подходящие вакансии»

export interface MatchView {
  seq: number;
  title: string;
  company: string;
  location: string;
  url: string;
  flags: string;
  score: number;
  reasons: string[];
  status: string;
  posted_at: number | null;
  first_seen_at: number;
}

export async function listMatches(db: D1Database, userId: string, limit = 50): Promise<MatchView[]> {
  const rows = (
    await db
      .prepare(
        `SELECT v.seq, v.title, v.company, v.location, v.url, v.flags, v.posted_at, v.first_seen_at, m.score, m.reasons, m.status
         FROM matches m JOIN vacancies v ON v.seq = m.vacancy_seq
         WHERE m.user_id = ? AND m.status = 'new'
         ORDER BY m.score DESC, v.seq DESC LIMIT ?`,
      )
      .bind(userId, limit)
      .all<Omit<MatchView, "reasons"> & { reasons: string }>()
  ).results;
  return rows.map((r) => ({ ...r, reasons: JSON.parse(r.reasons) as string[] }));
}

export async function hideMatch(db: D1Database, userId: string, seq: number): Promise<void> {
  await db.prepare("UPDATE matches SET status = 'hidden' WHERE user_id = ? AND vacancy_seq = ?").bind(userId, seq).run();
}
