import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { MemoryManager } from "../src/memory/memory-manager.js";
import { destilarGrupos, slugify, montarTranscricao, pareceDocumento } from "../src/knowledge/distiller.js";
import type { ILlmProvider } from "../src/providers/types.js";
import type { GroupMessage } from "../src/memory/group-repository.js";

const DIR = "./tmp/test-distiller";
const DB = `${DIR}/db.sqlite`;
const WS = `${DIR}/workspace`;
const ROBOT = "-1001183904847";

let mm: MemoryManager;

const DOC = `# Grupo

## Glossario
- **WIN$D** — "o WIN$D de voces" (Osvaldir, 2026-10-01). Uso: mini indice.
- **EA** — "to desenvolvendo um EA" (Osvaldir, 2026-03-26). Uso: robo.
- **DD** — "DD bem mais controlado" (Osvaldir, 2026-09-30). Uso: perda acumulada.`;

/** Provider falso que registra o que recebeu e devolve um documento previsivel. */
function fakeProvider(resposta = DOC): ILlmProvider & {
  chamadas: string[];
} {
  const chamadas: string[] = [];
  return {
    name: "fake",
    chamadas,
    generate: async (messages) => {
      chamadas.push(messages[messages.length - 1].content);
      return { text: resposta, finishReason: "stop" as const };
    },
  };
}

function semear(n: number, desde = 1): GroupMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    chatId: ROBOT,
    msgId: desde + i,
    chatTitle: "RobotCrowd - OPERAÇÕES",
    sender: "Osvaldir",
    text: `mensagem numero ${desde + i}`,
    date: "2026-10-20T12:00:00.000Z",
  }));
}

const docPath = () => path.join(WS, "conhecimento", "robotcrowd-operacoes.md");

beforeEach(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(WS, { recursive: true });
  mm = new MemoryManager({ dbPath: DB, windowSize: 5, dbMaxSizeMb: 500 });
  await mm.initialize();
});

afterEach(async () => {
  await mm.shutdown();
  fs.rmSync(DIR, { recursive: true, force: true });
});

describe("slugify", () => {
  it("tira acento e pontuacao para virar nome de arquivo estavel", () => {
    expect(slugify("RobotCrowd - OPERAÇÕES")).toBe("robotcrowd-operacoes");
    expect(slugify("RobotCrowd")).toBe("robotcrowd");
    // titulo so de simbolos nao pode gerar nome vazio
    expect(slugify("!!!")).toBe("grupo");
  });
});

describe("montarTranscricao", () => {
  it("carrega autor e data em cada linha: a atribuicao precisa chegar ao prompt", () => {
    const linha = montarTranscricao(semear(1)).split("\n")[0];
    expect(linha).toBe("[2026-10-20] Osvaldir: mensagem numero 1");
  });

  it("achata quebras de linha para uma mensagem nao virar varias", () => {
    const msgs = semear(1);
    msgs[0].text = "linha um\nlinha dois";
    expect(montarTranscricao(msgs).split("\n")).toHaveLength(1);
  });
});

describe("pareceDocumento", () => {
  const bom = `# RobotCrowd

## Glossário
- **DT** — "completo dez anos de DT" (Paulo, 2026-03-26). Uso: day trade.
- **EA** — "to desenvolvendo um EA" (Guilherme, 2026-03-26). Uso: robô.
- **DD** — "DD bem mais controlado" (Ronaldo, 2026-09-30). Uso: perda.`;

  it("aceita o documento na forma esperada", () => {
    expect(pareceDocumento(bom)).toBe(true);
    // sem acento no cabecalho tambem vale: o modelo alterna entre as duas grafias
    expect(pareceDocumento(bom.replace("Glossário", "Glossario"))).toBe(true);
  });

  // Texto real que um modelo devolveu em producao e que sobrescreveu um documento bom.
  it("rejeita o modelo ecoando as instrucoes em vez de produzir o documento", () => {
    const lixo = `Let me analyze this task carefully. I need to:

1. Extract three things from the new messages:
   - **Glossario** — terms, abbreviations, nicknames and jargon the group uses
   - **Problemas recorrentes** — recurring technical difficulties

Let me go through the new messages:

[2026-06-11] Osvaldir: Milho esse mes recuperando a taca`;
    expect(pareceDocumento(lixo)).toBe(false);
  });

  it("rejeita documento com secao mas sem verbetes suficientes", () => {
    expect(pareceDocumento("## Glossário\n- **DT** — day trade.")).toBe(false);
    expect(pareceDocumento("## Glossário\n\nNada a registrar.")).toBe(false);
  });
});

describe("destilarGrupos", () => {
  it("destila o primeiro lote e grava no workspace", async () => {
    mm.saveGroupMessages(semear(40));
    const provider = fakeProvider();

    await destilarGrupos({ memory: mm, providers: [provider], workspaceRoot: WS });

    expect(fs.existsSync(docPath())).toBe(true);
    const doc = fs.readFileSync(docPath(), "utf-8");
    expect(doc).toContain("WIN$D");
    expect(doc).toContain("Destilado automaticamente de 40 mensagens");
    expect(mm.groupMessages.digestWatermark(ROBOT)).toBe(40);
  });

  it("nao chama o LLM de novo quando nada novo chegou", async () => {
    mm.saveGroupMessages(semear(40));
    const provider = fakeProvider();

    await destilarGrupos({ memory: mm, providers: [provider], workspaceRoot: WS });
    await destilarGrupos({ memory: mm, providers: [provider], workspaceRoot: WS });

    expect(provider.chamadas).toHaveLength(1);
  });

  it("espera acumular: poucas mensagens novas nao justificam uma chamada de LLM", async () => {
    mm.saveGroupMessages(semear(40));
    const provider = fakeProvider();
    await destilarGrupos({ memory: mm, providers: [provider], workspaceRoot: WS });

    mm.saveGroupMessages(semear(10, 41));
    await destilarGrupos({ memory: mm, providers: [provider], workspaceRoot: WS });

    expect(provider.chamadas).toHaveLength(1);
    expect(mm.groupMessages.digestWatermark(ROBOT)).toBe(40);
  });

  it("re-destila quando o acumulo passa do minimo, mesclando com o documento anterior", async () => {
    mm.saveGroupMessages(semear(40));
    const provider = fakeProvider();
    await destilarGrupos({ memory: mm, providers: [provider], workspaceRoot: WS });

    mm.saveGroupMessages(semear(35, 41));
    await destilarGrupos({ memory: mm, providers: [provider], workspaceRoot: WS });

    expect(provider.chamadas).toHaveLength(2);
    // a segunda chamada precisa ter recebido o documento ja destilado, senao reescreve do zero
    expect(provider.chamadas[1]).toContain("conhecimento ja destilado");
    expect(provider.chamadas[1]).toContain("WIN$D");
    // e so as mensagens novas, nao as 40 ja processadas
    expect(provider.chamadas[1]).toContain("mensagem numero 41");
    expect(provider.chamadas[1]).not.toContain("mensagem numero 1:");
    expect(mm.groupMessages.digestWatermark(ROBOT)).toBe(75);
  });

  it("processa o primeiro lote grande em pedacos ate zerar a fila", async () => {
    mm.saveGroupMessages(semear(600));
    const provider = fakeProvider();

    await destilarGrupos({ memory: mm, providers: [provider], workspaceRoot: WS });

    // CHUNK e 120: 5 chamadas para 600 mensagens
    expect(provider.chamadas).toHaveLength(5);
    expect(mm.groupMessages.digestWatermark(ROBOT)).toBe(600);
  });

  it("falha no meio preserva o que ja foi destilado em vez de reprocessar tudo", async () => {
    mm.saveGroupMessages(semear(600));
    let n = 0;
    const provider: ILlmProvider = {
      name: "flaky",
      generate: async () => {
        if (++n === 2) throw new Error("429 rate limit");
        return { text: DOC, finishReason: "stop" as const };
      },
    };

    // nao pode propagar: o bot continua rodando mesmo com o destilador quebrado
    await expect(destilarGrupos({ memory: mm, providers: [provider], workspaceRoot: WS })).resolves.toBeUndefined();
    // o primeiro lote (CHUNK=120) entrou antes da falha e fica gravado
    expect(mm.groupMessages.digestWatermark(ROBOT)).toBe(120);

    // a rodada seguinte retoma de onde parou
    await destilarGrupos({ memory: mm, providers: [provider], workspaceRoot: WS });
    expect(mm.groupMessages.digestWatermark(ROBOT)).toBe(600);
  });

  // Regressao do que aconteceu em producao: o modelo gratuito devolvia HTTP 200 com corpo
  // vazio, o FallbackProvider contava como sucesso e a cadeia nunca saia do primeiro
  // modelo. Resposta vazia tem que ser falha daquele provedor, nao do destilador.
  it("resposta vazia passa a vez para o proximo modelo", async () => {
    mm.saveGroupMessages(semear(40));
    const tentados: string[] = [];
    const providers: ILlmProvider[] = [
      {
        name: "vazio",
        generate: async () => {
          tentados.push("vazio");
          return { text: "", finishReason: "stop" as const };
        },
      },
      {
        name: "tambem-vazio",
        generate: async () => {
          tentados.push("tambem-vazio");
          return { text: "   \n  ", finishReason: "stop" as const };
        },
      },
      {
        name: "bom",
        generate: async () => {
          tentados.push("bom");
          return { text: DOC, finishReason: "stop" as const };
        },
      },
    ];

    await destilarGrupos({ memory: mm, providers, workspaceRoot: WS });

    expect(tentados).toEqual(["vazio", "tambem-vazio", "bom"]);
    expect(mm.groupMessages.digestWatermark(ROBOT)).toBe(40);
    expect(fs.existsSync(docPath())).toBe(true);
  });

  it("resposta cheia porem malformada cede a vez e nao sobrescreve o documento bom", async () => {
    mm.saveGroupMessages(semear(40));
    await destilarGrupos({ memory: mm, providers: [fakeProvider()], workspaceRoot: WS });
    const antes = fs.readFileSync(docPath(), "utf-8");

    mm.saveGroupMessages(semear(35, 41));
    const lixo: ILlmProvider = {
      name: "tagarela",
      generate: async () => ({
        text: "Let me analyze this task carefully. I need to extract three things:\n\n[2026-06-11] Osvaldir: milho",
        finishReason: "stop" as const,
      }),
    };

    await destilarGrupos({ memory: mm, providers: [lixo], workspaceRoot: WS });

    expect(fs.readFileSync(docPath(), "utf-8")).toBe(antes);
    expect(mm.groupMessages.digestWatermark(ROBOT)).toBe(40);
  });

  it("provedor que lanca tambem cede a vez, em vez de abortar o grupo", async () => {
    mm.saveGroupMessages(semear(40));
    const providers: ILlmProvider[] = [
      { name: "429", generate: async () => { throw new Error("429 Too Many Requests"); } },
      { name: "bom", generate: async () => ({ text: DOC, finishReason: "stop" as const }) },
    ];

    await destilarGrupos({ memory: mm, providers, workspaceRoot: WS });

    expect(mm.groupMessages.digestWatermark(ROBOT)).toBe(40);
  });

  it("todos vazios nao apaga o conhecimento ja gravado nem avanca a marca", async () => {
    mm.saveGroupMessages(semear(40));
    await destilarGrupos({ memory: mm, providers: [fakeProvider()], workspaceRoot: WS });
    const antes = fs.readFileSync(docPath(), "utf-8");

    mm.saveGroupMessages(semear(35, 41));
    await destilarGrupos({ memory: mm, providers: [fakeProvider("   ")], workspaceRoot: WS });

    expect(fs.readFileSync(docPath(), "utf-8")).toBe(antes);
    expect(mm.groupMessages.digestWatermark(ROBOT)).toBe(40);
  });

  it("um grupo que falha nao impede o outro", async () => {
    mm.saveGroupMessages(semear(40));
    mm.saveGroupMessages(
      semear(40).map((m) => ({ ...m, chatId: "-100999", chatTitle: "RobotCrowd" }))
    );

    const provider: ILlmProvider = {
      name: "parcial",
      generate: async (messages) => {
        if (messages[1].content.includes("OPERAÇÕES")) throw new Error("boom");
        return { text: DOC, finishReason: "stop" as const };
      },
    };

    await destilarGrupos({ memory: mm, providers: [provider], workspaceRoot: WS });

    expect(fs.existsSync(path.join(WS, "conhecimento", "robotcrowd.md"))).toBe(true);
    expect(fs.existsSync(docPath())).toBe(false);
    expect(mm.groupMessages.digestWatermark("-100999")).toBe(40);
    expect(mm.groupMessages.digestWatermark(ROBOT)).toBe(0);
  });
});
