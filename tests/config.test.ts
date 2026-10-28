import { describe, it, expect } from "vitest";
import { validateConfig, ConfigError } from "../src/config.js";

const OK = {
  TELEGRAM_BOT_TOKEN: "123:abc",
  TELEGRAM_ALLOWED_USER_IDS: "111, 222",
  OPENROUTER_API_KEY: "sk-or-v1-x",
};

describe("validateConfig", () => {
  it("reports every missing required key at once", () => {
    try {
      validateConfig({});
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).missingKeys).toEqual(
        expect.arrayContaining(["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USER_IDS"])
      );
    }
  });

  it("reports non-numeric settings as invalid", () => {
    try {
      validateConfig({ ...OK, MAX_ITERATIONS: "banana" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ConfigError).invalidKeys).toContain("MAX_ITERATIONS");
    }
  });

  it("trims the allowed-user CSV", () => {
    expect(validateConfig(OK).telegram.allowedUserIds).toEqual(["111", "222"]);
  });

  it("applies documented defaults", () => {
    const c = validateConfig(OK);
    expect(c.agent.maxIterations).toBe(5);
    expect(c.memory.windowSize).toBe(20);
    expect(c.memory.dbMaxSizeMb).toBe(500);
    expect(c.filesystem.workspaceRoot).toBe("./output");
    expect(c.logging.logMessageContent).toBe(false);
  });

  it("never lists the primary provider among the fallbacks", () => {
    const c = validateConfig({ ...OK, LLM_PROVIDER: "gemini", LLM_PROVIDERS: "gemini,deepseek" });
    expect(c.llm.primaryProvider).toBe("gemini");
    expect(c.llm.fallbackProviders).toEqual(["deepseek"]);
  });

  it("does not demand per-provider keys when OpenRouter is configured", () => {
    const c = validateConfig({ ...OK, LLM_PROVIDER: "gemini", LLM_PROVIDERS: "deepseek" });
    expect(c.llm.openRouterApiKey).toBe("sk-or-v1-x");
    expect(c.llm.apiKeys).toEqual({});
  });

  it("demands per-provider keys when OpenRouter is absent", () => {
    const raw = { ...OK, LLM_PROVIDER: "gemini", LLM_PROVIDERS: "deepseek" } as Record<string, string | undefined>;
    delete raw.OPENROUTER_API_KEY;
    try {
      validateConfig(raw);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ConfigError).missingKeys).toEqual(
        expect.arrayContaining(["GEMINI_API_KEY", "DEEPSEEK_API_KEY"])
      );
    }
  });

  it("returns a frozen config", () => {
    const c = validateConfig(OK);
    expect(Object.isFrozen(c)).toBe(true);
  });
});

// Antes desta regra, OPENROUTER_API_KEY desligava a coleta de chaves nativas: uma
// GEMINI_API_KEY no .env era ignorada em silencio e o trafego ia para o alias pago
// do OpenRouter. O operador nao tinha como perceber.
describe("precedencia de chave nativa sobre OpenRouter", () => {
  const base = { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_ALLOWED_USER_IDS: "1" };

  it("coleta a chave nativa mesmo com OpenRouter configurado", () => {
    const cfg = validateConfig({
      ...base,
      OPENROUTER_API_KEY: "sk-or-xxx",
      LLM_PROVIDER: "gemini",
      LLM_PROVIDERS: "deepseek",
      GEMINI_API_KEY: "AIza-xxx",
    });
    expect(cfg.llm.apiKeys.gemini).toBe("AIza-xxx");
    // deepseek fica sem chave nativa de proposito: quem cobre e o OpenRouter
    expect(cfg.llm.apiKeys.deepseek).toBeUndefined();
    expect(cfg.llm.openRouterApiKey).toBe("sk-or-xxx");
  });

  it("com OpenRouter, chave nativa ausente nao e erro: ele cobre o provedor", () => {
    expect(() =>
      validateConfig({ ...base, OPENROUTER_API_KEY: "sk-or-xxx", LLM_PROVIDER: "gemini" })
    ).not.toThrow();
  });

  it("sem OpenRouter, chave nativa ausente continua sendo erro de boot", () => {
    expect(() => validateConfig({ ...base, LLM_PROVIDER: "gemini" })).toThrow(/GEMINI_API_KEY/);
  });

  it("modelo cru do OpenRouter nao exige chave nativa: nao esta no mapa", () => {
    const cfg = validateConfig({
      ...base,
      OPENROUTER_API_KEY: "sk-or-xxx",
      LLM_PROVIDER: "dots-studio/dots-3-note-preview:free",
    });
    expect(cfg.llm.apiKeys).toEqual({});
  });
});

describe("provedor openai e override de modelo", () => {
  const base = { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_ALLOWED_USER_IDS: "1" };

  it("reconhece OPENAI_API_KEY como chave nativa", () => {
    const cfg = validateConfig({ ...base, LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-xxx" });
    expect(cfg.llm.apiKeys.openai).toBe("sk-xxx");
  });

  it("sem a chave e sem OpenRouter, o boot falha apontando a variavel certa", () => {
    expect(() => validateConfig({ ...base, LLM_PROVIDER: "openai" })).toThrow(/OPENAI_API_KEY/);
  });

  // nome de modelo aposentado nao pode exigir edicao de codigo para voltar a bootar
  it("OPENAI_MODEL sobrescreve o padrao do preset", () => {
    const cfg = validateConfig({
      ...base, LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-xxx", OPENAI_MODEL: "gpt-9-turbo",
    });
    expect(cfg.llm.models.openai).toBe("gpt-9-turbo");
  });

  it("sem override, models fica vazio e o preset decide", () => {
    const cfg = validateConfig({ ...base, LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-xxx" });
    expect(cfg.llm.models).toEqual({});
  });
});
