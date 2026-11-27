-- Адрес для отклика по компании, когда его нет в тексте вакансии (в PoC адрес был лишь у ~5 % вакансий).
-- Ищем сайт компании и адрес на нём (jobs@, careers@, hr@, hello@…), результат кешируем на компанию.
CREATE TABLE companies (
  company_key TEXT PRIMARY KEY,           -- как в applications.company_key (нормализованное название)
  name TEXT NOT NULL,
  domain TEXT,                            -- найденный сайт компании
  email TEXT,                             -- адрес для отклика на домене компании
  email_source TEXT,                      -- страница или сервис, где нашли адрес
  status TEXT NOT NULL,                   -- found | no_email | no_domain | error
  checked_at INTEGER NOT NULL
);
CREATE INDEX companies_checked ON companies(status, checked_at);
