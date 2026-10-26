import type { ILlmProvider, LlmMessage, LlmResponse } from "./types.js";
import type { ToolDefinition } from "../tools/registry.js";
import { GeminiProvider } from "./gemini-provider.js";
import { OpenAiCompatProvider, DIRECT_PRESETS, openRouterProvider } from "./openai-compat-provider.js";

export class ProviderFactory {
  private providers: Map<string, ILlmProvider> = new Map();

  register(name: string, provider: ILlmProvider): void {
    this.providers.set(name, provider);
  }

  create(name: string): ILlmProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`Provider '${name}' not registered.`);
    }
    return provider;
  }

  createWithFallback(names: string[]): ILlmProvider {
    // create() ja lanca para nome desconhecido, entao a lista nunca chega vazia aqui
    return new FallbackProvider(names.map((n) => this.create(n)));
  }

  getNames(): string[] {
    return Array.from(this.providers.keys());
  }

  static createFromConfig(config: {
    primaryProvider: string;
    fallbackProviders: string[];
    apiKeys: Record<string, string>;
    openRouterApiKey?: string;
    timeoutMs?: number;
    retryCount?: number;
    retryBaseDelayMs?: number;
  }): ProviderFactory {
    const factory = new ProviderFactory();

    const allProviders = [config.primaryProvider, ...config.fallbackProviders];
    const seen = new Set<string>();

    const useOpenRouter = !!config.openRouterApiKey;

    for (const name of allProviders) {
      if (seen.has(name)) continue;
      seen.add(name);

      const retries = {
        timeoutMs: config.timeoutMs,
        retryCount: config.retryCount,
        retryBaseDelayMs: config.retryBaseDelayMs,
      };

      if (useOpenRouter) {
        factory.register(name, openRouterProvider({ name, apiKey: config.openRouterApiKey!, ...retries }));
        continue;
      }

      const apiKey = config.apiKeys[name];
      if (!apiKey) continue;

      const preset = DIRECT_PRESETS[name];
      if (preset) {
        factory.register(name, new OpenAiCompatProvider({ name, apiKey, ...preset, ...retries }));
      } else if (name === "gemini") {
        factory.register(name, new GeminiProvider({ apiKey, ...retries }));
      } else {
        console.warn(`[ProviderFactory] Unknown provider '${name}', skipping.`);
      }
    }

    return factory;
  }
}

class FallbackProvider implements ILlmProvider {
  readonly name = "fallback";

  constructor(private providers: ILlmProvider[]) {}

  async generate(messages: LlmMessage[], tools?: ToolDefinition[]): Promise<LlmResponse> {
    let lastError: Error | undefined;

    for (const provider of this.providers) {
      try {
        console.info(`[FallbackProvider] Trying ${provider.name}...`);
        const response = await provider.generate(messages, tools);
        console.info(`[FallbackProvider] ${provider.name} succeeded.`);
        return response;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.warn(`[FallbackProvider] ${provider.name} failed: ${lastError.message}`);
      }
    }

    throw lastError || new Error("All providers exhausted.");
  }
}