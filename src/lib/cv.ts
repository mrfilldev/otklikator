import { unzipSync, strFromU8 } from "fflate";
import { now, type Env } from "../env";

export const MAX_CV_BYTES = 5 * 1024 * 1024;
export const PDF_TYPE = "application/pdf";
export const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export type CvFile =
  | { kind: "pdf"; bytes: Uint8Array; contentType: typeof PDF_TYPE }
  | { kind: "docx"; bytes: Uint8Array; contentType: typeof DOCX_TYPE; text: string };

export class CvError extends Error {}

/** Проверяет файл по содержимому (не по расширению) и для DOCX достаёт текст. */
export function readCv(bytes: Uint8Array): CvFile {
  if (bytes.length === 0) throw new CvError("Файл пустой.");
  if (bytes.length > MAX_CV_BYTES) throw new CvError("Файл больше 5 МБ. Сожмите PDF или загрузите DOCX.");
  const head = String.fromCharCode(...bytes.subarray(0, 5));
  if (head === "%PDF-") return { kind: "pdf", bytes, contentType: PDF_TYPE };
  if (head.startsWith("PK")) {
    const text = docxText(bytes);
    if (text.length < 50) throw new CvError("В документе почти нет текста. Загрузите PDF.");
    return { kind: "docx", bytes, contentType: DOCX_TYPE, text };
  }
  throw new CvError("Нужен PDF или DOCX.");
}

/** Текст из word/document.xml: абзацы — строками, ячейки таблиц — через табуляцию. */
export function docxText(bytes: Uint8Array): string {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: (f) => f.name === "word/document.xml" });
  } catch {
    throw new CvError("Не получилось открыть DOCX. Сохраните резюме как PDF и загрузите снова.");
  }
  const xml = files["word/document.xml"];
  if (!xml) throw new CvError("Это не похоже на документ Word. Нужен PDF или DOCX.");
  return strFromU8(xml)
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:br[^>]*\/>/g, "\n")
    .replace(/<\/w:tc>/g, "\t")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 100_000);
}

export interface ResumeRow {
  id: string;
  user_id: string;
  r2_key: string;
  filename: string;
  content_type: string;
  size: number;
  text: string | null;
  created_at: number;
}

export function safeFilename(name: string, cv: CvFile): string {
  const base = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim().slice(0, 120) || "cv";
  const ext = cv.kind === "pdf" ? ".pdf" : ".docx";
  return base.toLowerCase().endsWith(ext) ? base : base + ext;
}

export async function storeResume(env: Env, userId: string, filename: string, cv: CvFile): Promise<ResumeRow> {
  const id = crypto.randomUUID();
  const row: ResumeRow = {
    id,
    user_id: userId,
    r2_key: `cv/${userId}/${id}`,
    filename: safeFilename(filename, cv),
    content_type: cv.contentType,
    size: cv.bytes.length,
    text: cv.kind === "docx" ? cv.text : null,
    created_at: now(),
  };
  await env.CV_BUCKET.put(row.r2_key, cv.bytes, {
    httpMetadata: { contentType: cv.contentType },
    customMetadata: { userId, filename: row.filename },
  });
  await env.DB.prepare(
    "INSERT INTO resumes (id, user_id, r2_key, filename, content_type, size, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(row.id, row.user_id, row.r2_key, row.filename, row.content_type, row.size, row.text, row.created_at)
    .run();
  return row;
}

export function latestResume(db: D1Database, userId: string): Promise<ResumeRow | null> {
  return db
    .prepare("SELECT * FROM resumes WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .bind(userId)
    .first<ResumeRow>();
}

/** Загружает сохранённое CV обратно (для повторного автозаполнения). */
export async function loadResume(env: Env, row: ResumeRow): Promise<CvFile | null> {
  const obj = await env.CV_BUCKET.get(row.r2_key);
  if (!obj) return null;
  return readCv(new Uint8Array(await obj.arrayBuffer()));
}
