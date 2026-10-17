import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { SkillLoader } from "../src/skills/skill-loader.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { CriarArquivoTool } from "../src/tools/criar-arquivo.js";

const DIR = "./tmp/test-skills";

function writeSkill(name: string, body: string): void {
  const dir = path.join(DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), body, "utf-8");
}

function loader(): SkillLoader {
  const reg = new ToolRegistry();
  reg.register(new CriarArquivoTool("./output"));
  return new SkillLoader(DIR, reg);
}

beforeEach(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
});

afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }));

describe("SkillLoader frontmatter parsing", () => {
  it("reads scalars, a requires list, and the body as the system prompt", () => {
    writeSkill("juridico", [
      "---",
      "name: juridico",
      "description: Analisa contratos",
      "version: 1.2.0",
      "requires:",
      "  - criar_arquivo",
      "  - ler_arquivo",
      "---",
      "",
      "Você é um advogado.",
      "Seja formal.",
    ].join("\n"));

    const [skill] = loader().loadAll();
    expect(skill.name).toBe("juridico");
    expect(skill.description).toBe("Analisa contratos");
    expect(skill.version).toBe("1.2.0");
    expect(skill.requires).toEqual(["criar_arquivo", "ler_arquivo"]);
    expect(skill.systemPrompt).toBe("Você é um advogado.\nSeja formal.");
  });

  it("defaults version and requires when they are absent", () => {
    writeSkill("minimo", "---\nname: minimo\ndescription: d\n---\ncorpo");
    const [skill] = loader().loadAll();
    expect(skill.version).toBe("0.0.0");
    expect(skill.requires).toEqual([]);
  });

  it("skips a skill with no frontmatter", () => {
    writeSkill("sem-fm", "apenas texto, sem frontmatter");
    expect(loader().loadAll()).toEqual([]);
  });

  it("skips a skill whose frontmatter has no name", () => {
    writeSkill("sem-nome", "---\ndescription: d\n---\ncorpo");
    expect(loader().loadAll()).toEqual([]);
  });

  it("ignores directories without a SKILL.md", () => {
    fs.mkdirSync(path.join(DIR, "vazio"), { recursive: true });
    expect(loader().loadAll()).toEqual([]);
  });

  it("returns an empty list when the skills directory is missing", () => {
    fs.rmSync(DIR, { recursive: true, force: true });
    expect(loader().loadAll()).toEqual([]);
  });

  it("deduplicates by skill name, last directory wins", () => {
    writeSkill("a-dir", "---\nname: dup\ndescription: primeira\n---\nx");
    writeSkill("z-dir", "---\nname: dup\ndescription: segunda\n---\ny");
    const skills = loader().loadAll();
    expect(skills.length).toBe(1);
    expect(skills[0].description).toBe("segunda");
  });

  it("reload() picks up a skill added after the first load", () => {
    const l = loader();
    expect(l.loadAll()).toEqual([]);
    writeSkill("novo", "---\nname: novo\ndescription: d\n---\ncorpo");
    expect(l.reload().map((s) => s.name)).toEqual(["novo"]);
  });
});
