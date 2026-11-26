-- Пользователи: регистрация по email, подтверждение через одноразовую ссылку.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  email_verified_at INTEGER,
  stripe_customer_id TEXT UNIQUE,
  created_at INTEGER NOT NULL
);

-- Одноразовые ссылки входа/подтверждения. Храним только sha256 от токена.
CREATE TABLE login_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX login_tokens_user ON login_tokens(user_id, created_at);

-- Сессии (cookie). Храним только sha256 от id сессии.
CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- Подписки Stripe: источник правды — вебхуки, здесь их последнее состояние.
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,               -- sub_...
  user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL,              -- active, trialing, past_due, canceled, ...
  price_id TEXT,
  current_period_end INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX subscriptions_user ON subscriptions(user_id);

-- Обработанные события Stripe (защита от повторной доставки).
CREATE TABLE stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
