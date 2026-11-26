import type { Env } from "../env";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

/**
 * Отправка через Resend. Без RESEND_API_KEY (локальная разработка) письмо
 * печатается в консоль wrangler dev, чтобы можно было пройти вход без почты.
 */
export async function sendMail(env: Env, mail: Mail): Promise<void> {
  if (!env.RESEND_API_KEY) {
    console.log(`[mail] to=${mail.to} subject=${mail.subject}\n${mail.text}`);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [mail.to], subject: mail.subject, text: mail.text }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

export function loginMail(appUrl: string, email: string, token: string): Mail {
  const link = `${appUrl}/auth/verify?token=${encodeURIComponent(token)}`;
  return {
    to: email,
    subject: "Подтвердите email — Otklikator",
    text: `Чтобы подтвердить адрес и войти, откройте ссылку (действует 24 часа):\n\n${link}\n\nЕсли вы не регистрировались, просто проигнорируйте письмо.`,
  };
}

export function paymentFailedMail(appUrl: string, email: string): Mail {
  return {
    to: email,
    subject: "Не прошла оплата подписки — Otklikator",
    text: `Не получилось списать оплату за автопоиск. Обновите карту в кабинете:\n\n${appUrl}/app\n\nПока оплата не пройдёт, автопоиск на паузе.`,
  };
}
