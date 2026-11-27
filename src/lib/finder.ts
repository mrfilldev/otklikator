import { now, type Env } from "../env";
import { ACTIVE_STATUSES } from "./billing";
import { cleanHtml, norm, unescapeHtml } from "./jobs/text";
import { EMAIL_RX, companyKey, findApplyEmail, isJunkEmail } from "./letters";

/**
 * Поиск адреса для отклика, когда его нет в тексте вакансии.
 *  1. Сайт компании: домен из ссылки на вакансию или из ссылок в описании, иначе угадываем по названию
 *     (acme.com / .io / .ai …). Сайт принимаем, только если он про эту компанию (домен или <title> совпадает
 *     с названием) и это не припаркованный домен.
 *  2. Адрес на сайте: главная, ссылки на карьеру/контакты с неё и /careers, /contact. Берём только ролевые адреса
 *     на домене компании (jobs@, careers@, hr@ → team@, hello@ → contact@, info@), личные не трогаем.
 *  3. Если на сайте пусто и задан HUNTER_API_KEY — общие адреса домена из Hunter.io.
 *  4. У домена адреса должна быть MX-запись (DNS-over-HTTPS), иначе письмо вернётся и испортит репутацию.
 * Угадывать jobs@домен без подтверждения нельзя: отказы портят репутацию отправителя, а SMTP-проверка из Workers
 * невозможна (порт 25 закрыт). Результат кешируется в companies на компанию.
 */

export const MAX_LOOKUPS_PER_RUN = 4;
const MAX_FETCHES_PER_COMPANY = 8;
const RECHECK_DAYS = { found: 90, no_email: 30, no_domain: 30, error: 1 } as const;
const GUESS_TLDS = ["com", "io", "ai", "co", "dev"];
const UA = "Mozilla/5.0 (compatible; OtklikatorBot/1.0; +https://otklikator.app)";

export interface Page {
  url: string;
  html: string;
}
export type PageFetcher = (url: string) => Promise<Page | null>;
export type MxCheck = (domain: string) => Promise<boolean>;

export const httpPage: PageFetcher = async (url) => {
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(8000), headers: { "User-Agent": UA, Accept: "text/html" } });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("html")) return null;
    return { url: res.url || url, html: (await res.text()).slice(0, 400_000) };
  } catch {
    return null;
  }
};

export const dnsMx: MxCheck = async (domain) => {
  try {
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`, {
      headers: { Accept: "application/dns-json" },
      signal: AbortSignal.timeout(5000),
    });
    const data = (await res.json()) as { Answer?: { type: number }[] };
    return !!data.Answer?.some((a) => a.type === 15);
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// Домены

/** Агрегаторы, ATS и прочие сайты, которые точно не сайт компании. */
const NOT_COMPANY =
  /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|recruitee\.com|smartrecruiters\.com|bamboohr\.com|personio\.(de|com)|teamtailor\.com|breezy\.hr|workday\.com|myworkdayjobs\.com|jobvite\.com|icims\.com|taleo\.net|rippling\.com|remoteok\.com|weworkremotely\.com|himalayas\.app|remotive\.com|jobicy\.com|ycombinator\.com|workatastartup\.com|wellfound\.com|angel\.co|linkedin\.com|indeed\.com|glassdoor\.com|t\.me|telegram\.(me|org)|google\.com|goo\.gl|forms\.gle|github\.com|gitlab\.io|notion\.(so|site)|typeform\.com|bit\.ly|medium\.com|substack\.com|twitter\.com|x\.com|facebook\.com|instagram\.com|youtube\.com|calendly\.com|hh\.ru|habr\.com|djinni\.co)$/i;

const TWO_LEVEL = /^(co|com|org|net|ac|gov|edu)$/;

/** Регистрируемый домен: careers.acme.co.uk → acme.co.uk, www.acme.io → acme.io. */
export function registrable(host: string): string {
  const parts = host.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const n = TWO_LEVEL.test(parts[parts.length - 2]) && parts[parts.length - 1].length === 2 ? 3 : 2;
  return parts.slice(-n).join(".");
}
const stem = (domain: string) => registrable(domain).split(".")[0].replace(/-/g, "");

/** Название компании без суффиксов и пробелов: «Acme Labs, Inc.» → acme. */
export function companySlug(name: string): string {
  return companyKey(name).replace(/[^a-z0-9]/g, "");
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

/** Кандидаты в сайт компании, самые вероятные первыми. */
export function candidateDomains(company: string, url: string, description: string): string[] {
  const slug = companySlug(company);
  const out: string[] = [];
  const add = (host: string | null) => {
    if (!host || NOT_COMPANY.test(host) || !/\.[a-z]{2,}$/.test(host)) return;
    const d = registrable(host);
    if (!out.includes(d)) out.push(d);
  };
  add(hostOf(url));
  const linked = [...description.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)].map((m) => m[1].toLowerCase());
  for (const h of linked) if (slug.length >= 3 && stem(h).includes(slug)) add(h);
  if (slug.length >= 3) for (const tld of GUESS_TLDS) add(`${slug}.${tld}`);
  return out;
}

const PARKED = /for sale|buy this domain|domain is parked|parkingcrew|sedoparking|sedo\.com|hugedomains|dan\.com|afternic|this domain (may be|is) for sale|domain name is available/i;

function pageTitle(html: string): string {
  const og = /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)/i.exec(html)?.[1] ?? "";
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  return unescapeHtml(`${og} ${title}`);
}

/** Сайт про эту компанию: домен совпадает с названием или название есть в <title>, и это не парковка. */
export function isCompanySite(page: Page, domain: string, company: string): boolean {
  const slug = companySlug(company);
  const finalHost = hostOf(page.url) ?? domain;
  if (PARKED.test(page.html.slice(0, 20_000))) return false;
  if (registrable(finalHost) !== registrable(domain) && stem(finalHost) !== stem(domain)) return false;
  const s = stem(domain);
  if (slug.length >= 3 && (s === slug || (s.includes(slug) && slug.length >= 4) || (slug.includes(s) && s.length >= 4))) return true;
  return slug.length >= 3 && norm(pageTitle(page.html)).replace(/\s+/g, "").includes(slug);
}

// ---------------------------------------------------------------------------
// Адреса на сайте

const RANK: [RegExp, number][] = [
  [/^(jobs?|careers?|hr|hiring|recruit\w*|talent|people|apply|cv|resumes?|join|joinus|work|vacanc\w*)$/, 3],
  [/^(team|founders?|hello|hi|hey)$/, 2],
  [/^(contact|info|office|general|mail|inquiries|enquiries)$/, 1],
];

/** Насколько адрес подходит для отклика: 3 — отдел найма, 2 — команда/основатели, 1 — общий, 0 — не берём. */
export function roleRank(email: string): number {
  const local = email.split("@")[0].toLowerCase().replace(/[._-]/g, "");
  return RANK.find(([rx]) => rx.test(local))?.[1] ?? 0;
}

/** Ролевые адреса на домене компании со страницы (из mailto: и из текста). */
export function siteEmails(html: string, domain: string): string[] {
  const text = `${[...html.matchAll(/mailto:([^"'?\s>]+)/gi)].map((m) => decodeURIComponent(m[1])).join(" ")} ${cleanHtml(html)}`;
  const out: string[] = [];
  for (const m of text.matchAll(EMAIL_RX)) {
    const e = m[0].replace(/\.+$/, "").toLowerCase();
    const host = e.split("@")[1];
    if (registrable(host) !== registrable(domain) || isJunkEmail(e) || roleRank(e) === 0 || out.includes(e)) continue;
    out.push(e);
  }
  return out;
}

const pickBest = (emails: string[]) => [...emails].sort((a, b) => roleRank(b) - roleRank(a))[0] ?? null;

const CAREER_LINK = /\/(careers?|jobs?|join(-us)?|hiring|work-with-us|work-at|contact(-us)?|about(-us)?|team|company)(\/|$|\?|#)/i;

/** Ссылки с главной на страницы карьеры и контактов того же сайта. */
export function careerLinks(page: Page, domain: string): string[] {
  const out: string[] = [];
  for (const m of page.html.matchAll(/href=["']([^"'#]+)["']/gi)) {
    let u: URL;
    try {
      u = new URL(m[1], page.url);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(u.protocol) || registrable(u.hostname) !== registrable(domain) || !CAREER_LINK.test(u.pathname + "/")) continue;
    const href = `${u.origin}${u.pathname}`;
    if (!out.includes(href)) out.push(href);
  }
  // Сначала карьера, потом контакты и «о нас».
  return out.sort((a, b) => Number(!/career|job|join|hiring|work/i.test(a)) - Number(!/career|job|join|hiring|work/i.test(b)));
}

// ---------------------------------------------------------------------------
// Поиск по одной компании

export interface Lookup {
  domain: string | null;
  email: string | null;
  source: string | null;
  status: "found" | "no_email" | "no_domain" | "error";
}

export async function lookupCompany(
  env: Pick<Env, "HUNTER_API_KEY">,
  v: { company: string; url: string; description: string },
  deps: { page?: PageFetcher; mx?: MxCheck } = {},
): Promise<Lookup> {
  const page = deps.page ?? httpPage;
  const mx = deps.mx ?? dnsMx;
  let budget = MAX_FETCHES_PER_COMPANY;
  const get = async (url: string) => (budget-- > 0 ? page(url) : null);

  // 1. Сайт компании
  let domain: string | null = null;
  let home: Page | null = null;
  for (const d of candidateDomains(v.company, v.url, v.description)) {
    if (budget <= 2) break; // на поиск адреса на сайте должно остаться хотя бы две загрузки
    const p = await get(`https://${d}/`);
    if (p && isCompanySite(p, d, v.company)) {
      domain = d;
      home = p;
      break;
    }
  }
  if (!domain || !home) return { domain: null, email: null, source: null, status: "no_domain" };

  // 2. Адрес на сайте
  const found: { email: string; source: string }[] = [];
  const collect = (p: Page) => siteEmails(p.html, domain!).forEach((email) => found.push({ email, source: p.url }));
  collect(home);
  const pages = [...careerLinks(home, domain), `https://${domain}/careers`, `https://${domain}/contact`];
  const seen = new Set([home.url.replace(/\/$/, "")]);
  for (const url of pages) {
    if (found.some((f) => roleRank(f.email) === 3) || budget <= 0) break;
    const key = url.replace(/\/$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    const p = await get(url);
    if (p) collect(p);
  }

  // 3. Hunter.io как запасной вариант
  if (!found.length && env.HUNTER_API_KEY) {
    try {
      const res = await fetch(
        `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&type=generic&limit=10&api_key=${env.HUNTER_API_KEY}`,
        { signal: AbortSignal.timeout(8000) },
      );
      if (res.ok) {
        const data = (await res.json()) as { data?: { emails?: { value?: string }[] } };
        for (const e of data.data?.emails ?? []) {
          const email = (e.value ?? "").toLowerCase();
          if (email && registrable(email.split("@")[1] ?? "") === domain && !isJunkEmail(email) && roleRank(email) > 0) {
            found.push({ email, source: "hunter.io" });
          }
        }
      }
    } catch {
      // Hunter недоступен — остаёмся без адреса.
    }
  }

  const best = pickBest(found.map((f) => f.email));
  if (!best) return { domain, email: null, source: null, status: "no_email" };
  // 4. Почта на домене должна принимать письма.
  if (!(await mx(best.split("@")[1]))) return { domain, email: null, source: null, status: "no_email" };
  return { domain, email: best, source: found.find((f) => f.email === best)!.source, status: "found" };
}

// ---------------------------------------------------------------------------
// Кеш и запуск из Cron

export async function saveLookup(db: D1Database, company: string, r: Lookup, ts = now()) {
  await db
    .prepare(
      `INSERT INTO companies (company_key, name, domain, email, email_source, status, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(company_key) DO UPDATE SET name = excluded.name, domain = excluded.domain, email = excluded.email,
         email_source = excluded.email_source, status = excluded.status, checked_at = excluded.checked_at`,
    )
    .bind(companyKey(company), company, r.domain, r.email, r.source, r.status, ts)
    .run();
}

export async function companyEmails(db: D1Database, companies: string[]): Promise<Map<string, string>> {
  const keys = [...new Set(companies.map(companyKey))];
  if (!keys.length) return new Map();
  const rows = (
    await db
      .prepare("SELECT company_key, email FROM companies WHERE status = 'found' AND email IS NOT NULL AND company_key IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(keys))
      .all<{ company_key: string; email: string }>()
  ).results;
  return new Map(rows.map((r) => [r.company_key, r.email]));
}

/** Куда слать отклик: адрес из текста вакансии, иначе найденный на сайте компании. */
export async function applyEmailFor(db: D1Database, v: { company: string; description: string }): Promise<string | null> {
  return findApplyEmail(v.description) ?? (await companyEmails(db, [v.company])).get(companyKey(v.company)) ?? null;
}

export interface FinderReport {
  looked: number;
  found: number;
}

/**
 * Ищет адреса для компаний из подходящих вакансий тех, у кого включён автопилот: сначала самые высокие баллы.
 * Компании с адресом в тексте вакансии и проверенные недавно пропускаем. Не больше MAX_LOOKUPS_PER_RUN за запуск.
 */
export async function runFinder(env: Env, ts = now(), deps: { page?: PageFetcher; mx?: MxCheck } = {}): Promise<FinderReport> {
  const statuses = ACTIVE_STATUSES.map(() => "?").join(", ");
  const rows = (
    await env.DB.prepare(
      `SELECT v.company, v.url, v.description, MAX(m.score) AS score
       FROM matches m JOIN vacancies v ON v.seq = m.vacancy_seq JOIN autopilot p ON p.user_id = m.user_id AND p.enabled = 1
       WHERE m.status = 'new' AND m.score >= p.min_score
         AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = m.user_id AND s.status IN (${statuses}))
       GROUP BY v.company ORDER BY score DESC LIMIT 300`,
    )
      .bind(...ACTIVE_STATUSES)
      .all<{ company: string; url: string; description: string }>()
  ).results;
  const keys = [...new Set(rows.map((r) => companyKey(r.company)))];
  const checked = new Map(
    keys.length
      ? (
          await env.DB.prepare("SELECT company_key, status, checked_at FROM companies WHERE company_key IN (SELECT value FROM json_each(?))")
            .bind(JSON.stringify(keys))
            .all<{ company_key: string; status: keyof typeof RECHECK_DAYS; checked_at: number }>()
        ).results.map((r) => [r.company_key, r])
      : [],
  );
  const todo: typeof rows = [];
  const taken = new Set<string>();
  for (const r of rows) {
    const key = companyKey(r.company);
    if (!key || taken.has(key) || findApplyEmail(r.description)) continue;
    const c = checked.get(key);
    if (c && c.checked_at > ts - (RECHECK_DAYS[c.status] ?? 30) * 86400) continue;
    taken.add(key);
    todo.push(r);
    if (todo.length >= MAX_LOOKUPS_PER_RUN) break;
  }
  const report: FinderReport = { looked: 0, found: 0 };
  for (const r of todo) {
    let res: Lookup;
    try {
      res = await lookupCompany(env, r, deps);
    } catch (e) {
      console.error(`[finder] ${r.company}:`, e instanceof Error ? e.message : e);
      res = { domain: null, email: null, source: null, status: "error" };
    }
    await saveLookup(env.DB, r.company, res, ts);
    report.looked++;
    if (res.status === "found") report.found++;
  }
  return report;
}
