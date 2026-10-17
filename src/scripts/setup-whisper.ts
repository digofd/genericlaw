/**
 * Baixa o que a entrada de voz precisa: o CLI do whisper.cpp e um modelo ggml.
 *
 * O repo espera o whisper.cpp especificamente (arquivo de modelo ggml + flags
 * `--model/--file/--output-txt`), nao o `whisper` em Python da OpenAI, cujo CLI e
 * diferente e que arrasta o torch junto.
 *
 * Uso: npm run setup:whisper [-- --model base]
 */
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const MODEL_BASE_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
const RELEASES_URL = "https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=20";
const BIN_DIR = "./bin/whisper";
const MODEL_DIR = "./models/whisper";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { headers: { "User-Agent": "genericlaw-setup" } });
  if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText} for ${url}`);

  const total = Number(res.headers.get("content-length") || 0);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const chunks: Buffer[] = [];
  let received = 0;
  let lastPct = -1;

  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
    received += chunk.length;
    if (total) {
      const pct = Math.floor((received / total) * 100);
      if (pct >= lastPct + 10) {
        lastPct = pct;
        process.stdout.write(`  ${pct}% (${(received / 1024 / 1024).toFixed(1)}MB)\n`);
      }
    }
  }

  fs.writeFileSync(dest, Buffer.concat(chunks));
}

/** So o Windows tem CLI pronto para baixar; nas outras plataformas o whisper.cpp e compilado do fonte. */
async function findWindowsBinaryAsset(): Promise<{ name: string; url: string }> {
  const res = await fetch(RELEASES_URL, { headers: { "User-Agent": "genericlaw-setup" } });
  if (!res.ok) throw new Error(`GitHub releases: ${res.status}`);
  const releases = (await res.json()) as { tag_name: string; assets: { name: string; browser_download_url: string }[] }[];

  for (const rel of releases) {
    // build simples de CPU x64: sem CUDA, sem BLAS, ~8MB
    const asset = rel.assets.find((a) => a.name === "whisper-bin-x64.zip");
    if (asset) {
      console.log(`whisper.cpp build: ${rel.tag_name} / ${asset.name}`);
      return { name: asset.name, url: asset.browser_download_url };
    }
  }
  throw new Error("no whisper-bin-x64.zip found in recent releases");
}

async function unzip(zipPath: string, destDir: string): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });
  if (process.platform === "win32") {
    await execFileAsync("powershell", [
      "-NoProfile", "-Command",
      `Expand-Archive -LiteralPath '${path.resolve(zipPath)}' -DestinationPath '${path.resolve(destDir)}' -Force`,
    ], { timeout: 120000 });
  } else {
    await execFileAsync("unzip", ["-o", zipPath, "-d", destDir], { timeout: 120000 });
  }
}

function findCli(dir: string): string | null {
  // A ordem importa: builds recentes trazem `main` apenas como stub que imprime aviso
  // de depreciacao e sai, entao whisper-cli precisa vencer quando os dois existem.
  const wanted = process.platform === "win32"
    ? ["whisper-cli.exe", "main.exe"]
    : ["whisper-cli", "main"];

  const found = new Map<string, string>();
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (wanted.includes(entry.name) && !found.has(entry.name)) found.set(entry.name, full);
    }
  }
  for (const name of wanted) {
    const hit = found.get(name);
    if (hit) return hit;
  }
  return null;
}

async function main(): Promise<void> {
  const model = arg("model", process.env.WHISPER_MODEL || "small");
  const modelPath = path.join(MODEL_DIR, `ggml-${model}.bin`);

  // 1. o CLI
  let cli: string | null = fs.existsSync(BIN_DIR) ? findCli(BIN_DIR) : null;
  if (cli) {
    console.log(`whisper CLI already present: ${cli}`);
  } else if (process.platform !== "win32") {
    console.log("No prebuilt whisper.cpp CLI for this platform.");
    console.log("Build it from https://github.com/ggml-org/whisper.cpp and set WHISPER_BINARY to the result.");
  } else {
    const asset = await findWindowsBinaryAsset();
    const zipPath = path.join("./tmp", asset.name);
    console.log(`Downloading ${asset.name}...`);
    await download(asset.url, zipPath);
    await unzip(zipPath, BIN_DIR);
    fs.rmSync(zipPath, { force: true });
    cli = findCli(BIN_DIR);
    if (!cli) throw new Error(`extracted ${asset.name} but found no whisper-cli/main binary in ${BIN_DIR}`);
    console.log(`whisper CLI: ${cli}`);
  }

  // 2. o modelo
  if (fs.existsSync(modelPath)) {
    console.log(`Model already present: ${modelPath} (${(fs.statSync(modelPath).size / 1024 / 1024).toFixed(0)}MB)`);
  } else {
    console.log(`Downloading ggml-${model}.bin...`);
    await download(`${MODEL_BASE_URL}/ggml-${model}.bin`, modelPath);
    console.log(`Model: ${modelPath} (${(fs.statSync(modelPath).size / 1024 / 1024).toFixed(0)}MB)`);
  }

  console.log("\nAdd to .env:");
  if (cli) console.log(`  WHISPER_BINARY=${cli.replace(/\\/g, "/")}`);
  console.log(`  WHISPER_MODEL=${model}`);
  console.log("\nVoice output also needs edge-tts (`pip install edge-tts`); if it lands outside PATH,");
  console.log("set EDGE_TTS_BINARY to its full path.");
}

main().catch((err) => {
  console.error(`setup-whisper failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
