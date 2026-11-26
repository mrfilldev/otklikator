/**
 * Источники вакансий без браузера — порт resume/scripts/us_feeds.py и adjacent_feeds.py на Workers.
 * В PoC фиды сразу отсекали всё, кроме Python/backend (под одного человека). Здесь пользователей много и стек у всех свой,
 * поэтому тянем широко (разработка, продукт, проекты), а отбор под человека делает score.ts по его анкете.
 * LinkedIn guest API из PoC не переносим: с IP Cloudflare он быстро отвечает 429, а скрейпинг LinkedIn против их правил.
 */
import { ATS_BOARDS, TG_CHANNELS, type AtsBoard } from "./boards";
import { cleanHtml, toUnix, vacancyFlags } from "./text";

export interface RawVacancy {
  id: string; // "<src>:<id>"
  source: string;
  title: string;
  company: string;
  location: string;
  url: string;
  description: string;
  flags: string;
  posted_at: number | null;
}

/** Достаёт текст по URL. В проде — fetch, в тестах — фикстуры. */
export type Fetcher = (url: string) => Promise<string>;

export interface FeedTask {
  key: string;
  /** Как часто опрашивать, в часах. Как в рутинах resume: ~5 раз в сутки, ATS-доски — 4, HN — раз в сутки. */
  everyHours: number;
  run: (get: Fetcher, since: number) => Promise<RawVacancy[]>;
}

const DESC_MAX = 4000;

function card(
  src: string,
  extId: string | number,
  title: string,
  company: string,
  location: string,
  url: string,
  text: string,
  posted: number | null,
  opts: { remote?: boolean } = {},
): RawVacancy | null {
  const t = cleanHtml(title).slice(0, 200);
  if (!t || !url) return null;
  const desc = text.slice(0, DESC_MAX);
  return {
    id: `${src}:${String(extId).slice(0, 80)}`,
    source: src,
    title: t,
    company: cleanHtml(company).slice(0, 120) || "—",
    location: cleanHtml(location).slice(0, 160),
    url,
    description: desc,
    flags: vacancyFlags(location, desc, opts),
    posted_at: posted,
  };
}

const fresh = (posted: number | null, since: number) => posted === null || posted >= since;
const keep = <T>(xs: (T | null)[]) => xs.filter((x): x is T => x !== null);
const json = async <T = any>(get: Fetcher, url: string): Promise<T> => JSON.parse(await get(url)) as T;

// ---------------------------------------------------------------------------
// Агрегаторы удалёнки

const AGGREGATOR_HOURS = 5;

const remoteok: FeedTask = {
  key: "remoteok",
  everyHours: AGGREGATOR_HOURS,
  async run(get, since) {
    const data = await json<any[]>(get, "https://remoteok.com/api");
    return keep(
      data
        .filter((j) => j && j.id && j.position)
        .map((j) => {
          const posted = toUnix(j.epoch ?? j.date);
          if (!fresh(posted, since)) return null;
          const tags = (j.tags ?? []).join(", ");
          return card("rok", j.id, j.position, j.company ?? "", j.location || "Remote", j.url ?? `https://remoteok.com/remote-jobs/${j.id}`, `${tags}. ${cleanHtml(j.description)}`, posted, { remote: true });
        }),
    );
  },
};

/** RSS без DOMParser (в Workers его нет): достаточно простых регулярок для <item>. */
export function parseRss(xml: string): Record<string, string>[] {
  const items: Record<string, string>[] = [];
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const it: Record<string, string> = {};
    for (const f of m[1].matchAll(/<([a-zA-Z:_-]+)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
      it[f[1].toLowerCase()] = f[2].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").trim();
    }
    items.push(it);
  }
  return items;
}

/** Один общий RSS вместо запроса на каждый раздел: меньше запросов к сайту, лишнее отсечёт скоринг. */
const wwr: FeedTask = {
  key: "wwr",
  everyHours: AGGREGATOR_HOURS,
  async run(get, since) {
    const items = parseRss(await get("https://weworkremotely.com/remote-jobs.rss"));
    return keep(
      items.map((it) => {
        const posted = toUnix(it.pubdate);
        if (!fresh(posted, since)) return null;
        const full = cleanHtml(it.title);
        const i = full.indexOf(": ");
        const [co, role] = i > 0 ? [full.slice(0, i), full.slice(i + 2)] : ["", full];
        const guid = (it.guid || it.link || full).replace(/\W+/g, "-").slice(-60);
        return card("wwr", guid, role, co, it.region || it.country || "Remote", cleanHtml(it.link), cleanHtml(it.description), posted, { remote: true });
      }),
    );
  },
};

const HIMALAYAS_QUERIES = ["software engineer", "developer", "product manager"];
const himalayas: FeedTask[] = HIMALAYAS_QUERIES.map((q) => ({
  key: `himalayas:${q}`,
  everyHours: AGGREGATOR_HOURS,
  async run(get, since) {
    const data = await json(get, `https://himalayas.app/jobs/api?limit=50&q=${encodeURIComponent(q)}`);
    return keep(
      (data.jobs ?? []).map((j: any) => {
        const posted = toUnix(j.pubDate);
        if (!fresh(posted, since)) return null;
        const loc = (j.locationRestrictions ?? []).join(", ") || "Worldwide";
        const emp = j.employmentType ? `${j.employmentType}. ` : "";
        const id = String(j.guid ?? j.applicationLink ?? "").split("/").pop()?.slice(0, 60) || j.title;
        return card("him", id, j.title, j.companyName ?? "", loc, j.applicationLink ?? j.guid ?? "", emp + cleanHtml(j.description), posted, { remote: true });
      }),
    );
  },
}));

/** Один запрос на всю ленту Remotive (они просят не дёргать API часто). */
const remotive: FeedTask = {
  key: "remotive",
  everyHours: AGGREGATOR_HOURS,
  async run(get, since) {
    const data = await json(get, "https://remotive.com/api/remote-jobs?limit=500");
    return keep(
      (data.jobs ?? []).map((j: any) => {
        const posted = toUnix(j.publication_date);
        if (!fresh(posted, since)) return null;
        const emp = j.job_type ? `${j.job_type}. ` : "";
        return card("rem", j.id, j.title, j.company_name ?? "", j.candidate_required_location || "Worldwide", j.url, emp + cleanHtml(j.description), posted, { remote: true });
      }),
    );
  },
};

const JOBICY_QUERIES = ["industry=dev", "tag=product%20manager"];
const jobicy: FeedTask[] = JOBICY_QUERIES.map((q) => ({
  key: `jobicy:${decodeURIComponent(q)}`,
  everyHours: AGGREGATOR_HOURS,
  async run(get, since) {
    const data = await json(get, `https://jobicy.com/api/v2/remote-jobs?count=100&${q}`);
    return keep(
      (data.jobs ?? []).map((j: any) => {
        const posted = toUnix(j.pubDate);
        if (!fresh(posted, since)) return null;
        const emp = Array.isArray(j.jobType) ? `${j.jobType.join(", ")}. ` : "";
        return card("jbc", j.id, j.jobTitle, j.companyName ?? "", j.jobGeo || "Anywhere", j.url, emp + cleanHtml(j.jobDescription ?? j.jobExcerpt), posted, { remote: true });
      }),
    );
  },
}));

/** HN «Who is hiring» и «Seeking freelancer»: только удалёнка. */
function hnThread(kind: "hiring" | "freelance"): FeedTask {
  return {
    key: `hn:${kind}`,
    everyHours: 24,
    async run(get, since) {
      const stories = await json(get, "https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10");
      const needle = kind === "hiring" ? "who is hiring" : "seeking freelancer";
      const st = (stories.hits ?? []).find((h: any) => String(h.title).toLowerCase().includes(needle) && !String(h.title).toLowerCase().includes("wants"));
      if (!st) return [];
      const comments = await json(get, `https://hn.algolia.com/api/v1/search_by_date?tags=comment,story_${st.objectID}&hitsPerPage=300`);
      const minTs = kind === "freelance" ? Math.min(since, Math.floor(Date.now() / 1000) - 35 * 86400) : since;
      return keep(
        (comments.hits ?? []).map((c: any) => {
          if ((c.created_at_i ?? 0) < minTs || c.parent_id !== Number(st.objectID)) return null;
          const txt = cleanHtml(c.comment_text);
          if (!/remote/i.test(txt)) return null;
          if (kind === "freelance" && !/^\s*seeking freelancer/i.test(txt)) return null;
          const head = txt.replace(/^\s*seeking freelancer\W*/i, "").slice(0, 160);
          const parts = head.split("|").map((s) => s.trim());
          const title = parts.find((p, i) => i > 0 && /engineer|developer|manager|designer|lead|architect|scientist|analyst/i.test(p)) ?? head;
          const flagsText = kind === "freelance" ? `freelance contract. ${txt}` : txt;
          return card(kind === "hiring" ? "hn" : "hnf", c.objectID, title, parts[0] ?? "", parts.find((p) => /remote/i.test(p)) ?? "Remote", `https://news.ycombinator.com/item?id=${c.objectID}`, flagsText, c.created_at_i ?? null);
        }),
      );
    },
  };
}

/** Публичное превью канала t.me/s/<канал>. Первая строка поста — заголовок, компанию обычно не разобрать. */
function telegram(channel: string): FeedTask {
  return {
    key: `tg:${channel}`,
    everyHours: AGGREGATOR_HOURS,
    async run(get, since) {
      const page = await get(`https://t.me/s/${channel}`);
      return keep(
        page
          .split("tgme_widget_message_wrap")
          .slice(1)
          .map((m) => {
            const post = /data-post="([^"]+)"/.exec(m)?.[1];
            const tm = /datetime="([^"]+)"/.exec(m)?.[1];
            const raw = /tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/.exec(m)?.[1];
            if (!post || !tm || !raw) return null;
            const posted = toUnix(tm);
            if (!fresh(posted, since)) return null;
            const firstLine = cleanHtml(raw.split(/<br\s*\/?>/i)[0]).replace(/^[^\p{L}\p{N}]+/u, "");
            const text = cleanHtml(raw);
            if (/REMOTE RUSSIA|REMOTE BELARUS|REMOTE KZ/.test(text)) return null;
            // Шаблон @opento_dev: "Company name: X Title: Y Grades: …"
            const mm = /Company name\s*:\s*(.*?)\s+Title\s*:\s*(.*?)\s+Grades/.exec(text);
            const title = mm ? mm[2] : firstLine || text.slice(0, 90);
            const company = mm ? mm[1] : /(?:компания|company)\s*[:—-]\s*([^\n.,|]{2,60})/i.exec(text)?.[1] ?? `@${channel}`;
            const links = [...raw.matchAll(/href="(https?:\/\/[^"]+)"/g)].map((x) => x[1]).filter((l) => !l.includes("t.me"));
            const remote = REMOTE_IN_TEXT.test(text);
            return card("tg", post.replace("/", "-"), title.slice(0, 120), company, remote ? "Remote (see post)" : "see post", links[0] ?? `https://t.me/${post}`, text, posted, { remote });
          }),
      );
    },
  };
}
const REMOTE_IN_TEXT = /remote|worldwide|anywhere|удал[её]нн|удалёнка|удаленка/i;

// ---------------------------------------------------------------------------
// ATS-доски компаний

const ATS_SRC: Record<AtsBoard["kind"], string> = {
  greenhouse: "gh",
  greenhouse_eu: "gh",
  lever: "lv",
  lever_eu: "lv",
  ashby: "ash",
  workable: "wk",
  recruitee: "rc",
  smartrecruiters: "sr",
};

export async function fetchAts(get: Fetcher, board: AtsBoard, since: number): Promise<RawVacancy[]> {
  const { kind, slug, company } = board;
  const src = ATS_SRC[kind];
  const mk = (id: string | number, title: string, loc: string, url: string, text: string, posted: number | null, remote = false) =>
    fresh(posted, since) ? card(src, `${slug}-${id}`, title, company, loc, url, text, posted, { remote }) : null;

  switch (kind) {
    case "greenhouse":
    case "greenhouse_eu": {
      const host = kind === "greenhouse_eu" ? "boards-api.eu.greenhouse.io" : "boards-api.greenhouse.io";
      const data = await json(get, `https://${host}/v1/boards/${slug}/jobs?content=true`);
      return keep((data.jobs ?? []).map((j: any) => mk(j.id, j.title, j.location?.name ?? "", j.absolute_url, cleanHtml(j.content), toUnix(j.updated_at ?? j.first_published))));
    }
    case "lever":
    case "lever_eu": {
      const host = kind === "lever_eu" ? "api.eu.lever.co" : "api.lever.co";
      const data = await json<any[]>(get, `https://${host}/v0/postings/${slug}?mode=json`);
      return keep(
        data.map((j) =>
          mk(j.id, j.text, [j.categories?.location, j.workplaceType === "remote" ? "Remote" : ""].filter(Boolean).join(", "), j.hostedUrl,
            [j.categories?.commitment, j.descriptionPlain ?? cleanHtml(j.description)].filter(Boolean).join(". "), toUnix(j.createdAt), j.workplaceType === "remote"),
        ),
      );
    }
    case "ashby": {
      const data = await json(get, `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=false`);
      return keep(
        (data.jobs ?? []).map((j: any) =>
          mk(j.id, j.title, [j.location, j.isRemote ? "Remote" : ""].filter(Boolean).join(", "), j.jobUrl,
            [j.employmentType, j.descriptionPlain ?? cleanHtml(j.descriptionHtml)].filter(Boolean).join(". "), toUnix(j.publishedAt), Boolean(j.isRemote)),
        ),
      );
    }
    case "workable": {
      const data = await json(get, `https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`);
      return keep(
        (data.jobs ?? []).map((j: any) =>
          mk(j.shortcode, j.title, [j.city, j.country, j.telecommuting ? "Remote" : ""].filter(Boolean).join(", "), j.url ?? j.shortlink,
            [j.employment_type, cleanHtml(j.description)].filter(Boolean).join(". "), toUnix(j.published_on ?? j.created_at), Boolean(j.telecommuting)),
        ),
      );
    }
    case "recruitee": {
      const data = await json(get, `https://${slug}.recruitee.com/api/offers/`);
      return keep(
        (data.offers ?? []).map((j: any) =>
          mk(j.id, j.title, [j.city, j.country, j.remote ? "Remote" : ""].filter(Boolean).join(", "), j.careers_url ?? j.careers_apply_url,
            [j.employment_type_code, cleanHtml(j.description)].filter(Boolean).join(". "), toUnix(j.published_at ?? j.created_at), Boolean(j.remote)),
        ),
      );
    }
    case "smartrecruiters": {
      const data = await json(get, `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100`);
      return keep(
        (data.content ?? []).map((j: any) => {
          const loc = j.location ?? {};
          return mk(j.id, j.name, [loc.city, loc.country?.toUpperCase?.(), loc.remote ? "Remote" : ""].filter(Boolean).join(", "),
            `https://jobs.smartrecruiters.com/${slug}/${j.id}`, [j.typeOfEmployment?.label, j.experienceLevel?.label].filter(Boolean).join(". "),
            toUnix(j.releasedDate), Boolean(loc.remote));
        }),
      );
    }
  }
}

const atsTasks: FeedTask[] = ATS_BOARDS.map((board) => ({
  key: `${board.kind}:${board.slug}`,
  everyHours: 6,
  run: (get, since) => fetchAts(get, board, since),
}));

/** Все источники по кругу. Порядок стабильный: курсор в feed_state указывает, с какого продолжить. */
export const FEED_TASKS: FeedTask[] = [
  remoteok,
  wwr,
  remotive,
  ...himalayas,
  ...jobicy,
  hnThread("hiring"),
  hnThread("freelance"),
  ...TG_CHANNELS.map(telegram),
  ...atsTasks,
];

/** Ответ не 2xx. 429/403 — сайт просит отстать: источник уходит на паузу (см. pipeline.ts). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter: string | null = null,
  ) {
    super(`HTTP ${status}`);
  }
}

export const USER_AGENT = "Mozilla/5.0 (compatible; OtklikatorBot/1.0; +https://otklikator.app)";

export const httpFetcher: Fetcher = async (url) => {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json, application/rss+xml, text/html;q=0.9, */*;q=0.5" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new HttpError(res.status, res.headers.get("retry-after"));
  return res.text();
};
