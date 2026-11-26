# Эксплуатация

## Среды

| | Staging (тест) | Прод |
|---|---|---|
| Адрес | https://otklikator.mrfilldev.workers.dev | https://otklikator.app (custom domain) |
| Worker | `otklikator` | `otklikator-prod` |
| Конфиг | верхний блок `wrangler.toml` | `[env.production]`, флаг `--env production` |
| D1 | `otklikator` | `otklikator-prod` |
| R2 | `otklikator-cv` | `otklikator-cv-prod` |
| Stripe | test mode, test-ключи | live mode, live-ключи; webhook на `https://otklikator.app/stripe/webhook` |
| Отправитель писем | `onboarding@resend.dev` (работает только на адрес владельца аккаунта Resend) | `noreply@otklikator.app` (домен подтверждён в Resend) |
| Cron | `*/20 * * * *` | тот же (`[triggers]` наследуется в `[env.production]`) |

Публичные переменные (`APP_URL`, `STRIPE_PRICE_ID`, `EMAIL_FROM`, `OPENROUTER_MODEL`) лежат в `wrangler.toml`
для каждой среды отдельно.

Wrangler залогинен на Mac Влада в `~/DEV/2026/otklikator`, все команды ниже запускаются оттуда. В облачном
контейнере Claude ключей Cloudflare нет.

## Секреты

Значения никогда не коммитятся и не пересылаются в чат: только `wrangler secret put` (или дашборд Cloudflare →
воркер → Variables and Secrets) и локальный `.dev.vars` (в `.gitignore`, пример — `.dev.vars.example`).

| Секрет | Зачем | Если нет |
|---|---|---|
| `STRIPE_SECRET_KEY` | Stripe API (лучше restricted key: Checkout Sessions, Customers, Subscriptions, Customer portal) | оплата не работает |
| `STRIPE_WEBHOOK_SECRET` | проверка подписи вебхука (`whsec_…` у endpoint'а в Stripe) | вебхуки отклоняются |
| `RESEND_API_KEY` | отправка писем | письма не уходят, текст печатается в лог (удобно для `wrangler dev`) |
| `OPENROUTER_API_KEY` | автозаполнение анкеты по CV | CV сохраняется, анкета заполняется вручную |

```sh
cd ~/DEV/2026/otklikator
npx wrangler secret put STRIPE_SECRET_KEY                    # staging
npx wrangler secret put STRIPE_SECRET_KEY --env production   # прод
# так же STRIPE_WEBHOOK_SECRET, RESEND_API_KEY, OPENROUTER_API_KEY
npx wrangler secret list --env production                    # проверить, что заданы (значения не показывает)
```

## Деплой

```sh
cd ~/DEV/2026/otklikator
git checkout main && git pull
npm install
npm test && npm run typecheck

npm run deploy:cf     # staging: миграции D1 otklikator --remote, затем wrangler deploy
npm run deploy:prod   # прод: миграции D1 otklikator-prod --remote --env production, затем wrangler deploy --env production
```

Сначала staging, проверить вход, загрузку CV и `/app/matches`, потом прод. Обе команды сначала применяют
новые миграции, поэтому отдельный шаг миграций при обычном деплое не нужен.

Первый деплой с нуля (уже сделано для обеих сред):

```sh
npx wrangler d1 create otklikator-prod          # id → database_id в wrangler.toml
npx wrangler r2 bucket create otklikator-cv-prod
# секреты (см. выше), затем
npm run deploy:prod
```

Дальше в Stripe: endpoint вебхука с пятью событиями (см. [architecture.md](architecture.md#оплата-srclibbillingts)),
Customer Portal (отмена и смена карты), Price recurring €5/week в `STRIPE_PRICE_ID`.

## Миграции

- Файлы в `migrations/`, нумерация `NNNN_описание.sql`, применяются по порядку и один раз
  (wrangler ведёт учёт в самой базе).
- Только вперёд: уже применённый файл не редактировать, исправление — новой миграцией.
- Применяются сами в `deploy:cf` / `deploy:prod`. Вручную:

```sh
npm run db:migrate:local                                                   # локальная база для wrangler dev
npx wrangler d1 migrations list otklikator-prod --remote --env production  # что применено в проде
npx wrangler d1 migrations apply otklikator-prod --remote --env production
```

Текущие миграции: `0001_init` (пользователи, вход, подписки), `0002_profile` (CV и анкета),
`0003_vacancies` (вакансии, совпадения, журнал фидов), `0004_feed_sources` (расписание источников).

## Локальный запуск

```sh
npm install
cp .dev.vars.example .dev.vars        # тестовые ключи Stripe
npm run db:migrate:local
npm run dev                            # http://localhost:8787
```

Без `RESEND_API_KEY` ссылка входа печатается в консоль `wrangler dev`. Вебхуки:
`stripe listen --forward-to localhost:8787/stripe/webhook` (печатает `whsec_…` для `.dev.vars`), карта `4242 4242 4242 4242`.
Cron локально: `npx wrangler dev --test-scheduled`, затем `curl "http://localhost:8787/__scheduled?cron=*/20+*+*+*+*"`.

## Runbook

### Логи прода

```sh
npx wrangler tail --env production
```

Имя воркера не указывать: с `--env production` wrangler сам берёт `otklikator-prod` из `wrangler.toml`.
Полезные строки: `[jobs] feeds=… new=…` (каждый запуск Cron),
`[jobs] cron failed`, `[jobs] alert mail failed`, `[error] METHOD path` (ошибки HTTP).
Запуски Cron видны и в дашборде Cloudflare: Workers & Pages → `otklikator-prod` (настройки триггеров и логи).

### Работает ли Cron и фиды

```sh
# последние опросы
npx wrangler d1 execute otklikator-prod --remote --env production --command \
  "SELECT task, fetched, inserted, error, datetime(ran_at,'unixepoch') AS at FROM feed_runs ORDER BY id DESC LIMIT 30"

# сколько опросов и ошибок за сутки
npx wrangler d1 execute otklikator-prod --remote --env production --command \
  "SELECT COUNT(*) AS runs, SUM(error IS NOT NULL) AS errors, SUM(inserted) AS new FROM feed_runs WHERE ran_at > unixepoch() - 86400"

# источники на паузе или с ошибками
npx wrangler d1 execute otklikator-prod --remote --env production --command \
  "SELECT task, fails, blocks, datetime(paused_until,'unixepoch') AS paused, last_error FROM feed_sources WHERE fails > 0 OR paused_until > unixepoch()"

# вакансии и совпадения
npx wrangler d1 execute otklikator-prod --remote --env production --command \
  "SELECT (SELECT COUNT(*) FROM vacancies) AS vacancies, (SELECT COUNT(*) FROM matches WHERE status='new') AS new_matches"
```

Пустой `feed_runs` при живом воркере значит, что Cron не запускается или падает до записи: смотреть `wrangler tail`
и Trigger Events в дашборде, проверить, что после деплоя у `otklikator-prod` есть cron `*/20 * * * *`.

### Снять паузу с источника

Пауза снимается сама. Чтобы опросить источник раньше:

```sh
npx wrangler d1 execute otklikator-prod --remote --env production --command \
  "UPDATE feed_sources SET next_run_at = 0, paused_until = NULL WHERE task = 'remoteok'"
```

### Оплата

- Подписка не активировалась после оплаты: Stripe Dashboard → Developers → Webhooks → endpoint прода → доставки
  событий (ответ должен быть 200). Затем `SELECT * FROM subscriptions WHERE user_id = '…'`.
- 400 на вебхуке почти всегда — не тот `STRIPE_WEBHOOK_SECRET` (test вместо live или наоборот).

### Письма не приходят

Проверить `RESEND_API_KEY` в нужной среде, статус домена `otklikator.app` в Resend и логи Resend. На staging
отправитель `onboarding@resend.dev` доставляет только на адрес владельца аккаунта Resend.
