-- Отклики: письмо под вакансию (черновик модели, правки человека) и что с ним стало.
-- Одна строка на пару человек × вакансия. Пока вакансия в matches со статусом hidden/applied, cleanup её не удаляет,
-- поэтому отправленные отклики живут столько же, сколько совпадение.
CREATE TABLE applications (
  user_id TEXT NOT NULL REFERENCES users(id),
  vacancy_seq INTEGER NOT NULL REFERENCES vacancies(seq) ON DELETE CASCADE,
  company_key TEXT NOT NULL,              -- нормализованная компания: правило «не чаще раза в 2 недели в одну компанию»
  to_email TEXT,                          -- куда слать: найден в тексте вакансии или вписан человеком
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',   -- draft | sent | skipped
  channel TEXT,                           -- manual (человек отправил сам) | gmail (этап 4, PR 9)
  model TEXT,                             -- какой моделью написан черновик
  unverified TEXT NOT NULL DEFAULT '[]',  -- JSON: цифры из письма, которых нет ни в анкете, ни в вакансии
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sent_at INTEGER,
  PRIMARY KEY (user_id, vacancy_seq)
);
CREATE INDEX applications_company ON applications(user_id, company_key, sent_at);
CREATE INDEX applications_created ON applications(user_id, created_at);
