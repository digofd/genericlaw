export class ConfigError extends Error {
  readonly missingKeys: string[];
  readonly invalidKeys: string[];

  constructor(message: string, missingKeys: string[], invalidKeys: string[]) {
    super(message);
    this.name = "ConfigError";
    this.missingKeys = missingKeys;
    this.invalidKeys = invalidKeys;
  }
}

export interface AppConfig {
  telegram: {
    botToken: string;
    allowedUserIds: string[];
  };
  /** Leitura de grupos via conta pessoal (MTProto). Ausente = recurso desligado. */
  groups?: {
    apiId: number;
    apiHash: string;
    session: string;
    chatIds: string[];
    backfillLimit: number;
  };
  llm: {
    primaryProvider: string;
    fallbackProviders: string[];
    apiKeys: Record<string, string>;
    /** Sobrescreve o modelo padrao do provedor, por <PROVEDOR>_MODEL. */
    models: Record<string, string>;
    openRouterApiKey?: string;
  };
  agent: {
    maxIterations: number;
    llmTimeoutMs: number;
    llmRetryCount: number;
    llmRetryBaseDelayMs: number;
    toolTimeoutMs: number;
  };
  memory: {
    windowSize: number;
    dbPath: string;
    dbMaxSizeMb: number;
  };
  filesystem: {
    workspaceRoot: string;
    tmpDir: string;
    skillsDir: string;
  };
  logging: {
    logMessageContent: boolean;
  };
  audio: {
    whisperBinary: string;
    whisperModel: string;
    whisperLanguage: string;
    ttsVoiceId: string;
    ffmpegBinary: string;
    edgeTtsBinary: string;
  };
}

// min existe porque zero e negativo passavam na validacao e quebravam em runtime:
// MEMORY_WINDOW_SIZE=0 apaga o historico a cada mensagem, MAX_ITERATIONS=0 nunca roda o agente.
function parseNumber(
  raw: string | undefined,
  key: string,
  fallback: number,
  invalidKeys: string[],
  min = 1
): number {
  if (raw === undefined) return fallback;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed < min) {
    invalidKeys.push(key);
    return fallback;
  }
  return parsed;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  return raw.toLowerCase() === "true";
}

function parseCsv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const REQUIRED_VARS = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USER_IDS"] as const;

// TELEGRAM_BACKFILL_LIMIT fica de fora: tem default util e nao impede a leitura de grupos.
const GROUP_VARS = ["TELEGRAM_API_ID", "TELEGRAM_API_HASH", "TELEGRAM_SESSION", "TELEGRAM_GROUP_IDS"] as const;

const API_KEY_MAP: Record<string, string> = {
  gemini: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  groq: "GROQ_API_KEY",
};

// Nome de modelo envelhece mais rapido que o codigo: sem isto, um modelo aposentado
// exige editar o fonte para voltar a bootar.
const MODEL_ENV_MAP: Record<string, string> = {
  gemini: "GEMINI_MODEL",
  openai: "OPENAI_MODEL",
  deepseek: "DEEPSEEK_MODEL",
  groq: "GROQ_MODEL",
};

const OPENROUTER_KEY = "OPENROUTER_API_KEY";

export function validateConfig(raw: Record<string, string | undefined>): AppConfig {
  const missingKeys: string[] = [];
  const invalidKeys: string[] = [];

  for (const key of REQUIRED_VARS) {
    if (!raw[key]) {
      missingKeys.push(key);
    }
  }

  const _maxIterations = parseNumber(raw.MAX_ITERATIONS, "MAX_ITERATIONS", 5, invalidKeys);
  const _llmTimeoutMs = parseNumber(raw.LLM_TIMEOUT_MS, "LLM_TIMEOUT_MS", 120000, invalidKeys);
  // os dois de retry aceitam 0: "nao tentar de novo" e "sem espera" sao pedidos validos
  const _llmRetryCount = parseNumber(raw.LLM_RETRY_COUNT, "LLM_RETRY_COUNT", 3, invalidKeys, 0);
  const _llmRetryBaseDelayMs = parseNumber(raw.LLM_RETRY_BASE_DELAY_MS, "LLM_RETRY_BASE_DELAY_MS", 1000, invalidKeys, 0);
  const _toolTimeoutMs = parseNumber(raw.TOOL_TIMEOUT_MS, "TOOL_TIMEOUT_MS", 30000, invalidKeys);
  const _windowSize = parseNumber(raw.MEMORY_WINDOW_SIZE, "MEMORY_WINDOW_SIZE", 20, invalidKeys);
  const _dbMaxSizeMb = parseNumber(raw.DB_MAX_SIZE_MB, "DB_MAX_SIZE_MB", 500, invalidKeys);

  const primaryProvider = raw.LLM_PROVIDER || "gemini";
  const fallbackProviders = parseCsv(raw.LLM_PROVIDERS).filter((p) => p !== primaryProvider);
  const allProviders = [primaryProvider, ...fallbackProviders];

  const openRouterApiKey = raw[OPENROUTER_KEY] || undefined;

  // Sempre coletadas, mesmo com OpenRouter configurado: a chave nativa de um provedor
  // tem precedencia sobre ele para aquele provedor. Permite primario nativo e confiavel
  // (ex: gemini) com o resto da cadeia de fallback via OpenRouter.
  const apiKeys: Record<string, string> = {};
  for (const provider of allProviders) {
    const keyEnv = API_KEY_MAP[provider];
    if (!keyEnv) continue;

    if (raw[keyEnv]) {
      apiKeys[provider] = raw[keyEnv]!;
    } else if (!openRouterApiKey) {
      // sem OpenRouter para cobrir, a chave nativa e obrigatoria
      missingKeys.push(keyEnv);
    }
  }

  const models: Record<string, string> = {};
  for (const provider of allProviders) {
    const modelEnv = MODEL_ENV_MAP[provider];
    if (modelEnv && raw[modelEnv]) models[provider] = raw[modelEnv]!;
  }

  // Config parcial e pior que ausente: o bot sobe parecendo saudavel e nunca le grupo nenhum.
  // Entao basta uma das quatro aparecer para as outras tres virarem obrigatorias.
  let groups: AppConfig["groups"];
  if (GROUP_VARS.some((key) => raw[key])) {
    for (const key of GROUP_VARS) {
      if (!raw[key]) missingKeys.push(key);
    }
    groups = {
      apiId: parseNumber(raw.TELEGRAM_API_ID, "TELEGRAM_API_ID", 0, invalidKeys),
      apiHash: raw.TELEGRAM_API_HASH || "",
      session: raw.TELEGRAM_SESSION || "",
      chatIds: parseCsv(raw.TELEGRAM_GROUP_IDS),
      backfillLimit: parseNumber(raw.TELEGRAM_BACKFILL_LIMIT, "TELEGRAM_BACKFILL_LIMIT", 500, invalidKeys),
    };
  }

  if (missingKeys.length > 0 || invalidKeys.length > 0) {
    const msg =
      `Config validation failed.\n` +
      (missingKeys.length ? `Missing: ${missingKeys.join(", ")}\n` : "") +
      (invalidKeys.length ? `Invalid: ${invalidKeys.join(", ")}` : "");
    throw new ConfigError(msg, missingKeys, invalidKeys);
  }

  const config: AppConfig = {
    telegram: {
      botToken: raw.TELEGRAM_BOT_TOKEN!,
      allowedUserIds: parseCsv(raw.TELEGRAM_ALLOWED_USER_IDS),
    },
    groups,
    llm: {
      primaryProvider,
      fallbackProviders,
      apiKeys,
      models,
      openRouterApiKey,
    },
    agent: {
      maxIterations: _maxIterations,
      llmTimeoutMs: _llmTimeoutMs,
      llmRetryCount: _llmRetryCount,
      llmRetryBaseDelayMs: _llmRetryBaseDelayMs,
      toolTimeoutMs: _toolTimeoutMs,
    },
    memory: {
      windowSize: _windowSize,
      dbPath: raw.DB_PATH || "./data/db.sqlite",
      dbMaxSizeMb: _dbMaxSizeMb,
    },
    filesystem: {
      workspaceRoot: raw.WORKSPACE_ROOT || "./output",
      tmpDir: raw.TMP_DIR || "./tmp",
      skillsDir: raw.SKILLS_DIR || "./agents/skills",
    },
    logging: {
      logMessageContent: parseBoolean(raw.LOG_MESSAGE_CONTENT, false),
    },
    audio: {
      whisperBinary: raw.WHISPER_BINARY || "whisper",
      whisperModel: raw.WHISPER_MODEL || "small",
      whisperLanguage: raw.WHISPER_LANGUAGE || "pt",
      ttsVoiceId: raw.TTS_VOICE_ID || "pt-BR-ThalitaMultilingualNeural",
      ffmpegBinary: raw.FFMPEG_BINARY || "ffmpeg",
      edgeTtsBinary: raw.EDGE_TTS_BINARY || "edge-tts",
    },
  };

  return Object.freeze(config) as AppConfig;
}