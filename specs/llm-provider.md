# Spec: LLM Provider System (Provedores de IA)

---

## 1. Resumo

O sistema de provedores abstrai a comunicacao com APIs externas de LLM (Gemini, DeepSeek, Groq). Ele define uma interface uniforme (`ILlmProvider`) que o Agent Loop consome sem saber qual provedor esta ativo. Uma `ProviderFactory` seleciona e instancia o provedor configurado, com fallback automatico em caso de falha.

---

## 2. Contexto e Motivacao

**Problema:**
APIs de LLM tem formatos de request/response diferentes. Gemini usa REST com `generateContent`. DeepSeek usa formato OpenAI-compatible. Trocar de provedor sem uma camada de abstracao exige refatorar o Agent Loop inteiro.

**Evidencias:**
O PRD e a arquitetura mencionam "troca dinamica de LLMs" e "ProviderFactory com fallback" mas nenhum spec define o contrato, o modelo de autenticacao, ou a cadeia de retry.

**Por que agora:**
Sem essa especificacao, cada desenvolvedor implementa o provider de um jeito diferente. A padronizacao garante que adicionar um novo provedor (ex: Claude, GPT-4) exija apenas uma nova classe que implementa `ILlmProvider`, sem tocar no Agent Loop.

---

## 3. Goals (Objetivos)

- [x] G-01: Definir a interface `ILlmProvider` com metodo unico `generate(messages, tools?): Promise<LlmResponse>`.
- [ ] G-02: A `ProviderFactory` deve instanciar o provedor correto a partir de uma string de configuracao (`LLM_PROVIDER`).
- [ ] G-03: Implementar fallback automatico: se o provedor primario falhar, tentar o proximo da cadeia configurada.
- [ ] G-04: Todo provider deve formatar mensagens do formato interno do GeneriClaw para o formato nativo da API alvo.
- [ ] G-05: Suportar retry com exponential backoff para erros transientes (429, 503).

**Metricas de sucesso:**
| Metrica | Baseline atual | Target | Prazo |
|---------|---------------|--------|-------|
| Tempo para adicionar novo provider | Sem padrao | < 30 min (1 arquivo) | MVP |
| Fallback bem-sucedido | Nao implementado | < 2s para troca | MVP |
| Retry em 429/503 | Nao implementado | Recuperacao automatica | MVP |

---

## 4. Non-Goals (Fora do Escopo)

- NG-01: Nao faremos streaming de respostas (chunks SSE). A resposta chega completa antes de ser processada.
- NG-02: Nao suportaremos provedores self-hosted (Ollama, LM Studio) no MVP. O foco inicial sao APIs cloud.
- NG-03: O provider nao gerencia tokens nem calcula custos. Isso e responsabilidade do Memory Manager (truncamento).

---

## 5. Usuarios e Personas

**Usuario primario:** O Agent Loop, que chama `provider.generate(messages, tools)` e recebe `LlmResponse`.

**Usuario secundario:** O desenvolvedor, que implementa novos providers extendendo `BaseLlmProvider`.

---

## 6. Requisitos Funcionais

### 6.1 Requisitos Principais

| ID | Requisito | Prioridade | Criterio de Aceite |
|----|-----------|-----------|-------------------|
| RF-01 | `ILlmProvider.generate(messages, tools?)` recebe o array de mensagens e as definicoes de tools, e retorna `LlmResponse`. | Must | Qualquer classe implementando a interface funciona com o Agent Loop sem alteracoes. |
| RF-02 | `ProviderFactory.create(providerName)` instancia o provider pelo nome. | Must | Passar `"gemini"` retorna instancia de `GeminiProvider`. |
| RF-03 | O factory aceita uma lista ordenada de providers para fallback. | Must | Configurar `LLM_PROVIDERS=gemini,deepseek` faz com que falha no Gemini acione DeepSeek automaticamente. |
| RF-04 | Cada provider implementa `formatMessages(internalMessages): ProviderSpecificFormat`. | Must | Mensagens do formato interno `{ role, content }` viram o formato exato da API alvo. |
| RF-05 | Retry com exponential backoff: 1s, 2s, 4s (max 3 tentativas, alinhado com `LLM_RETRY_COUNT=3`) para erros 429 e 503. A sequencia de delays e gerada com base em `LLM_RETRY_COUNT` e `LLM_RETRY_BASE_DELAY_MS` - com count=3 e base=1000, os delays sao 1s, 2s, 4s. | Must | Rate limit temporario nao interrompe o fluxo do usuario. |
| RF-06 | `LlmResponse` contem `{ text: string, toolCalls?: ToolCall[], finishReason: string, usage?: TokenUsage }`. | Must | O Agent Loop extrai `text` para resposta direta ou `toolCalls` para execucao de ferramenta. |

### 6.2 Fluxo Principal (Happy Path)

1. Agent Loop chama `provider.generate(messages, tools)`.
2. Provider formata as mensagens para o schema da API alvo.
3. Provider envia requisicao HTTP com API key do `.env`.
4. API retorna resposta com texto ou tool calls.
5. Provider converte a resposta nativa para `LlmResponse`.
6. Agent Loop recebe `LlmResponse` e decide: responder ao usuario ou executar tool.

### 6.3 Fluxos Alternativos

**Fluxo Alternativo A - Fallback por falha (transparente ao AgentLoop):**
1. Provider primario (Gemini) retorna 503 apos 3 tentativas de retry esgotadas.
2. O proxy de fallback (criado por `ProviderFactory.createWithFallback()`) detecta a falha e instancia o proximo provider da cadeia (DeepSeek).
3. O proxy refaz a chamada com o novo provider, sem que o AgentLoop perceba a troca.
4. Se todos os providers da cadeia falharem, o proxy propaga o erro ao AgentLoop, que o repassa ao AgentController.
5. O AgentController encaminha o erro ao OutputHandler, que notifica o usuario.

**Fluxo Alternativo B - Retry bem-sucedido:**
1. Provider retorna 429 (rate limit).
2. Sistema espera 1s e retry.
3. Segunda tentativa tambem 429. Espera 2s.
4. Terceira tentativa retorna 200. Resposta normal.

---

## 7. Requisitos Nao-Funcionais

| ID | Requisito | Valor alvo | Observacao |
|----|-----------|-----------|------------|
| RNF-01 | Timeout por requisicao | 120s | Alinhado com o timeout do Agent Loop. |
| RNF-02 | Tamanho maximo de resposta | 64KB | O provider retorna a resposta completa da API sem truncamento. O limite de 64KB e aplicado downstream pelo MemoryManager na persistencia (ver memory.md EC-03). O AgentLoop opera com a resposta completa em RAM - o truncamento ocorre apenas na gravacao no banco de dados. |
| RNF-03 | Isolamento de provider | 100% | Falha em um provider nao afeta instancias de outros providers. |

---

## 8. Design e Interface

### 8.1 Interface ILlmProvider

```typescript
interface LlmMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolCallId?: string;
  name?: string;  // Deferido para v2: reservado para tool call responses com identificacao do agente. Nao populado no MVP. Ver Q4.
}

interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}
```

**Consumo de TokenUsage:** O `TokenUsage` e retornado por cada provider via `LlmResponse.usage` (campo opcional - providers que nao reportam uso retornam `undefined`). O `MemoryManager.saveResponse()` persiste `TokenUsage` no campo `metadata` da mensagem (coluna `messages.metadata` como JSON) para auditoria e analise de custos. O `AgentLoop` tambem loga `TokenUsage` no console ao final de cada iteracao: `[AgentLoop] Tokens: prompt=<N>, completion=<N>, total=<N>`. Nenhum modulo bloqueia ou toma decisao com base em `TokenUsage` no MVP - e puramente informacional. Truncamento de contexto e baseado em contagem de mensagens (`MEMORY_WINDOW_SIZE`), nao em contagem de tokens.

```typescript
interface LlmResponse {
  text: string;
  toolCalls?: ToolCall[];
  finishReason: "stop" | "tool_calls" | "length" | "error";
  usage?: TokenUsage;
}

interface ILlmProvider {
  readonly name: string;
  generate(messages: LlmMessage[], tools?: ToolDefinition[]): Promise<LlmResponse>;
}
```

### 8.2 ProviderFactory

```typescript
class ProviderFactory {
  private providers: Map<string, ILlmProvider> = new Map();

  register(name: string, provider: ILlmProvider): void;
  create(name: string): ILlmProvider;
  createWithFallback(names: string[]): ILlmProvider;  // retorna proxy com fallback
}
```

### 8.3 Traducao de tools por provider

Cada provider converte `ToolDefinition[]` para o formato nativo da sua API. `ToolDefinition` ja tem
o shape de `function` da OpenAI, entao a conversao e so o involucro:

- **OpenAI-like (DeepSeek, Groq, OpenRouter):** `body.tools = tools.map(t => ({ type: "function", function: t }))`, via o helper compartilhado `toOpenAiTools()`.
- **Gemini:** `body.tools = [{ functionDeclarations }]`, com um mapeamento real do schema - o tipo vira enum maiusculo (`OBJECT`, `STRING`), o booleano `required` por propriedade e **removido** (o Gemini so aceita `required` como array no nivel do objeto), e `properties`/`items` sao convertidos recursivamente.

Se `tools` vier vazio ou ausente, o campo nao e enviado.

### 8.4 Retry Logic

```typescript
async function withRetry<T>(
  fn: () => Promise<T>,
  options: { maxRetries: number; baseDelayMs: number; retryOn: number[] }
): Promise<T>;
```

### 8.5 Erros dentro de uma resposta 200

Gateways de agregacao - OpenRouter em particular - retornam falhas do provedor upstream com
**HTTP 200** e um objeto `error` no corpo:

```json
{ "error": { "message": "Upstream error from Nvidia: Service temporarily overloaded", "code": 503 } }
```

Os providers OpenAI-like devem, depois de parsear o JSON, lancar quando `data.error` existir,
usando `data.error.code` como `status` do erro. Sem isso a resposta e lida como sucesso sem
`choices`, e o resultado e triplo: `withRetry` nao tenta de novo (nada foi lancado), o
`FallbackProvider` nao troca de provider, e o usuario recebe um texto placebo em vez do erro.

Pelo mesmo motivo, o corpo da resposta deve ser incluido na mensagem de erro HTTP (truncado) em vez
de descartado - `401`/`402`/`404` sozinhos nao dizem se o problema e a chave, o credito ou um modelo
removido do catalogo.

O Gemini nativo nao tem esse comportamento: ele reporta erro via status HTTP.

---

## 9. Modelo de Dados

Nao gera tabelas SQLite. Estado e transiente durante a requisicao.

---

## 10. Integracoes e Dependencias

| Dependencia | Tipo | Impacto se indisponivel |
|-------------|------|------------------------|
| Agent Loop | Consumidor | Sem Agent Loop, providers nao sao chamados. |
| API Keys (.env) | Obrigatoria | Sem chave, provider nao autentica. Erro fatal na inicializacao. |
| Rede (HTTP) | Obrigatoria | Sem internet, todas as chamadas falham. |

---

## 11. Edge Cases e Tratamento de Erros

| Cenario | Trigger | Comportamento esperado |
|---------|---------|----------------------|
| EC-01: API key invalida | 401 ou 403 da API. | Provider retorna `LlmResponse` com `finishReason: "error"` e mensagem descritiva. NAO tenta retry. NAO faz fallback (todas as keys podem estar invalidas). |
| EC-02: Resposta malformada | API retorna JSON que nao segue o schema esperado. | Parse failure vira `LlmResponse` com `finishReason: "error"` e `text: "Falha ao interpretar resposta do provedor."` |
| EC-03: Tool call com JSON invalido nos argumentos | API retorna `arguments` como string que nao faz parse para JSON. | Provider tenta `JSON.parse`. Se falhar, tool call e ignorado e `text` da resposta e usado como fallback. |
| EC-04: Timeout de rede | Requisicao excede 120s. | AbortController cancela. Tratado como erro transiente -> retry ou fallback. |
| EC-05: Todos os providers esgotados | Nenhum provider da cadeia respondeu com sucesso. | Erro propagado ao Agent Loop, que responde ao usuario: "Todos os provedores de IA estao indisponiveis no momento." |

---

## 12. Seguranca e Privacidade

- **API Keys:** Carregadas exclusivamente do `.env` via `process.env`. Nunca logadas, nunca incluidas em mensagens de erro visiveis ao usuario.
- **Dados em transito:** Toda comunicacao com APIs externas usa HTTPS. Nenhum dado trafega em texto plano.
- **Sanitizacao de erros:** Mensagens de erro enviadas ao usuario nunca contem a API key, mesmo que o erro original da API a inclua (ex: URL com key no path).

---

## 13. Plano de Rollout

1. Implementar `ILlmProvider` e classes base.
2. Implementar `GeminiProvider` (provider primario inicial).
3. Implementar `ProviderFactory` com fallback.
4. Adicionar `DeepSeekProvider`.
5. Adicionar `GroqProvider`.
6. Integrar com Agent Loop.

---

## 14. Open Questions

- Q1 (Resolvida): Truncamento hard no byte 65536, executado pelo MemoryManager ao persistir a resposta no banco (ver memory.md Q3). O provider retorna a resposta completa. O AgentLoop opera com a resposta completa em RAM. Apenas na persistencia o conteudo e truncado.
- Q2 (Resolvida): NG-02 cobre apenas LLMs self-hosted (Ollama, LM Studio, llama.cpp local). Whisper local e Edge-TTS sao dependencias de sistema explicitamente incluidas no escopo do MVP para STT/TTS.
- Q3 (Resolvida): Mock de HTTP com `nock` ou `msw`. Cada provider tera testes unitarios que interceptam chamadas HTTP e retornam respostas pre-definidas (200 com tool calls, 429, 503, JSON malformado). Testes de integracao do ProviderFactory validam a cadeia de fallback com providers mockados.
- Q4 (Deferido para v2): Campo `name` na interface `LlmMessage` nao e populado no MVP. Reservado para respostas de tool call que identifiquem o agente ou funcao chamadora (ex: OpenAI function calling usa `name` para associar respostas de funcao ao nome da funcao). Sera populado quando tool calls retornarem resultados com identificacao explicita do executor.
