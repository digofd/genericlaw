# GeneriClaw

**Agente pessoal de IA que roda na sua máquina e se controla pelo Telegram.**

Texto, voz ou PDF entram pelo chat; o agente raciocina em ciclo ReAct, executa ferramentas no seu filesystem e responde de volta — em texto, arquivo ou áudio. As conversas ficam num SQLite local. Os LLMs são usados **só para inferência**: nenhum histórico sai da sua máquina.

```mermaid
graph LR
    U([👤 Você]) <--> TG[📱 Telegram]
    TG --> IN[InputHandler<br/>texto · voz · PDF]
    IN --> AC[AgentController]
    AC --> RT{SkillRouter<br/>passo zero}
    RT --> AL[AgentLoop<br/>ReAct]
    AL <--> PF[ProviderFactory<br/>fallback em cadeia]
    AL <--> TR[ToolRegistry]
    AC <--> MM[(SQLite<br/>local)]
    AC --> OUT[OutputHandler] --> TG
    PF -.-> LLM[Gemini · DeepSeek<br/>Groq · OpenRouter]
    IN -.-> W[Whisper local]
    OUT -.-> T[edge-tts]
```

---

## A ideia central: contexto sob demanda

O problema de qualquer agente com muitas habilidades é que a documentação de todas elas compete pela mesma janela de contexto. GeneriClaw resolve isso em **duas etapas**:

1. **Passo zero (roteamento barato).** O `SkillRouter` recebe apenas `nome + descrição` de cada skill — algumas dezenas de tokens — mais a intenção do usuário. Devolve o nome de uma skill, ou `null`.
2. **Injeção em runtime.** Só a skill escolhida tem seu `SKILL.md` completo injetado no system prompt, e só durante aquela requisição. Terminou, o contexto é descartado.

Pergunta solta como *"que horas são?"* devolve `null` no passo zero e cai no agente raiz, sem carregar documentação nenhuma. O custo de ter 50 skills instaladas é o mesmo de ter 3.

> Uma requisição = uma intenção. Encadear múltiplas skills é deliberadamente **não-objetivo**: isso é trabalho do ReAct na etapa seguinte, não do router.

---

## O que está implementado

| Capacidade | Como funciona |
|---|---|
| **Entrada multimodal** | Texto, voz (Whisper local → STT) e PDF (`pdf-parse`) |
| **Saída multimodal** | Texto com chunking, arquivos `.md` e áudio (edge-tts) |
| **Ciclo ReAct** | `AgentLoop` itera pensamento → ferramenta → observação, com teto de iterações |
| **4 provedores de LLM** | Gemini, DeepSeek, Groq e OpenRouter, atrás de uma interface única |
| **Fallback em cadeia** | `FallbackProvider` percorre a lista configurada; cada um com retry e backoff |
| **Memória local** | SQLite (`sql.js`) com janela de contexto deslizante e teto de tamanho |
| **Skills hot-reload** | `agents/skills/` é relido a cada mensagem; criar uma pasta já a disponibiliza |
| **Ferramentas de arquivo** | `criar_arquivo`, `ler_arquivo`, `listar_arquivos`, presas à `WORKSPACE_ROOT` |
| **Whitelist estrita** | Só IDs em `TELEGRAM_ALLOWED_USER_IDS` são atendidos |
| **Degradação graciosa** | Sem `ffmpeg`/`whisper`/`edge-tts`, o bot sobe e desliga só a voz |
| **Shutdown ordenado** | `SIGINT`/`SIGTERM`, ou `/parar` no chat, param polling e controller, com timeout de 10s |

**Testes:** `npm test` roda 93 testes em 15 arquivos (`vitest`). Vários deles leem o *destino* em vez da origem — o corpo JSON que sai para a API do LLM, o texto que chega na API do Telegram, os arquivos no disco, o stderr de um boot real — porque uma peça que "roda" não é uma peça que entrega.

---

## Arquitetura

Monolito modular com sistema de plugins. A escolha é deliberada: para um agente pessoal rodando num único host, microsserviços só adicionariam latência e cerimônia. O preço é escalar apenas verticalmente — irrelevante para o caso de uso.

```
src/
├── main.ts          # bootstrap: valida config, checa binários, monta o grafo, trata shutdown
├── config.ts        # validação de env com erro explícito (falha rápido, não em runtime)
├── core/            # AgentController (fachada do pipeline) + AgentLoop (motor ReAct)
├── providers/       # Gemini + OpenAiCompat (DeepSeek, Groq, OpenRouter) + factory com fallback
├── memory/          # MemoryManager (janela, truncamento) + repositórios SQLite
├── skills/          # SkillLoader (hot-reload) + SkillRouter (passo zero)
├── tools/           # ToolRegistry + ferramentas de filesystem
├── input/           # Telegram, Whisper, parsing de documentos
└── output/          # chunking, arquivos, edge-tts
```

Cada módulo tem uma spec correspondente em [`specs/`](specs/) com contrato, interface, edge cases e dependências — comece por [`specs/architecture.md`](specs/architecture.md).

---

## Rodando

**Pré-requisitos:** Node 18+, um bot do Telegram ([@BotFather](https://t.me/BotFather)) e ao menos uma API key de LLM.
Opcionais, só para voz: `ffmpeg`, `whisper` e `edge-tts` no `PATH`.

```bash
git clone https://github.com/francojeferson/genericlaw.git
cd genericlaw
npm install
cp .env.example .env    # preencha o token e as chaves
npm run dev
```

O mínimo viável no `.env`:

```env
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_ALLOWED_USER_IDS=seu_id_numerico
LLM_PROVIDER=gemini
GEMINI_API_KEY=AIza...
```

Para usar uma chave só para todos os modelos, preencha `OPENROUTER_API_KEY` e liste os provedores em `LLM_PROVIDERS`. A ordem da lista **é** a ordem de fallback.

Ajustes úteis: `MAX_ITERATIONS` (teto do ReAct), `MEMORY_WINDOW_SIZE` (quantas mensagens entram no contexto), `WORKSPACE_ROOT` (onde as ferramentas podem escrever) e `LOG_MESSAGE_CONTENT=false`, que mantém o conteúdo das mensagens fora dos logs.

---

## Criando uma skill

Uma skill é uma pasta com um `SKILL.md`. Não há build, registro nem restart:

```
agents/skills/
└── revisor-de-contrato/
    └── SKILL.md
```

```markdown
---
name: revisor-de-contrato
description: Revisa cláusulas de contrato e aponta risco jurídico
version: 1.0.0
requires: [ler_arquivo, criar_arquivo]
---

Você é um revisor de contratos. Para cada cláusula recebida:
1. Classifique o risco como baixo, médio ou alto.
2. Cite a cláusula exata que gerou a classificação.
3. Proponha uma redação alternativa quando o risco for alto.

Entregue o resultado como arquivo .md.
```

O `description` é o que o router vê no passo zero — é ele que decide se a skill é acionada, então escreva pensando em **quando** ela deve disparar. O corpo é o system prompt completo, injetado só quando ela ganha.

---

## Privacidade

A whitelist por ID de usuário do Telegram é verificada antes de qualquer processamento. O banco, os arquivos gerados e os temporários ficam no host. Para as APIs de LLM vai apenas o contexto necessário à inferência — e `LOG_MESSAGE_CONTENT=false` evita que o conteúdo apareça nos logs locais.

Com Whisper rodando localmente, **áudio nunca sai da máquina**.
