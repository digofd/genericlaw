import type { ILlmProvider, LlmMessage, LlmResponse, TokenUsage } from "./types.js";
import { withRetry, toOpenAiTools, toOpenAiMessages } from "./types.js";
import type { ToolDefinition } from "../tools/registry.js";

interface OpenAiCompatResponse {
  error?: { message?: string; code?: number };
  choices?: {
    message?: {
      content?: string;
      tool_calls?: { id: string; function: { name: string; arguments: string } }[];
    };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export interface OpenAiCompatConfig {
  name: string;
  url: string;
  apiKey: string;
  model: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  retryCount?: number;
  retryBaseDelayMs?: number;
}

/**
 * DeepSeek, Groq e OpenRouter falam o mesmo protocolo: antes eram tres arquivos
 * que diferiam em nome, URL e modelo, e toda correcao de protocolo tinha de ser
 * feita tres vezes. Diferencas reais ficam no OpenAiCompatConfig.
 */
export class OpenAiCompatProvider implements ILlmProvider {
  readonly name: string;
  private url: string;
  private apiKey: string;
  private model: string;
  private headers: Record<string, string>;
  private timeoutMs: number;
  private retryCount: number;
  private retryBaseDelayMs: number;

  constructor(config: OpenAiCompatConfig) {
    this.name = config.name;
    this.url = config.url;
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.headers = config.headers ?? {};
    this.timeoutMs = config.timeoutMs || 120000;
    this.retryCount = config.retryCount ?? 3;
    this.retryBaseDelayMs = config.retryBaseDelayMs ?? 1000;
  }

  async generate(messages: LlmMessage[], tools?: ToolDefinition[]): Promise<LlmResponse> {
    return withRetry(() => this._generate(messages, tools), {
      maxRetries: this.retryCount,
      baseDelayMs: this.retryBaseDelayMs,
      retryOn: [429, 503],
    });
  }

  private async _generate(messages: LlmMessage[], tools?: ToolDefinition[]): Promise<LlmResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOpenAiMessages(messages),
      temperature: 0.7,
      max_tokens: 8192,
    };

    if (tools && tools.length > 0) {
      body.tools = toOpenAiTools(tools);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          ...this.headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw this.error(
          `${response.status} ${response.statusText}${detail ? ` - ${detail.slice(0, 200)}` : ""}`,
          response.status
        );
      }

      const data = (await response.json()) as OpenAiCompatResponse;

      // um 200 ainda pode carregar falha do provedor upstream; lanca para retry/fallback verem
      if (data.error) {
        throw this.error(`${data.error.code ?? "?"} ${data.error.message ?? "unknown error"}`, data.error.code);
      }

      return this.parseResponse(data);
    } finally {
      clearTimeout(timeout);
    }
  }

  private error(detail: string, status?: number): Error & { status?: number } {
    const err: Error & { status?: number } = new Error(`${this.name} API error: ${detail}`);
    err.status = status;
    return err;
  }

  private parseResponse(data: OpenAiCompatResponse): LlmResponse {
    const choice = data.choices?.[0];
    if (!choice) {
      return { text: `No response from ${this.name}`, finishReason: "error" };
    }

    const text = choice.message?.content || "";
    const toolCalls = choice.message?.tool_calls?.map((tc) => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        args = {};
      }
      return { id: tc.id, name: tc.function.name, arguments: args };
    });

    const usage: TokenUsage | undefined = data.usage
      ? {
          promptTokens: data.usage.prompt_tokens || 0,
          completionTokens: data.usage.completion_tokens || 0,
          totalTokens: data.usage.total_tokens || 0,
        }
      : undefined;

    let finishReason: LlmResponse["finishReason"] = "stop";
    if (choice.finish_reason === "length") finishReason = "length";
    else if (choice.finish_reason === "tool_calls" || (toolCalls && toolCalls.length > 0)) {
      finishReason = "tool_calls";
    }

    return { text, toolCalls, finishReason, usage };
  }
}

/**
 * Provedores com chave propria. O Gemini fica de fora: protocolo diferente.
 * O `model` aqui e so o padrao — <PROVEDOR>_MODEL no .env sobrescreve, porque
 * nome de modelo envelhece mais rapido que este arquivo.
 */
export const DIRECT_PRESETS: Record<string, { url: string; model: string }> = {
  openai: { url: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-mini" },
  deepseek: { url: "https://api.deepseek.com/v1/chat/completions", model: "deepseek-chat" },
  groq: { url: "https://api.groq.com/openai/v1/chat/completions", model: "llama-3.3-70b-versatile" },
};

// Apenas apelidos. Qualquer slug cru do OpenRouter tambem funciona como LLM_PROVIDER.
// A disponibilidade de modelos muda: "groq" e "nemotron-nano" sairam quando o OpenRouter os removeu do catalogo.
export const OPENROUTER_MODEL_MAP: Record<string, string> = {
  gemini: "google/gemini-2.5-flash",
  deepseek: "deepseek/deepseek-chat",
  nemotron: "nvidia/nemotron-3-ultra-550b-a55b:free",
  "nemotron-super": "nvidia/nemotron-3-super-120b-a12b:free",
};

export function openRouterProvider(config: {
  name: string;
  apiKey: string;
  timeoutMs?: number;
  retryCount?: number;
  retryBaseDelayMs?: number;
}): OpenAiCompatProvider {
  const model = OPENROUTER_MODEL_MAP[config.name] || config.name;
  console.info(`[OpenRouter] ${config.name} -> ${model}`);
  return new OpenAiCompatProvider({
    ...config,
    url: "https://openrouter.ai/api/v1/chat/completions",
    model,
    headers: { "HTTP-Referer": "http://localhost", "X-Title": "GeneriClaw" },
  });
}
