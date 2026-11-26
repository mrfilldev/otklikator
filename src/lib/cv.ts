import { unzipSync, strFromU8 } from "fflate";
import { extractText, getDocumentProxy } from "unpdf";
import { now, type Env } from "../env";

export const MAX_CV_BYTES = 5 * 1024 * 1024;
export const PDF_TYPE = "application/pdf";
export const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Меньше этого — считаем, что текста в файле нет (скан или картинка), и анкету по нему не заполняем. */
export const MIN_CV_TEXT = 200;

export type CvFile =
  | { kind: "pdf"; bytes: Uint8Array; contentType: typeof PDF_TYPE; text: string }
  | { kind: "docx"; bytes: Uint8Array; contentType: typeof DOCX_TYPE; text: string };

export class CvError extends Error {}

/**
 * Проверяет файл по содержимому (не по расширению) и достаёт из него текст.
 * Модель получает только этот текст: если его нет, анкету не заполняем, а не даём модели гадать.
 */
export async function readCv(bytes: Uint8Array): Promise<CvFile> {
  if (bytes.length === 0) throw new CvError("Файл пустой.");
  if (bytes.length > MAX_CV_BYTES) throw new CvError("Файл больше 5 МБ. Сожмите PDF или загрузите DOCX.");
  const head = String.fromCharCode(...bytes.subarray(0, 5));
  if (head === "%PDF-") {
    const text = await pdfText(bytes);
    if (text.length < MIN_CV_TEXT) {
      throw new CvError("Не получилось прочитать текст из PDF: похоже, это скан или картинка. Загрузите DOCX или PDF с текстом.");
    }
    return { kind: "pdf", bytes, contentType: PDF_TYPE, text };
  }
  if (head.startsWith("PK")) {
    const text = docxText(bytes);
    if (text.length < MIN_CV_TEXT) throw new CvError("В документе почти нет текста. Загрузите PDF.");
    return { kind: "docx", bytes, contentType: DOCX_TYPE, text };
  }
  throw new CvError("Нужен PDF или DOCX.");
}

/** Текст из PDF (pdf.js через unpdf), страницы подряд. */
export async function pdfText(bytes: Uint8Array): Promise<string> {
  try {
    // pdf.js забирает буфер себе, поэтому отдаём копию: оригинал ещё нужен для R2
    const pdf = await getDocumentProxy(bytes.slice());
    const { text } = await extractText(pdf, { mergePages: true });
    return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 100_000);
  } catch {
    throw new CvError("Не получилось открыть PDF. Сохраните резюме заново или загрузите DOCX.");
  }
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
    text: cv.text,
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
