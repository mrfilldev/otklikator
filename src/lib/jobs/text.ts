/** Общие утилиты для фидов и скоринга: очистка HTML, нормализация, флаги локации. Портировано из resume/scripts. */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…" };

export function unescapeHtml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** HTML → одна строка текста (как clean() в PoC: двойной unescape, потому что фиды экранируют дважды). */
export function cleanHtml(s: string | null | undefined): string {
  const once = unescapeHtml(unescapeHtml(s ?? ""));
  return once
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    // Адрес из mailto: оставляем в тексте: по нему потом ищем, куда отправить отклик.
    .replace(/<a\b[^>]*href=["']mailto:([^"'?]+)[^>]*>/gi, " $1 ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function norm(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9а-яё+#]+/g, " ")
    .trim();
}

const COMPANY_SUFFIX = /\b(inc|llc|ltd|limited|gmbh|ag|bv|sa|sas|srl|plc|corp|corporation|co|company|group|technologies|technology|labs|hq|ооо|ао)\b/g;

/** Ключ дедупа между источниками: одна и та же вакансия на RemoteOK и в Greenhouse компании. */
export function fingerprint(company: string, title: string): string {
  const co = norm(company).replace(COMPANY_SUFFIX, " ").replace(/\s+/g, "").replace(/^@/, "");
  const t = norm(title)
    .replace(/\b(remote|удаленно|удалённо|worldwide|anywhere|emea|europe|eu|us|usa)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${co}|${t}`;
}

export const REMOTE_RX = /remote|anywhere|worldwide|distributed|work from home|wfh|удал[её]нн?о?|удалёнка|удаленка/i;
const WORLD_RX = /anywhere|worldwide|global|emea|europe|\beu\b|international|по всему миру/i;
const US_ONLY_RX =
  /us[- ]only|u\.s\. (citizen|resident)|must (be|reside).{0,30}(united states|u\.s\.|\bus\b)|work authori[sz]ation|authorized to work in the (us|united states)|us citizen|security clearance|united states only|usa only|remote[ -]+(us|usa|united states)\b|\bus remote|\(us\)|us-based/i;
const CONTRACT_RX = /contractor|\bcontract\b|b2b|freelance|independent contractor|1099|\beor\b|deel|consultant|контракт|фриланс|самозанят/i;
const CY_RX = /cyprus|limassol|nicosia|larnaca|paphos|кипр|лимассол|никосия|ларнака|пафос/i;

/**
 * Флаги по локации и тексту вакансии (как в us_feeds.py / adjacent_feeds.py):
 * REMOTE — удалёнка; WORLD — открыто по миру/EMEA/EU; US_ONLY — нужен статус в США; CONTRACT — контракт/B2B; CY — Кипр.
 */
export function vacancyFlags(location: string, text: string, opts: { remote?: boolean } = {}): string {
  const blob = `${location} ${text.slice(0, 3000)}`;
  const f: string[] = [];
  if (opts.remote || REMOTE_RX.test(location) || REMOTE_RX.test(text.slice(0, 600))) f.push("REMOTE");
  if (WORLD_RX.test(location) || WORLD_RX.test(text.slice(0, 1500))) f.push("WORLD");
  if (US_ONLY_RX.test(blob) && !WORLD_RX.test(location)) f.push("US_ONLY");
  if (CONTRACT_RX.test(blob)) f.push("CONTRACT");
  if (CY_RX.test(blob)) f.push("CY");
  return f.join(" ");
}

export function hasFlag(flags: string, flag: string): boolean {
  return ` ${flags} `.includes(` ${flag} `);
}

/** Unix-время из ISO-строки, миллисекунд или секунд. null, если не разобрать. */
export function toUnix(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Math.floor(v > 1e11 ? v / 1000 : v);
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return toUnix(Number(s));
  // "2026-11-20 10:00:00" (Jobicy) → ISO
  const iso = /^\d{4}-\d{2}-\d{2} \d/.test(s) ? s.replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? "" : "Z") : s;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}
