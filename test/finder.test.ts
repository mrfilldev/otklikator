import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { runAutopilot, saveSettings } from "../src/lib/autopilot";
import {
  candidateDomains,
  careerLinks,
  companySlug,
  isCompanySite,
  lookupCompany,
  registrable,
  roleRank,
  runFinder,
  siteEmails,
  type PageFetcher,
} from "../src/lib/finder";
import { saveVacancies } from "../src/lib/jobs/pipeline";
import { emptyProfile, saveProfile } from "../src/lib/profile";
import { signIn } from "./helpers";

const T0 = Date.UTC(2026, 10, 27, 6, 0) / 1000;

/** Сайты: acme.com припаркован, acme.io — настоящий, с /careers и /contact. */
const SITES: Record<string, string> = {
  "https://acme.com/": "<html><title>acme.com is for sale</title><body>Buy this domain</body></html>",
  "https://acme.io/": `<html><head><title>Acme — payments infrastructure</title></head><body>
    <a href="/about">About</a> <a href="https://acme.io/careers">Careers</a> <a href="https://twitter.com/acme">X</a>
    <p>Questions? <a href="mailto:hello@acme.io">hello@acme.io</a></p></body></html>`,
  "https://acme.io/careers": `<html><body>Join us! Send your CV to jobs@acme.io. CEO: john@acme.io. support@acme.io.
    Partner: talent@other-agency.com <img src="logo@2x.png"></body></html>`,
};
const fakePage =
  (sites: Record<string, string>): PageFetcher =>
  async (url) =>
    sites[url] === undefined ? null : { url, html: sites[url] };

afterEach(() => vi.restoreAllMocks());

describe("finder helpers", () => {
  it("domains and names", () => {
    expect(registrable("careers.acme.co.uk")).toBe("acme.co.uk");
    expect(registrable("www.acme.io")).toBe("acme.io");
    expect(companySlug("Acme Labs, Inc.")).toBe("acme");
    expect(candidateDomains("Acme", "https://job-boards.greenhouse.io/acme/jobs/1", "")).toEqual(["acme.com", "acme.io", "acme.ai", "acme.co", "acme.dev"]);
    expect(candidateDomains("Globex", "https://careers.globex.de/jobs/1", "see https://www.globex-group.com and https://github.com/x")[0]).toBe("globex.de");
    expect(candidateDomains("Globex", "https://remoteok.com/1", "see https://www.globex-group.com")[0]).toBe("globex-group.com");
  });

  it("site check, links and role addresses", () => {
    expect(isCompanySite({ url: "https://acme.com/", html: SITES["https://acme.com/"] }, "acme.com", "Acme")).toBe(false);
    expect(isCompanySite({ url: "https://acme.io/", html: SITES["https://acme.io/"] }, "acme.io", "Acme")).toBe(true);
    // Домен не похож на название, но в <title> оно есть.
    expect(isCompanySite({ url: "https://getinitech.com/", html: "<title>Initech | Home</title>" }, "getinitech.com", "Initech")).toBe(true);
    expect(isCompanySite({ url: "https://other.com/", html: "<title>Other</title>" }, "acme.io", "Acme")).toBe(false);
    expect(careerLinks({ url: "https://acme.io/", html: SITES["https://acme.io/"] }, "acme.io")).toEqual(["https://acme.io/careers", "https://acme.io/about"]);
    expect(siteEmails(SITES["https://acme.io/careers"], "acme.io")).toEqual(["jobs@acme.io"]);
    expect([roleRank("jobs@a.io"), roleRank("hello@a.io"), roleRank("info@a.io"), roleRank("john@a.io")]).toEqual([3, 2, 1, 0]);
  });
});

describe("lookupCompany", () => {
  it("finds the careers address on the real site, skipping the parked guess", async () => {
    const r = await lookupCompany({}, { company: "Acme", url: "https://job-boards.greenhouse.io/acme/jobs/1", description: "" }, { page: fakePage(SITES), mx: async () => true });
    expect(r).toEqual({ domain: "acme.io", email: "jobs@acme.io", source: "https://acme.io/careers", status: "found" });
  });

  it("no MX, no site", async () => {
    const deps = { page: fakePage(SITES), mx: async () => false };
    expect((await lookupCompany({}, { company: "Acme", url: "", description: "" }, deps)).status).toBe("no_email");
    expect(await lookupCompany({}, { company: "Nowhere", url: "", description: "" }, deps)).toMatchObject({ status: "no_domain", email: null });
  });

  it("falls back to Hunter when the site has no address", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      expect(String(input)).toContain("api.hunter.io/v2/domain-search?domain=acme.io");
      return Response.json({ data: { emails: [{ value: "careers@acme.io" }, { value: "anna@acme.io" }] } });
    });
    const sites = { ...SITES, "https://acme.io/careers": "<p>No emails here</p>", "https://acme.io/": "<title>Acme</title>" };
    const r = await lookupCompany({ HUNTER_API_KEY: "h" }, { company: "Acme", url: "", description: "" }, { page: fakePage(sites), mx: async () => true });
    expect(r).toMatchObject({ email: "careers@acme.io", source: "hunter.io", status: "found" });
  });
});

describe("runFinder + autopilot", () => {
  it("looks up companies from autopilot matches, caches them, and autopilot then applies there", async () => {
    const { userId } = await signIn("finder@example.com");
    await saveProfile(env.DB, userId, { ...emptyProfile(), full_name: "Anna Petrova", skills: ["Python"] }, "user", null);
    await env.DB.prepare("INSERT INTO subscriptions (id, user_id, status, updated_at) VALUES ('sub_f', ?, 'active', ?)").bind(userId, T0).run();
    await saveVacancies(env.DB, [{ id: "gh:acme-1", source: "gh", title: "Backend Engineer", company: "Acme", location: "Remote", url: "https://job-boards.greenhouse.io/acme/jobs/1", description: "Apply via the form.", flags: "", posted_at: T0 }], T0);
    const seq = (await env.DB.prepare("SELECT seq FROM vacancies WHERE id = 'gh:acme-1'").first<{ seq: number }>())!.seq;
    await env.DB.prepare("INSERT INTO matches (user_id, vacancy_seq, score, reasons, status, created_at) VALUES (?, ?, 80, '[]', 'new', ?)").bind(userId, seq, T0).run();
    await saveSettings(env.DB, userId, { enabled: true, review_window: true, daily_limit: 5, min_score: 60 }, T0);

    const page = vi.fn(fakePage(SITES));
    expect(await runFinder(env as unknown as Env, T0, { page, mx: async () => true })).toEqual({ looked: 1, found: 1 });
    const row = await env.DB.prepare("SELECT domain, email, status FROM companies WHERE name = 'Acme'").first();
    expect(row).toEqual({ domain: "acme.io", email: "jobs@acme.io", status: "found" });
    // Повторно ту же компанию не ищем.
    const calls = page.mock.calls.length;
    expect(await runFinder(env as unknown as Env, T0 + 3600, { page, mx: async () => true })).toEqual({ looked: 0, found: 0 });
    expect(page.mock.calls.length).toBe(calls);

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://openrouter.ai/")) {
        return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ subject: "Backend Engineer — Anna", body: "Hello there. Open to a call?" }) } }] });
      }
      return Response.json({ id: "msg_1" });
    });
    const r = await runAutopilot({ ...env, RESEND_API_KEY: "re_test", APPLY_FROM_DOMAIN: "apply.test" } as unknown as Env, T0);
    expect(r.queued).toBe(1);
    const a = await env.DB.prepare("SELECT to_email, status FROM applications WHERE user_id = ?").bind(userId).first();
    expect(a).toEqual({ to_email: "jobs@acme.io", status: "queued" });
    await env.DB.prepare("UPDATE autopilot SET enabled = 0").run();
  });
});
