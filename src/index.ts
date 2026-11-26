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
import { CvError, latestResume, loadResume, readCv, storeResume } from "./lib/cv";
import { loginMail, sendMail } from "./lib/email";
import {
  ProfileExtractError,
  emptyProfile,
  extractProfile,
  getProfile,
  mergeProfiles,
  profileFromForm,
  saveProfile,
} from "./lib/profile";
import {
  checkEmailPage,
  dashboardPage,
  errorPage,
  invalidLinkPage,
  landingPage,
  privacyPage,
  profilePage,
  termsPage,
} from "./views";

const SESSION_COOKIE = "sid";

type AppEnv = { Bindings: Env; Variables: { user: User } };
const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  if (await userBySession(c.env.DB, getCookie(c, SESSION_COOKIE))) return c.redirect("/app");
  return c.html(landingPage());
});

app.get("/terms", (c) => c.html(termsPage()));
app.get("/privacy", (c) => c.html(privacyPage()));

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
app.use("/app/*", requireUser);
app.use("/billing/*", requireUser);

app.get("/app", async (c) => {
  const user = c.get("user");
  const [sub, active, profile, resume] = await Promise.all([
    latestSubscription(c.env.DB, user.id),
    hasActiveSubscription(c.env.DB, user.id),
    getProfile(c.env.DB, user.id),
    latestResume(c.env.DB, user.id),
  ]);
  return c.html(dashboardPage(user, sub, active, c.req.query("paid") === "1", profile, resume));
});

// --- Резюме и анкета ---

app.get("/app/profile", async (c) => {
  const user = c.get("user");
  const [profile, resume] = await Promise.all([getProfile(c.env.DB, user.id), latestResume(c.env.DB, user.id)]);
  return c.html(profilePage(profile, resume, { saved: c.req.query("saved") === "1" }));
});

/**
 * Загрузка CV: проверяем файл, кладём в R2, заполняем анкету моделью.
 * Если автозаполнение не удалось, файл всё равно сохранён, а анкету можно заполнить руками.
 */
app.post("/app/cv", async (c) => {
  const user = c.get("user");
  const form = await c.req.parseBody();
  const file = form.cv;
  const [current, resume] = await Promise.all([getProfile(c.env.DB, user.id), latestResume(c.env.DB, user.id)]);
  if (!(file instanceof File) || file.size === 0) {
    return c.html(profilePage(current, resume, { error: "Выберите файл с резюме." }), 400);
  }
  let cv;
  try {
    cv = readCv(new Uint8Array(await file.arrayBuffer()));
  } catch (e) {
    if (e instanceof CvError) return c.html(profilePage(current, resume, { error: e.message }), 400);
    throw e;
  }
  const stored = await storeResume(c.env, user.id, file.name, cv);
  await fillProfile(c.env, user.id, stored.id, () => extractProfile(c.env, cv));
  return c.redirect("/app/profile", 303);
});

/** Заполнить анкету заново по последнему загруженному CV. */
app.post("/app/profile/refill", async (c) => {
  const user = c.get("user");
  const resume = await latestResume(c.env.DB, user.id);
  const cv = resume ? await loadResume(c.env, resume) : null;
  if (!resume || !cv) return c.redirect("/app/profile", 303);
  await fillProfile(c.env, user.id, resume.id, () => extractProfile(c.env, cv));
  return c.redirect("/app/profile", 303);
});

app.post("/app/profile", async (c) => {
  const user = c.get("user");
  const form = await c.req.parseBody({ all: true });
  const current = await getProfile(c.env.DB, user.id);
  await saveProfile(c.env.DB, user.id, profileFromForm(form), "user", current?.resumeId ?? null);
  return c.redirect("/app/profile?saved=1", 303);
});

/** Скачать загруженное CV (то, что уйдёт работодателям). */
app.get("/app/cv", async (c) => {
  const user = c.get("user");
  const resume = await latestResume(c.env.DB, user.id);
  const obj = resume ? await c.env.CV_BUCKET.get(resume.r2_key) : null;
  if (!resume || !obj) return c.redirect("/app/profile");
  return new Response(obj.body, {
    headers: {
      "content-type": resume.content_type,
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(resume.filename)}`,
      "cache-control": "private, no-store",
    },
  });
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

async function fillProfile(env: Env, userId: string, resumeId: string, extract: () => ReturnType<typeof extractProfile>) {
  const current = await getProfile(env.DB, userId);
  try {
    const fresh = await extract();
    // Что человек указал сам и чего нет в CV (формат, зарплата, «не хочу»), не затираем.
    await saveProfile(env.DB, userId, mergeProfiles(fresh, current?.profile ?? null), "ai", resumeId);
  } catch (e) {
    const message =
      e instanceof ProfileExtractError ? e.message : "Автозаполнение сейчас не сработало. Попробуйте ещё раз позже или заполните анкету вручную.";
    if (!(e instanceof ProfileExtractError)) console.error("[profile] extract failed:", e instanceof Error ? `${e.name}: ${e.message}` : e);
    await saveProfile(env.DB, userId, current?.profile ?? emptyProfile(), current?.source ?? "ai", resumeId, message);
  }
}

// Ошибки (в том числе Stripe) логируем целиком, человеку показываем понятную страницу.
app.onError((err, c) => {
  console.error(`[error] ${c.req.method} ${c.req.path}:`, err instanceof Error ? `${err.name}: ${err.message}` : err);
  return c.html(errorPage(), 500);
});

export default app;
