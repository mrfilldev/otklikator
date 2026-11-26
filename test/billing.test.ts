import { SELF, env } from "cloudflare:test";
import Stripe from "stripe";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BASE, signIn } from "./helpers";

const stripe = new Stripe("sk_test_dummy", { httpClient: Stripe.createFetchHttpClient() });
let seq = 0;

async function sendEvent(type: string, object: object, id = `evt_${++seq}`) {
  const payload = JSON.stringify({ id, object: "event", type, data: { object } });
  const header = await stripe.webhooks.generateTestHeaderStringAsync({
    payload,
    secret: env.STRIPE_WEBHOOK_SECRET,
    cryptoProvider: Stripe.createSubtleCryptoProvider(),
  });
  return SELF.fetch(`${BASE}/stripe/webhook`, { method: "POST", body: payload, headers: { "stripe-signature": header } });
}

const subscription = (userId: string, status: string, extra: object = {}) => ({
  id: "sub_123",
  object: "subscription",
  customer: "cus_123",
  status,
  cancel_at_period_end: false,
  metadata: { user_id: userId },
  items: { data: [{ price: { id: "price_test_weekly" }, current_period_end: 1_900_000_000 }] },
  ...extra,
});

afterEach(() => vi.restoreAllMocks());

describe("Stripe", () => {
  it("отклоняет вебхук с неверной подписью", async () => {
    const res = await SELF.fetch(`${BASE}/stripe/webhook`, {
      method: "POST",
      body: "{}",
      headers: { "stripe-signature": "t=1,v1=deadbeef" },
    });
    expect(res.status).toBe(400);
  });

  it("включает и выключает доступ по событиям подписки, повтор события игнорирует", async () => {
    const { cookie, userId } = await signIn("dima@example.com");

    let res = await sendEvent("customer.subscription.created", subscription(userId, "active"), "evt_created");
    expect(await res.json()).toMatchObject({ result: "processed" });
    expect(await (await SELF.fetch(`${BASE}/app`, { headers: { cookie } })).text()).toContain("Автопоиск включён");

    const user = await env.DB.prepare("SELECT stripe_customer_id FROM users WHERE id = ?").bind(userId).first();
    expect(user!.stripe_customer_id).toBe("cus_123");

    res = await sendEvent("customer.subscription.created", subscription(userId, "active"), "evt_created");
    expect(await res.json()).toMatchObject({ result: "duplicate" });

    await sendEvent("customer.subscription.deleted", subscription(userId, "canceled"));
    const page = await (await SELF.fetch(`${BASE}/app`, { headers: { cookie } })).text();
    expect(page).toContain("Автопоиск выключен");
  });

  it("находит пользователя по customer, если в подписке нет metadata", async () => {
    const { userId } = await signIn("eva@example.com");
    await env.DB.prepare("UPDATE users SET stripe_customer_id = 'cus_eva' WHERE id = ?").bind(userId).run();
    await sendEvent("customer.subscription.updated", subscription(userId, "past_due", { id: "sub_eva", customer: "cus_eva", metadata: {} }));
    const row = await env.DB.prepare("SELECT status FROM subscriptions WHERE id = 'sub_eva'").first();
    expect(row!.status).toBe("past_due");
  });

  it("создаёт Checkout Session на недельную цену и редиректит в Stripe", async () => {
    const { cookie, userId } = await signIn("fedor@example.com");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ id: "cs_test", object: "checkout.session", url: "https://checkout.stripe.com/c/pay/cs_test" }),
    );
    const res = await SELF.fetch(`${BASE}/billing/checkout`, { method: "POST", headers: { cookie }, redirect: "manual" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://checkout.stripe.com/c/pay/cs_test");

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("/v1/checkout/sessions");
    const sent = new URLSearchParams(String(init!.body));
    expect(sent.get("mode")).toBe("subscription");
    expect(sent.get("line_items[0][price]")).toBe("price_test_weekly");
    expect(sent.get("client_reference_id")).toBe(userId);
    expect(sent.get("customer_email")).toBe("fedor@example.com");
  });
});
