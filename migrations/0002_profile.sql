-- Загруженные CV. Сам файл лежит в R2 (ключ r2_key), здесь метаданные и извлечённый текст.
CREATE TABLE resumes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  r2_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,       -- application/pdf или ...wordprocessingml.document
  size INTEGER NOT NULL,
  text TEXT,                        -- текст DOCX (для PDF модель читает файл сама, текст не храним)
  created_at INTEGER NOT NULL
);
CREATE INDEX resumes_user ON resumes(user_id, created_at);

-- Анкета-портрет: одна на пользователя, JSON по схеме ProfileSchema (src/lib/profile.ts).
CREATE TABLE profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  data TEXT NOT NULL,
  source TEXT NOT NULL,             -- ai (заполнено по CV) | user (человек сохранил правки)
  resume_id TEXT REFERENCES resumes(id),
  parse_error TEXT,                 -- почему не удалось заполнить автоматически (показываем человеку)
  updated_at INTEGER NOT NULL
);
