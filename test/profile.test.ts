import { SELF, env } from "cloudflare:test";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { docxText, readCv } from "../src/lib/cv";
import { emptyProfile, extractProfile, mergeProfiles, parseProfileJson, profileFromForm, profileToForm, type Profile } from "../src/lib/profile";
import { BASE, signIn } from "./helpers";

afterEach(() => vi.restoreAllMocks());

const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");

function docx(paragraphs: string[]): Uint8Array {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("");
  return zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "word/document.xml": strToU8(`<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>`),
  });
}

const aiProfile: Profile = {
  ...emptyProfile(),
  full_name: "Anna Petrova",
  headline: "Backend engineer (Python)",
  summary: "Built and ran the backend of a B2B SaaS.",
  target_roles: ["Backend Engineer", "Python Developer"],
  seniority: "senior",
  years_experience: 6,
  skills: ["Python", "FastAPI", "PostgreSQL"],
  location: "Limassol, Cyprus",
  languages: [{ language: "English", level: "C1" }],
  experience: [{ company: "Moidex", title: "Backend lead", period: "2022 – 2026", highlights: ["Led a team of 6"] }],
  facts: [{ question: "Years of commercial Python experience", answer: "6+" }],
  contacts: { ...emptyProfile().contacts, email: "anna@example.com" },
};

/** Подменяет ответ OpenRouter: модель «возвращает» анкету JSON-ом. */
function mockLlm(content: string | null, finish_reason = "stop") {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://openrouter.ai/api/v1/")) throw new Error(`unexpected fetch ${url}`);
    return Response.json({
      id: "gen-1",
      model: "z-ai/glm-5.3",
      choices: [{ index: 0, finish_reason, message: { role: "assistant", content } }],
      usage: { prompt_tokens: 1000, completion_tokens: 500 },
    });
  });
}
const mockLlmProfile = (p: Profile | null, finish = "stop") => mockLlm(p ? JSON.stringify(p) : null, finish);

async function upload(cookie: string, bytes: Uint8Array, name: string) {
  const form = new FormData();
  form.append("cv", new File([bytes], name));
  return SELF.fetch(`${BASE}/app/cv`, { method: "POST", body: form, headers: { cookie }, redirect: "manual" });
}

describe("файл CV", () => {
  it("узнаёт PDF и DOCX по содержимому, достаёт текст из DOCX", () => {
    expect(readCv(PDF).kind).toBe("pdf");
    const cv = readCv(docx(["Anna Petrova", "Backend engineer &amp; team lead with six years of Python experience"]));
    expect(cv.kind).toBe("docx");
    expect(cv.kind === "docx" && cv.text).toBe("Anna Petrova\nBackend engineer & team lead with six years of Python experience");
  });

  it("отклоняет чужие форматы, пустые и слишком большие файлы", () => {
    expect(() => readCv(new TextEncoder().encode("hello world"))).toThrow("PDF или DOCX");
    expect(() => readCv(new Uint8Array())).toThrow("пустой");
    expect(() => readCv(new Uint8Array(6 * 1024 * 1024).fill(37))).toThrow("5 МБ");
    expect(() => docxText(zipSync({ "a.txt": strToU8("x") }))).toThrow("не похоже");
  });
});

describe("загрузка CV и анкета", () => {
  it("загружает PDF, заполняет анкету моделью и показывает её", async () => {
    const { cookie, userId } = await signIn("anna@example.com");
    const fetchSpy = mockLlmProfile(aiProfile);
    const res = await upload(cookie, PDF, "Anna CV.pdf");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/app/profile");

    // в модель ушёл PDF файлом, с JSON-схемой анкеты
    const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(body.model).toBe("z-ai/glm-5.3");
    const schema = body.response_format.json_schema.schema;
    // strict-режим требует: все поля обязательны, лишних нет (вложенные объекты тоже)
    expect(schema.additionalProperties).toBe(false);
    expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
    expect(schema.properties.contacts.additionalProperties).toBe(false);
    expect(schema.properties.experience.items.additionalProperties).toBe(false);
    expect(body.plugins[0].id).toBe("file-parser");
    expect(body.messages[1].content[0].type).toBe("file");
    expect(body.messages[1].content[0].file.file_data).toMatch(/^data:application\/pdf;base64,JVBERi0/);
    fetchSpy.mockRestore();

    const resume = await env.DB.prepare("SELECT * FROM resumes WHERE user_id = ?").bind(userId).first<{ r2_key: string; filename: string }>();
    expect(resume!.filename).toBe("Anna CV.pdf");
    expect(await env.CV_BUCKET.get(resume!.r2_key)).not.toBeNull();

    const page = await (await SELF.fetch(`${BASE}/app/profile`, { headers: { cookie } })).text();
    expect(page).toContain("Anna Petrova");
    expect(page).toContain("Backend Engineer\nPython Developer");
    expect(page).toContain("Анкета заполнена по резюме");

    const dash = await (await SELF.fetch(`${BASE}/app`, { headers: { cookie } })).text();
    expect(dash).toContain("Ищем: Backend Engineer, Python Developer");

    const file = await SELF.fetch(`${BASE}/app/cv`, { headers: { cookie } });
    expect(file.headers.get("content-type")).toBe("application/pdf");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PDF);
  });

  it("DOCX уходит в модель текстом", async () => {
    const { cookie } = await signIn("docx@example.com");
    const fetchSpy = mockLlmProfile(aiProfile);
    const res = await upload(cookie, docx(["Anna Petrova", "Senior Python developer, FastAPI, PostgreSQL, Kafka"]), "cv.docx");
    expect(res.status).toBe(303);
    const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(body.plugins).toBeUndefined();
    expect(body.messages[1].content[0].type).toBe("text");
    expect(body.messages[1].content[0].text).toContain("Senior Python developer");
  });

  it("человек правит анкету, повторная загрузка не затирает его настройки", async () => {
    const { cookie, userId } = await signIn("edit@example.com");
    mockLlmProfile(aiProfile);
    await upload(cookie, PDF, "cv.pdf");

    const form = new URLSearchParams({
      full_name: "Anna P.",
      headline: "Python backend",
      seniority: "lead",
      years_experience: "7",
      target_roles: "Backend Engineer\n\nTech Lead",
      skills: "Python\nGo",
      relocation: "no",
      salary_min: "5000",
      salary_currency: "eur",
      avoid: "DevOps",
      languages: "English — C1\nRussian: native",
      facts: "Team size: 6",
      experience: "Backend lead | Moidex | 2022 – 2026\n- Led a team of 6\n- Sold the company\n\nDeveloper | Acme | 2019 – 2022",
      contact_email: "anna@example.com",
    });
    form.append("work_formats", "remote");
    form.append("work_formats", "hybrid");
    const save = await SELF.fetch(`${BASE}/app/profile`, { method: "POST", body: form, headers: { cookie }, redirect: "manual" });
    expect(save.headers.get("location")).toBe("/app/profile?saved=1");

    const row = await env.DB.prepare("SELECT data, source FROM profiles WHERE user_id = ?").bind(userId).first<{ data: string; source: string }>();
    expect(row!.source).toBe("user");
    const saved = JSON.parse(row!.data) as Profile;
    expect(saved.target_roles).toEqual(["Backend Engineer", "Tech Lead"]);
    expect(saved.work_formats).toEqual(["remote", "hybrid"]);
    expect(saved.relocation).toBe(false);
    expect(saved.salary_currency).toBe("EUR");
    expect(saved.languages).toEqual([
      { language: "English", level: "C1" },
      { language: "Russian", level: "native" },
    ]);
    expect(saved.experience).toEqual([
      { title: "Backend lead", company: "Moidex", period: "2022 – 2026", highlights: ["Led a team of 6", "Sold the company"] },
      { title: "Developer", company: "Acme", period: "2019 – 2022", highlights: [] },
    ]);

    // новое CV: данные из него обновляются, а формат/зарплата/«не предлагать» (их в CV нет) остаются
    await upload(cookie, PDF, "cv2.pdf");
    const after = JSON.parse(
      (await env.DB.prepare("SELECT data FROM profiles WHERE user_id = ?").bind(userId).first<{ data: string }>())!.data,
    ) as Profile;
    expect(after.full_name).toBe("Anna Petrova");
    expect(after.work_formats).toEqual(["remote", "hybrid"]);
    expect(after.salary_min).toBe(5000);
    expect(after.avoid).toEqual(["DevOps"]);
  });

  it("если модель не справилась, CV сохраняется, а анкету можно заполнить вручную", async () => {
    const { cookie, userId } = await signIn("fail@example.com");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("overloaded", { status: 529 }));
    const res = await upload(cookie, PDF, "cv.pdf");
    expect(res.status).toBe(303);
    const page = await (await SELF.fetch(`${BASE}/app/profile`, { headers: { cookie } })).text();
    expect(page).toContain("Автозаполнение сейчас не сработало");
    expect(page).toContain("Сохранить анкету");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM resumes WHERE user_id = ?").bind(userId).first("n")).toBe(1);

    // повтор по уже загруженному файлу
    vi.restoreAllMocks();
    mockLlmProfile(aiProfile);
    await SELF.fetch(`${BASE}/app/profile/refill`, { method: "POST", headers: { cookie }, redirect: "manual" });
    const again = await (await SELF.fetch(`${BASE}/app/profile`, { headers: { cookie } })).text();
    expect(again).toContain("Anna Petrova");
    expect(again).not.toContain("Автозаполнение сейчас не сработало");
  });

  it("показывает ошибку для неподходящего файла и не пускает без входа", async () => {
    const { cookie } = await signIn("bad@example.com");
    const res = await upload(cookie, new TextEncoder().encode("just text"), "cv.txt");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Нужен PDF или DOCX");

    const anon = await SELF.fetch(`${BASE}/app/profile`, { redirect: "manual" });
    expect(anon.headers.get("location")).toBe("/");
    const anonFile = await SELF.fetch(`${BASE}/app/cv`, { redirect: "manual" });
    expect(anonFile.headers.get("location")).toBe("/");
  });
});

describe("анкета: логика", () => {
  it("без ключа API просит заполнить вручную, оборванный ответ — проверить", async () => {
    await expect(extractProfile({ ...env, OPENROUTER_API_KEY: undefined }, readCv(PDF))).rejects.toThrow("вручную");
    mockLlm('{"full_name": "Anna', "length");
    await expect(extractProfile(env, readCv(PDF))).rejects.toThrow("не полностью");
  });

  it("понимает JSON в ```-блоке и без необязательных полей, отбрасывает мусор", () => {
    const p = parseProfileJson('Вот анкета:\n```json\n{"full_name":"Anna","skills":["Python"],"contacts":{"email":"a@b.c"}}\n```');
    expect(p?.full_name).toBe("Anna");
    expect(p?.skills).toEqual(["Python"]);
    expect(p?.contacts.email).toBe("a@b.c");
    expect(p?.contacts.phone).toBeNull();
    expect(parseProfileJson("no json here")).toBeNull();
    expect(parseProfileJson('{"seniority":"guru"}')).toBeNull();
  });

  it("форма и анкета переводятся туда и обратно без потерь", () => {
    const form = profileToForm(aiProfile);
    const back = profileFromForm({
      ...form,
      full_name: aiProfile.full_name,
      headline: aiProfile.headline,
      summary: aiProfile.summary,
      seniority: aiProfile.seniority,
      years_experience: String(aiProfile.years_experience),
      location: aiProfile.location,
      contact_email: aiProfile.contacts.email,
    });
    expect(back).toEqual(aiProfile);
  });

  it("слияние: свежие данные главнее, пустое не затирает старое", () => {
    const prev = { ...emptyProfile(), skills: ["Go"], salary_min: 4000, contacts: { ...emptyProfile().contacts, phone: "+357" } };
    const merged = mergeProfiles({ ...emptyProfile(), skills: ["Python"] }, prev);
    expect(merged.skills).toEqual(["Python"]);
    expect(merged.salary_min).toBe(4000);
    expect(merged.contacts.phone).toBe("+357");
  });
});
