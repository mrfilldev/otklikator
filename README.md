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

## Деплой

```sh
npx wrangler d1 create otklikator      # id → database_id в wrangler.toml
npm run db:migrate:remote
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret put RESEND_API_KEY
# в wrangler.toml: APP_URL = https://<домен>, EMAIL_FROM с доменом, подтверждённым в Resend
npm run deploy
```

## Структура

- `src/index.ts` — маршруты.
- `src/lib/auth.ts` — регистрация, одноразовые ссылки, сессии (в БД только sha256 токенов).
- `src/lib/billing.ts` — Stripe: Checkout, Portal, обработка вебхуков.
- `src/lib/email.ts` — письма через Resend.
- `src/views.ts` — HTML-страницы.
- `migrations/` — схема D1.
- `test/` — тесты.
