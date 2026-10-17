import type { Context } from "grammy";
import { InputFile } from "grammy";
import type { AgentLoopResult } from "../memory/memory-manager.js";
import { EdgeTTSProcessor } from "./edge-tts.js";
import { EventEmitter } from "events";
import fs from "fs";

const CHUNK_SIZE = 4000;

// o edge-tts escala mal: ~500 chars levam 9s, ~3000 levam 78s, ~7000 nunca terminou.
// Um audio de varios minutos tambem e ruim de ouvir, entao a parte falada tem teto e
// a resposta completa vai em seguida como texto.
const TTS_MAX_CHARS = 2000;

export interface OutputStrategy {
  send(ctx: Context, result: AgentLoopResult): Promise<void>;
}

export class TextOutputStrategy implements OutputStrategy {
  async send(ctx: Context, result: AgentLoopResult): Promise<void> {
    // o Telegram recusa texto vazio com 400; nunca deixar um chegar na API
    const text = result.finalResponse?.trim() || "(resposta vazia)";

    if (text.length <= CHUNK_SIZE) {
      await ctx.reply(text);
      return;
    }

    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += CHUNK_SIZE) {
      chunks.push(text.slice(i, i + CHUNK_SIZE));
    }

    for (const chunk of chunks) {
      await ctx.reply(chunk);
    }
  }
}

export class AudioOutputStrategy implements OutputStrategy {
  private tts: EdgeTTSProcessor;
  // os dois caminhos de fallback passam pelo divisor de blocos: ctx.reply() recusa
  // qualquer coisa acima de 4096 chars, entao uma resposta longa falhava duas vezes
  private readonly text = new TextOutputStrategy();

  constructor(tts: EdgeTTSProcessor) {
    this.tts = tts;
  }

  async send(ctx: Context, result: AgentLoopResult): Promise<void> {
    try {
      const available = await this.tts.isAvailable();
      if (!available) {
        await this.text.send(ctx, result);
        return;
      }

      const full = result.finalResponse;
      const abbreviated = full.length > TTS_MAX_CHARS;
      const spoken = abbreviated
        ? `${full.slice(0, TTS_MAX_CHARS)} ... Resposta abreviada. O texto completo segue na próxima mensagem.`
        : full;

      const audioPath = await this.tts.synthesize(spoken);
      try {
        // o grammy trata uma string crua como file_id ou URL; um caminho do Windows vira
        // uma URL com porta invalida. Arquivos locais precisam ir dentro de InputFile.
        await ctx.replyWithVoice(new InputFile(audioPath));
      } finally {
        try {
          if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
        } catch {}
      }

      // nada se perde quando a resposta era longa demais para narrar
      if (abbreviated) await this.text.send(ctx, result);
    } catch (err: unknown) {
      // cair para texto e o certo, mas fazer isso em silencio escondia um pipeline de
      // audio quebrado atras do que parecia uma resposta normal
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[AudioOutputStrategy] Voice reply failed, sending text instead: ${msg}`);
      await this.text.send(ctx, result);
    }
  }
}

export class ErrorOutputStrategy implements OutputStrategy {
  async send(ctx: Context, result: AgentLoopResult): Promise<void> {
    const msg = result.errorMessage || "Ocorreu um erro inesperado.";
    await ctx.reply(`\u26a0\ufe0f Erro: ${msg}`);
  }
}

export class TelegramOutputHandler {
  private strategies: Map<string, OutputStrategy>;
  private ctx: Context;
  private eventEmitter: EventEmitter;

  constructor(ctx: Context, config: { ttsVoiceId: string; tmpDir: string; edgeTtsBinary?: string; ffmpegBinary?: string }, eventEmitter: EventEmitter) {
    this.ctx = ctx;
    this.eventEmitter = eventEmitter;

    const tts = new EdgeTTSProcessor({
      voice: config.ttsVoiceId,
      tempDir: config.tmpDir,
      binary: config.edgeTtsBinary,
      ffmpegBinary: config.ffmpegBinary,
    });

    this.strategies = new Map();
    this.strategies.set("text", new TextOutputStrategy());
    this.strategies.set("audio", new AudioOutputStrategy(tts));
    this.strategies.set("error", new ErrorOutputStrategy());
  }

  async send(conversationId: string, result: AgentLoopResult): Promise<void> {
    let strategy: OutputStrategy;

    if (result.finishReason === "error") {
      strategy = this.strategies.get("error")!;
    } else if (result.requiresAudioReply) {
      strategy = this.strategies.get("audio")!;
    } else {
      strategy = this.strategies.get("text")!;
    }

    try {
      await strategy.send(this.ctx, result);
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (e.message.includes("403") || e.message.includes("Forbidden") || e.message.includes("blocked")) {
        this.eventEmitter.emit("userBlocked", { conversationId });
        return;
      }
      throw e;
    }
  }

  async sendReply(text: string): Promise<void> {
    if (text.length <= CHUNK_SIZE) {
      await this.ctx.reply(text);
      return;
    }

    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += CHUNK_SIZE) {
      chunks.push(text.slice(i, i + CHUNK_SIZE));
    }

    for (const chunk of chunks) {
      await this.ctx.reply(chunk);
    }
  }

  async sendError(text: string): Promise<void> {
    await this.ctx.reply(`\u26a0\ufe0f ${text.trim() || "Erro desconhecido."}`);
  }
}