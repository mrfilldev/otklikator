# Otklikator

Платформа автооткликов: человек регистрируется по email, загружает CV, подписывается на автопоиск,
а платформа каждый день находит вакансии, пишет письма и отправляет отклики с его почты.
План MVP: https://claude.ai/artifact/AswwCPj4ePRCJJLEBDYYYg

Стек: Cloudflare Workers (TypeScript, Hono), D1, Stripe (Checkout + Customer Portal + вебхуки), Resend для писем.

## Что уже есть (этап 1)

- Регистрация и вход по email: одноразовая ссылка (24 ч), подтверждение адреса, сессия в HttpOnly-cookie на 30 дней.
  Пароля нет. На один адрес — не чаще одного письма в минуту.
- Кабинет `/app`: статус подписки, кнопка «Включить автопоиск», «Управлять подпиской».
- Stripe: Checkout в режиме подписки, Customer Portal, вебхук `/stripe/webhook` с проверкой подписи
  и защитой от повторной доставки. Доступ к автопоиску определяется по таблице `subscriptions` (статусы `active`, `trialing`).

## Этап 2: резюме и анкета

- `/app/profile`: загрузка CV (PDF или DOCX до 5 МБ, тип проверяется по содержимому). Оригинал лежит в R2 (`CV_BUCKET`),
  метаданные — в таблице `resumes`, его можно скачать (`/app/cv`): этот файл потом уйдёт работодателям.
- Анкета-портрет (`profiles`, JSON по `ProfileSchema` в `src/lib/profile.ts`): роли, стек, уровень и опыт, формат и занятость,
  локация, зарплата, языки, места работы с достижениями, готовые ответы для форм откликов, контакты, «не предлагать».
- Автозаполнение: Claude API (structured outputs). PDF уходит в модель файлом (читает и сканы), из DOCX достаём текст.
  Модель заполняет только то, что есть в CV; формат, зарплату и «не предлагать» человек указывает сам,
  и повторная загрузка CV их не затирает. Без `ANTHROPIC_API_KEY` или при сбое CV сохраняется, анкета заполняется вручную,
  есть кнопка «Заполнить по резюме заново».

Перед первым деплоем этапа 2:

```sh
npx wrangler r2 bucket create otklikator-cv
npx wrangler r2 bucket create otklikator-cv-prod
npx wrangler secret put ANTHROPIC_API_KEY                    # тест
npx wrangler secret put ANTHROPIC_API_KEY --env production   # прод
```

Миграция `0002_profile.sql` применяется сама в `deploy:cf` / `deploy:prod`.

## Локальный запуск

```sh
npm install
cp .dev.vars.example .dev.vars        # вписать тестовые ключи Stripe
npm run db:migrate:local
npm run dev                            # http://localhost:8787
```

Без `RESEND_API_KEY` письма не отправляются: ссылка для входа печатается в консоль `wrangler dev`.

Вебхуки локально: `stripe listen --forward-to localhost:8787/stripe/webhook` (он печатает `whsec_...` для `.dev.vars`),
оплата — тестовой картой `4242 4242 4242 4242`.

## Тесты

```sh
npm test          # vitest в рантайме Workers (Miniflare + D1)
npm run typecheck
```

## Настройка Stripe (сначала test mode)

1. Product «Автопоиск» → Price: recurring, интервал **week**, $5 (или €5). Его `price_...` — в `STRIPE_PRICE_ID` в `wrangler.toml`.
2. Settings → Billing → Customer portal: разрешить отмену подписки и смену карты.
3. Developers → Webhooks → endpoint `https://<домен>/stripe/webhook`, события:
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.payment_failed`. Signing secret → `STRIPE_WEBHOOK_SECRET`.
4. Ключ API: лучше restricted key с правами на Checkout Sessions, Customers, Subscriptions, Customer portal.

Ключи никогда не коммитятся и не пересылаются в чат: только `wrangler secret put` и локальный `.dev.vars`.

## Деплой через Cloudflare Workers Builds (рекомендуется)

Cloudflare сам собирает и деплоит воркер при каждом пуше в `main`, токены в GitHub не нужны.

1. D1 → Create database `otklikator`; Database ID — в `database_id` в `wrangler.toml`.
2. Workers & Pages → Create → Import a repository → `mrfilldev/otklikator`, ветка `main`,
   Deploy command: `npm run deploy:cf` (сначала применяет миграции D1, потом деплоит).
3. Настройки воркера → Variables and Secrets → тип Secret: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`.
4. `APP_URL` в `wrangler.toml` = адрес воркера (`https://otklikator.<subdomain>.workers.dev` или свой домен).

## Деплой вручную

```sh
npx wrangler d1 create otklikator      # id → database_id в wrangler.toml
npm run db:migrate:remote
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret put RESEND_API_KEY
# в wrangler.toml: APP_URL = https://<домен>, EMAIL_FROM с доменом, подтверждённым в Resend
npm run deploy
```

## Этап 3: поиск и скоринг вакансий

- Cron Trigger каждые 20 минут (`[triggers]` в `wrangler.toml`, наследуется в прод) вызывает `runJobsCron` (`src/lib/jobs/pipeline.ts`).
- Источники без браузера (`src/lib/jobs/sources.ts`, порт `resume/scripts/us_feeds.py` и `adjacent_feeds.py`): RemoteOK,
  We Work Remotely (RSS), Remotive, Himalayas, Jobicy, HN «Who is hiring» и «Seeking freelancer», публичные Telegram-каналы
  (`t.me/s/…`), ATS-доски компаний (Greenhouse, Lever, Ashby, Workable, Recruitee, SmartRecruiters) — список в
  `src/lib/jobs/boards.ts` (из `ats_companies.json`, `cyprus_companies.csv`, `us_startups.csv`). LinkedIn не берём.
  Фиды тянем широко (любой стек, продукт, проекты): отбор под человека делает скоринг.
- За один запуск обходим `FEEDS_PER_RUN` источников по кругу (курсор в `feed_state`), чтобы уложиться в лимиты подзапросов
  и запросов к D1. Журнал опросов с ошибками — `feed_runs` (хранится неделю).
- Дедуп: `vacancies.id` (`<источник>:<id>`) и `fingerprint` (компания + должность), так одна вакансия с RemoteOK и из
  Greenhouse компании сохраняется один раз. Вакансии, пропавшие из фидов больше 45 дней назад, удаляются.
- Скоринг (`src/lib/jobs/score.ts`, обобщение `jobslib.score` + `triage.py`): роль из анкеты (и соседние), стек, грейд,
  локация и формат, контракт/частичная занятость, свежесть → 0–100 и короткие причины. Отсекаем только «не хочу»,
  чужую роль или язык, US-only, офис в другой стране (если человек не готов к переезду) и стажировки для опытных.
  Порог `MIN_SCORE`.
- Подбор (`matches`) считается для всех подтверждённых пользователей с анкетой, с курсора `match_state`; правка анкеты
  пересчитывает свежие вакансии. Не больше 3 новых совпадений от одной компании за пересчёт. Страница `/app/matches`,
  кнопка «Не подходит» скрывает вакансию.

Миграция `0003_vacancies.sql` применяется сама в `deploy:cf` / `deploy:prod`. Локально cron можно дёрнуть так:
`npx wrangler dev --test-scheduled`, затем `curl "http://localhost:8787/__scheduled?cron=*/20+*+*+*+*"`.

## Структура

- `src/index.ts` — маршруты.
- `src/lib/auth.ts` — регистрация, одноразовые ссылки, сессии (в БД только sha256 токенов).
- `src/lib/billing.ts` — Stripe: Checkout, Portal, обработка вебхуков.
- `src/lib/email.ts` — письма через Resend.
- `src/lib/jobs/` — фиды вакансий, дедуп, скоринг и подбор (Cron).
- `src/views.ts` — HTML-страницы.
- `migrations/` — схема D1.
- `test/` — тесты.
