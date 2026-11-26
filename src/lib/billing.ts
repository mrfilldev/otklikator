import Stripe from "stripe";
import { now, type Env, type User } from "../env";
import { paymentFailedMail, sendMail } from "./email";

export const ACTIVE_STATUSES = ["active", "trialing"];

export function stripeClient(env: Env): Stripe {
  return new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
}

export interface SubscriptionRow {
  id: string;
  user_id: string;
  status: string;
  price_id: string | null;
  current_period_end: number | null;
  cancel_at_period_end: number;
}

/** Последняя подписка пользователя (по времени обновления). */
export function latestSubscription(db: D1Database, userId: string) {
  return db
    .prepare("SELECT * FROM subscriptions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1")
    .bind(userId)
    .first<SubscriptionRow>();
}

export async function hasActiveSubscription(db: D1Database, userId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 FROM subscriptions WHERE user_id = ? AND status IN (${ACTIVE_STATUSES.map(() => "?").join(",")})`)
    .bind(userId, ...ACTIVE_STATUSES)
    .first();
  return !!row;
}

export async function createCheckoutSession(env: Env, stripe: Stripe, user: User): Promise<string> {
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: env.STRIPE_PRICE_ID, quantity: 1 }],
    client_reference_id: user.id,
    ...(user.stripe_customer_id ? { customer: user.stripe_customer_id } : { customer_email: user.email }),
    subscription_data: { metadata: { user_id: user.id } },
    success_url: `${env.APP_URL}/app?paid=1`,
    cancel_url: `${env.APP_URL}/app`,
  });
  return session.url!;
}

export async function createPortalSession(env: Env, stripe: Stripe, customerId: string): Promise<string> {
  const session = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: `${env.APP_URL}/app` });
  return session.url;
}

const idOf = (v: string | { id: string } | null | undefined) => (typeof v === "string" ? v : v?.id ?? null);

/** current_period_end в новых версиях API живёт на позиции подписки, в старых — на самой подписке. */
function periodEnd(sub: Stripe.Subscription): number | null {
  const item = sub.items?.data?.[0] as (Stripe.SubscriptionItem & { current_period_end?: number }) | undefined;
  return item?.current_period_end ?? (sub as unknown as { current_period_end?: number }).current_period_end ?? null;
}

async function userIdForSubscription(db: D1Database, sub: Stripe.Subscription): Promise<string | null> {
  if (sub.metadata?.user_id) return sub.metadata.user_id;
  const customerId = idOf(sub.customer);
  const row = await db.prepare("SELECT id FROM users WHERE stripe_customer_id = ?").bind(customerId).first<{ id: string }>();
  return row?.id ?? null;
}

export async function upsertSubscription(db: D1Database, sub: Stripe.Subscription): Promise<void> {
  const userId = await userIdForSubscription(db, sub);
  if (!userId) throw new Error(`No user for subscription ${sub.id}`);
  const customerId = idOf(sub.customer);
  await db.batch([
    db
      .prepare("UPDATE users SET stripe_customer_id = COALESCE(stripe_customer_id, ?) WHERE id = ?")
      .bind(customerId, userId),
    db
      .prepare(
        `INSERT INTO subscriptions (id, user_id, status, price_id, current_period_end, cancel_at_period_end, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, price_id = excluded.price_id,
           current_period_end = excluded.current_period_end, cancel_at_period_end = excluded.cancel_at_period_end,
           updated_at = excluded.updated_at`,
      )
      .bind(
        sub.id,
        userId,
        sub.status,
        sub.items?.data?.[0]?.price?.id ?? null,
        periodEnd(sub),
        sub.cancel_at_period_end ? 1 : 0,
        now(),
      ),
  ]);
}

/**
 * Обработка события Stripe. Идемпотентно: id события пишется в stripe_events,
 * повторная доставка ничего не делает. При ошибке запись удаляется, чтобы
 * Stripe мог повторить доставку.
 */
export async function handleStripeEvent(env: Env, stripe: Stripe, event: Stripe.Event): Promise<"processed" | "duplicate"> {
  const db = env.DB;
  const ins = await db
    .prepare("INSERT OR IGNORE INTO stripe_events (id, type, received_at) VALUES (?, ?, ?)")
    .bind(event.id, event.type, now())
    .run();
  if (!ins.meta.changes) return "duplicate";
  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object as Stripe.Checkout.Session;
        if (s.mode !== "subscription" || !s.client_reference_id) break;
        await db
          .prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id IS NULL")
          .bind(idOf(s.customer), s.client_reference_id)
          .run();
        const subId = idOf(s.subscription);
        if (subId) await upsertSubscription(db, await stripe.subscriptions.retrieve(subId));
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await upsertSubscription(db, event.data.object as Stripe.Subscription);
        break;
      case "invoice.payment_failed": {
        const inv = event.data.object as Stripe.Invoice;
        const user = await db
          .prepare("SELECT email FROM users WHERE stripe_customer_id = ?")
          .bind(idOf(inv.customer))
          .first<{ email: string }>();
        if (user) await sendMail(env, paymentFailedMail(env.APP_URL, user.email));
        break;
      }
    }
  } catch (err) {
    await db.prepare("DELETE FROM stripe_events WHERE id = ?").bind(event.id).run();
    throw err;
  }
  return "processed";
}
