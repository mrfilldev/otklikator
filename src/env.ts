export interface Env {
  DB: D1Database;
  CV_BUCKET: R2Bucket;
  APP_URL: string;
  STRIPE_PRICE_ID: string;
  EMAIL_FROM: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  RESEND_API_KEY?: string;
  /** Ключ Claude API для автозаполнения анкеты по CV. Без него анкету заполняют вручную. */
  ANTHROPIC_API_KEY?: string;
}

export interface User {
  id: string;
  email: string;
  email_verified_at: number | null;
  stripe_customer_id: string | null;
  created_at: number;
}

export const now = () => Math.floor(Date.now() / 1000);
