# Spec: Tool Registry (Ferramentas Executaveis)

---

## 1. Resumo

O Tool Registry e o subsistema que expoe ferramentas executaveis ao Agent Loop. Cada Tool e uma funcao concreta que o LLM pode invocar via function call estruturado. O Registry mantem o catalogo de ferramentas disponiveis e gera as `ToolDefinition` que o AgentLoop entrega ao provider como *function declarations nativas* - nao como texto no system prompt.

---

## 2. Contexto e Motivacao

**Problema:**
O Agent Loop precisa de um contrato padronizado para expor capacidades ao LLM. Sem um registry formal, cada ferramenta teria formato de invocacao diferente, o system prompt ficaria inconsistente, e adicionar nova tool exigiria mexer no core do loop.

**Evidencias:**
Patterns como ReAct e function calling do OpenAI/Anthropic padronizaram o contrato "tool definition JSON" -> "tool call JSON" -> "tool result string". Sem adotar isso de forma explicita, o agente fica fragil.

**Por que agora:**
O Agent Loop (`agent-loop.md`) e a arquitetura (`architecture.md`) referenciam ToolRegistry e BaseTool como dependencias obrigatorias. A definicao formal fecha o gap de documentacao e torna o contrato implementavel.

---

## 3. Goals (Objetivos)

- [ ] G-01: Definir a interface `ITool` com contrato claro de schema, execucao e validacao.
- [ ] G-02: O `ToolRegistry` deve expor o catalogo completo de tools como array de definicoes JSON compativel com LLMs.
- [x] G-03: O `ToolRegistry` deve resolver a tool correta a partir do nome retornado pelo LLM, via `get(name)`.
- [ ] G-04: Toda tool deve validar seus argumentos contra um schema JSON antes da execucao.

**Metricas de sucesso:**
| Metrica | Baseline atual | Target | Prazo |
|---------|---------------|--------|-------|
| Tool Calls parseados corretamente | N/A | 100% schemas validos | MVP |
| Novas tools adicionadas sem alterar core | N/A | Registrar via arquivo unico | MVP |

---

## 4. Non-Goals (Fora do Escopo)

- NG-01: O Registry nao e responsavel por executar ferramentas. Apenas catalogar e instanciar. A execucao e feita pelo Agent Loop.
- NG-02: Ferramentas nao fazem acesso direto ao banco de dados. Se precisarem de persistencia, recebem dependencias via injecao.
- NG-03: Nao implementaremos sandboxing de runtime (chroot/container). Ferramentas executam com as mesmas permissoes do processo Node.
- NG-04: Tool calls paralelas (batch) nao sao suportadas. O ReAct e sequencial - apenas a primeira tool call de cada resposta do LLM e executada. Se o LLM retornar multiplos tool calls em uma unica resposta, o AgentLoop executa apenas o primeiro e ignora os demais, logando warning: `[AgentLoop] LLM returned N tool calls; only the first is executed. Ignored: [tool names]`. Paralelismo fica para versao futura.

---

## 5. Usuarios e Personas

**Usuario primario:** O Agent Loop, que consulta o Registry para montar o system prompt e usa o Factory para instanciar tools solicitadas pelo LLM.

**Usuario secundario:** O desenvolvedor, que registra novas tools extendendo `BaseTool`.

---

## 6. Requisitos Funcionais

### 6.1 Requisitos Principais

| ID | Requisito | Prioridade | Criterio de Aceite |
|----|-----------|-----------|-------------------|
| RF-01 | `ITool` deve expor: `name: string`, `description: string`, `parameters: JSONSchema`, `execute(args): Promise<ToolResult>`. | Must | Qualquer classe implementando ITool e registravel no Registry. |
| RF-02 | `ToolRegistry.register(tool)` adiciona a tool ao catalogo interno. | Must | Apos registro, `getToolDefinitions()` inclui a nova tool no array. |
| RF-03 | `ToolRegistry.getToolDefinitions()` retorna array no formato OpenAI function definitions. | Must | O output e um array de objetos com `name`, `description`, `parameters` passado ao provider como function declarations nativas, nunca como texto de prompt. |
| RF-04 | `ToolRegistry.get(name)` retorna a instancia da tool registrada com o nome exato. | Must | Buscar tool inexistente lanca erro tratavel pelo Agent Loop. |
| RF-05 | `BaseTool.validateArgs(args)` valida os argumentos contra o `parameters` schema antes da execucao. | Must | Args invalidos retornam erro estruturado, nao sao passados a execucao. |
| RF-06 | `ToolResult` contem `{ success: boolean, output: string, error?: string }`. | Must | O Agent Loop usa `output` como Observation no proximo passo ReAct. |

### 6.2 Fluxo Principal (Happy Path)

1. Na inicializacao, o sistema registra todas as tools disponiveis no `ToolRegistry`.
2. O **AgentController** chama `registry.getToolDefinitions()` durante a montagem do system prompt (ver agent-controller.md secao 6.2 passo 7). O AgentLoop NAO chama `getToolDefinitions()` - ele recebe o array de mensagens ja montado com as definicoes de tools inclusas.
3. O LLM retorna um tool call: `{ name: "criar_arquivo", arguments: { path: "...", content: "..." } }`.
4. O Agent Loop chama `toolRegistry.get("criar_arquivo")`.
5. A tool valida os argumentos via `validateArgs(arguments)`.
6. O Agent Loop executa `tool.execute(arguments)` e recebe `ToolResult`.
7. O `output` do ToolResult e injetado como Observation no proximo passo do ReAct.

### 6.3 Fluxos Alternativos

**Fluxo Alternativo A - Tool nao encontrada:**
1. LLM solicita tool `"enviar_email"` que nao esta registrada.
2. `toolRegistry.get("enviar_email")` lanca erro.
3. Agent Loop captura e injeta observation: "Tool 'enviar_email' nao disponivel. Ferramentas disponiveis: [lista]".

**Fluxo Alternativo B - Argumentos invalidos:**
1. LLM envia `{ arguments: { filename: 123 } }` onde schema espera string.
2. `validateArgs` retorna erro de tipo.
3. Observation: "Argumento 'filename' invalido: esperava string, recebeu number. Corrija e reenvie."
4. LLM tem chance de corrigir na proxima iteracao.

---

## 7. Requisitos Nao-Funcionais

| ID | Requisito | Valor alvo | Observacao |
|----|-----------|-----------|------------|
| RNF-01 | Tempo de instanciacao | < 5ms | Factory.create e sincrono. |
| RNF-02 | Isolamento de erros | 100% | Falha em uma tool nao derruba o Registry nem outras tools. |

---

## 8. Design e Interface

### 8.1 Interface ITool

```typescript
interface ToolParameter {
  type: "string" | "number" | "boolean" | "object" | "array";
  description: string;
  required?: boolean;
  enum?: string[];
  properties?: Record<string, ToolParameter>;  // para type: "object"
  items?: ToolParameter;  // para type: "array"
}

interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, ToolParameter>;
    required: string[];
  };
}

interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

interface ITool {
  readonly definition: ToolDefinition;
  validateArgs(args: Record<string, unknown>): { valid: boolean; errors?: string[] };
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}
```

### 8.2 Classe ToolRegistry

```typescript
class ToolRegistry {
  private tools: Map<string, ITool> = new Map();

  register(tool: ITool): void;
  getToolDefinitions(): ToolDefinition[];
  getToolNames(): string[];
  has(name: string): boolean;
  get(name: string): ITool;   // lanca se nao existir
}
```

Nao existe uma classe fabrica separada. `ToolRegistry.get()` cumpre esse papel; um wrapper de um
metodo so adicionava indirecao sem comportamento proprio.

### 8.2.1 Helpers de path e truncamento

`tools/registry.ts` tambem exporta utilitarios compartilhados pelas tools concretas
(ver `core-tools.md` 5.4):

```typescript
function isInsideWorkspace(workspaceAbs: string, absPath: string): boolean;
function resolveInWorkspace(workspaceRoot: string, inputPath: string): string | null;
function truncateUtf8(text: string, maxBytes: number): string;
```

### 8.3 Classe BaseTool

```typescript
abstract class BaseTool implements ITool {
  abstract readonly definition: ToolDefinition;
  abstract execute(args: Record<string, unknown>): Promise<ToolResult>;

  validateArgs(args: Record<string, unknown>): { valid: boolean; errors?: string[] };
}
```

---

## 9. Modelo de Dados

Nao gera tabelas SQLite. O Registry e stateful em RAM. As definicoes de tool sao injetadas via codigo (classes TS), nao serializadas.

---

## 10. Integracoes e Dependencias

| Dependencia | Tipo | Impacto se indisponivel |
|-------------|------|------------------------|
| Agent Loop | Consumidor | Sem Agent Loop, as tools nao sao invocadas. |
| Filesystem (`fs`) | Opcional | Tools que escrevem arquivos precisam de acesso FS. |

---

## 11. Edge Cases e Tratamento de Erros

| Cenario | Trigger | Comportamento esperado |
|---------|---------|----------------------|
| EC-01: Tool duplicada | Duas tools registradas com mesmo nome. | `register()` substitui silenciosamente a anterior. Loga warning no console. |
| EC-02: Tool lanca excecao nao tratada | Erro de runtime dentro de `execute()`. | Agent Loop captura, embrulha como ToolResult com `success: false` e `error` preenchido. |
| EC-03: Schema parameters malformado | Tool registrada com schema que nao segue JSON Schema Draft 7. | Validacao de schema na inicializacao. Ferramenta com schema invalido e rejeitada no register com erro claro. |
| EC-04: Execucao excede timeout | Tool demora > 30s. | Agent Loop aplica timeout via `Promise.race`. Observation indica timeout. |

---

## 12. Seguranca e Privacidade

- **Validacao de entrada:** Toda tool deve validar argumentos antes de executar. Isso previne injecao de paths, comandos ou dados maliciosos via LLM.
- **Sanitizacao:** Ferramentas que operam no filesystem devem resolver paths relativos contra o diretorio base `WORKSPACE_ROOT` (definido via variavel de ambiente, padrao `./output`). Paths absolutos ou com `..` sao recusados. O diretorio base e verificado na inicializacao da tool - se nao existir, e criado automaticamente.
- **Segredos:** Ferramentas nao tem acesso direto a variaveis de ambiente ou secrets. Dependencias sensiveis sao injetadas pelo construtor.

---

## 13. Plano de Rollout

Implementacao em tres etapas:
1. Definir interfaces e classes base (ToolRegistry, BaseTool).
2. Registrar as tools iniciais (filesystem: criar_arquivo, ler_arquivo, listar_arquivos).
3. Integrar com Agent Loop para montagem de system prompt e execucao.

---

## 14. Open Questions

- Q1 (Resolvida): Nao. Registro de ferramentas e feito apenas na inicializacao. Ferramentas nao podem registrar outras ferramentas dinamicamente.
- Q2 (Resolvida): Validacao manual (zero dependencias). O schema usado pelas tools e simples (tipos primitivos, required, enum). Uma funcao `validateArgs` de ~50 linhas cobre todos os casos sem adicionar ~150KB (ajv) ou ~50KB (zod) ao bundle. Se futuras tools exigirem schemas complexos (anyOf, $ref, pattern), zod pode ser reconsiderado.
