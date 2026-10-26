import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import { MemoryManager } from "../src/memory/memory-manager.js";
import { validateConfig, ConfigError } from "../src/config.js";

const DIR = "./tmp/test-window";
const DB = `${DIR}/db.sqlite`;
const CHAT = "chat-1";

// A e uma mensagem antiga, que a janela tem que deixar de fora.
// B e recente e tem que entrar - e o controle que prova que a busca le a janela.
const MARCADOR_A = "MARCADOR-ANTIGO-8B4F";
const MARCADOR_B = "MARCADOR-RECENTE-C6A2";

let mm: MemoryManager;

async function memoriaCom(windowSize: number): Promise<MemoryManager> {
  fs.rmSync(DIR, { recursive: true, force: true });
  const m = new MemoryManager({ dbPath: DB, windowSize, dbMaxSizeMb: 50 });
  await m.initialize();
  m.createConversation("u1", CHAT);
  m.saveMessage(CHAT, "user", MARCADOR_A);
  m.saveMessage(CHAT, "assistant", "resposta antiga");
  m.saveMessage(CHAT, "user", MARCADOR_B);
  return m;
}

beforeEach(() => fs.rmSync(DIR, { recursive: true, force: true }));
afterEach(async () => {
  await mm?.shutdown();
  fs.rmSync(DIR, { recursive: true, force: true });
});

describe("janela de contexto", () => {
  it("com janela 2, a mensagem antiga fica fora e a recente entra (controle)", async () => {
    mm = await memoriaCom(2);
    const janela = mm.getRecentMessages(CHAT).map((m) => m.content).join("\n");

    expect(janela).toContain(MARCADOR_B);
    expect(janela).not.toContain(MARCADOR_A);
  });

  it("com janela 0, o historico inteiro e apagado do banco a cada mensagem", async () => {
    mm = await memoriaCom(0);

    // saveMessage trunca quando count > windowSize*4; com 0 isso vale sempre,
    // e deleteOldMessages(id, 0) apaga a conversa toda. Perda de dados, nao so
    // janela vazia - por isso a config precisa recusar o valor.
    const noBanco = (mm as unknown as { messageRepo: { findByConversationId(id: string): unknown[] } })
      .messageRepo.findByConversationId(CHAT);
    expect(noBanco).toHaveLength(0);
    expect(mm.getRecentMessages(CHAT)).toHaveLength(0);
  });

  it("limit 0 no repositorio devolve zero, nao a conversa inteira", async () => {
    mm = await memoriaCom(5);
    const repo = (mm as unknown as {
      messageRepo: { findByConversationId(id: string, limit?: number): unknown[] };
    }).messageRepo;

    // `limit ? ...` tratava 0 como "sem limite" e caia no ramo que devolve tudo
    expect(repo.findByConversationId(CHAT, 0)).toHaveLength(0);
    expect(repo.findByConversationId(CHAT)).toHaveLength(3); // controle: sem limite devolve tudo
  });
});

describe("validacao de MEMORY_WINDOW_SIZE", () => {
  const base = { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_ALLOWED_USER_IDS: "1", OPENROUTER_API_KEY: "k" };

  it("aceita um valor positivo (controle)", () => {
    expect(validateConfig({ ...base, MEMORY_WINDOW_SIZE: "5" }).memory.windowSize).toBe(5);
  });

  it("recusa zero e negativo", () => {
    for (const v of ["0", "-3"]) {
      expect(() => validateConfig({ ...base, MEMORY_WINDOW_SIZE: v })).toThrow(ConfigError);
    }
  });

  it("recusa MAX_ITERATIONS zero", () => {
    expect(() => validateConfig({ ...base, MAX_ITERATIONS: "0" })).toThrow(ConfigError);
  });
});

describe("limite de tamanho do banco", () => {
  // o limite so era checado no boot; agora vale em toda gravacao (autosave e shutdown)
  async function avisosAoGravar(dbMaxSizeMb: number): Promise<string> {
    const linhas: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void linhas.push(a.join(" ")));

    fs.rmSync(DIR, { recursive: true, force: true });
    const m = new MemoryManager({ dbPath: DB, windowSize: 20, dbMaxSizeMb });
    await m.initialize();
    m.createConversation("u1", CHAT);
    m.saveMessage(CHAT, "user", MARCADOR_B);
    await m.shutdown(); // passa por saveToDisk, o mesmo caminho do autosave

    spy.mockRestore();
    return linhas.join("\n");
  }

  it("avisa e compacta quando o banco passa do limite, fora do boot", async () => {
    expect(await avisosAoGravar(0.00001)).toContain("exceeds limit");
  });

  it("nao avisa quando o banco cabe no limite (controle)", async () => {
    expect(await avisosAoGravar(500)).not.toContain("exceeds limit");
  });
});
