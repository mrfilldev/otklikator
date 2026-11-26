/**
 * Компании с открытыми ATS-досками (JSON без авторизации). Источник — resume/state/ats_companies.json
 * и строки cyprus_companies.csv / us_startups.csv, у которых страница вакансий на Greenhouse/Lever/Ashby/Workable/Recruitee/SmartRecruiters.
 * Компании с самописными страницами карьеры (их большинство в CSV) без браузера не читаются — их здесь нет.
 * Добавить компанию = дописать строку; мёртвая доска просто даёт ошибку в feed_runs и не мешает остальным.
 */
export type AtsKind = "greenhouse" | "greenhouse_eu" | "lever" | "lever_eu" | "ashby" | "workable" | "recruitee" | "smartrecruiters";

export interface AtsBoard {
  kind: AtsKind;
  slug: string;
  /** Название для карточки и дедупа (slug доски часто не похож на имя компании). */
  company: string;
  /** Регион, откуда компания попала в список: cy — Кипр, us — американские стартапы, intl — остальные. */
  region: "cy" | "us" | "intl";
}

const b = (kind: AtsKind, slug: string, company: string, region: AtsBoard["region"] = "intl"): AtsBoard => ({ kind, slug, company, region });

export const ATS_BOARDS: AtsBoard[] = [
  // state/ats_companies.json
  b("greenhouse", "gitlab", "GitLab"),
  b("greenhouse", "datadog", "Datadog"),
  b("greenhouse", "mongodb", "MongoDB"),
  b("greenhouse", "twilio", "Twilio"),
  b("greenhouse", "cloudflare", "Cloudflare"),
  b("greenhouse", "airtable", "Airtable"),
  b("greenhouse", "elastic", "Elastic"),
  b("greenhouse", "stripe", "Stripe"),
  b("greenhouse", "okta", "Okta"),
  b("greenhouse", "pagerduty", "PagerDuty"),
  b("greenhouse", "samsara", "Samsara"),
  b("greenhouse", "grafanalabs", "Grafana Labs"),
  b("greenhouse", "brex", "Brex"),
  b("greenhouse", "wise", "Wise"),
  b("greenhouse", "bitpanda", "Bitpanda"),
  b("greenhouse", "payoneer", "Payoneer"),
  b("greenhouse", "remote", "Remote"),
  b("lever", "crypto", "Crypto.com"),
  b("lever", "binance", "Binance"),
  b("lever", "palantir", "Palantir"),
  b("lever", "kraken", "Kraken"),
  b("ashby", "linear", "Linear"),
  b("ashby", "notion", "Notion"),
  b("ashby", "ramp", "Ramp"),
  b("ashby", "supabase", "Supabase"),
  b("ashby", "posthog", "PostHog"),
  b("ashby", "vercel", "Vercel"),
  b("ashby", "openai", "OpenAI"),
  b("ashby", "deel", "Deel"),
  b("ashby", "zapier", "Zapier"),
  b("ashby", "n8n", "n8n"),
  b("ashby", "airbyte", "Airbyte"),
  b("ashby", "sentry", "Sentry"),
  b("ashby", "render", "Render"),
  b("ashby", "cohere", "Cohere"),
  b("workable", "paysafe", "Paysafe"),
  b("workable", "playtech", "Playtech"),
  b("workable", "exness", "Exness"),
  b("workable", "softgames", "Softgames"),
  b("workable", "nexo", "Nexo"),
  b("workable", "wargaming", "Wargaming"),
  b("workable", "viber", "Viber"),
  b("workable", "grid-dynamics", "Grid Dynamics"),
  b("workable", "epam", "EPAM"),
  b("workable", "intellias", "Intellias"),
  b("workable", "ebury", "Ebury"),
  b("workable", "paymentsense", "Paymentsense"),
  // cyprus_companies.csv
  b("smartrecruiters", "Playtech", "Playtech", "cy"),
  b("workable", "learnworlds", "LearnWorlds", "cy"),
  b("lever_eu", "xm", "XM Group", "cy"),
  b("workable", "payabl", "payabl", "cy"),
  b("workable", "pepperstone", "Pepperstone", "cy"),
  b("workable", "intergotelecom", "SMS.to", "cy"),
  b("workable", "mercuryo", "Mercuryo", "cy"),
  b("workable", "fpmarkets", "FP Markets", "cy"),
  b("recruitee", "fortrade", "Fortrade", "cy"),
  b("workable", "freedomfinanceeu", "Freedom Finance Europe", "cy"),
  b("ashby", "welltech", "Welltech", "cy"),
  b("ashby", "kraken.com", "Kraken", "cy"),
  b("ashby", "holywater", "Holywater Tech", "cy"),
  b("lever", "Fliff", "Fliff", "cy"),
  b("greenhouse_eu", "finyard", "Finyard", "cy"),
  b("recruitee", "progaming", "Progaming", "cy"),
  // us_startups.csv
  b("ashby", "3ive", "3ive", "us"),
  b("ashby", "alternativepayments", "Alternative Payments", "us"),
  b("ashby", "polar", "Polar", "us"),
];

/** Публичные Telegram-каналы с вакансиями (читаются без аккаунта через t.me/s/<канал>). */
export const TG_CHANNELS = ["opento_dev", "remote_python_jobs", "forproducts", "Remoteit", "findmyremote_backend", "evacuatejobs"];
