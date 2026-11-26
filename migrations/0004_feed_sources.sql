-- Расписание и здоровье каждого источника вакансий (вместо общего круга по курсору).
-- Каждый источник опрашивается со своей частотой; на 429/403 уходит на паузу (сутки, при повторе дольше);
-- после трёх неудач подряд — одно письмо владельцу.
CREATE TABLE feed_sources (
  task TEXT PRIMARY KEY,                  -- ключ из FEED_TASKS, например "remotive" или "greenhouse:gitlab"
  next_run_at INTEGER NOT NULL,           -- не опрашивать раньше
  fails INTEGER NOT NULL DEFAULT 0,       -- неудач подряд
  blocks INTEGER NOT NULL DEFAULT 0,      -- отказов 429/403 подряд (для удвоения паузы)
  paused_until INTEGER,                   -- пауза после 429/403
  last_ok_at INTEGER,
  last_error TEXT,
  alerted_at INTEGER,                     -- когда писали владельцу про эту серию неудач
  updated_at INTEGER NOT NULL
);
