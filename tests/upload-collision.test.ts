import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "fs";
import path from "path";
import type { Bot, Context } from "grammy";
import { TelegramInputHandler } from "../src/input/input-handler.js";
import type { AgentController } from "../src/core/agent-controller.js";
import type { AppConfig } from "../src/config.js";
import type { ProcessedInput } from "../src/input/types.js";

const WS = "./tmp/test-upload-ws";
const TMP = "./tmp/test-upload-tmp";
const UPLOADS = path.join(WS, "uploads");

// Dois envios com o mesmo nome de arquivo. B e o controle: o ultimo sempre chega,
// entao se B nao aparecer no disco e a busca que esta quebrada, nao a peca.
const MARCADOR_A = "MARCADOR-UPLOAD-1-D4E7";
const MARCADOR_B = "MARCADOR-UPLOAD-2-F9A1";

afterAll(() => {
  fs.rmSync(WS, { recursive: true, force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
});

const config = {
  telegram: { allowedUserIds: ["7"] },
  filesystem: { workspaceRoot: WS, tmpDir: TMP },
  audio: { whisperModel: "small", whisperBinary: "whisper", whisperLanguage: "pt", ffmpegBinary: "ffmpeg" },
} as unknown as AppConfig;

/** Bot fake que guarda os handlers que o start() registra, como o grammy faria. */
function fakeBot() {
  const handlers = new Map<string, (ctx: Context) => Promise<void>>();
  return {
    token: "t",
    api: { getFile: async () => ({ file_path: "remote/doc.md" }) },
    command: () => {},
    on: (ev: string | string[], fn: (ctx: Context) => Promise<void>) => {
      for (const e of Array.isArray(ev) ? ev : [ev]) handlers.set(e, fn);
    },
    start: async () => {},
    stop: async () => {},
    handlers,
  };
}

const entregues: ProcessedInput[] = [];
const controller = {
  handle: async (input: ProcessedInput) => void entregues.push(input),
} as unknown as AgentController;

function ctxComDocumento(): Context {
  return {
    from: { id: 7 },
    chat: { id: 7 },
    message: { document: { file_id: "f1", file_name: "contrato.md", mime_type: "text/markdown" } },
    reply: async () => {},
    replyWithChatAction: async () => {},
  } as unknown as Context;
}

beforeEach(() => {
  entregues.length = 0;
  fs.rmSync(WS, { recursive: true, force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
});
afterEach(() => vi.unstubAllGlobals());

async function handlerDeDocumento(): Promise<(ctx: Context) => Promise<void>> {
  const bot = fakeBot();
  const handler = new TelegramInputHandler({
    bot: bot as unknown as Bot,
    controller,
    config,
    voiceEnabled: false,
  });
  await handler.start();
  return bot.handlers.get("message:document")!;
}

/** Caminho real: start() registra o handler, o handler baixa, salva e entrega. */
async function enviarDocumento(conteudo: string): Promise<void> {
  vi.stubGlobal("fetch", async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new TextEncoder().encode(conteudo).buffer,
  }));

  await (await handlerDeDocumento())(ctxComDocumento());
}

describe("dois uploads com o mesmo nome", () => {
  it("os dois conteudos sobrevivem no disco", async () => {
    await enviarDocumento(MARCADOR_A);
    await enviarDocumento(MARCADOR_B);

    const noDisco = fs
      .readdirSync(UPLOADS)
      .map((f) => fs.readFileSync(path.join(UPLOADS, f), "utf-8"))
      .join("\n");

    expect(noDisco).toContain(MARCADOR_B); // controle
    expect(noDisco).toContain(MARCADOR_A);
  });

  it("dois downloads no mesmo milissegundo nao se sobrescrevem no tmp", async () => {
    // o nome do temporario vinha de Date.now(): congelar o relogio faz a corrida
    // acontecer sempre, em vez de uma vez a cada mil envios
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    const conteudos = [MARCADOR_A, MARCADOR_B];
    let n = 0;
    vi.stubGlobal("fetch", async () => {
      const corpo = conteudos[n++] ?? MARCADOR_B;
      await Promise.resolve(); // cede o controle entre baixar e ler, como a rede faria
      return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(corpo).buffer };
    });

    const disparar = await handlerDeDocumento();
    await Promise.all([disparar(ctxComDocumento()), disparar(ctxComDocumento())]);

    const entregue = entregues.map((e) => e.content).join("\n");
    expect(entregue).toContain(MARCADOR_B); // controle
    expect(entregue).toContain(MARCADOR_A);
  });

  it("o ponteiro entregue ao modelo aponta para o arquivo recem-salvo", async () => {
    await enviarDocumento(MARCADOR_A);
    await enviarDocumento(MARCADOR_B);

    const [rel] = entregues[1].content.match(/uploads\/[^"]+/) ?? [];
    expect(rel).toBeTruthy();
    expect(fs.readFileSync(path.join(WS, rel!), "utf-8")).toContain(MARCADOR_B);
  });
});
