# Otklikator

Платформа автопоиска вакансий (и, на этапе 4, автооткликов): человек входит по email, загружает CV, анкета заполняется
сама, а за €5 в неделю платформа каждые 20 минут собирает свежие вакансии из открытых фидов и подбирает подходящие
под его анкету.

- Прод: https://otklikator.app (worker `otklikator-prod`)
- Staging: https://otklikator.mrfilldev.workers.dev (worker `otklikator`, test-ключи Stripe)
- План MVP: https://claude.ai/artifact/AswwCPj4ePRCJJLEBDYYYg

Стек: Cloudflare Workers (TypeScript, Hono), D1, R2, Cron Triggers, Stripe (Checkout, Customer Portal, вебхуки,
Managed Payments), Resend, OpenRouter (GLM) для разбора CV.

## Документация

Подробно — в [docs/](docs/README.md):

- [Продукт и путь пользователя](docs/product.md)
- [Архитектура: маршруты, схема D1, CV, оплата, конвейер вакансий, скоринг](docs/architecture.md)
- [Источники вакансий и политика опроса](docs/feeds.md)
- [Эксплуатация: среды, секреты, деплой, миграции, runbook](docs/operations.md)
- [Дорожная карта и открытые решения](docs/roadmap.md)

## Быстрый старт

```sh
npm install
cp .dev.vars.example .dev.vars        # тестовые ключи Stripe
npm run db:migrate:local
npm run dev                            # http://localhost:8787
npm test && npm run typecheck
```

Деплой (из `~/DEV/2026/otklikator`, где залогинен wrangler): `npm run deploy:cf` — staging, `npm run deploy:prod` — прод.
Обе команды сначала применяют миграции D1. Секреты — только `npx wrangler secret put <ИМЯ> [--env production]`,
никогда в коде или в чате (список — в [docs/operations.md](docs/operations.md#секреты)).

## Структура

- `src/index.ts` — маршруты и обработчик Cron.
- `src/lib/auth.ts` — вход по email, одноразовые ссылки, сессии (в БД только sha256 токенов).
- `src/lib/billing.ts` — Stripe: Checkout, Portal, вебхуки.
- `src/lib/cv.ts`, `src/lib/profile.ts` — CV (R2, текст из PDF/DOCX) и анкета (схема, автозаполнение через OpenRouter).
- `src/lib/email.ts` — письма через Resend.
- `src/lib/jobs/` — фиды вакансий, дедуп, скоринг и подбор.
- `src/views.ts` — HTML-страницы.
- `migrations/` — схема D1. `test/` — тесты (vitest в рантайме Workers).
- `docs/` — документация.
