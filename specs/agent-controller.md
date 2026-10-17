# Spec: AgentController (Facade Central)

---

## 1. Resumo

O `AgentController` e o facade que orquestra o pipeline completo do GeneriClaw. Ele recebe o input processado do `TelegramInputHandler`, coordena o roteamento de Skills, dispara o `AgentLoop` com o provider e ferramentas corretos, persiste resultados via `MemoryManager`, e encaminha a resposta ao `TelegramOutputHandler`. Nenhum outro modulo conhece o fluxo completo - cada componente ve apenas seu contrato.

---

## 2. Contexto e Motivacao

**Problema:**
Sem um orquestrador central, o `TelegramInputHandler` precisaria conhecer o `AgentLoop`, o `SkillRouter`, o `MemoryManager` e o `OutputHandler`. Isso cria acoplamento radial onde cada modulo depende de todos os outros. Uma mudanca no pipeline (ex: adicionar pre-processamento) exige mexer em multiplos arquivos sem relacao clara.

**Evidencias:**
O diagrama de componentes em `architecture.md` ja posiciona o `AgentController` como ponto central entre Input, Skill System, AgentLoop e Memory. O PRD descreve o fluxo principal como sequencia orquestrada: input -> controller -> loop -> output. Mas nenhum spec define o contrato dessa classe.

**Por que agora:**
A ausencia do spec deixa ambigua a ordem de inicializacao dos subsistemas, a propagacao de erros entre camadas, e o contrato que cada modulo expoe ao controller. Sem isso, cada desenvolvedor implementa a cola de um jeito diferente.

---

## 3. Goals (Objetivos)

- [ ] G-01: Definir o metodo principal `handle(input: ProcessedInput): Promise<void>` como ponto unico de entrada do pipeline.
- [ ] G-02: Orquestrar a sequencia Skill Router -> AgentLoop -> Memory -> Output com propagacao de erros controlada.
- [ ] G-03: Gerenciar a inicializacao ordenada de todos os subsistemas.
- [ ] G-04: Garantir que nenhum modulo de dominio conheca outro diretamente - toda comunicacao passa pelo Controller ou por contratos.

**Metricas de sucesso:**
| Metrica | Baseline atual | Target | Prazo |
|---------|---------------|--------|-------|
| Acoplamento entre modulos | N modulos conhecem N outros | Cada modulo conhece apenas o Controller + contratos | MVP |
| Tempo para adicionar passo no pipeline | Alterar multiplos arquivos | Alterar apenas AgentController | MVP |

---

## 4. Non-Goals (Fora do Escopo)

- NG-01: O Controller nao toma decisoes de negocio (qual skill usar, qual tool chamar). Ele apenas orquestra. Decisoes sao dos subsistemas.
- NG-02: O Controller nao faz retry ou fallback de LLM. Isso e responsabilidade do `ProviderFactory` (ver `llm-provider.md`).
- NG-03: O Controller nao gerencia ciclo de vida de processos (spawn, kill). E puramente logico.

---

## 5. Usuarios e Personas

**Usuario primario:** O `TelegramInputHandler`, que entrega `ProcessedInput` ao controller apos validar whitelist e extrair texto/anexos.

**Usuario secundario:** O desenvolvedor, que adiciona novos passos ao pipeline ou depura o fluxo completo via logs do controller.

---

## 6. Requisitos Funcionais

### 6.1 Requisitos Principais

| ID | Requisito | Prioridade | Criterio de Aceite |
|----|-----------|-----------|-------------------|
| RF-01 | `AgentController.init()` deve inicializar todos os subsistemas na ordem correta. | Must | Chamar `init()` e receber `true` indica que DB, Skills, Tools, Providers, Input e Output estao prontos. |
| RF-02 | `AgentController.handle(input)` deve executar o pipeline completo: Skill routing -> Agent Loop -> Persistencia -> Output. | Must | Uma mensagem de texto chega ao usuario como resposta sem erros nao tratados. |
| RF-03 | Erro em qualquer etapa do pipeline deve ser capturado e propagado ao `ErrorOutputStrategy`. | Must | Falha no LLM gera mensagem de erro visivel ao usuario, nao crash silencioso. |
| RF-04 | O Controller deve logar cada transicao de etapa no console para depuracao. | Must | Log mostra: `[AgentController] input -> skill -> agent -> memory -> output`. |
| RF-05 | O Controller deve expor metodo `shutdown()` para encerramento gracioso (fechar DB, cancelar loops pendentes). | Must | `SIGTERM` ou `Ctrl+C` chama `shutdown()` e o processo termina sem corromper o SQLite. |

### 6.2 Fluxo Principal (Happy Path)

1. `TelegramInputHandler` processa mensagem e chama `controller.handle(processedInput)`.
2. Controller extrai `conversationId`, `userId` e `content` do `ProcessedInput`.
3. Controller verifica se a conversa esta bloqueada via `MemoryManager.isConversationBlocked(conversationId)`. Se bloqueada, descarta o processamento e loga: `[AgentController] Skipping message from blocked user <userId>.` O processamento para aqui.
4. Controller chama `SkillRouter.route(content, availableSkills)` para determinar skill ativa (ou `null`). `availableSkills` vem de `SkillLoader.loadAll()`.
5. Se skill ativa, controller carrega `skillContent` e metadados da skill.
6. Controller chama `MemoryManager.saveMessage(conversationId, "user", content)` para persistir a mensagem do usuario antes de carregar o historico.
7. Controller chama `MemoryManager.getRecentMessages(conversationId)` para carregar historico.
8. Controller monta o array completo de mensagens: system prompt (com tools + skill) + historico + mensagem atual. Esta e a unica etapa de assembly - o AgentLoop recebe o array pronto e nao adiciona mensagens do banco.
9. Controller obtem o provider via `ProviderFactory.createWithFallback(...)` e o injeta no AgentLoop.
10. Controller chama `AgentLoop.run(messages, provider, toolRegistry)`.
11. AgentLoop retorna `AgentLoopResult` com a resposta final.
12. Controller chama `MemoryManager.saveResponse(conversationId, result)`.
13. Controller chama `OutputHandler.send(conversationId, result)`.
14. Resposta chega ao usuario no Telegram.

**Retroactive blocking (mid-session):** Se o OutputHandler detectar erro 403 "Forbidden: bot was blocked by the user" durante o envio, ele emite um evento `userBlocked`. O AgentController captura e chama `MemoryManager.markConversationBlocked(conversationId)`. Na proxima mensagem deste usuario, o passo 3 detecta o bloqueio e descarta o processamento. Ver telegram-output.md EC-03 e Q3.

**Propagacao de `requiresAudioReply`:** O flag segue o pipeline completo:
1. `TelegramInputHandler` injeta `requiresAudioReply: true` no `ProcessedInput` quando o input e voz ou contem keyword explicita (ver telegram-input.md RF-06).
2. `AgentController` repassa o flag sem modificacao do `ProcessedInput` para o `AgentLoop` - ele nao toma decisao sobre audio, apenas preserva o metadado.
3. `AgentLoop` copia `input.requiresAudioReply` para `AgentLoopResult.requiresAudioReply`. O LLM NAO pode determinar se a resposta deve ser em audio - o flag e determinado exclusivamente pelo tipo de input (voz -> audio, texto -> texto), exceto por keyword explicita no texto do usuario.
4. `OutputHandler` decide a estrategia: `finishReason === "error"` -> `ErrorOutputStrategy`; senao `requiresAudioReply` -> `AudioOutputStrategy`; senao `TextOutputStrategy`.

A precedencia e: erro de provider > input de voz > keyword explicita no texto > padrao texto. Arquivos gerados nao afetam a escolha: eles sao criados no `WORKSPACE_ROOT` pela tool `criar_arquivo` e apenas citados na resposta.

### 6.2.1 System Prompt Assembly (Ownership)

O AgentController e o unico responsavel por montar o array completo de mensagens que o AgentLoop consome. Nenhum outro modulo adiciona conteudo ao system prompt. A montagem segue esta estrutura e ordem:

```
[0] System message: base system prompt (definido pelo AgentController)
[1] System message: tool definitions (`toolRegistry.getToolDefinitions()`)
[2] System message: skill system prompt (se skill ativa, carregado via `SkillLoader`)
[3..N] Mensagens historicas (`memoryManager.getRecentMessages()`)
[N+1] Mensagem atual do usuario (`ProcessedInput.content`)
```

**Regras de delimitacao:** Cada componente do system prompt e uma mensagem separada com `role: "system"`. A concatenacao nao usa delimitadores textuais - cada bloco e uma mensagem independente no array.

**Responsabilidades por componente:**

| Componente | Quem gera | Quem injeta |
|------------|-----------|-------------|
| Base system prompt | AgentController (string fixa) | AgentController |
| Tool definitions | ToolRegistry.getToolDefinitions() | AgentController |
| Skill system prompt | SkillLoader (via `SkillManifest.systemPrompt`) | AgentController |
| Historico | MemoryManager.getRecentMessages() | AgentController |
| Mensagem atual | ProcessedInput.content | AgentController |

O AgentLoop NAO consulta o banco de dados e NAO carrega skills: recebe o array de mensagens pronto via `run(messages, provider, toolRegistry)`. O `toolRegistry` serve para duas coisas: resolver a tool a executar (`get(name)`) e obter as `ToolDefinition` entregues ao provider como function declarations nativas a cada iteracao. O AgentController **nao** injeta tools no prompt - descreve-las em texto nao habilita function calling e apenas consome tokens.

**Regra para historico vazio (conversa nova):** Se `getRecentMessages()` retornar array vazio (EC-03: nova conversa), nenhuma mensagem historica e inserida. O array montado e: `[0]` system prompt base, `[1]` tool definitions, `[2]` skill system prompt (se ativa), `[3]` mensagem atual do usuario. Os indices `[3..N]` colapsam - nao ha placeholder, gap, ou deslocamento de indices. O `[N+1]` da formula original equivale a `[3]` quando o historico esta vazio.

Esta secao resolve as ambiguidades.

### 6.3 Fluxos Alternativos

**Fluxo Alternativo A - Erro no AgentLoop:**
1. AgentLoop lanca excecao (timeout, max iterations, LLM indisponivel).
2. Controller captura e chama `OutputHandler.sendError(conversationId, error)`.
3. Usuario recebe mensagem de erro formatada.

**Fluxo Alternativo B - Sem skill correspondente:**
1. `SkillRouter.route()` retorna `null`.
2. Controller pula etapa de carregamento de skill e prossegue com o AgentLoop generico (chatbot casual).

**Fluxo Alternativo C - Shutdown durante processamento:**
1. `shutdown()` e chamado enquanto uma mensagem esta no AgentLoop.
2. Controller seta flag `isShuttingDown = true`.
3. Requisicao atual conclui normalmente (nao e abortada).
4. Novas requisicoes sao rejeitadas com "Sistema em desligamento."

---

## 7. Requisitos Nao-Funcionais

| ID | Requisito | Valor alvo | Observacao |
|----|-----------|-----------|------------|
| RNF-01 | Tempo de orquestracao (overhead) | < 5ms | Medido como o tempo entre `handle(input)` ser chamado e `AgentLoop.run()` ser invocado, excluindo I/O de dependencias (DB, FS). O controller em si apenas coordena chamadas. |
| RNF-02 | Propagacao de erro | 100% | Nenhum erro escapa do pipeline sem ser logado e reportado. |

---

## 8. Design e Interface

### 8.1 ProcessedInput

```typescript
interface ProcessedInput {
  conversationId: string;
  userId: string;
  content: string;                    // texto puro (digitado ou transcrito)
  source: "text" | "voice" | "document";
  requiresAudioReply: boolean;
  voiceId?: string;                   // ex: 'pt-BR-ThalitaMultilingualNeural'
}
```

### 8.2 AgentLoopResult

```typescript
interface AgentLoopResult {
  conversationId: string;
  finalResponse: string;
  toolCallsMade: number;
  iterationsUsed: number;
  finishReason: "stop" | "max_iterations" | "error";
  requiresAudioReply: boolean;
  usage?: TokenUsage;                 // uso de tokens reportado pelo provider (opcional)
  errorMessage?: string;
}
```

### 8.3 AgentController

```typescript
class AgentController {
  private skillRouter: SkillRouter;
  private skillLoader: SkillLoader;
  private agentLoop: AgentLoop;
  private memoryManager: MemoryManager;
  private outputHandler: TelegramOutputHandler;
  private providerFactory: ProviderFactory;
  private isShuttingDown: boolean;
  private processingQueue: Map<string, Promise<void>>;  // conversationId -> Promise

  constructor(deps: AgentControllerDeps);

  async init(): Promise<boolean>;
  async handle(input: ProcessedInput): Promise<void>;
  async shutdown(): Promise<void>;
}
```

**Concurrency queue (`processingQueue`):** Map interno que serializa mensagens da mesma conversa. Quando `handle()` recebe `ProcessedInput`, verifica se `processingQueue` ja tem uma Promise pendente para aquele `conversationId`. Se tiver, a nova mensagem aguarda (`await`) a Promise existente antes de iniciar, garantindo ordem FIFO por conversa. Conversas diferentes processam em paralelo. Limite: no maximo 5 mensagens pendentes por conversationId (ver EC-02). Timeout de stall: 5 minutos. Esta fila previne processamento concorrente dentro do mesmo processo. Para guarda de instancia entre processos, ver bootstrap.md EC-05 (arquivo de lock `./data/genericlaw.lock`).
---

## 9. Modelo de Dados

O Controller nao gera tabelas. Ele orquestra o `MemoryManager`, que e o dono da persistencia.

---

## 10. Integracoes e Dependencias

| Dependencia | Tipo | Impacto se indisponivel |
|-------------|------|------------------------|
| TelegramInputHandler | Fornecedor de input | Sem input, nao ha pipeline para executar. |
| SkillRouter + SkillLoader | Obrigatoria | Sem skills, o agente opera como chatbot generico (fallback). |
| AgentLoop | Obrigatoria | Sem loop, nao ha raciocinio. |
| MemoryManager | Obrigatoria | Sem persistencia, historico e perdido a cada mensagem. |
| TelegramOutputHandler | Obrigatoria | Sem output, resposta nao chega ao usuario. |
| ProviderFactory | Obrigatoria | Sem provider, nao ha LLM para inferencia. |

---

## 11. Edge Cases e Tratamento de Erros

| Cenario | Trigger | Comportamento esperado |
|---------|---------|----------------------|
| EC-01: Falha na inicializacao de subsistema | DB corrompido, skill folder ausente, provider sem API key. | `init()` retorna `false`. Controller loga qual subsistema falhou e o processo termina com codigo de erro. |
| EC-02: Duas mensagens concorrentes do mesmo usuario | Usuario envia segunda mensagem antes da primeira terminar. | Fila implicita por conversationId: o Controller mantem um `Map<conversationId, Promise>` interno que serializa mensagens da mesma conversa. A segunda mensagem aguarda a Promise da primeira resolver antes de iniciar. Conversas diferentes processam em paralelo. Limite: no maximo 5 mensagens pendentes por conversationId. Acima disso, mensagens sao descartadas com warning: `[AgentController] Message queue full for conversation <id>. Dropping oldest pending.` Timeout de stall: se uma Promise pendente nao resolver em 5 minutos, e considerada stall e descartada. |
| EC-03: Conversa nova sem historico | Primeira mensagem de um usuario sem conversationId ativo. | Controller cria nova conversation via `MemoryManager.createConversation(userId)` e prossegue normalmente. |
| EC-04: Resultado do AgentLoop sem resposta textual | LLM retorna apenas tool calls sem texto final. | Controller usa `AgentLoopResult.finalResponse` que e sempre populado pelo loop (seja resposta do LLM ou mensagem de fallback). |

---

## 12. Seguranca e Privacidade

- **Isolamento de contexto:** Cada `conversationId` e isolado. O Controller nunca cruza mensagens de conversas diferentes.
- **Propagacao de erros segura:** Mensagens de erro enviadas ao usuario nunca contem dados internos (paths, API keys, stack traces). Apenas mensagens amigaveis.
- **Log seguro:** Logs de depuracao podem conter conteudo de mensagens. Em producao, logs de conteudo devem ser desabilitados via flag `LOG_MESSAGE_CONTENT=false`.

---

## 13. Plano de Rollout

1. Implementar `AgentController` com dependencias mockadas para teste do pipeline.
2. Integrar com `TelegramInputHandler` real.
3. Integrar com `SkillRouter` e `AgentLoop` reais.
4. Adicionar `shutdown()` e testes de encerramento gracioso.
5. Adicionar logs de transicao de etapa.

---

## 14. Open Questions

- Q1 (Resolvida): Atualizacao manual com revisao de changelog. Semver automatico NAO sera usado no MVP - risco de breaking changes em dependencias core (grammy, sql.js) e alto demais para atualizacao desacompanhada. Dependabot/Renovate podem ser configurados para alertas apenas (nao PR automaticos) na versao 2.
- Q2 (Deferido para quando ocorrer): Mudancas na API de polling do Telegram sao abstraidas pelo Grammy. Se a API mudar de forma que o Grammy nao acompanhe, o contrato `ProcessedInput` pode precisar de adaptacao. Este risco e mitigado pelo fato de que o Grammy e mantido ativamente e a API de Bot do Telegram e estavel desde 2015. Nenhuma acao necessaria no MVP.
