import { BaseTool, truncateUtf8, delimitarNaoConfiavel } from "./registry.js";
import type { ToolDefinition, ToolResult } from "./registry.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { GroupMessage, GroupSummary } from "../memory/group-repository.js";

const LIMITE_PADRAO = 30;
const LIMITE_MAX = 100;
// o resultado volta como contexto a cada turno seguinte, entao vale apertar
const MAX_SAIDA_BYTES = 12000;

export class HistoricoGrupoTool extends BaseTool {
  constructor(private memory: MemoryManager) {
    super();
  }

  readonly definition: ToolDefinition = {
    name: "historico_grupo",
    description:
      "Consulta o historico de mensagens dos grupos do Telegram que estao sendo acompanhados. " +
      "Use 'listar' para descobrir quais grupos existem, 'recentes' para ler as ultimas mensagens " +
      "de um grupo e 'buscar' para procurar um texto nas mensagens.",
    parameters: {
      type: "object",
      properties: {
        acao: {
          type: "string",
          description: "O que fazer: listar os grupos, ler as mensagens recentes de um, ou buscar um texto.",
          enum: ["listar", "recentes", "buscar"],
        },
        grupo: {
          type: "string",
          description:
            "Nome (ou parte do nome) do grupo, ou o id numerico. Obrigatorio em 'recentes', opcional em 'buscar'.",
        },
        termo: { type: "string", description: "Texto a procurar. Obrigatorio em 'buscar'." },
        limite: {
          type: "number",
          description: `Quantas mensagens retornar. Padrao ${LIMITE_PADRAO}, maximo ${LIMITE_MAX}.`,
        },
      },
      required: ["acao"],
    },
  };

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const acao = args.acao as string;
    const grupo = typeof args.grupo === "string" ? args.grupo.trim() : "";
    const termo = typeof args.termo === "string" ? args.termo.trim() : "";

    // valores fora da faixa (0, negativo, 5000) chegam do modelo com frequencia
    const bruto = typeof args.limite === "number" ? Math.floor(args.limite) : LIMITE_PADRAO;
    const limite = Math.min(Math.max(bruto, 1), LIMITE_MAX);

    const grupos = this.memory.groupMessages.groups();
    if (grupos.length === 0) {
      return {
        success: true,
        output:
          "Nenhum grupo acompanhado ainda. Verifique TELEGRAM_GROUP_IDS no .env e se o coletor subiu sem erro.",
      };
    }

    if (acao === "listar") return { success: true, output: this.formatarGrupos(grupos) };

    if (acao === "recentes") {
      if (!grupo) {
        return { success: false, output: "Erro: informe 'grupo' para a acao 'recentes'.", error: "missing grupo" };
      }
      const alvo = this.resolverGrupo(grupo, grupos);
      if ("erro" in alvo) return { success: false, output: alvo.erro, error: "grupo" };

      const msgs = this.memory.groupMessages.recent(alvo.chatId, limite);
      return {
        success: true,
        output: this.formatarMensagens(`Ultimas ${msgs.length} mensagens de "${alvo.chatTitle}"`, msgs, false),
      };
    }

    if (acao === "buscar") {
      if (!termo) {
        return { success: false, output: "Erro: informe 'termo' para a acao 'buscar'.", error: "missing termo" };
      }
      let chatId: string | undefined;
      let onde = "todos os grupos";
      if (grupo) {
        const alvo = this.resolverGrupo(grupo, grupos);
        if ("erro" in alvo) return { success: false, output: alvo.erro, error: "grupo" };
        chatId = alvo.chatId;
        onde = `"${alvo.chatTitle}"`;
      }

      const msgs = this.memory.groupMessages.search(termo, limite, chatId);
      if (msgs.length === 0) {
        return { success: true, output: `Nada encontrado para "${termo}" em ${onde}.` };
      }
      // search devolve do mais novo para o mais antigo; ler em ordem cronologica e mais util
      return {
        success: true,
        output: this.formatarMensagens(
          `${msgs.length} resultado(s) para "${termo}" em ${onde}`,
          msgs.reverse(),
          !chatId
        ),
      };
    }

    return { success: false, output: `Erro: acao desconhecida '${acao}'.`, error: "acao" };
  }

  /** Casa por id exato primeiro, depois por pedaco do nome. */
  private resolverGrupo(
    busca: string,
    grupos: GroupSummary[]
  ): GroupSummary | { erro: string } {
    const exato = grupos.find((g) => g.chatId === busca);
    if (exato) return exato;

    const alvo = busca.toLowerCase();
    const parciais = grupos.filter((g) => g.chatTitle.toLowerCase().includes(alvo));

    if (parciais.length === 1) return parciais[0];
    if (parciais.length === 0) {
      return { erro: `Erro: nenhum grupo corresponde a "${busca}".\n${this.formatarGrupos(grupos)}` };
    }
    return {
      erro:
        `Erro: "${busca}" corresponde a ${parciais.length} grupos. Seja mais especifico:\n` +
        parciais.map((g) => `  - ${g.chatTitle} (id ${g.chatId})`).join("\n"),
    };
  }

  private formatarGrupos(grupos: GroupSummary[]): string {
    const linhas = grupos.map(
      (g) => `  - ${g.chatTitle} (id ${g.chatId}) — ${g.total} mensagens, ultima em ${g.lastDate.slice(0, 16).replace("T", " ")}`
    );
    return `Grupos acompanhados:\n${linhas.join("\n")}`;
  }

  private formatarMensagens(titulo: string, msgs: GroupMessage[], comGrupo: boolean): string {
    if (msgs.length === 0) return `${titulo}: nenhuma mensagem.`;

    const linhas = msgs.map((m) => {
      const quando = m.date.slice(0, 16).replace("T", " ");
      const prefixo = comGrupo ? `[${m.chatTitle}] ` : "";
      return `${prefixo}[${quando}] ${m.sender}: ${m.text}`;
    });

    // trunca antes de embrulhar: cortar depois poderia decepar o marcador de fim
    const corpo = truncateUtf8(linhas.join("\n"), MAX_SAIDA_BYTES);
    return `${titulo}:\n${delimitarNaoConfiavel(corpo, "o texto literal de mensagens escritas por membros do grupo")}`;
  }
}
