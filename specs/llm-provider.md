# Spec: LLM Provider System (Provedores de IA)

---

## 1. Resumo

O sistema de provedores abstrai a comunicacao com APIs externas de LLM. Ele define uma interface uniforme (`ILlmProvider`) que o Agent Loop consome sem saber qual provedor esta ativo. Uma `ProviderFactory` seleciona e instancia o provedor configurado, com fallback automatico em caso de falha.

**Duas implementacoes, nao quatro.** `GeminiProvider` fala o protocolo nativo do Gemini;
`OpenAiCompatProvider` fala o protocolo de chat completions da OpenAI e atende DeepSeek, Groq e
OpenRouter - as diferencas entre eles sao URL, modelo padrao e headers, e vivem em configuracao
(`DIRECT_PRESETS`, `openRouterProvider()`), nao em codigo duplicado. Antes eram tres arquivos de
~150 linhas que diferiam em 7 linhas; toda correcao de protocolo precisava ser feita tres vezes.

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
- [x] G-02: A `ProviderFactory` deve instanciar o provedor correto a partir de uma string de configuracao (`LLM_PROVIDER`).
- [x] G-03: Implementar fallback automatico: se o provedor primario falhar, tentar o proximo da cadeia configurada.
- [x] G-04: Todo provider deve formatar mensagens do formato interno do GeneriClaw para o formato nativo da API alvo.
- [x] G-05: Suportar retry com exponential backoff para erros transientes (429, 503).
- [x] G-06: O par `tool_calls` / `role: "tool"` deve atravessar intacto ate o corpo da requisicao (ver 8.6).

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
  toolCallId?: string;          // em role: "tool" - a qual chamada este resultado responde
  toolCalls?: ToolCall[];       // em role: "assistant" - as chamadas que esta mensagem pediu. Ver 8.6.
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
  create(name: string): ILlmProvider;           // lanca se o nome nao foi registrado
  createWithFallback(names: string[]): ILlmProvider;  // retorna proxy com fallback
  getNames(): string[];                         // nomes registrados - o bootstrap usa para falhar rapido

  static createFromConfig(config): ProviderFactory;
}
```

`createFromConfig()` registra, para cada nome em `[primaryProvider, ...fallbackProviders]`:

- **Com `OPENROUTER_API_KEY`:** um `OpenAiCompatProvider` apontando para o OpenRouter, para *todos*
  os nomes. Uma chave atende a cadeia inteira.
- **Sem ela:** `gemini` vira `GeminiProvider`; nomes em `DIRECT_PRESETS` (`deepseek`, `groq`) viram
  `OpenAiCompatProvider` com a URL e o modelo do preset; qualquer outro nome e pulado com warning.

**Nome pulado e silencioso por construcao**, e por isso o bootstrap compara `getNames()` com a lista
configurada e encerra o processo se faltar algum (ver `bootstrap.md` 5). Sem essa checagem o bot
sobe saudavel e responde "Nenhum provedor de IA disponivel." a *toda* mensagem, sem nada no boot
indicando o porque.

### 8.2.1 OpenAiCompatProvider

```typescript
interface OpenAiCompatConfig {
  name: string;          // aparece no log e nas mensagens de erro
  url: string;           // endpoint de chat completions
  apiKey: string;
  model: string;
  headers?: Record<string, string>;   // OpenRouter exige HTTP-Referer e X-Title
  timeoutMs?: number;
  retryCount?: number;
  retryBaseDelayMs?: number;
}
```

Acrescentar um provedor OpenAI-compativel e acrescentar uma entrada em `DIRECT_PRESETS` - nenhuma
classe nova.

### 8.3 Traducao de tools por provider

Cada provider converte `ToolDefinition[]` para o formato nativo da sua API. `ToolDefinition` ja tem
o shape de `function` da OpenAI, entao a conversao e so o involucro:

- **OpenAI-like (`OpenAiCompatProvider`: DeepSeek, Groq, OpenRouter):** `body.tools = tools.map(t => ({ type: "function", function: t }))`, via o helper compartilhado `toOpenAiTools()`. As mensagens passam por `toOpenAiMessages()` (ver 8.6).
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

### 8.6 O par `tool_calls` / `role: "tool"` (obrigatorio)

Nas APIs compativeis com OpenAI, uma mensagem `role: "tool"` **so e valida se a mensagem `assistant`
anterior declarar `tool_calls` com o mesmo `id`**. Um resultado orfao e recusado com
`400 Invalid parameter: messages with role 'tool' must be a response to a preceding message with
'tool_calls'`.

Por isso `LlmMessage` carrega `toolCalls`, o AgentLoop o preenche ao registrar a chamada
(`agent-loop.md` 8.7), e os providers OpenAI-like serializam tudo pelo helper compartilhado
`toOpenAiMessages()`:

```typescript
// role: "assistant" com toolCalls vira
{ role: "assistant", content: "...", tool_calls: [
    { id, type: "function", function: { name, arguments: JSON.stringify(args) } }
]}
// e o resultado seguinte referencia aquele id
{ role: "tool", content: "...", tool_call_id: id }
```

**Historico:** por um periodo o AgentLoop registrava a mensagem do assistente **sem** o campo - ele
nem existia em `LlmMessage` - e enviava o resultado orfao. DeepSeek e Groq diretos recusavam toda
segunda iteracao de qualquer turno com ferramenta; parte dos modelos do OpenRouter toleravam, o que
escondeu o defeito. Nenhum teste olhava o corpo da requisicao, so a origem.

**O Gemini nao usa este par.** `formatMessages()` converte o resultado para
`{ role: "user", parts: [{ text: "Tool result: ..." }] }` - texto comum, sempre valido. Funciona,
mas perde a associacao explicita entre chamada e resultado; com uma tool call por iteracao
(`agent-loop.md` EC-06) o modelo resolve pelo contexto.

### 8.7 Estrategia de teste: ler o corpo enviado, nao o objeto montado

Os testes de provider (`tests/provider-request-body.test.ts`) interceptam `fetch` e inspecionam o
**JSON que seria enviado** - o destino, nao a origem. A invariante verificada em cada provider
OpenAI-like e a da 8.6: toda mensagem `role: "tool"` tem um `assistant` anterior declarando aquele
`tool_call_id`.

Cada caso planta dois marcadores: um no campo investigado (o `id` da tool call) e um **de controle**
no texto do usuario, que comprovadamente chega. Se o de controle nao aparece, quem esta quebrada e a
busca, nao a peca - e a conclusao de "nao achei" seria falsa.

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

Entregue. `ILlmProvider`, `GeminiProvider`, `OpenAiCompatProvider` (DeepSeek, Groq, OpenRouter),
`ProviderFactory` com fallback, retry com backoff e integracao com o AgentLoop estao implementados e
cobertos por testes.

Proximo passo em aberto: tool calls paralelas - hoje o AgentLoop executa apenas a primeira de cada
resposta (ver `agent-loop.md` EC-06).

---

## 14. Open Questions

- Q1 (Resolvida): Truncamento hard no byte 65536, executado pelo MemoryManager ao persistir a resposta no banco (ver memory.md Q3). O provider retorna a resposta completa. O AgentLoop opera com a resposta completa em RAM. Apenas na persistencia o conteudo e truncado.
- Q2 (Resolvida): NG-02 cobre apenas LLMs self-hosted (Ollama, LM Studio, llama.cpp local). Whisper local e Edge-TTS sao dependencias de sistema explicitamente incluidas no escopo do MVP para STT/TTS.
- Q3 (Resolvida): sem `nock` nem `msw` - `vi.stubGlobal("fetch", ...)` do proprio vitest basta e nao adiciona dependencia. Ver 8.7 para o que os testes verificam e por que eles leem o corpo enviado.
- Q4 (Deferido para v2): Campo `name` na interface `LlmMessage` nao e populado no MVP. Reservado para respostas de tool call que identifiquem o agente ou funcao chamadora (ex: OpenAI function calling usa `name` para associar respostas de funcao ao nome da funcao). Sera populado quando tool calls retornarem resultados com identificacao explicita do executor.
