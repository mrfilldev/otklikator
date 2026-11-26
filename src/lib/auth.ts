import { now, type User } from "../env";
import { randomToken, sha256 } from "./crypto";

export const LOGIN_TOKEN_TTL = 24 * 3600; // ссылка из письма живёт 24 часа
export const SESSION_TTL = 30 * 24 * 3600; // сессия — 30 дней
export const RESEND_COOLDOWN = 60; // не чаще одного письма в минуту на адрес

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return email.length <= 254 && EMAIL_RE.test(email) ? email : null;
}

export async function getOrCreateUser(db: D1Database, email: string): Promise<User> {
  await db
    .prepare("INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)")
    .bind(crypto.randomUUID(), email, now())
    .run();
  return (await db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<User>())!;
}

/**
 * Создаёт одноразовую ссылку входа. Возвращает null, если письмо на этот адрес
 * уже отправляли меньше минуты назад (защита от спама чужих ящиков).
 */
export async function createLoginToken(db: D1Database, userId: string): Promise<string | null> {
  const recent = await db
    .prepare("SELECT 1 FROM login_tokens WHERE user_id = ? AND created_at > ?")
    .bind(userId, now() - RESEND_COOLDOWN)
    .first();
  if (recent) return null;
  const token = randomToken();
  await db
    .prepare("INSERT INTO login_tokens (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(token), userId, now() + LOGIN_TOKEN_TTL, now())
    .run();
  return token;
}

/** Гасит токен (один раз), подтверждает email. Возвращает пользователя или null. */
export async function consumeLoginToken(db: D1Database, token: string): Promise<User | null> {
  const hash = await sha256(token);
  const t = now();
  const res = await db
    .prepare("UPDATE login_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?")
    .bind(t, hash, t)
    .run();
  if (!res.meta.changes) return null;
  const row = await db.prepare("SELECT user_id FROM login_tokens WHERE token_hash = ?").bind(hash).first<{ user_id: string }>();
  if (!row) return null;
  await db
    .prepare("UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?")
    .bind(t, row.user_id)
    .run();
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(row.user_id).first<User>();
}

export async function createSession(db: D1Database, userId: string): Promise<string> {
  const sid = randomToken();
  await db
    .prepare("INSERT INTO sessions (id_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(sid), userId, now() + SESSION_TTL, now())
    .run();
  return sid;
}

export async function userBySession(db: D1Database, sid: string | undefined): Promise<User | null> {
  if (!sid) return null;
  return db
    .prepare("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ? AND s.expires_at > ?")
    .bind(await sha256(sid), now())
    .first<User>();
}

export async function deleteSession(db: D1Database, sid: string | undefined): Promise<void> {
  if (sid) await db.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(await sha256(sid)).run();
}
