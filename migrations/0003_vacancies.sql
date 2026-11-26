-- Вакансии из открытых фидов (без браузера): агрегаторы удалёнки, ATS-доски компаний, Telegram-каналы.
-- Одна строка на вакансию; повтор той же вакансии из другого источника отсекается по fingerprint.
CREATE TABLE vacancies (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,  -- порядок появления: курсор для подбора по пользователям
  id TEXT NOT NULL UNIQUE,                -- "<источник>:<id в источнике>", например "gh:123456"
  source TEXT NOT NULL,                   -- rok, wwr, him, rem, jbc, hn, tg, gh, lv, ash, wk, rc, sr
  title TEXT NOT NULL,
  company TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',   -- очищенный текст, до 4000 символов
  flags TEXT NOT NULL DEFAULT '',         -- через пробел: REMOTE WORLD US_ONLY CONTRACT CY
  fingerprint TEXT NOT NULL UNIQUE,       -- нормализованные «компания|должность»: дедуп между источниками
  posted_at INTEGER,                      -- когда опубликована (если источник говорит)
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX vacancies_first_seen ON vacancies(first_seen_at);
CREATE INDEX vacancies_last_seen ON vacancies(last_seen_at);

-- Подходящие вакансии для конкретного человека: оценка по его анкете и почему.
CREATE TABLE matches (
  user_id TEXT NOT NULL REFERENCES users(id),
  vacancy_seq INTEGER NOT NULL REFERENCES vacancies(seq) ON DELETE CASCADE,
  score INTEGER NOT NULL,                 -- 0–100
  reasons TEXT NOT NULL,                  -- JSON-массив коротких причин для человека
  status TEXT NOT NULL DEFAULT 'new',     -- new | hidden | applied (дальше: отклики)
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, vacancy_seq)
);
CREATE INDEX matches_user_score ON matches(user_id, status, score DESC);

-- До какой вакансии уже посчитан подбор для человека. При правке анкеты пересчитываем свежие вакансии заново.
CREATE TABLE match_state (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  last_seq INTEGER NOT NULL,
  profile_updated_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Состояние сбора: курсор по кругу источников (за один запуск Cron обходим часть, чтобы уложиться в лимит подзапросов).
CREATE TABLE feed_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Журнал опросов источников: сколько пришло, сколько новых, ошибка. Для отладки и здоровья фидов.
CREATE TABLE feed_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT NOT NULL,                     -- например "remotive:software-dev" или "greenhouse:gitlab"
  fetched INTEGER NOT NULL,
  inserted INTEGER NOT NULL,
  error TEXT,
  ran_at INTEGER NOT NULL
);
CREATE INDEX feed_runs_task ON feed_runs(task, ran_at);
