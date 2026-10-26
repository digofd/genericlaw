import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import fs from "fs";
import { AgentLoop } from "../src/core/agent-loop.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { CriarArquivoTool } from "../src/tools/criar-arquivo.js";
import type { ILlmProvider, LlmResponse } from "../src/providers/types.js";

const WS = "./tmp/test-log";
afterAll(() => fs.rmSync(WS, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

// A viaja como conteudo de mensagem; B e o nome da ferramenta, que o log sempre
// mostra. Sem B, "A nao apareceu" poderia ser apenas a captura de log quebrada.
const MARCADOR_A = "MARCADOR-SEGREDO-4C8D";
const MARCADOR_B = "criar_arquivo";

class ScriptedProvider implements ILlmProvider {
  readonly name = "scripted";
  constructor(private script: LlmResponse[]) {}
  async generate(): Promise<LlmResponse> {
    return this.script.shift() ?? { text: "fim", finishReason: "stop" };
  }
}

/** Destino: tudo que o processo escreveu no log durante o caminho real. */
async function logsDoCaminhoReal(logMessageContent: boolean): Promise<string> {
  const linhas: string[] = [];
  const capturar = (...args: unknown[]) => void linhas.push(args.join(" "));
  vi.spyOn(console, "info").mockImplementation(capturar);
  vi.spyOn(console, "warn").mockImplementation(capturar);

  const reg = new ToolRegistry();
  reg.register(new CriarArquivoTool(WS));

  const provider = new ScriptedProvider([
    {
      text: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "1", name: MARCADOR_B, arguments: { path: "nota.md", content: MARCADOR_A } }],
    },
    { text: "ok", finishReason: "stop" },
  ]);

  await new AgentLoop({ maxIterations: 5, toolTimeoutMs: 5000, logMessageContent }).run(
    [{ role: "user", content: "anote" }],
    provider,
    reg
  );

  return linhas.join("\n");
}

describe("LOG_MESSAGE_CONTENT", () => {
  it("com a flag ligada, o conteudo aparece no log", async () => {
    const log = await logsDoCaminhoReal(true);
    expect(log).toContain(MARCADOR_B); // controle: a captura funciona
    expect(log).toContain(MARCADOR_A);
  });

  it("com a flag desligada (padrao), o conteudo nao aparece no log", async () => {
    const log = await logsDoCaminhoReal(false);
    expect(log).toContain(MARCADOR_B); // controle: a captura funciona
    expect(log).not.toContain(MARCADOR_A);
  });
});
