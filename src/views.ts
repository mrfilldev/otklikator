import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { User } from "./env";
import type { SubscriptionRow } from "./lib/billing";
import type { ResumeRow } from "./lib/cv";
import type { MatchView } from "./lib/jobs/pipeline";
import { hasFlag } from "./lib/jobs/text";
import { EMPLOYMENT, SENIORITY, WORK_FORMATS, profileToForm, type StoredProfile } from "./lib/profile";

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

const css = raw(`
  :root { color-scheme: light dark; --fg:#1d1d1f; --bg:#fafafa; --muted:#6e6e73; --accent:#2f6fed; --card:#fff; --line:#e3e3e8 }
  @media (prefers-color-scheme: dark) { :root { --fg:#f2f2f2; --bg:#141416; --muted:#a1a1a6; --card:#1d1d20; --line:#2e2e33 } }
  * { box-sizing: border-box }
  body { margin:0; font:16px/1.5 system-ui, -apple-system, sans-serif; color:var(--fg); background:var(--bg) }
  main { max-width:560px; margin:48px auto; padding:0 16px }
  h1 { font-size:28px; margin:0 0 8px } p { margin:0 0 16px } .muted { color:var(--muted) }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:24px; margin:24px 0 }
  input[type=email], input[type=text], input[type=number], select, textarea { width:100%; padding:12px; border:1px solid var(--line); border-radius:8px; font:inherit; background:var(--bg); color:var(--fg) }
  button { margin-top:12px; padding:12px 20px; border:0; border-radius:8px; background:var(--accent); color:#fff; font:inherit; cursor:pointer }
  button.link { background:none; color:var(--muted); padding:0; margin:0; text-decoration:underline }
  .ok { color:#1f9d55 } .warn { color:#c27c0e }
  textarea { min-height:96px; resize:vertical } label { display:block; margin:16px 0 4px; font-weight:600 }
  .hint { font-weight:400; color:var(--muted); font-size:14px } .row { display:flex; gap:12px } .row > * { flex:1 }
  .checks label { display:inline-flex; gap:6px; align-items:center; margin:4px 16px 4px 0; font-weight:400 }
  input[type=file] { margin:8px 0 }
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
      <body><main>${body}<footer class="muted" style="margin-top:48px;font-size:14px"><a href="/terms">Условия</a> · <a href="/privacy">Конфиденциальность</a> · <a href="mailto:mrfillippovvv@gmail.com">Поддержка</a></footer></main></body>
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

export function dashboardPage(
  user: User,
  sub: SubscriptionRow | null,
  active: boolean,
  justPaid: boolean,
  profile: StoredProfile | null = null,
  resume: ResumeRow | null = null,
  matchCount = 0,
) {
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
      <div class="card"><h2 style="margin-top:0">Резюме и анкета</h2>${profileSummary(profile, resume)}</div>
      ${profile
        ? html`<div class="card"><h2 style="margin-top:0">Подходящие вакансии</h2>
            ${matchCount
              ? html`<p>Нашли ${matchCount} по вашей анкете. <a href="/app/matches">Посмотреть</a></p>`
              : html`<p class="muted">Подбираем вакансии по анкете, обычно это занимает до часа.</p>`}</div>`
        : ""}
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

export function termsPage() {
  return layout(
    "Условия использования — Otklikator",
    html`<h1>Условия использования</h1>
      <p class="muted">Редакция от 26 ноября 2026 г.</p>
      <p>Otklikator — сервис, который подбирает вакансии под профиль пользователя, готовит сопроводительные письма и помогает отправлять отклики. Сервис предоставляет индивидуальный предприниматель Владислав Филиппов, Лимасол, Кипр.</p>
      <h2>Подписка и оплата</h2>
      <p>Доступ к автопоиску предоставляется по подписке. Стоимость и период списания указаны на странице оплаты. Подписка продлевается автоматически, пока вы её не отмените. Отменить подписку или сменить карту можно в кабинете («Управлять подпиской»); после отмены доступ сохраняется до конца оплаченного периода. Платежи обрабатывает Stripe.</p>
      <h2>Что мы не гарантируем</h2>
      <p>Мы не гарантируем приглашений на интервью или трудоустройства: решение всегда за работодателем. Вы отвечаете за достоверность данных в своём резюме и профиле.</p>
      <h2>Допустимое использование</h2>
      <p>Нельзя использовать сервис для рассылки спама, отправки чужих данных или откликов от чужого имени. Мы можем приостановить доступ при нарушении этих правил.</p>
      <h2>Возвраты</h2>
      <p>Если сервис не работал по нашей вине, напишите в поддержку — вернём оплату за затронутый период.</p>
      <h2>Контакты</h2>
      <p>Поддержка: <a href="mailto:mrfillippovvv@gmail.com">mrfillippovvv@gmail.com</a>.</p>`,
  );
}

export function privacyPage() {
  return layout(
    "Политика конфиденциальности — Otklikator",
    html`<h1>Политика конфиденциальности</h1>
      <p class="muted">Редакция от 26 ноября 2026 г.</p>
      <p>Оператор данных — индивидуальный предприниматель Владислав Филиппов, Лимасол, Кипр. Мы обрабатываем данные в соответствии с GDPR.</p>
      <h2>Какие данные мы храним</h2>
      <p>Email для входа; резюме и данные анкеты, которые вы загружаете; список вакансий и отправленных откликов; статус подписки. Данные карты мы не видим и не храним — их обрабатывает Stripe.</p>
      <h2>Зачем</h2>
      <p>Чтобы подбирать вакансии, готовить и отправлять отклики по вашему подтверждению, присылать письма для входа и уведомления, принимать оплату.</p>
      <h2>Кому передаём</h2>
      <p>Только подрядчикам, без которых сервис не работает: Cloudflare (хостинг и база данных), Stripe (платежи), Resend (отправка писем), провайдер языковой модели (разбор резюме и подготовка писем). Отклики уходят работодателям, которых вы выбрали.</p>
      <h2>Срок хранения и ваши права</h2>
      <p>Храним данные, пока у вас есть аккаунт. Вы можете запросить копию данных, исправление или удаление аккаунта, написав на <a href="mailto:mrfillippovvv@gmail.com">mrfillippovvv@gmail.com</a>.</p>
      <h2>Cookies</h2>
      <p>Используем только одну техническую cookie для входа в аккаунт.</p>`,
  );
}

function profileSummary(stored: StoredProfile | null, resume: ResumeRow | null) {
  if (!resume && !stored) {
    return html`<p>Загрузите резюме, и мы заполним анкету: роли, стек, опыт, языки. Её можно поправить.</p>
      ${uploadForm()}`;
  }
  const p = stored?.profile;
  return html`${p?.headline || p?.full_name
      ? html`<p><b>${p.full_name ?? ""}</b>${p.full_name && p.headline ? " · " : ""}${p.headline ?? ""}</p>`
      : ""}
    ${p && p.target_roles.length ? html`<p class="muted">Ищем: ${p.target_roles.join(", ")}</p>` : ""}
    ${stored?.parseError ? html`<p class="warn">${stored.parseError}</p>` : ""}
    <a href="/app/profile">Открыть анкету</a>`;
}

const FORMAT_LABELS: Record<(typeof WORK_FORMATS)[number], string> = { remote: "Удалённо", hybrid: "Гибрид", onsite: "В офисе" };
const EMPLOYMENT_LABELS: Record<(typeof EMPLOYMENT)[number], string> = {
  full_time: "Полная занятость",
  part_time: "Частичная",
  contract: "Контракт / B2B",
};
const SENIORITY_LABELS: Record<(typeof SENIORITY)[number], string> = {
  junior: "Junior",
  middle: "Middle",
  senior: "Senior",
  lead: "Lead",
};

function uploadForm(hasResume = false) {
  return html`<form method="post" action="/app/cv" enctype="multipart/form-data">
    <input type="file" name="cv" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" required />
    <p class="muted" style="font-size:14px">PDF или DOCX до 5 МБ. Заполнение анкеты занимает до минуты.</p>
    <button type="submit">${hasResume ? "Загрузить новое резюме" : "Загрузить резюме"}</button>
  </form>`;
}

export function profilePage(
  stored: StoredProfile | null,
  resume: ResumeRow | null,
  opts: { saved?: boolean; error?: string } = {},
) {
  const p = stored?.profile;
  const f = p ? profileToForm(p) : null;
  const text = (name: string, label: string, value: string | number | null | undefined, hint = "") =>
    html`<label for="${name}">${label}${hint ? html` <span class="hint">${hint}</span>` : ""}</label>
      <input id="${name}" name="${name}" type="text" value="${value ?? ""}" />`;
  const area = (name: string, label: string, value: string, hint = "") =>
    html`<label for="${name}">${label}${hint ? html` <span class="hint">${hint}</span>` : ""}</label>
      <textarea id="${name}" name="${name}">${value}</textarea>`;
  const checks = <T extends string>(name: string, all: readonly T[], labels: Record<T, string>, on: T[]) =>
    html`<div class="checks">
      ${all.map(
        (v) => html`<label><input type="checkbox" name="${name}" value="${v}" ${on.includes(v) ? "checked" : ""} /> ${labels[v]}</label>`,
      )}
    </div>`;

  const resumeBlock = resume
    ? html`<p>Загружено: <a href="/app/cv">${resume.filename}</a>
          <span class="muted">(${Math.max(1, Math.round(resume.size / 1024))} КБ)</span></p>
        ${stored?.parseError ? html`<p class="warn">${stored.parseError}</p>` : ""}
        ${stored?.source === "ai" && !stored.parseError ? html`<p class="ok">Анкета заполнена по резюме. Проверьте и поправьте.</p>` : ""}
        <form method="post" action="/app/profile/refill"><button class="link" type="submit">Заполнить анкету по резюме заново</button></form>
        <hr style="border:0;border-top:1px solid var(--line);margin:16px 0" />
        ${uploadForm(true)}`
    : uploadForm();

  return layout(
    "Анкета — Otklikator",
    html`<p><a href="/app">← Кабинет</a></p>
      <h1>Резюме и анкета</h1>
      <p class="muted">По анкете мы подбираем вакансии и пишем письма. Ничего не придумываем: только то, что здесь.</p>
      ${opts.error ? html`<p class="warn">${opts.error}</p>` : ""}
      ${opts.saved ? html`<p class="ok">Анкета сохранена.</p>` : ""}
      <div class="card"><h2 style="margin-top:0">Резюме</h2>${resumeBlock}</div>
      ${html`<form method="post" action="/app/profile" class="card">
            <h2 style="margin-top:0">Кто вы</h2>
            ${text("full_name", "Имя и фамилия", p?.full_name)}
            ${text("headline", "Кратко о себе", p?.headline, "одна строка, например «Backend-разработчик (Python)»")}
            ${area("summary", "Сильные стороны", p?.summary ?? "")}
            <div class="row">
              <div>
                <label for="seniority">Уровень</label>
                <select id="seniority" name="seniority">
                  <option value="">—</option>
                  ${SENIORITY.map((s) => html`<option value="${s}" ${p?.seniority === s ? "selected" : ""}>${SENIORITY_LABELS[s]}</option>`)}
                </select>
              </div>
              <div>${text("years_experience", "Лет опыта", p?.years_experience)}</div>
            </div>

            <h2>Что ищем</h2>
            ${area("target_roles", "Роли", f?.target_roles ?? "", "по одной в строке")}
            ${area("skills", "Стек и навыки", f?.skills ?? "", "по одному в строке, важные первыми")}
            <label>Формат работы</label>
            ${checks("work_formats", WORK_FORMATS, FORMAT_LABELS, p?.work_formats ?? [])}
            <label>Занятость</label>
            ${checks("employment_types", EMPLOYMENT, EMPLOYMENT_LABELS, p?.employment_types ?? [])}
            ${text("location", "Где вы живёте", p?.location, "город, страна")}
            <label for="relocation">Переезд</label>
            <select id="relocation" name="relocation">
              <option value="" ${p?.relocation == null ? "selected" : ""}>Не указано</option>
              <option value="yes" ${p?.relocation === true ? "selected" : ""}>Готов(а) к переезду</option>
              <option value="no" ${p?.relocation === false ? "selected" : ""}>Без переезда</option>
            </select>
            <div class="row">
              <div>${text("salary_min", "Зарплата от, в месяц", p?.salary_min)}</div>
              <div>${text("salary_currency", "Валюта", p?.salary_currency ?? "EUR")}</div>
            </div>
            ${area("avoid", "Не предлагать", f?.avoid ?? "", "роли, стек или сферы, по одному в строке")}

            <h2>Опыт</h2>
            ${area(
              "experience",
              "Места работы",
              f?.experience ?? "",
              "«Должность | Компания | Период», ниже достижения строками с «-»; места разделяйте пустой строкой",
            )}
            ${area("languages", "Языки", f?.languages ?? "", "«English — C1», по одному в строке")}
            ${area("facts", "Ответы для форм откликов", f?.facts ?? "", "«Вопрос: ответ», по одному в строке")}

            <h2>Контакты для откликов</h2>
            ${text("contact_email", "Email", p?.contacts.email)}
            ${text("contact_phone", "Телефон", p?.contacts.phone)}
            ${text("contact_telegram", "Telegram", p?.contacts.telegram)}
            ${text("contact_linkedin", "LinkedIn", p?.contacts.linkedin)}
            ${text("contact_github", "GitHub", p?.contacts.github)}
            ${text("contact_website", "Сайт или портфолио", p?.contacts.website)}
            <button type="submit">Сохранить анкету</button>
          </form>`}`,
  );
}

// --- Подходящие вакансии ---

export function matchesPage(matches: MatchView[], active: boolean) {
  const items = matches.map(
    (m) => html`<div class="card" style="padding:16px 20px;margin:12px 0">
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:baseline">
        <a href="${m.url}" target="_blank" rel="noopener noreferrer" style="font-weight:600">${m.title}</a>
        <span class="muted" title="Насколько вакансия подходит по анкете">${m.score}</span>
      </div>
      <p class="muted" style="margin:4px 0 8px">${m.company}${m.location ? html` · ${m.location}` : ""}${hasFlag(m.flags, "CONTRACT") ? " · контракт" : ""}</p>
      ${m.reasons.length ? html`<p class="hint" style="margin:0">${m.reasons.join(" · ")}</p>` : ""}
      <form method="post" action="/app/matches/${m.seq}/hide"><button class="link" type="submit" style="font-size:14px">Не подходит</button></form>
    </div>`,
  );
  return layout(
    "Подходящие вакансии — Otklikator",
    html`<p><a href="/app">← Кабинет</a></p>
      <h1>Подходящие вакансии</h1>
      <p class="muted">Подбираем по вашей анкете из открытых источников, список обновляется несколько раз в час.
        ${active ? "" : html`Чтобы мы сами писали письма и откликались, <a href="/app">включите автопоиск</a>.`}</p>
      ${matches.length ? items : html`<div class="card"><p class="muted">Пока ничего не нашли. Проверьте, что в <a href="/app/profile">анкете</a> указаны целевые роли и стек.</p></div>`}`,
  );
}
