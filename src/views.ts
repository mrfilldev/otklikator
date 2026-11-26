import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { User } from "./env";
import type { SubscriptionRow } from "./lib/billing";

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

const css = raw(`
  :root { color-scheme: light dark; --fg:#1d1d1f; --bg:#fafafa; --muted:#6e6e73; --accent:#2f6fed; --card:#fff; --line:#e3e3e8 }
  @media (prefers-color-scheme: dark) { :root { --fg:#f2f2f2; --bg:#141416; --muted:#a1a1a6; --card:#1d1d20; --line:#2e2e33 } }
  * { box-sizing: border-box }
  body { margin:0; font:16px/1.5 system-ui, -apple-system, sans-serif; color:var(--fg); background:var(--bg) }
  main { max-width:560px; margin:48px auto; padding:0 16px }
  h1 { font-size:28px; margin:0 0 8px } p { margin:0 0 16px } .muted { color:var(--muted) }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:24px; margin:24px 0 }
  input[type=email] { width:100%; padding:12px; border:1px solid var(--line); border-radius:8px; font:inherit; background:var(--bg); color:var(--fg) }
  button { margin-top:12px; padding:12px 20px; border:0; border-radius:8px; background:var(--accent); color:#fff; font:inherit; cursor:pointer }
  button.link { background:none; color:var(--muted); padding:0; margin:0; text-decoration:underline }
  .ok { color:#1f9d55 } .warn { color:#c27c0e }
`);

export function layout(title: string, body: Html) {
  return html`<!doctype html>
    <html lang="ru">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
        <style>${css}</style>
      </head>
      <body><main>${body}</main></body>
    </html>`;
}

export function landingPage(error?: string) {
  return layout(
    "Otklikator — автоотклики на вакансии",
    html`<h1>Otklikator</h1>
      <p class="muted">Каждый день находим подходящие вакансии, пишем письмо под каждую и отправляем отклик с вашей почты в один клик.</p>
      <div class="card">
        <form method="post" action="/auth/start">
          <label for="email">Ваш email</label>
          <input id="email" name="email" type="email" required autocomplete="email" placeholder="you@example.com" />
          ${error ? html`<p class="warn">${error}</p>` : ""}
          <button type="submit">Зарегистрироваться или войти</button>
        </form>
        <p class="muted" style="margin-top:12px">Пришлём ссылку для подтверждения адреса. Пароль не нужен.</p>
      </div>`,
  );
}

export function checkEmailPage(email: string) {
  return layout(
    "Проверьте почту — Otklikator",
    html`<h1>Проверьте почту</h1>
      <p>Мы отправили ссылку на <b>${email}</b>. Откройте её, чтобы подтвердить адрес и войти. Ссылка действует 24 часа.</p>
      <p class="muted">Письма нет? Проверьте «Спам» или <a href="/">запросите ссылку ещё раз</a> через минуту.</p>`,
  );
}

export function invalidLinkPage() {
  return layout(
    "Ссылка не работает — Otklikator",
    html`<h1>Ссылка не работает</h1>
      <p>Ссылка устарела или уже использована. <a href="/">Запросите новую</a>.</p>`,
  );
}

const dateFmt = (ts: number) => new Date(ts * 1000).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });

export function dashboardPage(user: User, sub: SubscriptionRow | null, active: boolean, justPaid: boolean) {
  let status: Html;
  if (active && sub) {
    const until = sub.current_period_end ? dateFmt(sub.current_period_end) : null;
    status = html`<p class="ok">Автопоиск включён.</p>
      ${until
        ? html`<p class="muted">${sub.cancel_at_period_end ? "Подписка закончится" : "Следующее списание"}: ${until}.</p>`
        : ""}
      <form method="post" action="/billing/portal"><button type="submit">Управлять подпиской</button></form>`;
  } else if (justPaid) {
    status = html`<p>Оплата получена, подключаем подписку. Обновите страницу через несколько секунд.</p>`;
  } else {
    status = html`<p>Автопоиск выключен.</p>
      ${sub && sub.status === "past_due" ? html`<p class="warn">Не прошла оплата — обновите карту.</p>` : ""}
      <form method="post" action="/billing/checkout"><button type="submit">Включить автопоиск — €5 в неделю</button></form>
      ${user.stripe_customer_id
        ? html`<form method="post" action="/billing/portal"><button class="link" type="submit">Счета и карта</button></form>`
        : ""}`;
  }
  return layout(
    "Кабинет — Otklikator",
    html`<h1>Кабинет</h1>
      <p class="muted">${user.email}</p>
      <div class="card">
        <h2 style="margin-top:0">Резюме и анкета</h2>
        <p class="muted">Скоро: загрузка CV и автозаполнение анкеты.</p>
      </div>
      <div class="card"><h2 style="margin-top:0">Подписка</h2>${status}</div>
      <form method="post" action="/auth/logout"><button class="link" type="submit">Выйти</button></form>`,
  );
}

export function errorPage() {
  return layout(
    "Ошибка — Otklikator",
    html`<h1>Что-то пошло не так</h1>
      <p>Мы уже видим ошибку в логах. Попробуйте ещё раз через минуту или <a href="/app">вернитесь в кабинет</a>.</p>`,
  );
}
