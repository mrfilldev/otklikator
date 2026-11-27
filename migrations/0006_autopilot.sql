-- Автопилот: система сама пишет письма лучшим совпадениям и отправляет их через Resend.
-- Включается человеком явно (отклики уходят от его имени). Раз в сутки после 07:00 по Кипру — отбор и черновики,
-- письма встают в очередь и уходят через окно отмены (или сразу, если окно выключено).
CREATE TABLE autopilot (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  enabled INTEGER NOT NULL DEFAULT 0,
  review_window INTEGER NOT NULL DEFAULT 1, -- 1: письма уходят через окно отмены; 0: сразу
  daily_limit INTEGER NOT NULL DEFAULT 10,  -- писем в сутки
  min_score INTEGER NOT NULL DEFAULT 60,    -- минимальный балл совпадения
  last_planned_day TEXT,                    -- YYYY-MM-DD по Кипру: когда последний раз делали отбор
  updated_at INTEGER NOT NULL
);

-- Очередь отправки: status = 'queued' и scheduled_at — когда отправлять.
-- Новые статусы applications: queued (ждёт отправки), failed (Resend отказал после нескольких попыток).
ALTER TABLE applications ADD COLUMN scheduled_at INTEGER;
ALTER TABLE applications ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'; -- manual | autopilot
ALTER TABLE applications ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE applications ADD COLUMN send_error TEXT;
ALTER TABLE applications ADD COLUMN message_id TEXT;                     -- id письма в Resend
ALTER TABLE applications ADD COLUMN reported_at INTEGER;                 -- попало ли в ежедневный отчёт
CREATE INDEX applications_queue ON applications(status, scheduled_at);
