# Spec: Agent Loop (Reasoning Engine)

---

## 1. Resumo

O **Agent Loop** e a engrenagem central do GeneriClaw. Ele implementa o padrao ReAct (Reasoning and Acting). E o modulo onde uma acao bruta entra, e submetida ao LLM base (Thought), uma ou mais ferramentas sao chamadas (Action+Observation), ate um veredito de resposta final ser chegado, repetindo em loop limitado de iteracoes para evitar impasses de contexto infinito.

---

## 2. Contexto e Motivacao

**Problema:**
Um LLM standard responde de forma estatica do ponto de vista do seu conhecimento congelado. Para que ele vire um Agente, e preciso que ele receba e aja recursivamente no ambiente que esta imersivo a ele.

**Evidencias:**
Tentar fazer uma "Mega Prompt" para que ele decida e gere arquivo num take so quase sempre gera inferencias sujas e falsas promessas de execucao (alucinadas). Ele deve executar uma ferramental real via Loop e aguardar o resultado para so entao inferir o fecho.

**Por que agora:**
Precisamos desacoplar a parte de grammy/entrada de dados da parte de processamento puramente sistemico (Tool calls/Registry).

---

## 3. Goals (Objetivos)

- [x] G-01: Rodar uma iteracao abstrata e agnostica onde um `LLM` possa fornecer ou uma resposta final legivel, ou um Tool Call bem estruturado.
- [x] G-02: Executar automaticamente o call pelo Factory de tools e repassar a observacao como se fosse o usuario (`ToolOutput`) no proximo payload pro LLM.
- [x] G-03: Parar de forma deterministica por um hard limit configuravel (ex: 5 interacoes no MAX_ITERATIONS).
- [x] G-04: Entregar as `ToolDefinition` do `ToolRegistry` ao provider em cada iteracao, como function declarations nativas.
- [x] G-05: Nunca executar a mesma tool duas vezes com argumentos identicos dentro de um mesmo turno.
- [x] G-06: Somar o consumo de tokens de todas as iteracoes do turno.
- [x] G-07: Registrar a tool call na mensagem do assistente, para o resultado seguinte nao viajar orfao (ver 8.7).
- [x] G-08: Respeitar `LOG_MESSAGE_CONTENT` ao logar argumentos de tool (ver 8.8).

**Metricas de sucesso:**
| Metrica | Baseline atual | Target | Prazo |
|---------|---------------|--------|-------|
| Completude (Success Rate de ReAct loops) | N/A | 95% encerram antes do teto | Em prod |
| Hard limit triggers | Sem limite | Estoura limpo (Throw Error) nas iteracoes superadas (>MAX) | Imediato |

---

## 4. Non-Goals (Fora do Escopo)

- NG-01: Manter sessoes abertas suspensas aguardando input do usuario no MEIO de um loop de Agent Loop ativo.
- NG-02: Executar Tools de forma paralela usando workers (as tool calls serao tratadas resolutivamente em cascata Promise-based Node sequencial no escopo da mesma iteracao ReAct).

---

## 5. Usuarios e Personas

**Modulo Cliente Primario:** O `AgentController`, que invoca o AgentLoop repassando o array de mensagens ja montado (system prompt + historico + input atual) e o provider ja resolvido via `ProviderFactory.createWithFallback()`.

---

## 6. Requisitos Funcionais

### 6.1 Requisitos Principais

| ID | Requisito | Prioridade | Criterio de Aceite |
|----|-----------|-----------|-------------------|
| RF-01 | O sistema deve suportar iterar sobre a classe `BaseTool` herdada para todas as features disponiveis usando o pattern Registry. | Must | Se o LLM retornar JSON malformado nos argumentos de tool call, o AgentLoop injeta observation de erro e a iteracao consome 1 unidade do limite. O LLM tem chance de corrigir na proxima iteracao. |
| RF-02 | O Agent Loop deve sempre instanciar uma iteracao limitadora e parar a execucao quando `current > MAX_ITERATIONS` for verificado. | Must | Uma chamada maliciosa nao gera billing infinito. |
| RF-03 | A Observacao do ambiente gerada por uma base de Tool (`result.output`) deve sempre retornar pro array de mensagens para a proxima deducao (Thought). | Must | LLM nao deve se perder; e nao pode pre-anunciar execucao. |
| RF-04 | O Agent Loop deve registrar logs detalhados de cada etapa (Thought, Action, Observation) no console para monitoramento. | Must | O desenvolvedor deve conseguir acompanhar o raciocinio do agente em tempo real. |

### 6.2 Fluxo Principal (Happy Path)

1. O AgentController monta o array completo de mensagens (system prompt + historico + input) e chama `AgentLoop.run(messages, provider, toolRegistry)`.
2. O AgentLoop recebe o array pronto - nao adiciona mensagens do banco.
3. LLM infere no array atual e decide a chamada `ToolChoice`.
4. O LLM, guiado pelo system prompt da skill, retorna um tool call para executar "criar_arquivo".
5. Iterator detecta chamada, Factory instancia e preenche com Args do JSON.
6. A Promise da Tool retorna "Arquivo Foo feito!".
7. Injeta resultado na variavel observation array como `{ role: "tool", content: "Arquivo Foo feito!" }`. Retorna ao (3) que gera a final response "Usuario, arquivo Foo foi construido!".

### 6.3 Fluxos Alternativos

**Fluxo Alternativo A - Max Iterations Reached:**
1. A IA acha que falta informacao ou repete tool call incorreto seguidamente.
2. Contagem do loop alcanca o `process.env.MAX_ITERATIONS` (5).
3. O Loop injeta break forcado.
4. Output final vira: "Desculpe, desisti ou deu timeout no processamento pois falhei nas chamadas em MAX iteracoes."

**Fluxo Alternativo B - Falha do Provider (LLM):**
1. `provider.generate()` lanca excecao apos todos os providers da cadeia de fallback serem esgotados.
2. O AgentLoop captura e propaga a excecao ao AgentController.
3. O AgentController encaminha o erro ao OutputHandler, que notifica o usuario.
4. O AgentLoop nao implementa logica de fallback - o fallback e tratado transparentemente pelo proxy criado por `ProviderFactory.createWithFallback()` antes da chamada ao AgentLoop. O AgentLoop so ve a excecao terminal.

---

## 7. Requisitos Nao-Funcionais

| ID | Requisito | Valor alvo | Observacao |
|----|-----------|-----------|------------|
| RNF-01 | Timeout por iteracao unitaria LLM | < 120s | Pra evitar socket hang do Node |
| RNF-02 | Timeout por execucao de tool | 30s | Aplicado via `Promise.race` no AgentLoop. Tool que excede o tempo tem execucao abortada e observation de timeout injetada. |

---

## 8. Design e Interface

### 8.1 AgentLoop

```typescript
class AgentLoop {
  private maxIterations: number;
  private toolTimeoutMs: number;
  private logMessageContent: boolean;   // padrao false; ver 8.8

  constructor(config: {
    maxIterations: number;
    toolTimeoutMs: number;
    logMessageContent?: boolean;
  });

  getBaseSystemPrompt(): string;        // o AgentController o injeta como mensagem [0]

  async run(
    messages: LlmMessage[],
    provider: ILlmProvider,
    toolRegistry: ToolRegistry
  ): Promise<AgentLoopResult>;
}
```

### 8.2 Contrato interno

- `run()` recebe o array de mensagens ja montado pelo AgentController. Nao adiciona mensagens do banco.
- Cada iteracao do ReAct consome 1 unidade do limite `maxIterations`, incluindo iteracoes que resultam em JSON malformado do LLM (EC-01). A resposta de correcao do LLM ocorre na iteracao seguinte, consumindo outra unidade.
- Quando uma Tool lanca excecao (EC-02), o erro e embrulhado como `{ role: "tool", content: "Error: ..." }` e injetado no array de mensagens para o LLM corrigir.
- O AgentLoop chama `provider.generate()` diretamente. O provider recebido ja e o proxy de fallback criado por `ProviderFactory.createWithFallback()`. O proxy absorve falhas de provedores individuais transparentemente. O AgentLoop so captura a excecao terminal (todos os providers esgotados) e a propaga ao Controller.
- Fallback padrao para `maxIterations` quando a variavel de ambiente `MAX_ITERATIONS` nao esta definida: 5.
- O AgentLoop **nao** classifica a resposta final por formato. A criacao de arquivos e feita pela tool `criar_arquivo`, que escreve no `WORKSPACE_ROOT`; a resposta ao usuario e sempre texto (ou audio, ver `requiresAudioReply`). Uma heuristica anterior marcava respostas contendo blocos markdown como "arquivo" e reenviava o texto inteiro como documento - com tool calling funcionando ela passou a duplicar entregas e foi removida.

### 8.3 Entrega de tools ao provider

Em cada iteracao o AgentLoop chama `provider.generate(messages, toolRegistry.getToolDefinitions())`.
As definicoes viajam pelo campo nativo de function calling de cada API - `tools` no formato OpenAI,
`functionDeclarations` no Gemini (ver `llm-provider.md` 8.3). **Tools nunca sao serializadas como
texto dentro de uma mensagem `system`.** Descrever ferramentas em prosa nao habilita function
calling: o modelo nao emite `tool_calls` e o loop nunca executa nada.

### 8.4 Deduplicacao de tool calls

O AgentLoop mantem, por execucao de `run()`, um conjunto das chamadas ja executadas, chaveado por
nome + argumentos serializados. Se o modelo repetir exatamente a mesma chamada, a tool **nao** e
executada de novo; em vez disso o loop injeta uma mensagem `tool` curta dizendo que o resultado ja
esta acima.

Isso existe porque todo resultado de tool e anexado ao contexto do loop: uma repeticao coloca a
mesma carga duas vezes no prompt. Observado em producao com um documento de ~195k caracteres lido
duas vezes seguidas, levando o prompt a 121k tokens.

### 8.5 Contabilidade de tokens

Cada iteracao e uma chamada de API faturada separadamente, entao `AgentLoopResult.usage` e a **soma**
de todas as iteracoes do turno, nao a ultima. O log de cada iteracao mostra o consumo individual e o
acumulado. Esse valor e persistido no metadata da mensagem pelo MemoryManager, entao qualquer
metrica de custo depende dele estar somado.

### 8.6 Propagacao de erro do provider

Se o provider sinaliza `finishReason: "error"`, o AgentLoop propaga isso como
`AgentLoopResult.finishReason = "error"` e preenche `errorMessage`. Um erro de provider nunca e
entregue como resposta normal - o OutputHandler precisa do campo para escolher a `ErrorOutputStrategy`
(ver `telegram-output.md`).

### 8.7 Registro da tool call na mensagem do assistente

Ao executar uma ferramenta, o loop anexa **duas** mensagens ao contexto, nesta ordem:

```typescript
{ role: "assistant", content: texto || `Calling tool: ${nome}`, toolCalls: [toolCall] }
{ role: "tool",      content: resultado, toolCallId: toolCall.id }
```

O campo `toolCalls` na primeira **nao e opcional na pratica**: as APIs compativeis com OpenAI
recusam com `400` um `role: "tool"` que nao responda a um `assistant` com `tool_calls` de mesmo
`id` (ver `llm-provider.md` 8.6). Omitir o campo quebra DeepSeek e Groq diretos em toda segunda
iteracao de qualquer turno com ferramenta.

A mensagem de deduplicacao (8.4) tambem carrega `toolCallId`, e por isso a chamada suprimida
continua sendo registrada em `alreadyExecuted` **antes** de o resultado ser injetado - caso
contrario a segunda ocorrencia seria um orfao.

### 8.8 Log de argumentos e `LOG_MESSAGE_CONTENT`

Cada execucao de tool e logada como
`[AgentLoop] Tool <nome>(<args>) executed: success|failure`. Os argumentos passam por
`describeArgs(args, logMessageContent)`:

- **`logMessageContent: false` (padrao):** *toda* string vira `<N chars>`. Nomes de tool, chaves de
  argumento e tamanhos continuam no log - o suficiente para seguir o fluxo sem gravar conteudo.
- **`logMessageContent: true`:** strings ate 80 caracteres saem literais; acima disso ainda viram
  `<N chars>`, porque um arquivo inteiro no log nao ajuda ninguem.

O valor vem de `AppConfig.logging.logMessageContent`, injetado pelo bootstrap no construtor. Durante
um periodo a flag existia na config, era lida do `.env` e testada - mas **nenhuma linha de codigo a
consultava**, enquanto o README e tres specs prometiam que ela mantinha conteudo fora dos logs. Uma
garantia de privacidade documentada e nao implementada e pior que a ausencia dela.

**Componentes afetados:** Terminal log-output, Repasse assincrono pro Output de chat.

---

## 9. Modelo de Dados

Nao gera tabelas SQL exclusivas, e stateful em RAM contendo arrays literais durante as interacoes. No fim, a resposta e entregue para salvar via MemoryManager.

---

## 10. Integracoes e Dependencias

| Dependencia | Tipo | Impacto se indisponivel |
|-------------|------|------------------------|
| ILlmProvider implementations | Obrigatoria | Loop principal e interrompido. O AgentLoop propaga a excecao ao Controller. |
| ToolRegistry instanciado | Obrigatoria | System prompt ficara vazio / nao enxerga bracos atuadores. |

---

## 11. Edge Cases e Tratamento de Erros

| Cenario | Trigger | Comportamento esperado |
|---------|---------|----------------------|
| EC-01: JSON Malformado de Argumento da IA | O LLM burla a formatacao e entrega string malfeita em vez do schema no ToolCall | Catch no loop e gera Observation pro LLM com `{ role: "tool", content: "JSON invalido, reenvie a estrutura corrigida por favor." }`. Esta iteracao consome 1 unidade do limite. |
| EC-02: Ferramenta retorna Throw (Error hard) | Tentou criar num path que nao existe na maquina host do Node (`fs.writeFileSync` failure). | O catch embrulha o erro como `{ role: "tool", content: "Error: ENOENT path not exists..." }` e injeta no array de mensagens. O LLM usa essa observation para corrigir o caminho na proxima iteracao. |
| EC-03: Max Iteration Limits | Variavel de MAX nao foi lida do env (null). | Definir fallback pra 5 explicitamente pra nao corromper infra. |
| EC-04: Provider (LLM) falha durante o loop | `provider.generate()` lanca excecao apos todos os providers da cadeia de fallback serem esgotados. | O AgentLoop captura e propaga a excecao ao AgentController. O fallback de provider e resolvido pelo `ProviderFactory.createWithFallback()` - o proxy de fallback absorve falhas de provedores individuais transparentemente. O AgentLoop so percebe a falha quando TODOS os providers da cadeia falham. |
| EC-05: Tool excede timeout de execucao | `tool.execute()` demora mais de `TOOL_TIMEOUT_MS` (padrao 30s). | AgentLoop aplica `Promise.race` com timeout. Observation injectada: `"Error: Tool execution timed out after 30s."`. Esta iteracao consome 1 unidade do limite. |
| EC-06: LLM retorna multiplos tool calls | Resposta do LLM contem `toolCalls` array com mais de 1 item. | O AgentLoop executa apenas o primeiro tool call. Os demais sao ignorados e um warning e logado: `[AgentLoop] LLM returned N tool calls; only the first is executed. Ignored: [tool names].` Esta e uma limitacao conhecida (tools.md NG-04). Paralelismo de tools fica para versao 2. |

---

## 12. Seguranca e Privacidade

- **Tools nao sao injetadas em prompt.** Elas viajam pelo campo nativo de function calling de cada API (8.3). Descreve-las em texto nao habilita tool calling e so consome tokens.
- O confinamento de paths e responsabilidade das proprias tools, via `resolveInWorkspace()` (ver `core-tools.md`). O AgentLoop nao valida argumentos alem do schema declarado em `ToolDefinition`.
- Conteudo de mensagem so aparece no log quando `LOG_MESSAGE_CONTENT=true` (8.8).

---

## 13. Plano de Rollout

Entregue: loop ReAct com teto de iteracoes, execucao de tools com timeout, deduplicacao,
contabilidade de tokens somada, registro do par `tool_calls`/`tool` e logs por iteracao. Coberto por
`tests/agent-loop.test.ts`, `tests/provider-request-body.test.ts` e `tests/log-privacy.test.ts`.

Em aberto: tool calls paralelas. Hoje apenas a primeira de cada resposta e executada; as demais sao
logadas e ignoradas (EC-06).

---

## 14. Open Questions

- Q1: Quantas iteracoes o LLM tipico consome para corrigir um JSON malformado? Se o padrao for 1-2 correcoes, 5 iteracoes sao suficientes. Se for 3+, o limite precisa ser revisto com dados reais.
- Q2 (Resolvida): RNF-02 ja define timeout de 30s por tool via `Promise.race`. Q2 era duplicada. Ver EC-05 para aplicacao do timeout.
