import { describe, expect, it } from "vitest";
import { emptyProfile, type Profile } from "../src/lib/profile";
import { MIN_SCORE, familyOf, scoreVacancy, type VacancyForScore } from "../src/lib/jobs/score";
import { fingerprint, vacancyFlags } from "../src/lib/jobs/text";

const NOW = 1_800_000_000;

const pythonDev: Profile = {
  ...emptyProfile(),
  headline: "Backend engineer (Python)",
  target_roles: ["Backend Engineer", "Python Developer", "Product Manager"],
  seniority: "senior",
  years_experience: 6,
  skills: ["Python", "FastAPI", "Django", "PostgreSQL", "Docker"],
  location: "Limassol, Cyprus",
  work_formats: ["remote", "hybrid"],
  employment_types: ["full_time", "contract"],
};

const javaDev: Profile = {
  ...emptyProfile(),
  headline: "Java developer",
  target_roles: ["Java Developer", "Backend Engineer"],
  seniority: "middle",
  skills: ["Java", "Spring", "Kafka"],
  location: "Belgrade, Serbia",
};

function vac(title: string, extra: Partial<VacancyForScore> = {}): VacancyForScore {
  const location = extra.location ?? "Remote";
  const description = extra.description ?? "";
  return { title, company: "Acme", location, description, flags: extra.flags ?? vacancyFlags(location, description, { remote: /remote/i.test(location) }), posted_at: NOW - 86400, ...extra };
}

const score = (v: VacancyForScore, p: Profile) => scoreVacancy(v, p, NOW);
const passes = (v: VacancyForScore, p: Profile) => {
  const r = score(v, p);
  return "score" in r && r.score >= MIN_SCORE;
};

describe("scoreVacancy", () => {
  it("высоко ставит свою роль и стек на удалёнке по миру", () => {
    const r = score(vac("Senior Python Backend Engineer", { location: "Remote, Worldwide", description: "We use FastAPI and PostgreSQL." }), pythonDev);
    expect("score" in r && r.score).toBeGreaterThanOrEqual(70);
    expect("score" in r && r.reasons.join(" ")).toContain("Python");
  });

  it("отсекает чужой стек, но не если там есть свой язык", () => {
    expect(score(vac("Senior Java Developer"), pythonDev)).toEqual({ skip: "стек: Java" });
    expect(passes(vac("Backend Engineer (Python/Go)", { description: "Python services" }), pythonDev)).toBe(true);
    // для джависта та же вакансия — своя
    expect(passes(vac("Senior Java Developer", { description: "Spring Boot, Kafka" }), javaDev)).toBe(true);
    expect(score(vac("Python Developer"), javaDev)).toEqual({ skip: "стек: Python" });
  });

  it("отсекает чужие роли: DevOps, ML, продажи", () => {
    expect(score(vac("DevOps Engineer"), pythonDev)).toEqual({ skip: "роль: devops" });
    expect(score(vac("Machine Learning Engineer"), pythonDev)).toEqual({ skip: "роль: ml" });
    expect(score(vac("Account Executive, EMEA"), pythonDev)).toEqual({ skip: "роль: nontech" });
  });

  it("берёт соседние роли и вторую целевую (PM)", () => {
    expect(passes(vac("Solutions Engineer", { location: "Remote, Europe", description: "Python, REST APIs, Docker" }), pythonDev)).toBe(true);
    expect(passes(vac("Product Manager", { location: "Remote, EMEA" }), pythonDev)).toBe(true);
    expect(familyOf("Technical Project Manager")).toBe("project");
  });

  it("US-only и офис в чужой стране — мимо, офис на Кипре — подходит", () => {
    expect(score(vac("Python Developer", { location: "Remote", description: "Must be authorized to work in the US." }), pythonDev)).toEqual({ skip: "только для США" });
    expect(score(vac("Python Developer", { location: "Berlin, Germany" }), pythonDev)).toEqual({ skip: "офис: Berlin, Germany" });
    const cy = score(vac("Python Developer", { location: "Limassol, Cyprus" }), pythonDev);
    expect("score" in cy && cy.reasons).toContain("в вашем городе/стране");
  });

  it("«не хочу» из анкеты и стажировки для опытных отсекает", () => {
    expect(score(vac("Python Developer, Gambling"), { ...pythonDev, avoid: ["gambling"] })).toEqual({ skip: "не хочу: gambling" });
    expect(score(vac("Python Developer Intern"), pythonDev)).toEqual({ skip: "стажировка" });
  });

  it("не отсекает за грейд выше и контракт отмечает плюсом", () => {
    expect(passes(vac("Lead Python Engineer"), pythonDev)).toBe(true);
    const r = score(vac("Python Developer", { location: "Remote, Worldwide", description: "B2B contractor role" }), pythonDev);
    expect("score" in r && r.reasons).toContain("контракт/B2B");
  });

  it("без целевых ролей в анкете не подбирает", () => {
    expect(score(vac("Python Developer"), emptyProfile())).toEqual({ skip: "в анкете нет целевых ролей" });
  });
});

describe("text", () => {
  it("fingerprint склеивает одну вакансию из разных источников", () => {
    expect(fingerprint("Acme Inc.", "Senior Python Engineer (Remote)")).toBe(fingerprint("ACME", "Senior Python Engineer - remote"));
    expect(fingerprint("Acme", "Backend Engineer")).not.toBe(fingerprint("Acme", "Frontend Engineer"));
  });

  it("флаги локации", () => {
    expect(vacancyFlags("Remote, Worldwide", "")).toBe("REMOTE WORLD");
    expect(vacancyFlags("Remote", "US citizens only. Must reside in the United States")).toContain("US_ONLY");
    expect(vacancyFlags("Limassol, Cyprus", "B2B contract")).toBe("CONTRACT CY");
  });
});
