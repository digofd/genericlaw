import type { ILlmProvider, LlmMessage, LlmResponse } from "../providers/types.js";
import type { ToolRegistry, ITool, ToolResult } from "../tools/registry.js";
import type { AgentLoopResult, TokenUsage } from "../memory/memory-manager.js";

const BASE_SYSTEM_PROMPT = `Você é o GeneriClaw, um agente pessoal de IA executando localmente no desktop do usuário.
Você responde comandos recebidos via Telegram, tem acesso a ferramentas de filesystem e pode gerar documentos.

Regras:
1. Responda SEMPRE em português do Brasil (pt-BR).
2. Seja direto e conciso.
3. Use ferramentas quando necessário para ler ou criar arquivos.
4. Se precisar criar um arquivo .md, use a ferramenta criar_arquivo.
5. Se a resposta do usuário for curta e casual, responda em texto puro.
6. Se gerar um documento, indique claramente o nome do arquivo criado.
7. Nunca invente resultados de ferramentas — execute-as primeiro.
8. Você PODE responder em áudio. Quando o usuário pedir áudio ou voz, apenas escreva a resposta normalmente: o sistema converte o texto em voz automaticamente. Nunca diga que não consegue gerar áudio e nunca sugira ferramentas externas de TTS.`;

/**
 * Renderizacao compacta e segura dos argumentos de tool: strings longas viram um tamanho.
 * Com logMessageContent desligado nenhuma string sai literal - e o que a flag promete.
 */
function describeArgs(args: Record<string, unknown>, logMessageContent: boolean): string {
  return Object.entries(args)
    .map(([k, v]) => {
      const ocultar = typeof v === "string" && (!logMessageContent || v.length > 80);
      return `${k}=${ocultar ? `<${(v as string).length} chars>` : JSON.stringify(v)}`;
    })
    .join(", ");
}

export class AgentLoop {
  private maxIterations: number;
  private toolTimeoutMs: number;
  private logMessageContent: boolean;

  constructor(config: { maxIterations: number; toolTimeoutMs: number; logMessageContent?: boolean }) {
    this.maxIterations = config.maxIterations;
    this.toolTimeoutMs = config.toolTimeoutMs;
    this.logMessageContent = config.logMessageContent ?? false;
  }

  getBaseSystemPrompt(): string {
    return BASE_SYSTEM_PROMPT;
  }

  async run(
    messages: LlmMessage[],
    provider: ILlmProvider,
    toolRegistry: ToolRegistry
  ): Promise<AgentLoopResult> {
    let toolCallsMade = 0;
    let iterationsUsed = 0;
    let totalUsage: TokenUsage | undefined = undefined;

    const conversationMessages = [...messages];
    // Repetir uma chamada identica anexa o mesmo resultado de novo; numa execucao real isso
    // colocou um arquivo de 195 mil caracteres duas vezes no contexto, levando o prompt a 121k tokens.
    const alreadyExecuted = new Set<string>();

    for (let i = 0; i < this.maxIterations; i++) {
      iterationsUsed = i + 1;
      console.info(`[AgentLoop] Iteration ${iterationsUsed}/${this.maxIterations}`);

      let response: LlmResponse;
      try {
        response = await provider.generate(conversationMessages, toolRegistry.getToolDefinitions());
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[AgentLoop] Provider failed: ${msg}`);
        return {
          conversationId: "",
          finalResponse: "Desculpe, todos os provedores de IA estão indisponíveis no momento.",
          toolCallsMade,
          iterationsUsed,
          finishReason: "error",
          requiresAudioReply: false,
          errorMessage: msg,
        };
      }

      if (response.usage) {
        // Cada iteracao e uma chamada faturada a parte, entao o custo do turno e a soma.
        // Antes isso sobrescrevia, reportando apenas a ultima chamada de um turno com varias etapas.
        totalUsage = totalUsage
          ? {
              promptTokens: totalUsage.promptTokens + response.usage.promptTokens,
              completionTokens: totalUsage.completionTokens + response.usage.completionTokens,
              totalTokens: totalUsage.totalTokens + response.usage.totalTokens,
            }
          : { ...response.usage };
        console.info(
          `[AgentLoop] Tokens: prompt=${response.usage.promptTokens}, completion=${response.usage.completionTokens}, total=${response.usage.totalTokens} (acumulado: ${totalUsage.totalTokens})`
        );
      }

      if (response.toolCalls && response.toolCalls.length > 0) {
        toolCallsMade++;

        if (response.toolCalls.length > 1) {
          const ignored = response.toolCalls.slice(1).map((tc) => tc.name);
          console.warn(
            `[AgentLoop] LLM returned ${response.toolCalls.length} tool calls; only the first is executed. Ignored: [${ignored.join(", ")}]`
          );
        }

        const toolCall = response.toolCalls[0];

        conversationMessages.push({
          role: "assistant",
          content: response.text || `Calling tool: ${toolCall.name}`,
          // sem isto o resultado abaixo vira um role=tool orfao e a API recusa com 400
          toolCalls: [toolCall],
        });

        const key = `${toolCall.name}:${JSON.stringify(toolCall.arguments)}`;
        if (alreadyExecuted.has(key)) {
          console.warn(`[AgentLoop] Duplicate call to ${toolCall.name} suppressed.`);
          conversationMessages.push({
            role: "tool",
            content:
              `Você já chamou ${toolCall.name} com exatamente estes argumentos nesta resposta. ` +
              `O resultado está acima — use-o em vez de repetir a chamada.`,
            toolCallId: toolCall.id,
          });
          continue;
        }
        alreadyExecuted.add(key);

        const toolResult = await this.executeTool(toolCall.name, toolCall.arguments, toolRegistry);

        conversationMessages.push({
          role: "tool",
          content: toolResult.output,
          toolCallId: toolCall.id,
        });

        console.info(
          `[AgentLoop] Tool ${toolCall.name}(${describeArgs(toolCall.arguments, this.logMessageContent)}) executed: ${toolResult.success ? "success" : "failure"}`
        );
        continue;
      }

      // Resposta vazia nao e resposta valida: o Telegram recusa texto vazio com
      // 400, entao ela apareceria como erro de pipeline em vez de resposta.
      const text = (response.text || "").trim();
      const failed = response.finishReason === "error" || text.length === 0;
      console.info(`[AgentLoop] Final response (${failed ? "error" : "text"})`);

      return {
        conversationId: "",
        finalResponse: text || "Não consegui gerar uma resposta. Tente reformular o pedido.",
        toolCallsMade,
        iterationsUsed,
        finishReason: failed ? "error" : "stop",
        requiresAudioReply: false,
        usage: totalUsage,
        errorMessage: failed ? (text || "empty response from provider") : undefined,
      };
    }

    console.warn("[AgentLoop] Max iterations reached.");
    return {
      conversationId: "",
      finalResponse: "Desculpe, desisti ou deu timeout no processamento pois falhei nas chamadas em MAX iterações.",
      toolCallsMade,
      iterationsUsed,
      finishReason: "max_iterations",
      requiresAudioReply: false,
      usage: totalUsage,
    };
  }

  private async executeTool(
    name: string,
    args: Record<string, unknown>,
    toolRegistry: ToolRegistry
  ): Promise<ToolResult> {
    if (!toolRegistry.has(name)) {
      const available = toolRegistry.getToolNames().join(", ");
      return {
        success: false,
        output: `Tool '${name}' não disponível. Ferramentas disponíveis: ${available}`,
        error: "tool not found",
      };
    }

    let tool: ITool;
    try {
      tool = toolRegistry.get(name);
    } catch {
      return {
        success: false,
        output: `Erro ao instanciar tool '${name}'.`,
        error: "instantiation error",
      };
    }

    const validation = tool.validateArgs(args);
    if (!validation.valid) {
      return {
        success: false,
        output: `Argumentos inválidos: ${validation.errors?.join(", ")}. Corrija e reenvie.`,
        error: "invalid args",
      };
    }

    try {
      const result = await Promise.race([
        tool.execute(args),
        new Promise<ToolResult>((resolve) =>
          setTimeout(
            () => resolve({ success: false, output: `Error: Tool execution timed out after ${this.toolTimeoutMs / 1000}s.`, error: "timeout" }),
            this.toolTimeoutMs
          )
        ),
      ]);
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: `Error: ${msg}`, error: msg };
    }
  }
}