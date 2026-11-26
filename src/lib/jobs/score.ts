/**
 * Оценка вакансии под анкету человека. Обобщение resume/scripts/jobslib.score + triage.py HARD:
 * в PoC правила были зашиты под одного кандидата (Python, без AI/DevOps), здесь их задаёт анкета —
 * целевые роли, стек, грейд, формат работы, локация и список «чего не хочу».
 *
 * Детерминированно и без модели: дёшево считать для каждого пользователя по каждой новой вакансии,
 * и человеку можно показать, почему вакансия подобрана (reasons).
 * Принцип из PoC: «по умолчанию откликаемся». Нехватка лет, другой домен, зарплата ниже — не повод отсекать,
 * отсекаем только явное несовпадение роли/стека, «не хочу», US-only и офис в чужой стране.
 */
import type { Profile } from "../profile";
import { REMOTE_RX, hasFlag, norm } from "./text";

export interface VacancyForScore {
  title: string;
  company: string;
  location: string;
  description: string;
  flags: string;
  posted_at: number | null;
}

export type ScoreResult = { skip: string } | { score: number; reasons: string[] };

export const MIN_SCORE = 35;

// ---------------------------------------------------------------------------
// Семейства ролей. Порядок важен: сначала самые узкие (ML раньше backend, fullstack раньше frontend).

export type Family =
  | "ml" | "devops" | "data" | "qa" | "mobile" | "fullstack" | "frontend" | "solutions" | "backend"
  | "pm" | "project" | "design" | "eng_manager" | "nontech" | "eng";

const FAMILIES: [Family, RegExp][] = [
  ["ml", /machine learning|\bml\b|\bmle\b|\bai\b|\bllm\b|\bnlp\b|computer vision|data scientist|deep learning|prompt engineer|ai\/ml/i],
  ["devops", /devops|dev ops|\bsre\b|site reliability|platform engineer|infrastructure|cloud engineer|systems? administrator|sysadmin|devsecops|kubernetes engineer/i],
  ["data", /data engineer|analytics engineer|data analyst|\bbi\b|business intelligence|etl developer|data warehouse|dwh/i],
  ["qa", /\bqa\b|quality assurance|\bsdet\b|tester|test (automation )?engineer|automation qa|тестировщик/i],
  ["mobile", /\bios\b|android|mobile|flutter|react native|swift developer|kotlin multiplatform/i],
  ["fullstack", /full[- ]?stack|фулл?стек/i],
  ["frontend", /front[- ]?end|фронтенд|react developer|vue|angular|\bui engineer|web developer/i],
  ["solutions", /solutions? (engineer|architect|consultant)|integrations? (engineer|developer|specialist)|implementation (engineer|specialist|consultant|manager)|technical account manager|\btam\b|sales engineer|pre-?sales|customer engineer|forward deployed|support engineer|technical support|application support/i],
  ["backend", /back[- ]?end|бэкенд|бекенд|server[- ]side|api (engineer|developer)|\b(python|java|golang|go|ruby|php|scala|elixir|rust|\.net|c#|node(\.js)?|django|rails|laravel|spring) (developer|engineer|разработчик)|разработчик (python|java|go|php)/i],
  ["eng_manager", /engineering manager|head of engineering|vp of engineering|\bcto\b|tech(nical)? lead|team lead|тимлид/i],
  ["pm", /product (manager|owner|lead|director)|head of product|\bcpo\b|продакт|product management|\bpm\b|\bpo\b/i],
  ["project", /project manager|delivery manager|program(me)? manager|scrum master|проджект|руководитель проект/i],
  ["design", /designer|\bux\b|\bui\/ux|product design|дизайнер/i],
  ["nontech", /\bsales\b|account executive|\bsdr\b|\bbdr\b|marketing|recruit|\bhr\b|talent|accountant|finance|legal|counsel|payroll|customer success manager|office manager|copywriter|content writer|маркетолог|рекрутер|бухгалтер/i],
  ["eng", /engineer|developer|programmer|разработчик|программист/i],
];

export function familyOf(title: string): Family | null {
  for (const [f, rx] of FAMILIES) if (rx.test(title)) return f;
  return null;
}

/** Что человеку тоже подходит, кроме его основной роли (соседние роли из PoC: solutions/integration для backend и т.п.). */
const ADJACENT: Partial<Record<Family, Family[]>> = {
  backend: ["fullstack", "solutions", "eng"],
  fullstack: ["backend", "frontend", "eng"],
  frontend: ["fullstack", "eng"],
  mobile: ["eng"],
  devops: ["eng"],
  data: ["eng"],
  ml: ["data", "eng"],
  qa: ["eng"],
  solutions: ["backend"],
  pm: ["project"],
  project: ["pm"],
  eng_manager: ["backend", "fullstack"],
};

export function userFamilies(p: Profile): Set<Family> {
  const out = new Set<Family>();
  for (const r of [...p.target_roles, p.headline ?? ""]) {
    const f = familyOf(r);
    if (f) out.add(f);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Стек

const ALIASES: Record<string, string[]> = {
  javascript: ["javascript", "js"],
  typescript: ["typescript", "ts"],
  "node.js": ["node.js", "nodejs", "node"],
  postgresql: ["postgresql", "postgres"],
  kubernetes: ["kubernetes", "k8s"],
  go: ["golang", "go"],
  "c#": ["c#", ".net", "dotnet"],
  ".net": [".net", "dotnet", "c#"],
  "react": ["react", "react.js", "reactjs"],
  "vue": ["vue", "vue.js", "vuejs"],
  "amazon web services": ["aws"],
  aws: ["aws", "amazon web services"],
  gcp: ["gcp", "google cloud"],
};
/** Короткие названия, которые в тексте часто значат другое («go to market», «R&D»): ищем только в явном виде. */
const AMBIGUOUS = new Set(["go", "r", "c", "js", "ts", "node", "rust", "swift", "dart", "ai", "ml"]);

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordRx = (w: string) => new RegExp(`(?<![\\w+#.])${esc(w)}(?![\\w+#]|\\.[a-z])`, "i");

function skillVariants(skill: string): string[] {
  const s = skill.toLowerCase().trim();
  return [...new Set([s, ...(ALIASES[s] ?? [])])];
}

function mentions(text: string, skill: string): boolean {
  return skillVariants(skill).some((v) => {
    if (!v) return false;
    if (AMBIGUOUS.has(v)) {
      if (v === "go") return /\bgolang\b|\bgo (developer|engineer|backend)\b|\(go\)|\bgo\/|\/go\b/i.test(text);
      // «R», «C», «AI» в тексте почти всегда не про стек; JS/TS и слова от 4 букв — по границам слова.
      return v.length >= 4 || v === "js" || v === "ts" ? wordRx(v).test(text) : false;
    }
    return wordRx(v).test(text);
  });
}

/** Языки, по которым роли не взаимозаменяемы: «Java Developer» не для того, у кого в стеке только Python. */
const LANGUAGES: [string, RegExp][] = [
  ["Python", /\bpython\b|django|fastapi|flask/i],
  ["Java", /\bjava\b(?!script)|spring\b|\bjvm\b/i],
  ["Kotlin", /\bkotlin\b/i],
  ["Scala", /\bscala\b/i],
  ["Go", /\bgolang\b|\bgo (developer|engineer)\b|\(go\)/i],
  ["Rust", /\brust\b/i],
  ["Ruby", /\bruby\b|\brails\b/i],
  ["PHP", /\bphp\b|laravel|symfony/i],
  [".NET", /\.net\b|\bc#|dotnet/i],
  ["C++", /c\+\+/i],
  ["Node.js", /\bnode(\.js|js)?\b/i],
  ["Elixir", /\belixir\b/i],
  ["Swift", /\bswift\b/i],
];

function userLanguages(p: Profile): Set<string> {
  const blob = [...p.skills, ...p.target_roles, p.headline ?? ""].join(" | ");
  const out = new Set<string>();
  for (const [name, rx] of LANGUAGES) if (rx.test(blob)) out.add(name);
  // JS/TS-разработчик спокойно идёт на Node.js
  if (/javascript|typescript|\bjs\b|\bts\b/i.test(blob)) out.add("Node.js");
  return out;
}

// ---------------------------------------------------------------------------
// Грейд

const LEVELS = ["intern", "junior", "middle", "senior", "lead"] as const;
type Level = (typeof LEVELS)[number];

function vacancyLevel(title: string): Level | null {
  if (/\bintern(ship)?\b|trainee|стаж[её]р|стажировка/i.test(title)) return "intern";
  if (/\bjunior\b|\bjr\.?\b|младший|джун/i.test(title)) return "junior";
  if (/\b(lead|principal|staff|head|director|architect)\b|тимлид|ведущий/i.test(title)) return "lead";
  if (/\bsenior\b|\bsr\.?\b|старший|сеньор/i.test(title)) return "senior";
  if (/\bmiddle\b|\bmid(-level)?\b|мидл/i.test(title)) return "middle";
  return null;
}

function userLevel(p: Profile): Level | null {
  if (p.seniority) return p.seniority;
  if (p.years_experience === null) return null;
  return p.years_experience >= 7 ? "senior" : p.years_experience >= 3 ? "middle" : "junior";
}

// ---------------------------------------------------------------------------
// Локация

const COUNTRY_ALIASES: Record<string, string[]> = {
  cyprus: ["cyprus", "кипр", "limassol", "лимассол", "nicosia", "larnaca", "paphos"],
  russia: ["russia", "россия", "рф", "moscow", "москва"],
  "united states": ["united states", "usa", "u.s.", " us "],
  germany: ["germany", "deutschland", "германия", "berlin", "munich"],
  spain: ["spain", "испания", "madrid", "barcelona"],
  serbia: ["serbia", "сербия", "belgrade", "белград"],
  georgia: ["georgia", "грузия", "tbilisi", "тбилиси"],
  armenia: ["armenia", "армения", "yerevan", "ереван"],
  portugal: ["portugal", "португалия", "lisbon", "лиссабон"],
  poland: ["poland", "польша", "warsaw", "варшава"],
  netherlands: ["netherlands", "нидерланды", "amsterdam"],
  "united kingdom": ["united kingdom", "uk", "england", "london", "великобритания", "лондон"],
};
const EU_COUNTRIES = /cyprus|germany|spain|portugal|poland|netherlands|france|italy|greece|austria|belgium|ireland|czech|estonia|latvia|lithuania|finland|sweden|denmark|bulgaria|romania|croatia|slovenia|slovakia|hungary|malta|luxembourg|кипр|германия|испания|португалия|польша/i;

/** Ключевые слова локации человека: город, страна и её синонимы. */
function userPlaces(p: Profile): string[] {
  const loc = norm(p.location);
  if (!loc) return [];
  const out = new Set(loc.split(" ").filter((w) => w.length > 2));
  for (const [country, names] of Object.entries(COUNTRY_ALIASES)) {
    if (names.some((n) => ` ${loc} `.includes(` ${norm(n)} `))) for (const n of [country, ...names]) out.add(norm(n));
  }
  return [...out];
}

// ---------------------------------------------------------------------------

/** Пересечение значимых слов заголовка и целевой роли (0..1). */
function roleOverlap(title: string, role: string): number {
  const stop = new Set(["senior", "junior", "middle", "lead", "remote", "and", "the", "of", "for", "with", "sr", "jr", "staff", "principal"]);
  const words = (s: string) => new Set(norm(s).split(" ").filter((w) => w.length > 1 && !stop.has(w)));
  const a = words(title);
  const b = words(role);
  if (!b.size) return 0;
  let hit = 0;
  for (const w of b) if (a.has(w)) hit++;
  return hit / b.size;
}

export function scoreVacancy(v: VacancyForScore, p: Profile, nowTs = Math.floor(Date.now() / 1000)): ScoreResult {
  const title = v.title;
  const titleN = ` ${norm(title)} `;
  const text = `${title}\n${v.description}`;
  const reasons: string[] = [];

  // 1. «Чего не хочу» из анкеты — по заголовку и компании.
  for (const a of p.avoid) {
    const n = norm(a);
    if (n.length > 1 && (titleN.includes(` ${n} `) || norm(v.company) === n)) return { skip: `не хочу: ${a}` };
  }

  // 2. Роль.
  const fam = familyOf(title);
  const mine = userFamilies(p);
  if (!mine.size) return { skip: "в анкете нет целевых ролей" };
  let roleScore = 0;
  const allowed = new Set<Family>(mine);
  for (const f of mine) for (const adj of ADJACENT[f] ?? []) allowed.add(adj);
  if (fam && !allowed.has(fam)) return { skip: `роль: ${fam}` };
  if (!fam) roleScore = 5;
  else if (mine.has(fam)) roleScore = 25;
  else if (fam === "eng") roleScore = 12;
  else roleScore = 15; // соседняя роль
  const best = p.target_roles.reduce(
    (acc, r) => {
      const o = roleOverlap(title, r);
      return o > acc.o ? { o, r } : acc;
    },
    { o: 0, r: "" },
  );
  roleScore += Math.round(best.o * 15);
  if (best.o >= 0.5) reasons.push(`роль: ${best.r}`);
  else if (fam && mine.has(fam)) reasons.push("ваша роль");
  else if (fam && fam !== "eng") reasons.push("соседняя роль");

  // 3. Стек: язык из заголовка, которого у человека нет, — мимо (Java Developer для питониста). Если в заголовке
  //    есть хоть один его язык («Python/Go Engineer»), не отсекаем.
  const langs = userLanguages(p);
  const titleLangs = LANGUAGES.filter(([, rx]) => rx.test(title)).map(([n]) => n);
  if (langs.size && titleLangs.length && !titleLangs.some((l) => langs.has(l))) return { skip: `стек: ${titleLangs.join("/")}` };

  let skillScore = 0;
  const inTitle: string[] = [];
  const inText: string[] = [];
  for (const s of p.skills.slice(0, 30)) {
    if (mentions(title, s)) inTitle.push(s);
    else if (mentions(v.description, s)) inText.push(s);
  }
  skillScore += Math.min(20, inTitle.length * 10) + Math.min(15, inText.length * 3);
  const shown = [...inTitle, ...inText].slice(0, 4);
  if (shown.length) reasons.push(`стек: ${shown.join(", ")}`);
  // Совсем ничего из стека в инженерной вакансии — слабый сигнал (описание может быть пустым, поэтому не отсекаем).
  if (!inTitle.length && !inText.length && v.description.length > 300 && fam && !["pm", "project", "design"].includes(fam)) skillScore -= 5;

  // 4. Грейд: выше на ступень — нормально (stretch), сильно выше — минус; ниже — минус; стажировка для опытного — мимо.
  let levelScore = 0;
  const vl = vacancyLevel(title);
  const ul = userLevel(p);
  if (vl && ul) {
    const d = LEVELS.indexOf(vl) - LEVELS.indexOf(ul);
    if (vl === "intern" && LEVELS.indexOf(ul) >= LEVELS.indexOf("middle")) return { skip: "стажировка" };
    levelScore = d === 0 ? 5 : d === 1 ? 2 : d >= 2 ? -8 : -6;
  }

  // 5. Где работать.
  const places = userPlaces(p);
  const locN = ` ${norm(v.location)} `;
  const local = places.some((pl) => locN.includes(` ${norm(pl)} `)) || (places.includes("cyprus") && hasFlag(v.flags, "CY"));
  const remote = hasFlag(v.flags, "REMOTE") || REMOTE_RX.test(v.location);
  const userInUs = places.includes("united states");
  const wantsRemoteOnly = p.work_formats.length > 0 && p.work_formats.every((f) => f === "remote");
  const onlyOffice = p.work_formats.length > 0 && !p.work_formats.includes("remote");
  let placeScore = 0;
  if (hasFlag(v.flags, "US_ONLY") && !userInUs && !local) return { skip: "только для США" };
  if (!remote && !local && v.location && !/see (jd|post)/i.test(v.location)) {
    if (p.relocation !== true) return { skip: `офис: ${v.location.slice(0, 40)}` };
    placeScore -= 5;
    reasons.push("с переездом");
  } else if (local) {
    if (wantsRemoteOnly && !remote) placeScore -= 3;
    else placeScore += 10;
    reasons.push(remote ? "удалённо, ваша страна" : "в вашем городе/стране");
  } else if (remote) {
    if (onlyOffice) placeScore -= 5;
    const world = hasFlag(v.flags, "WORLD");
    const euOk = world || (EU_COUNTRIES.test(p.location ?? "") && /europe|\beu\b|emea|cet|eet/i.test(v.location));
    placeScore += euOk ? 10 : 6;
    reasons.push(world ? "удалённо, по миру" : "удалённо");
  }

  // 6. Тип занятости: контракт/B2B — плюс тем, кто его хочет; не повод отсекать остальных.
  let empScore = 0;
  if (hasFlag(v.flags, "CONTRACT") && p.employment_types.includes("contract")) {
    empScore += 5;
    reasons.push("контракт/B2B");
  }
  if (/part[- ]?time|частичн|подработ/i.test(text) && p.employment_types.includes("part_time")) {
    empScore += 5;
    reasons.push("частичная занятость");
  }

  // 7. Свежесть.
  const age = v.posted_at ? (nowTs - v.posted_at) / 86400 : null;
  const freshScore = age !== null && age <= 3 ? 5 : age !== null && age > 21 ? -5 : 0;

  const score = Math.max(0, Math.min(100, roleScore + skillScore + levelScore + placeScore + empScore + freshScore));
  return { score, reasons };
}
