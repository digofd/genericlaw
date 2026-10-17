import type { Bot, Context } from "grammy";
import type { AgentController } from "../core/agent-controller.js";
import type { AppConfig } from "../config.js";
import type { ProcessedInput } from "./types.js";
import { WhisperProcessor } from "./whisper-processor.js";
import { CriarArquivoTool } from "../tools/criar-arquivo.js";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const execFileAsync = promisify(execFile);

// Comparado contra texto sem acentos, entao "audio" tambem cobre a forma acentuada.
// Uma lista fixa de frases deixava passar pedidos comuns como "mande o resumo em audio".
const AUDIO_REQUEST = /\b(audio|voz|falado|falada)\b|fale comigo/;
const DIACRITICS = /[̀-ͯ]/g;

/** Verdadeiro quando o usuario pediu a resposta como mensagem de voz. Exportado para testes. */
export function wantsAudioReply(text: string): boolean {
  const normalized = text.toLowerCase().normalize("NFD").replace(DIACRITICS, "");
  return AUDIO_REQUEST.test(normalized);
}

const UPLOAD_PREVIEW_CHARS = 500;

/** Destino, relativo ao workspace, de um documento enviado. Exportado para testes. */
export function uploadPathFor(fileName: string, isPdf: boolean): string {
  const base = path.basename(fileName).replace(/[^\w.\- ]+/g, "_").trim();
  const safe = base && base !== "." ? base : "documento";
  return isPdf ? `uploads/${safe.replace(/\.pdf$/i, "")}.md` : `uploads/${safe}`;
}

export class TelegramInputHandler {
  private bot: Bot;
  private whisper: WhisperProcessor;
  private allowedUserIds: string[];
  private tmpDir: string;
  private controller: AgentController;
  private ffmpegBinary: string;
  private voiceEnabled: boolean;
  private onShutdown?: () => Promise<void>;
  private workspaceRoot: string;

  constructor(config: {
    bot: Bot;
    controller: AgentController;
    config: AppConfig;
    voiceEnabled?: boolean;
    onShutdown?: () => Promise<void>;
  }) {
    this.bot = config.bot;
    this.controller = config.controller;
    this.allowedUserIds = config.config.telegram.allowedUserIds;
    this.tmpDir = config.config.filesystem.tmpDir;
    this.ffmpegBinary = config.config.audio.ffmpegBinary;
    this.workspaceRoot = config.config.filesystem.workspaceRoot;
    this.voiceEnabled = config.voiceEnabled ?? true;
    this.onShutdown = config.onShutdown;

    const modelPath = path.resolve(
      `./models/whisper/ggml-${config.config.audio.whisperModel}.bin`
    );
    this.whisper = new WhisperProcessor({
      modelPath,
      binaryPath: config.config.audio.whisperBinary,
      language: config.config.audio.whisperLanguage,
    });
  }

  async start(): Promise<void> {
    // registrado primeiro: o grammy encerra a cadeia aqui, entao /novo nunca chega em handleText
    this.bot.command(["novo", "reset"], (ctx) => this.handleReset(ctx));
    this.bot.command(["parar", "stop"], (ctx) => this.handleStop(ctx));
    this.bot.on("message:text", (ctx) => this.handleText(ctx));
    this.bot.on(["message:voice", "message:audio"], (ctx) => this.handleVoice(ctx));
    this.bot.on("message:document", (ctx) => this.handleDocument(ctx));

    console.info("[TelegramInputHandler] Starting polling...");
    await this.bot.start();
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }

  private isWhitelisted(userId: number): boolean {
    return this.allowedUserIds.includes(String(userId));
  }

  private buildProcessedInput(
    ctx: Context,
    content: string,
    source: ProcessedInput["source"],
    requiresAudioReply: boolean
  ): ProcessedInput {
    return {
      conversationId: String(ctx.chat!.id),
      userId: String(ctx.from!.id),
      content,
      source,
      requiresAudioReply,
    };
  }

  private detectAudioKeyword(text: string): boolean {
    return wantsAudioReply(text);
  }

  private async handleStop(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !this.isWhitelisted(userId)) return;
    if (!this.onShutdown) {
      await ctx.reply("Encerramento nao esta disponivel nesta instancia.");
      return;
    }

    await ctx.reply("Encerrando o GeneriClaw. Ate logo.");

    // Agendado para depois deste handler retornar: o shutdown chama bot.stop(),
    // que aguarda os handlers em andamento - chamar aqui dentro travaria.
    const run = this.onShutdown;
    setTimeout(() => { void run(); }, 100);
  }

  private async handleReset(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !this.isWhitelisted(userId)) return;

    const removed = this.controller.resetConversation(String(ctx.chat!.id));
    await ctx.reply(
      `Conversa reiniciada: ${removed} mensagem(ns) apagada(s). ` +
      `Os arquivos já criados continuam no workspace.`
    );
  }

  private async handleText(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !this.isWhitelisted(userId)) return;

    const text = ctx.message?.text || "";
    if (!text.trim()) return;

    await ctx.replyWithChatAction("typing");

    const requiresAudioReply = this.detectAudioKeyword(text);
    const input = this.buildProcessedInput(ctx, text, "text", requiresAudioReply);
    await this.controller.handle(input, ctx);
  }

  private async handleVoice(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !this.isWhitelisted(userId)) return;
    if (!this.voiceEnabled) {
      await ctx.reply("Voz desabilitada: dependências de áudio não encontradas.");
      return;
    }

    const msg = ctx.message as Record<string, unknown> | undefined;
    const voice =
      ctx.message?.voice ||
      (msg?.audio as { file_id: string } | undefined);
    if (!voice) return;

    const fileId = (voice as { file_id: string }).file_id;
    if (!fileId) return;

    await ctx.replyWithChatAction("typing");

    let oggPath: string | null = null;
    let wavPath: string | null = null;

    try {
      oggPath = await this.downloadFile(fileId, "ogg");

      wavPath = path.resolve(this.tmpDir, `${path.basename(oggPath, ".ogg")}.wav`);
      await this.convertToWav(oggPath, wavPath);

      const whisperAvailable = await this.whisper.isAvailable();
      if (!whisperAvailable) {
        await ctx.reply("Voz desabilitada: Whisper não está disponível no momento.");
        return;
      }

      const transcript = await this.whisper.transcribe(wavPath);

      if (!transcript.trim()) {
        await ctx.reply("Áudio vazio captado. Pode reenviar?");
        return;
      }

      const input = this.buildProcessedInput(ctx, transcript, "voice", true);
      await this.controller.handle(input, ctx);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[TelegramInputHandler] Voice processing error: ${msg}`);
      await ctx.reply("\u26a0\ufe0f Falha ao processar o áudio: arquivo grande demais ou falha no serviço.");
    } finally {
      if (oggPath) try { fs.unlinkSync(oggPath); } catch {}
      if (wavPath) try { fs.unlinkSync(wavPath); } catch {}
    }
  }

  private async handleDocument(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !this.isWhitelisted(userId)) return;

    const doc = ctx.message?.document;
    if (!doc) return;

    const fileName = doc.file_name || "";
    const mimeType = doc.mime_type || "";
    const isPdf = mimeType === "application/pdf" || fileName.toLowerCase().endsWith(".pdf");
    const isMarkdown = fileName.toLowerCase().endsWith(".md");

    if (!isPdf && !isMarkdown) {
      await ctx.reply("\u26a0\ufe0f No momento, só consigo processar texto estruturado (.md), áudio e PDF.");
      return;
    }

    await ctx.replyWithChatAction("typing");

    let downloadedPath: string | null = null;

    try {
      const ext = isPdf ? "pdf" : "md";
      downloadedPath = await this.downloadFile(doc.file_id, ext);

      let text: string;
      if (isMarkdown) {
        text = fs.readFileSync(downloadedPath, "utf-8");
      } else {
        text = await this.extractPdfText(downloadedPath);
      }

      if (!text.trim()) {
        if (isPdf) {
          await ctx.reply("\u26a0\ufe0f Este PDF parece conter apenas imagens escaneadas. Não foi possível extrair texto.");
        } else {
          await ctx.reply("\u26a0\ufe0f Arquivo vazio.");
        }
        return;
      }

      // Guarda o documento e entrega um ponteiro ao modelo, nao o texto inteiro:
      // embutido, ele seria reenviado como contexto (ate 64KB) em todos os turnos seguintes.
      const relPath = uploadPathFor(fileName || `documento.${ext}`, isPdf);
      const saved = await new CriarArquivoTool(this.workspaceRoot).execute({ path: relPath, content: text, overwrite: true });

      let content: string;
      if (saved.success) {
        content =
          `O usuário enviou o arquivo "${fileName}". O conteúdo foi salvo em "${relPath}" ` +
          `(${text.length} caracteres). Use a ferramenta ler_arquivo para ler o conteúdo completo quando precisar.\n\n` +
          `Início do conteúdo:\n${text.slice(0, UPLOAD_PREVIEW_CHARS)}`;
      } else {
        console.warn(`[TelegramInputHandler] Could not store upload: ${saved.output}`);
        content = text;
      }

      const input = this.buildProcessedInput(ctx, content, "document", false);
      await this.controller.handle(input, ctx);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[TelegramInputHandler] Document processing error: ${msg}`);
      await ctx.reply("\u26a0\ufe0f Não foi possível extrair texto deste PDF. Ele pode estar protegido por senha ou criptografado.");
    } finally {
      if (downloadedPath) try { fs.unlinkSync(downloadedPath); } catch {}
    }
  }

  private async downloadFile(fileId: string, ext: string): Promise<string> {
    if (!fs.existsSync(this.tmpDir)) {
      fs.mkdirSync(this.tmpDir, { recursive: true });
    }

    const file = await this.bot.api.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;

    const outputPath = path.resolve(this.tmpDir, `download-${Date.now()}.${ext}`);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(outputPath, buffer);

    return outputPath;
  }

  private async convertToWav(oggPath: string, wavPath: string): Promise<void> {
    try {
      await execFileAsync(this.ffmpegBinary, [
        "-i", oggPath,
        "-ar", "16000",
        "-ac", "1",
        "-sample_fmt", "s16",
        wavPath,
        "-y",
      ], { timeout: 30000 });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`ffmpeg conversion failed: ${msg}`);
    }
  }

  private async extractPdfText(filePath: string): Promise<string> {
    const pdfParse = (await import("pdf-parse")).default;
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    return data.text || "";
  }
}