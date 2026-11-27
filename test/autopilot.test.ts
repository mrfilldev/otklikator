import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REVIEW_WINDOW_HOURS, localHour, reportMail, runAutopilot, saveSettings, senderLocal } from "../src/lib/autopilot";
import { saveVacancies } from "../src/lib/jobs/pipeline";
import { emptyProfile, saveProfile, type Profile } from "../src/lib/profile";
import type { Env } from "../src/env";
import { BASE, signIn } from "./helpers";

// 27 ноября 2026, 08:00 по Кипру (UTC+2) — после часа отбора.
const T0 = Date.UTC(2026, 10, 27, 6, 0) / 1000;
const ENV = { ...env, RESEND_API_KEY: "re_test", APPLY_FROM_DOMAIN: "apply.test" } as unknown as Env;

const profile: Profile = {
  ...emptyProfile(),
  full_name: "Anna Petrova",
  headline: "Backend engineer (Python)",
  experience: [{ company: "Moidex", title: "Backend lead", period: "2022 – 2026", highlights: ["Cut API latency by 40%"] }],
  contacts: { ...emptyProfile().contacts, email: "anna.personal@example.com" },
};

let n = 0;
/** Пользователь с подпиской, анкетой, CV и совпадениями; каждое — [компания, балл, есть ли адрес в тексте]. */
async function setup(email: string, matches: [string, number, boolean][], settings: { review_window?: boolean } = {}) {
  const { cookie, userId } = await signIn(email);
  await saveProfile(env.DB, userId, profile, "user", null);
  await env.DB.prepare("INSERT INTO subscriptions (id, user_id, status, updated_at) VALUES (?, ?, 'active', ?)").bind(`sub_${email}`, userId, T0).run();
  await env.CV_BUCKET.put(`cv/${userId}/1`, new TextEncoder().encode("%PDF-1.4 fake cv"));
  await env.DB.prepare("INSERT INTO resumes (id, user_id, r2_key, filename, content_type, size, text, created_at) VALUES (?, ?, ?, 'anna.pdf', 'application/pdf', 16, '', ?)")
    .bind(`r_${email}`, userId, `cv/${userId}/1`, T0)
    .run();
  const seqs: number[] = [];
  for (const [company, score, hasEmail] of matches) {
    const id = `rok:ap${++n}`;
    const description = `We build payments infra.${hasEmail ? ` Send your CV to jobs@${company.toLowerCase()}.io` : " Apply via the form."}`;
    await saveVacancies(env.DB, [{ id, source: "rok", title: `Python Engineer ${n}`, company, location: "Remote", url: `https://x.io/${n}`, description, flags: "REMOTE", posted_at: T0 }], T0);
    const { seq } = (await env.DB.prepare("SELECT seq FROM vacancies WHERE id = ?").bind(id).first<{ seq: number }>())!;
    await env.DB.prepare("INSERT INTO matches (user_id, vacancy_seq, score, reasons, status, created_at) VALUES (?, ?, ?, '[]', 'new', ?)").bind(userId, seq, score, T0).run();
    seqs.push(seq);
  }
  await saveSettings(env.DB, userId, { enabled: true, review_window: settings.review_window ?? true, daily_limit: 10, min_score: 60 }, T0);
  return { cookie, userId, seqs };
}

/** OpenRouter пишет письмо, Resend принимает (или отвечает resendStatus). */
function mockApis(resendStatus = 200) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://openrouter.ai/")) {
      const content = JSON.stringify({ subject: "Python Engineer — Anna", body: "Payments infra caught my eye. At Moidex I cut API latency by 40%. Open to a call?" });
      return Response.json({ choices: [{ finish_reason: "stop", message: { content } }] });
    }
    if (url === "https://api.resend.com/emails") {
      return resendStatus === 200 ? Response.json({ id: `msg_${Math.random()}` }) : new Response("boom", { status: resendStatus });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}
const resendCalls = (spy: ReturnType<typeof mockApis>) =>
  spy.mock.calls.filter((c) => String(c[0]) === "https://api.resend.com/emails").map((c) => JSON.parse(String((c[1] as RequestInit).body)));
const appRows = (userId: string) =>
  env.DB.prepare("SELECT vacancy_seq, status, scheduled_at, source, channel, attempts FROM applications WHERE user_id = ? ORDER BY vacancy_seq").bind(userId).all().then((r) => r.results);

afterEach(async () => {
  vi.restoreAllMocks();
  // Тесты делят базу: выключаем чужие автопилоты и очереди, чтобы следующий тест видел только своё.
  await env.DB.batch([env.DB.prepare("UPDATE autopilot SET enabled = 0"), env.DB.prepare("UPDATE applications SET status = 'skipped' WHERE status = 'queued'")]);
});

describe("helpers", () => {
  it("time, sender and report", () => {
    expect(localHour(T0)).toBe(8);
    expect(senderLocal("Anna Petrova")).toBe("anna.petrova");
    expect(senderLocal("José Núñez")).toBe("jose.nunez");
    expect(senderLocal("Анна Петрова")).toBe("applicant");
    expect(reportMail("https://x", "a@b.c", [], [], [], [])).toBeNull();
    const item = { vacancy_seq: 1, title: "Dev", company: "Acme", to_email: "jobs@acme.io", status: "sent", scheduled_at: null };
    expect(reportMail("https://x", "a@b.c", [item, item], [], [], [])!.subject).toContain("2 отклика");
  });
});

describe("autopilot", () => {
  it("picks the best match per company with an address, waits the review window, then sends with CV and Reply-To", async () => {
    const { userId, seqs } = await setup("ap1@example.com", [
      ["Acme", 80, true],
      ["Acme", 75, true], // та же компания — не в этот раз
      ["Globex", 90, false], // нет адреса
      ["Initech", 50, true], // ниже порога
      ["Umbrella", 65, true],
    ]);
    const spy = mockApis();
    const r = await runAutopilot(ENV, T0);
    expect(r).toMatchObject({ planned: 1, queued: 2, sent: 0 });
    const rows = await appRows(userId);
    expect(rows.map((x) => x.vacancy_seq)).toEqual([seqs[0], seqs[4]]);
    expect(rows.every((x) => x.status === "queued" && x.source === "autopilot" && x.scheduled_at === T0 + REVIEW_WINDOW_HOURS * 3600)).toBe(true);

    // Отчёт ушёл человеку, писем работодателям ещё нет.
    let mails = resendCalls(spy);
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toEqual(["ap1@example.com"]);
    expect(mails[0].text).toContain("уйдут в 11:00 по Кипру");

    // Через час: окно не прошло, повторного отбора в тот же день нет.
    expect(await runAutopilot(ENV, T0 + 3600)).toMatchObject({ planned: 0, sent: 0 });

    const r2 = await runAutopilot(ENV, T0 + REVIEW_WINDOW_HOURS * 3600 + 1);
    expect(r2.sent).toBe(2);
    mails = resendCalls(spy).slice(1);
    expect(mails.map((m) => m.to[0]).sort()).toEqual(["jobs@acme.io", "jobs@umbrella.io"]);
    expect(mails[0].from).toBe("Anna Petrova <anna.petrova@apply.test>");
    expect(mails[0].reply_to).toBe("anna.personal@example.com");
    expect(mails[0].attachments[0].filename).toBe("anna.pdf");
    expect(atob(mails[0].attachments[0].content)).toBe("%PDF-1.4 fake cv");
    expect(mails[0].text).toMatch(/^Hi (Acme|Umbrella) team,/);

    const statuses = await env.DB.prepare("SELECT status FROM matches WHERE user_id = ? AND vacancy_seq = ?").bind(userId, seqs[0]).first();
    expect(statuses).toEqual({ status: "applied" });
    expect((await appRows(userId)).every((x) => x.status === "sent" && x.channel === "resend")).toBe(true);

    // На следующий день: отчёт про отправленное вчера; вторая вакансия Acme — всё ещё нет (две недели).
    const r3 = await runAutopilot(ENV, T0 + 86400);
    expect(r3).toMatchObject({ planned: 1, queued: 0 });
    const report = resendCalls(spy).at(-1)!;
    expect(report.to).toEqual(["ap1@example.com"]);
    expect(report.text).toContain("Отправили с прошлого отчёта (2)");
  });

  it("without the review window sends right away; cancel and pause keep letters from going", async () => {
    const a = await setup("ap2@example.com", [["Hooli", 80, true]], { review_window: false });
    const spy = mockApis();
    expect(await runAutopilot(ENV, T0)).toMatchObject({ queued: 1, sent: 1 });
    expect(resendCalls(spy).map((m) => m.to[0])).toEqual(["jobs@hooli.io", "ap2@example.com"]);

    const b = await setup("ap3@example.com", [["Pied", 80, true], ["Aviato", 70, true]]);
    await runAutopilot(ENV, T0);
    // Отмена одного письма через кабинет, пауза для остальных.
    await SELF.fetch(`${BASE}/app/matches/${b.seqs[0]}/cancel?back=autopilot`, { method: "POST", headers: { cookie: b.cookie }, redirect: "manual" });
    await SELF.fetch(`${BASE}/app/autopilot`, { method: "POST", headers: { cookie: b.cookie }, body: new URLSearchParams({ action: "pause" }), redirect: "manual" });
    const r = await runAutopilot(ENV, T0 + 4 * 3600);
    expect(r).toMatchObject({ sent: 0, waiting: 1 });
    expect((await appRows(b.userId)).map((x) => x.status)).toEqual(["draft", "queued"]);
    expect(await (await SELF.fetch(`${BASE}/app/autopilot`, { headers: { cookie: b.cookie } })).text()).toContain("Автопилот выключен");
  });

  it("retries failed sends and gives up after three attempts", async () => {
    const { userId } = await setup("ap4@example.com", [["Massive", 80, true]], { review_window: false });
    mockApis(500);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await runAutopilot(ENV, T0);
    expect((await appRows(userId))[0]).toMatchObject({ status: "queued", attempts: 1 });
    await runAutopilot(ENV, T0 + 1200);
    await runAutopilot(ENV, T0 + 3600 * 2);
    expect((await appRows(userId))[0]).toMatchObject({ status: "failed", attempts: 3 });
  });

  it("manual 'Send' queues a draft for the next cron run; settings are clamped", async () => {
    const { cookie, userId, seqs } = await setup("ap5@example.com", [["Stark", 40, true]]);
    const spy = mockApis();
    const post = (path: string, body?: Record<string, string>) =>
      SELF.fetch(`${BASE}${path}`, { method: "POST", headers: { cookie }, body: body ? new URLSearchParams(body) : undefined, redirect: "manual" });
    await post(`/app/matches/${seqs[0]}/letter`);
    await post(`/app/matches/${seqs[0]}/queue`);
    expect((await appRows(userId))[0]).toMatchObject({ status: "queued", source: "manual" });
    expect(await (await SELF.fetch(`${BASE}/app/matches/${seqs[0]}`, { headers: { cookie } })).text()).toContain("Отменить отправку");
    // Ручная очередь уходит даже на паузе автопилота.
    await post("/app/autopilot", { action: "pause" });
    expect((await runAutopilot(ENV, Math.floor(Date.now() / 1000) + 60)).sent).toBe(1);
    expect(resendCalls(spy).some((m) => m.to[0] === "jobs@stark.io")).toBe(true);

    await post("/app/autopilot", { enabled: "on", daily_limit: "500", min_score: "1" });
    const s = await env.DB.prepare("SELECT enabled, review_window, daily_limit, min_score FROM autopilot WHERE user_id = ?").bind(userId).first();
    expect(s).toEqual({ enabled: 1, review_window: 0, daily_limit: 30, min_score: 35 });
  });
});
