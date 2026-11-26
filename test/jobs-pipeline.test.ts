import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { emptyProfile, saveProfile, type Profile } from "../src/lib/profile";
import { collect, listMatches, matchUsers, saveVacancies } from "../src/lib/jobs/pipeline";
import { FEED_TASKS, fetchAts, parseRss, type FeedTask, type Fetcher, type RawVacancy } from "../src/lib/jobs/sources";
import { BASE, signIn } from "./helpers";

const NOW = Math.floor(Date.now() / 1000);
const iso = (ts: number) => new Date(ts * 1000).toISOString();

/** Фикстуры в форме настоящих ответов источников (поля как читает PoC resume/scripts/us_feeds.py). */
const FIXTURES: Record<string, string> = {
  "https://remoteok.com/api": JSON.stringify([
    { legal: "notice" },
    { id: "101", epoch: NOW - 3600, position: "Senior Python Engineer", company: "Acme Inc.", location: "Worldwide", url: "https://remoteok.com/remote-jobs/101", tags: ["python", "django"], description: "&lt;p&gt;Django, PostgreSQL&lt;/p&gt;" },
    { id: "102", epoch: NOW - 60 * 86400, position: "Old Python Job", company: "Old", location: "Worldwide", url: "https://remoteok.com/remote-jobs/102" },
  ]),
  "https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss": `<?xml version="1.0"?><rss><channel>
    <item><title><![CDATA[Globex: Backend Developer (Python)]]></title><region>Anywhere in the World</region>
      <link>https://weworkremotely.com/remote-jobs/globex-backend</link><guid>https://weworkremotely.com/remote-jobs/globex-backend</guid>
      <pubDate>${new Date((NOW - 7200) * 1000).toUTCString()}</pubDate><description><![CDATA[<p>FastAPI &amp; Postgres</p>]]></description></item>
  </channel></rss>`,
  "https://boards-api.greenhouse.io/v1/boards/gitlab/jobs?content=true": JSON.stringify({
    jobs: [
      { id: 7, title: "Senior Backend Engineer, Python", location: { name: "Remote, EMEA" }, absolute_url: "https://job-boards.greenhouse.io/gitlab/jobs/7", updated_at: iso(NOW - 3600), content: "&lt;p&gt;Python and Go&lt;/p&gt;" },
      { id: 8, title: "Account Executive", location: { name: "Remote, EMEA" }, absolute_url: "https://job-boards.greenhouse.io/gitlab/jobs/8", updated_at: iso(NOW - 3600), content: "" },
    ],
  }),
  "https://t.me/s/opento_dev": `<div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="opento_dev/555">
      <div class="tgme_widget_message_text js-message_text">Company name: Initech Title: Python Developer Grades: Middle, Senior<br/>Remote, Europe. B2B contract.
      <a href="https://initech.example/jobs/1">Apply</a></div>
      <time datetime="${iso(NOW - 1800)}"></time></div></div>`,
};

const fixtureFetch: Fetcher = async (url) => {
  const body = FIXTURES[url];
  if (body === undefined) throw new Error(`HTTP 404 ${url}`);
  return body;
};
const task = (key: string) => FEED_TASKS.find((t) => t.key === key)!;

describe("источники", () => {
  it("RemoteOK: свежие вакансии, старше окна — нет", async () => {
    const items = await task("remoteok").run(fixtureFetch, NOW - 14 * 86400);
    expect(items.map((i) => i.id)).toEqual(["rok:101"]);
    expect(items[0]).toMatchObject({ title: "Senior Python Engineer", company: "Acme Inc." });
    expect(items[0].description).toContain("Django, PostgreSQL");
    expect(items[0].flags).toContain("WORLD");
  });

  it("WWR RSS: компания и роль из заголовка", async () => {
    const xml = FIXTURES["https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss"];
    expect(parseRss(xml)[0].title).toBe("Globex: Backend Developer (Python)");
    const [v] = await task("wwr:remote-back-end-programming-jobs").run(fixtureFetch, NOW - 86400);
    expect(v).toMatchObject({ source: "wwr", company: "Globex", title: "Backend Developer (Python)", location: "Anywhere in the World" });
  });

  it("Greenhouse и Telegram", async () => {
    const gh = await fetchAts(fixtureFetch, { kind: "greenhouse", slug: "gitlab", company: "GitLab", region: "intl" }, NOW - 86400);
    expect(gh.map((v) => v.id)).toEqual(["gh:gitlab-7", "gh:gitlab-8"]);
    expect(gh[0].flags).toContain("REMOTE");
    const [tg] = await task("tg:opento_dev").run(fixtureFetch, NOW - 86400);
    expect(tg).toMatchObject({ id: "tg:opento_dev-555", title: "Python Developer", company: "Initech", url: "https://initech.example/jobs/1" });
    expect(tg.flags).toContain("CONTRACT");
  });
});

function raw(id: string, title: string, company: string, extra: Partial<RawVacancy> = {}): RawVacancy {
  return { id, source: id.split(":")[0], title, company, location: "Remote, Worldwide", url: `https://example.com/${id}`, description: "", flags: "REMOTE WORLD", posted_at: NOW - 3600, ...extra };
}

describe("конвейер", () => {
  it("дедуп по id и между источниками", async () => {
    const first = await saveVacancies(env.DB, [raw("rok:1", "Senior Python Engineer", "Acme Inc."), raw("rok:1", "Senior Python Engineer", "Acme Inc.")]);
    expect(first).toBe(1);
    // та же вакансия на другом агрегаторе — не новая
    const again = await saveVacancies(env.DB, [raw("him:x", "Senior Python Engineer (Remote)", "ACME"), raw("rok:2", "Frontend Engineer", "Acme")]);
    expect(again).toBe(1);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM vacancies WHERE company LIKE 'acme%'").first<{ n: number }>();
    expect(n?.n).toBe(2);
  });

  it("обходит источники по кругу и пишет журнал с ошибками", async () => {
    const tasks: FeedTask[] = ["a", "b", "c"].map((k) => ({
      key: `t:${k}`,
      run: async () => {
        if (k === "b") throw new Error("HTTP 500");
        return [raw(`t:${k}`, `Python Developer ${k}`, `Co ${k}`)];
      },
    }));
    const r1 = await collect(env.DB, { tasks, perRun: 2, get: fixtureFetch });
    expect(r1.tasks.map((t) => t.task)).toEqual(["t:a", "t:b"]);
    expect(r1.tasks[1].error).toBe("HTTP 500");
    const r2 = await collect(env.DB, { tasks, perRun: 2, get: fixtureFetch });
    expect(r2.tasks.map((t) => t.task)).toEqual(["t:c", "t:a"]);
    const log = await env.DB.prepare("SELECT COUNT(*) AS n FROM feed_runs WHERE error IS NOT NULL").first<{ n: number }>();
    expect(log?.n).toBe(1);
  });

  it("подбирает по анкете, пересчитывает при правке, показывает на странице", async () => {
    const { cookie, userId } = await signIn("match@example.com");
    const profile: Profile = {
      ...emptyProfile(),
      target_roles: ["Backend Engineer", "Python Developer"],
      seniority: "senior",
      skills: ["Python", "Django"],
      location: "Limassol, Cyprus",
    };
    await saveProfile(env.DB, userId, profile, "user", null);
    await saveVacancies(env.DB, [
      raw("m:1", "Senior Python Developer", "Pyco", { description: "Django" }),
      raw("m:2", "Java Developer", "Javaco"),
      raw("m:3", "DevOps Engineer", "Opsco"),
    ]);

    const r = await matchUsers(env.DB);
    expect(r.matched).toBeGreaterThanOrEqual(1);
    let mine = await listMatches(env.DB, userId);
    expect(mine.map((m) => m.company)).toContain("Pyco");
    expect(mine.map((m) => m.company)).not.toContain("Javaco");
    expect(mine.map((m) => m.company)).not.toContain("Opsco");

    // повторный запуск без новых вакансий ничего не дублирует
    const again = await matchUsers(env.DB);
    expect(again.scored).toBe(0);

    // человек поменял анкету на Java — подбор пересчитан
    await new Promise((res) => setTimeout(res, 1100));
    await saveProfile(env.DB, userId, { ...profile, target_roles: ["Java Developer"], skills: ["Java"] }, "user", null);
    await matchUsers(env.DB);
    mine = await listMatches(env.DB, userId);
    expect(mine.map((m) => m.company)).toContain("Javaco");
    expect(mine.map((m) => m.company)).not.toContain("Pyco");

    const page = await SELF.fetch(`${BASE}/app/matches`, { headers: { cookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Java Developer");

    const seq = mine.find((m) => m.company === "Javaco")!.seq;
    const hide = await SELF.fetch(`${BASE}/app/matches/${seq}/hide`, { method: "POST", headers: { cookie }, redirect: "manual" });
    expect(hide.status).toBe(303);
    expect((await listMatches(env.DB, userId)).map((m) => m.company)).not.toContain("Javaco");

    const dash = await SELF.fetch(`${BASE}/app`, { headers: { cookie } });
    expect(await dash.text()).toContain("Подходящие вакансии");
  });
});
