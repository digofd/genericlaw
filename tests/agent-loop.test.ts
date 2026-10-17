import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import { AgentLoop } from "../src/core/agent-loop.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { CriarArquivoTool } from "../src/tools/criar-arquivo.js";
import { LerArquivoTool } from "../src/tools/ler-arquivo.js";
import type { ILlmProvider, LlmMessage, LlmResponse } from "../src/providers/types.js";

const WS = "./tmp/test-loop";

afterAll(() => fs.rmSync(WS, { recursive: true, force: true }));

function registry(): ToolRegistry {
  const r = new ToolRegistry();
  r.register(new CriarArquivoTool(WS));
  r.register(new LerArquivoTool(WS));
  return r;
}

/** Reproduz um roteiro fixo de respostas e registra o que foi enviado. */
class ScriptedProvider implements ILlmProvider {
  readonly name = "scripted";
  readonly seen: LlmMessage[][] = [];
  constructor(private script: LlmResponse[]) {}
  async generate(messages: LlmMessage[]): Promise<LlmResponse> {
    this.seen.push([...messages]);
    return this.script.shift() ?? { text: "fim", finishReason: "stop" };
  }
}

const readCall = (id: string): LlmResponse => ({
  text: "",
  finishReason: "tool_calls",
  toolCalls: [{ id, name: "ler_arquivo", arguments: { path: "doc.md", maxBytes: 200000 } }],
});

describe("AgentLoop duplicate tool calls", () => {
  it("executes an identical call only once and tells the model so", async () => {
    const reg = registry();
    await new CriarArquivoTool(WS).execute({ path: "doc.md", content: "conteudo", overwrite: true });

    const provider = new ScriptedProvider([readCall("a"), readCall("b"), { text: "pronto", finishReason: "stop" }]);
    const result = await new AgentLoop({ maxIterations: 5, toolTimeoutMs: 5000 }).run(
      [{ role: "system", content: "s" }, { role: "user", content: "leia" }],
      provider,
      reg
    );

    expect(result.finalResponse).toBe("pronto");

    const toolMessages = provider.seen[2].filter((m) => m.role === "tool");
    expect(toolMessages.length).toBe(2);
    expect(toolMessages[0].content).toContain("conteudo");
    // a repeticao NAO pode carregar o conteudo do arquivo uma segunda vez
    expect(toolMessages[1].content).toContain("já chamou");
    expect(toolMessages[1].content).not.toContain("conteudo");
  });

  it("still runs the same tool when the arguments differ", async () => {
    const reg = registry();
    const provider = new ScriptedProvider([
      { text: "", finishReason: "tool_calls", toolCalls: [{ id: "1", name: "criar_arquivo", arguments: { path: "a.md", content: "A" } }] },
      { text: "", finishReason: "tool_calls", toolCalls: [{ id: "2", name: "criar_arquivo", arguments: { path: "b.md", content: "B" } }] },
      { text: "ok", finishReason: "stop" },
    ]);

    await new AgentLoop({ maxIterations: 5, toolTimeoutMs: 5000 }).run(
      [{ role: "user", content: "crie dois" }], provider, reg
    );

    expect((await new LerArquivoTool(WS).execute({ path: "a.md" })).output).toBe("A");
    expect((await new LerArquivoTool(WS).execute({ path: "b.md" })).output).toBe("B");
  });
});

describe("token accounting", () => {
  it("sums usage across every iteration of a turn", async () => {
    const reg = registry();
    await new CriarArquivoTool(WS).execute({ path: "u.md", content: "x", overwrite: true });

    const provider = new ScriptedProvider([
      {
        text: "", finishReason: "tool_calls",
        toolCalls: [{ id: "1", name: "ler_arquivo", arguments: { path: "u.md" } }],
        usage: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100 },
      },
      {
        text: "pronto", finishReason: "stop",
        usage: { promptTokens: 2000, completionTokens: 200, totalTokens: 2200 },
      },
    ]);

    const r = await new AgentLoop({ maxIterations: 5, toolTimeoutMs: 5000 }).run(
      [{ role: "user", content: "leia" }], provider, reg
    );

    // o codigo antigo atribuia em vez de somar, entao isto reportava apenas 2200
    expect(r.usage).toEqual({ promptTokens: 3000, completionTokens: 300, totalTokens: 3300 });
    expect(r.iterationsUsed).toBe(2);
  });

  it("treats an empty model reply as an error rather than sending nothing", async () => {
    // o Telegram recusa texto vazio com 400, entao isto aparecia como erro de pipeline
    const provider = new ScriptedProvider([{ text: "   ", finishReason: "stop" }]);
    const r = await new AgentLoop({ maxIterations: 3, toolTimeoutMs: 5000 }).run(
      [{ role: "user", content: "oi" }], provider, registry()
    );
    expect(r.finishReason).toBe("error");
    expect(r.finalResponse.trim().length).toBeGreaterThan(0);
    expect(r.errorMessage).toBeTruthy();
  });

  it("leaves usage undefined when the provider reports none", async () => {
    const provider = new ScriptedProvider([{ text: "oi", finishReason: "stop" }]);
    const r = await new AgentLoop({ maxIterations: 3, toolTimeoutMs: 5000 }).run(
      [{ role: "user", content: "oi" }], provider, registry()
    );
    expect(r.usage).toBeUndefined();
  });
});

describe("ler_arquivo byte ceiling and paging", () => {
  const big = "x".repeat(100000);

  it("clamps maxBytes to the ceiling even when the model asks for more", async () => {
    await new CriarArquivoTool(WS).execute({ path: "big.md", content: big, overwrite: true });

    const r = await new LerArquivoTool(WS).execute({ path: "big.md", maxBytes: 200000 });
    expect(r.success).toBe(true);
    expect(r.output).toContain("leitura parcial");
    expect(r.output).toContain("offset=32768");
    expect(r.output.length).toBeLessThan(33000);
  });

  it("pages through a large file to reassemble it exactly", async () => {
    await new CriarArquivoTool(WS).execute({ path: "big.md", content: big, overwrite: true });
    const tool = new LerArquivoTool(WS);

    let assembled = "";
    let offset = 0;
    for (let guard = 0; guard < 20; guard++) {
      const r = await tool.execute({ path: "big.md", maxBytes: 32768, offset });
      expect(r.success).toBe(true);
      const match = r.output.match(/offset=(\d+)/);
      if (!match) { assembled += r.output; break; }
      assembled += r.output.slice(0, r.output.indexOf("\n\n[...leitura parcial"));
      offset = Number(match[1]);
    }
    expect(assembled).toBe(big);
  });

  it("rejects an offset past the end of the file", async () => {
    await new CriarArquivoTool(WS).execute({ path: "small.md", content: "abc", overwrite: true });
    const r = await new LerArquivoTool(WS).execute({ path: "small.md", offset: 999 });
    expect(r.success).toBe(false);
    expect(r.error).toBe("offset out of range");
  });

  it("does not split a multi-byte character across pages", async () => {
    // o c-cedilha ocupa 2 bytes, entao uma fronteira de 8193 bytes cai no meio do caractere
    const content = "a".repeat(8192) + "ç".repeat(100);
    await new CriarArquivoTool(WS).execute({ path: "utf8.md", content, overwrite: true });

    const first = await new LerArquivoTool(WS).execute({ path: "utf8.md", maxBytes: 8193 });
    expect(first.output).not.toContain("�");

    const next = Number(first.output.match(/offset=(\d+)/)![1]);
    const second = await new LerArquivoTool(WS).execute({ path: "utf8.md", maxBytes: 32768, offset: next });
    expect(second.output).not.toContain("�");
  });
});
