import type { ILlmProvider, LlmMessage, LlmResponse, TokenUsage } from "./types.js";
import { withRetry, toOpenAiTools } from "./types.js";
import type { ToolDefinition } from "../tools/registry.js";

interface OpenAIResponse {
  error?: { message?: string; code?: number };
  choices?: {
    message?: {
      content?: string;
      tool_calls?: {
        id: string;
        function: { name: string; arguments: string };
      }[];
    };
    finish_reason?: string;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export class GroqProvider implements ILlmProvider {
  readonly name = "groq";
  private apiKey: string;
  private model: string;
  private timeoutMs: number;
  private retryCount: number;
  private retryBaseDelayMs: number;

  constructor(config: {
    apiKey: string;
    model?: string;
    timeoutMs?: number;
    retryCount?: number;
    retryBaseDelayMs?: number;
  }) {
    this.apiKey = config.apiKey;
    this.model = config.model || "llama-3.3-70b-versatile";
    this.timeoutMs = config.timeoutMs || 120000;
    this.retryCount = config.retryCount || 3;
    this.retryBaseDelayMs = config.retryBaseDelayMs || 1000;
  }

  async generate(messages: LlmMessage[], tools?: ToolDefinition[]): Promise<LlmResponse> {
    return withRetry(
      () => this._generate(messages, tools),
      {
        maxRetries: this.retryCount,
        baseDelayMs: this.retryBaseDelayMs,
        retryOn: [429, 503],
      }
    );
  }

  private async _generate(messages: LlmMessage[], tools?: ToolDefinition[]): Promise<LlmResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
      })),
      temperature: 0.7,
      max_tokens: 8192,
    };

    if (tools && tools.length > 0) {
      body.tools = toOpenAiTools(tools);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        const error: Error & { status?: number } = new Error(
          `Groq API error: ${response.status} ${response.statusText}${detail ? ` - ${detail.slice(0, 200)}` : ""}`
        );
        error.status = response.status;
        throw error;
      }

      const data = (await response.json()) as OpenAIResponse;

      // um 200 ainda pode carregar falha do provedor upstream; lanca para retry/fallback verem
      if (data.error) {
        const error: Error & { status?: number } = new Error(
          `Groq API error: ${data.error.code ?? "?"} ${data.error.message ?? "unknown error"}`
        );
        error.status = data.error.code;
        throw error;
      }

      return this.parseResponse(data);
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseResponse(data: OpenAIResponse): LlmResponse {
    const choice = data.choices?.[0];
    if (!choice) {
      return { text: "No response from Groq", finishReason: "error" };
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