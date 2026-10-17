import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";

const execFileAsync = promisify(execFile);

export class EdgeTTSProcessor {
  private voice: string;
  private tempDir: string;
  private binary: string;
  private ffmpegBinary: string;

  constructor(config: { voice: string; tempDir: string; binary?: string; ffmpegBinary?: string }) {
    this.voice = config.voice;
    this.tempDir = config.tempDir;
    // configuravel como WHISPER_BINARY/FFMPEG_BINARY: o pip instala fora do PATH no Windows
    this.binary = config.binary || "edge-tts";
    this.ffmpegBinary = config.ffmpegBinary || "ffmpeg";
  }

  async synthesize(text: string): Promise<string> {
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }

    // o edge-tts emite MP3 independente da extensao de saida, e o sendVoice do
    // Telegram so aceita OGG/Opus - um MP3 chamado .ogg e recusado.
    const id = uuidv4();
    const mp3Path = path.resolve(this.tempDir, `tts-${id}.mp3`);
    const outputPath = path.resolve(this.tempDir, `tts-${id}.ogg`);
    const textPath = path.resolve(this.tempDir, `tts-${id}.txt`);

    const cleanText = text
      .replace(/[*_~`#>\-\[\]()!|{}]/g, "")
      .replace(/\n+/g, " ")
      .trim();

    try {
      // --file em vez de --text: mantem texto longo e caracteres especiais fora da linha
      // de comando. Quem chama ainda precisa limitar o tamanho - o edge-tts escala mal
      // (~500 chars 9s, ~3000 chars 78s, ~7000 chars nunca retornou).
      fs.writeFileSync(textPath, cleanText, "utf-8");

      await execFileAsync(this.binary, [
        "--voice", this.voice,
        "--file", textPath,
        "--write-media", mp3Path,
      ], { timeout: 180000 });

      await execFileAsync(this.ffmpegBinary, [
        "-hide_banner", "-loglevel", "error",
        "-i", mp3Path,
        "-c:a", "libopus", "-b:a", "32k", "-ar", "48000", "-ac", "1",
        outputPath, "-y",
      ], { timeout: 60000 });

      return outputPath;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Edge-TTS synthesis failed: ${msg}`);
    } finally {
      try { fs.unlinkSync(mp3Path); } catch { /* may not exist */ }
      try { fs.unlinkSync(textPath); } catch { /* may not exist */ }
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.binary, ["--version"], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
}