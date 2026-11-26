import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveVacancies } from "../src/lib/jobs/pipeline";
import { cleanHtml } from "../src/lib/jobs/text";
import { companyKey, findApplyEmail, letterLanguage, unverifiedNumbers } from "../src/lib/letters";
import { emptyProfile, saveProfile, type Profile } from "../src/lib/profile";
import { BASE, signIn } from "./helpers";

const NOW = Math.floor(Date.now() / 1000);

const profile: Profile = {
  ...emptyProfile(),
  full_name: "Anna Petrova",
  headline: "Backend engineer (Python)",
  seniority: "senior",
  years_experience: 6,
  skills: ["Python", "PostgreSQL"],
  experience: [{ company: "Moidex", title: "Backend lead", period: "2022 – 2026", highlights: ["Cut API latency by 40%"] }],
  contacts: { ...emptyProfile().contacts, email: "anna@example.com", linkedin: "linkedin.com/in/anna" },
};

/** Готовит пользователя с анкетой и одним совпадением; active — есть ли подписка. */
async function setup(email: string, active: boolean, description = "We build payments infra. Send your CV to jobs@acme.io") {
  const { cookie, userId } = await signIn(email);
  await saveProfile(env.DB, userId, profile, "user", null);
  const id = `rok:${email}`;
  await saveVacancies(env.DB, [
    { id, source: "rok", title: `Senior Python Engineer ${email}`, company: "Acme Inc.", location: "Remote", url: "https://acme.io/jobs/1", description, flags: "REMOTE", posted_at: NOW },
  ]);
  const { seq } = (await env.DB.prepare("SELECT seq FROM vacancies WHERE id = ?").bind(id).first<{ seq: number }>())!;
  await env.DB.prepare("INSERT INTO matches (user_id, vacancy_seq, score, reasons, status, created_at) VALUES (?, ?, 80, '[\"Python\"]', 'new', ?)")
    .bind(userId, seq, NOW)
    .run();
  if (active) {
    await env.DB.prepare("INSERT INTO subscriptions (id, user_id, status, updated_at) VALUES (?, ?, 'active', ?)").bind(`sub_${email}`, userId, NOW).run();
  }
  return { cookie, userId, seq };
}

function mockLetter(...bodies: string[]) {
  let i = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://openrouter.ai/api/v1/")) throw new Error(`unexpected fetch ${url}`);
    const body = bodies[Math.min(i++, bodies.length - 1)];
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ subject: "Senior Python Engineer — Anna", body }) } }] });
  });
}

const post = (path: string, cookie: string, body?: Record<string, string>) =>
  SELF.fetch(`${BASE}${path}`, { method: "POST", headers: { cookie }, body: body ? new URLSearchParams(body) : undefined, redirect: "manual" });
const page = async (path: string, cookie: string) => (await SELF.fetch(`${BASE}${path}`, { headers: { cookie } })).text();

afterEach(() => vi.restoreAllMocks());

describe("helpers", () => {
  it("finds the apply address and skips noreply/privacy", () => {
    expect(findApplyEmail("Questions: privacy@acme.io. Send your CV to careers@acme.io.")).toBe("careers@acme.io");
    expect(findApplyEmail("noreply@acme.io logo@2x.png")).toBeNull();
    expect(findApplyEmail("Пишите на Ivan.Petrov@Startup.ru")).toBe("ivan.petrov@startup.ru");
    expect(cleanHtml('<p>Apply: <a href="mailto:hr@acme.io?subject=x">here</a></p>')).toContain("hr@acme.io");
  });

  it("picks letter language and flags invented numbers", () => {
    expect(letterLanguage({ title: "Python-разработчик", description: "Ищем бэкенд-разработчика в команду" })).toBe("ru");
    expect(letterLanguage({ title: "Backend Engineer", description: "Python, Postgres" })).toBe("en");
    expect(unverifiedNumbers("Cut latency by 40% for 12 teams", "Cut API latency by 40%")).toEqual(["12"]);
    expect(companyKey("Acme Inc.")).toBe(companyKey("ACME"));
  });
});

describe("letters", () => {
  it("without a subscription offers checkout and refuses to draft", async () => {
    const { cookie, seq } = await setup("free@example.com", false);
    const fetchSpy = mockLetter("x");
    expect((await post(`/app/matches/${seq}/letter`, cookie)).status).toBe(303);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await page(`/app/matches/${seq}`, cookie)).toContain("/billing/checkout");
  });

  it("drafts, edits, marks sent and blocks the same company for two weeks", async () => {
    const { cookie, userId, seq } = await setup("paid@example.com", true);
    const fetchSpy = mockLetter("Your payments infra caught my eye. At Moidex I cut API latency by 40%. Open to a call next week?");
    await post(`/app/matches/${seq}/letter`, cookie);

    const req = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(req.messages[1].content).toContain("Cut API latency by 40%");
    expect(req.messages[1].content).toContain("payments infra");

    const a = await env.DB.prepare("SELECT * FROM applications WHERE user_id = ?").bind(userId).first<Record<string, string>>();
    expect(a!.to_email).toBe("jobs@acme.io");
    expect(a!.body).toMatch(/^Hi Acme Inc\. team,\n\n.*40%.*\n\nAnna Petrova\nlinkedin\.com\/in\/anna$/s);
    expect(a!.unverified).toBe("[]");

    const html = await page(`/app/matches/${seq}`, cookie);
    expect(html).toContain("mailto:jobs@acme.io?subject=");
    expect(html).toContain("Я отправил(а)");

    await post(`/app/matches/${seq}/application`, cookie, { to_email: "Hiring@Acme.io", subject: "Edited", body: "Edited body" });
    const edited = await env.DB.prepare("SELECT to_email, subject FROM applications WHERE user_id = ?").bind(userId).first();
    expect(edited).toEqual({ to_email: "hiring@acme.io", subject: "Edited" });

    await post(`/app/matches/${seq}/sent`, cookie);
    const sent = await env.DB.prepare("SELECT a.status, a.channel, m.status AS match FROM applications a JOIN matches m ON m.user_id = a.user_id AND m.vacancy_seq = a.vacancy_seq WHERE a.user_id = ?")
      .bind(userId)
      .first();
    expect(sent).toEqual({ status: "sent", channel: "manual", match: "applied" });
    // Отправленное письмо не перезаписывается новым черновиком.
    await post(`/app/matches/${seq}/letter`, cookie);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Другая вакансия той же компании: предупреждение про две недели.
    await saveVacancies(env.DB, [{ id: "rok:acme-2", source: "rok", title: "Staff Engineer", company: "ACME", location: "", url: "https://acme.io/2", description: "", flags: "", posted_at: NOW }]);
    const other = (await env.DB.prepare("SELECT seq FROM vacancies WHERE id = 'rok:acme-2'").first<{ seq: number }>())!.seq;
    await env.DB.prepare("INSERT INTO matches (user_id, vacancy_seq, score, reasons, status, created_at) VALUES (?, ?, 70, '[]', 'new', ?)").bind(userId, other, NOW).run();
    expect(await page(`/app/matches/${other}`, cookie)).toContain("Вы уже откликались в ACME");
  });

  it("retries once when the model invents numbers and warns if it still does", async () => {
    const { cookie, userId, seq } = await setup("nums@example.com", true, "Apply via the form.");
    const fetchSpy = mockLetter("I led 25 engineers.", "I led 30 engineers.");
    await post(`/app/matches/${seq}/letter`, cookie);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String((fetchSpy.mock.calls[1][1] as RequestInit).body)).messages[1].content).toContain("25");
    const a = await env.DB.prepare("SELECT to_email, unverified FROM applications WHERE user_id = ?").bind(userId).first();
    expect(a).toEqual({ to_email: null, unverified: '["30"]' });
    const html = await page(`/app/matches/${seq}`, cookie);
    expect(html).toContain("Проверьте цифры 30");
    expect(html).toContain("Адреса в тексте вакансии нет");
  });

  it("skip hides the vacancy; model failure shows an error", async () => {
    const { cookie, userId, seq } = await setup("skip@example.com", true);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("overloaded", { status: 529 }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post(`/app/matches/${seq}/letter`, cookie);
    expect(res.headers.get("location")).toBe(`/app/matches/${seq}?error=draft`);
    expect(await page(`/app/matches/${seq}?error=draft`, cookie)).toContain("Не получилось написать письмо");

    await post(`/app/matches/${seq}/skip`, cookie);
    const m = await env.DB.prepare("SELECT status FROM matches WHERE user_id = ?").bind(userId).first();
    expect(m).toEqual({ status: "hidden" });
    expect(await page("/app/matches", cookie)).not.toContain(`/app/matches/${seq}`);
  });
});
