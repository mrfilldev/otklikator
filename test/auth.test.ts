import { SELF, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { BASE, signIn } from "./helpers";

describe("регистрация по email", () => {
  it("отправляет ссылку, подтверждает email и пускает в кабинет", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const start = await SELF.fetch(`${BASE}/auth/start`, {
      method: "POST",
      body: new URLSearchParams({ email: "  Anna@Example.com " }),
    });
    expect(start.status).toBe(200);
    expect(await start.text()).toContain("anna@example.com");
    const mail = String(log.mock.calls.at(-1)?.[0]);
    log.mockRestore();
    const token = /token=([\w%-]+)/.exec(mail)![1];

    const before = await env.DB.prepare("SELECT email_verified_at FROM users WHERE email = ?").bind("anna@example.com").first();
    expect(before!.email_verified_at).toBeNull();

    const verify = await SELF.fetch(`${BASE}/auth/verify?token=${token}`, { redirect: "manual" });
    expect(verify.status).toBe(302);
    expect(verify.headers.get("location")).toBe("/app");
    const cookie = verify.headers.get("set-cookie")!;
    expect(cookie).toMatch(/HttpOnly/i);

    const after = await env.DB.prepare("SELECT email_verified_at FROM users WHERE email = ?").bind("anna@example.com").first();
    expect(after!.email_verified_at).not.toBeNull();

    const app = await SELF.fetch(`${BASE}/app`, { headers: { cookie: cookie.split(";")[0] } });
    expect(await app.text()).toContain("anna@example.com");

    // ссылка одноразовая
    const again = await SELF.fetch(`${BASE}/auth/verify?token=${token}`, { redirect: "manual" });
    expect(again.status).toBe(400);
  });

  it("не шлёт второе письмо чаще раза в минуту", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const body = () => new URLSearchParams({ email: "bob@example.com" });
    await SELF.fetch(`${BASE}/auth/start`, { method: "POST", body: body() });
    await SELF.fetch(`${BASE}/auth/start`, { method: "POST", body: body() });
    expect(log.mock.calls.filter((c) => String(c[0]).includes("bob@example.com")).length).toBe(1);
    log.mockRestore();
  });

  it("отклоняет неверный email и чужой токен", async () => {
    const bad = await SELF.fetch(`${BASE}/auth/start`, { method: "POST", body: new URLSearchParams({ email: "nope" }) });
    expect(bad.status).toBe(400);
    const forged = await SELF.fetch(`${BASE}/auth/verify?token=forged`, { redirect: "manual" });
    expect(forged.status).toBe(400);
  });

  it("без сессии кабинет и оплата недоступны, выход гасит сессию", async () => {
    const anon = await SELF.fetch(`${BASE}/app`, { redirect: "manual" });
    expect(anon.headers.get("location")).toBe("/");
    const checkout = await SELF.fetch(`${BASE}/billing/checkout`, { method: "POST", redirect: "manual" });
    expect(checkout.headers.get("location")).toBe("/");

    const { cookie } = await signIn("carol@example.com");
    await SELF.fetch(`${BASE}/auth/logout`, { method: "POST", headers: { cookie }, redirect: "manual" });
    const after = await SELF.fetch(`${BASE}/app`, { headers: { cookie }, redirect: "manual" });
    expect(after.headers.get("location")).toBe("/");
  });

  it("страницы условий и конфиденциальности открываются без входа", async () => {
    expect((await SELF.fetch(`${BASE}/terms`)).status).toBe(200);
    expect(await (await SELF.fetch(`${BASE}/privacy`)).text()).toContain("Stripe");
  });
});
