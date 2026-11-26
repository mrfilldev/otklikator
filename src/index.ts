import { Hono } from "hono";
import Stripe from "stripe";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { Env, User } from "./env";
import {
  SESSION_TTL,
  consumeLoginToken,
  createLoginToken,
  createSession,
  deleteSession,
  getOrCreateUser,
  normalizeEmail,
  userBySession,
} from "./lib/auth";
import {
  createCheckoutSession,
  createPortalSession,
  handleStripeEvent,
  hasActiveSubscription,
  latestSubscription,
  stripeClient,
} from "./lib/billing";
import { loginMail, sendMail } from "./lib/email";
import { checkEmailPage, dashboardPage, invalidLinkPage, landingPage } from "./views";

const SESSION_COOKIE = "sid";

type AppEnv = { Bindings: Env; Variables: { user: User } };
const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  if (await userBySession(c.env.DB, getCookie(c, SESSION_COOKIE))) return c.redirect("/app");
  return c.html(landingPage());
});

app.post("/auth/start", async (c) => {
  const form = await c.req.parseBody();
  const email = normalizeEmail(form.email);
  if (!email) return c.html(landingPage("Похоже, в адресе опечатка."), 400);
  const user = await getOrCreateUser(c.env.DB, email);
  const token = await createLoginToken(c.env.DB, user.id);
  // token === null: письмо уже ушло меньше минуты назад — показываем ту же страницу.
  if (token) await sendMail(c.env, loginMail(c.env.APP_URL, email, token));
  return c.html(checkEmailPage(email));
});

app.get("/auth/verify", async (c) => {
  const token = c.req.query("token");
  const user = token ? await consumeLoginToken(c.env.DB, token) : null;
  if (!user) return c.html(invalidLinkPage(), 400);
  const sid = await createSession(c.env.DB, user.id);
  setCookie(c, SESSION_COOKIE, sid, {
    httpOnly: true,
    secure: c.env.APP_URL.startsWith("https://"),
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL,
  });
  return c.redirect("/app");
});

app.post("/auth/logout", async (c) => {
  await deleteSession(c.env.DB, getCookie(c, SESSION_COOKIE));
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.redirect("/");
});

// Всё ниже — только для вошедших.
const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  const user = await userBySession(c.env.DB, getCookie(c, SESSION_COOKIE));
  if (!user) return c.redirect("/");
  c.set("user", user);
  await next();
});
app.use("/app", requireUser);
app.use("/billing/*", requireUser);

app.get("/app", async (c) => {
  const user = c.get("user");
  const [sub, active] = await Promise.all([
    latestSubscription(c.env.DB, user.id),
    hasActiveSubscription(c.env.DB, user.id),
  ]);
  return c.html(dashboardPage(user, sub, active, c.req.query("paid") === "1"));
});

app.post("/billing/checkout", async (c) => {
  const user = c.get("user");
  if (await hasActiveSubscription(c.env.DB, user.id)) return c.redirect("/app");
  return c.redirect(await createCheckoutSession(c.env, stripeClient(c.env), user), 303);
});

app.post("/billing/portal", async (c) => {
  const user = c.get("user");
  if (!user.stripe_customer_id) return c.redirect("/app");
  return c.redirect(await createPortalSession(c.env, stripeClient(c.env), user.stripe_customer_id), 303);
});

app.post("/stripe/webhook", async (c) => {
  const signature = c.req.header("stripe-signature");
  if (!signature) return c.text("missing signature", 400);
  const stripe = stripeClient(c.env);
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      await c.req.text(),
      signature,
      c.env.STRIPE_WEBHOOK_SECRET,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch {
    return c.text("bad signature", 400);
  }
  const result = await handleStripeEvent(c.env, stripe, event);
  return c.json({ received: true, result });
});

export default app;
