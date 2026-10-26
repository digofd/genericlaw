import { describe, it, expect, afterAll } from "vitest";
import { execFile } from "child_process";
import fs from "fs";

// A viaja como nome de provider no .env ate a saida de erro do boot.
// O controle e um boot com provider valido: ele tem que passar da checagem de
// providers e morrer so no token do Telegram. Sem isso, "falhou" nao prova nada,
// porque os dois boots falham.
const MARCADOR_A = "MARCADOR-PROVIDER-5E2B";

/** Destino: stderr e exit code do processo real, do jeito que o operador ve. */
function boot(env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      "npx",
      ["tsx", "src/main.ts"],
      {
        timeout: 60000,
        shell: true,
        env: {
          ...process.env,
          // o .env do projeto nao pode entrar: o dotenv nao sobrescreve o que ja existe
          OPENROUTER_API_KEY: "",
          GEMINI_API_KEY: "",
          LLM_PROVIDERS: "",
          TELEGRAM_BOT_TOKEN: "000:token-invalido-de-teste",
          TELEGRAM_ALLOWED_USER_IDS: "1",
          ...env,
        },
      },
      (err, stdout, stderr) => {
        const code = (err as { code?: number } | null)?.code ?? 0;
        resolve({ code, out: `${stdout}\n${stderr}` });
      }
    );
    child.stdin?.end();
  });
}

describe("boot com providers inutilizaveis", () => {
  it(
    "morre no boot citando o provider que nao pode ser criado",
    async () => {
      const { code, out } = await boot({ LLM_PROVIDER: MARCADOR_A });

      expect(code).toBe(1);
      expect(out).toContain(MARCADOR_A);
    },
    90000
  );

  it(
    "com provider valido, passa da checagem e so falha depois (controle)",
    async () => {
      const { code, out } = await boot({ LLM_PROVIDER: "gemini", GEMINI_API_KEY: "chave-de-teste" });

      expect(code).toBe(1); // o token do Telegram e falso de proposito
      expect(out).toContain("Telegram token validation failed");
    },
    90000
  );
});

// Marcador no nome das pastas: elas so podem existir se o boot leu a config.
const MARCADOR_WS = "./tmp/MARCADOR-WS-A3F1";
const MARCADOR_TMP = "./tmp/MARCADOR-TMP-A3F1";
const MARCADOR_SKILLS = "./tmp/MARCADOR-SKILLS-A3F1";

afterAll(() => {
  for (const d of [MARCADOR_WS, MARCADOR_TMP, MARCADOR_SKILLS]) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("diretorios criados no boot", () => {
  it(
    "cria o workspace configurado, nao um ./output fixo",
    async () => {
      for (const d of [MARCADOR_WS, MARCADOR_TMP, MARCADOR_SKILLS]) {
        fs.rmSync(d, { recursive: true, force: true });
      }

      const { out } = await boot({
        LLM_PROVIDER: "gemini",
        GEMINI_API_KEY: "chave-de-teste",
        WORKSPACE_ROOT: MARCADOR_WS,
        TMP_DIR: MARCADOR_TMP,
        SKILLS_DIR: MARCADOR_SKILLS,
      });

      // controle: o boot chegou mesmo ate o ponto dos mkdir antes de morrer no token
      expect(out).toContain("Telegram token validation failed");
      expect(fs.existsSync(MARCADOR_WS)).toBe(true);
      expect(fs.existsSync(MARCADOR_TMP)).toBe(true);
      expect(fs.existsSync(MARCADOR_SKILLS)).toBe(true);
    },
    90000
  );
});
