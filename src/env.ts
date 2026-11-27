export interface Env {
  DB: D1Database;
  CV_BUCKET: R2Bucket;
  APP_URL: string;
  STRIPE_PRICE_ID: string;
  EMAIL_FROM: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  RESEND_API_KEY?: string;
  /** Ключ OpenRouter для автозаполнения анкеты по CV. Без него анкету заполняют вручную. */
  OPENROUTER_API_KEY?: string;
  /** Модель на OpenRouter для разбора CV, например z-ai/glm-5.3. */
  OPENROUTER_MODEL?: string;
  /** Поддомен для писем-откликов через Resend (например apply.otklikator.app). Без него очередь не отправляется. */
  APPLY_FROM_DOMAIN?: string;
}

export interface User {
  id: string;
  email: string;
  email_verified_at: number | null;
  stripe_customer_id: string | null;
  created_at: number;
}

export const now = () => Math.floor(Date.now() / 1000);
