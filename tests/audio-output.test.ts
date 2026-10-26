import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "fs";
import path from "path";
import type { Context } from "grammy";
import { InputFile } from "grammy";
import type { EdgeTTSProcessor } from "../src/output/edge-tts.js";
import { AudioOutputStrategy } from "../src/output/output-handler.js";
import type { AgentLoopResult } from "../src/memory/memory-manager.js";

const DIR = "./tmp/test-audio";

/** Registra o que chegaria na API do Telegram, sem chama-la. */
class FakeContext {
  readonly replies: string[] = [];
  readonly voices: unknown[] = [];

  async reply(text: string): Promise<void> {
    // a API real recusa estes casos, entao trata-los como falha aqui tambem
    if (text.length === 0) throw new Error("400: message text is empty");
    if (text.length > 4096) throw new Error("400: message is too long");
    this.replies.push(text);
  }

  async replyWithVoice(file: unknown): Promise<void> {
    if (typeof file === "string") throw new Error("400: invalid file HTTP URL specified");
    this.voices.push(file);
  }
}

/** Substitui o edge-tts: registra o texto que pediram para falar. */
class FakeTts {
  spoken: string[] = [];
  constructor(
    private opts: { available?: boolean; fail?: boolean } = {},
  ) {}
  async isAvailable(): Promise<boolean> {
    return this.opts.available !== false;
  }
  async synthesize(text: string): Promise<string> {
    this.spoken.push(text);
    if (this.opts.fail) throw new Error("Edge-TTS synthesis failed: timeout");
    const file = path.join(DIR, `voice-${this.spoken.length}.ogg`);
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(file, "OggS-fake");
    return file;
  }
}

const asTts = (f: FakeTts) => f as unknown as EdgeTTSProcessor;
const asCtx = (c: FakeContext) => c as unknown as Context;

function result(text: string): AgentLoopResult {
  return {
    conversationId: "1",
    finalResponse: text,
    toolCallsMade: 0,
    iterationsUsed: 1,
    finishReason: "stop",
    requiresAudioReply: true,
  };
}

beforeEach(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }));

describe("AudioOutputStrategy", () => {
  it("sends a short answer as a voice note and nothing else", async () => {
    const tts = new FakeTts();
    const ctx = new FakeContext();

    await new AudioOutputStrategy(asTts(tts)).send(asCtx(ctx), result("Resposta curta."));

    expect(ctx.voices.length).toBe(1);
    expect(ctx.replies).toEqual([]);
    expect(tts.spoken[0]).toBe("Resposta curta.");
  });

  it("wraps the local file in InputFile, never a bare path string", async () => {
    const tts = new FakeTts();
    const ctx = new FakeContext();

    await new AudioOutputStrategy(asTts(tts)).send(asCtx(ctx), result("oi"));

    // uma string crua faz o grammy interpretar um caminho do Windows como URL e o Telegram recusa
    expect(ctx.voices[0]).toBeInstanceOf(InputFile);
  });

  it("deletes the synthesized file after sending", async () => {
    const tts = new FakeTts();
    const ctx = new FakeContext();

    await new AudioOutputStrategy(asTts(tts)).send(asCtx(ctx), result("oi"));

    expect(fs.existsSync(path.join(DIR, "voice-1.ogg"))).toBe(false);
  });

  it("caps the spoken text and sends the full answer as text afterwards", async () => {
    const long = "a".repeat(5000);
    const tts = new FakeTts();
    const ctx = new FakeContext();

    await new AudioOutputStrategy(asTts(tts)).send(asCtx(ctx), result(long));

    // a parte falada e limitada: o edge-tts nunca retornou com ~7000 chars
    expect(tts.spoken[0].length).toBeLessThan(2200);
    expect(tts.spoken[0]).toContain("Resposta abreviada");

    expect(ctx.voices.length).toBe(1);
    // a resposta inteira ainda chega, dividida abaixo do limite de 4096
    expect(ctx.replies.join("")).toBe(long);
    expect(ctx.replies.every((r) => r.length <= 4000)).toBe(true);
  });

  it("falls back to chunked text when synthesis fails", async () => {
    const long = "b".repeat(9000);
    const tts = new FakeTts({ fail: true });
    const ctx = new FakeContext();

    // o fallback chamava ctx.reply() direto, entao uma resposta longa
    // falhava duas vezes: no TTS e depois com "message is too long"
    await new AudioOutputStrategy(asTts(tts)).send(asCtx(ctx), result(long));

    expect(ctx.voices).toEqual([]);
    expect(ctx.replies.join("")).toBe(long);
    expect(ctx.replies.length).toBe(3);
  });

  it("falls back to chunked text when TTS is unavailable", async () => {
    const long = "c".repeat(9000);
    const tts = new FakeTts({ available: false });
    const ctx = new FakeContext();

    await new AudioOutputStrategy(asTts(tts)).send(asCtx(ctx), result(long));

    expect(tts.spoken).toEqual([]);
    expect(ctx.voices).toEqual([]);
    expect(ctx.replies.join("")).toBe(long);
  });

  it("logs why it fell back instead of failing silently", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tts = new FakeTts({ fail: true });

    await new AudioOutputStrategy(asTts(tts)).send(asCtx(new FakeContext()), result("oi"));

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Voice reply failed"));
  });

  it("never sends an empty message when the answer is blank", async () => {
    const tts = new FakeTts({ fail: true });
    const ctx = new FakeContext();

    await new AudioOutputStrategy(asTts(tts)).send(asCtx(ctx), result("   "));

    expect(ctx.replies).toEqual(["(resposta vazia)"]);
  });
});

describe("o que foi entregue, nao o que foi pedido", () => {
  it("informa voice quando o audio sai", async () => {
    const ctx = new FakeContext();
    const entregue = await new AudioOutputStrategy(asTts(new FakeTts())).send(asCtx(ctx), result("oi"));
    expect(entregue).toBe("voice");
    expect(ctx.voices).toHaveLength(1);
  });

  it("informa text quando o edge-tts falha, ainda que o pedido fosse audio", async () => {
    const ctx = new FakeContext();
    const entregue = await new AudioOutputStrategy(asTts(new FakeTts({ fail: true }))).send(asCtx(ctx), result("oi"));
    // o pedido era audio: so o valor entregue distingue este caso do de cima
    expect(entregue).toBe("text");
    expect(ctx.voices).toHaveLength(0);
    expect(ctx.replies).toHaveLength(1);
  });

  it("informa voice+text quando a resposta longa e narrada em parte", async () => {
    const ctx = new FakeContext();
    const entregue = await new AudioOutputStrategy(asTts(new FakeTts())).send(asCtx(ctx), result("x".repeat(2500)));
    expect(entregue).toBe("voice+text");
  });
});
