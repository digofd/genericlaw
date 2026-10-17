# Spec: Bootstrap / Main Entry Point

---

## 1. Resumo

O modulo de bootstrap e o ponto de entrada da aplicacao (`Main.ts`). Ele carrega variaveis de ambiente, inicializa os subsistemas na ordem correta, conecta o bot Grammy ao `AgentController`, e gerencia o encerramento gracioso.

---

## 2. Contexto e Motivacao

**Problema:**
architecture.md referencia `App() init()` e `Main.ts` mas nenhum spec define a ordem de inicializacao, o tratamento de falhas na partida, ou o wiring entre Grammy e AgentController. Sem isso, cada desenvolvedor implementa a cola de inicializacao de forma diferente, e falhas na partida podem corromper o SQLite ou deixar o bot parcialmente funcional sem diagnostico claro.

**Evidencias:**
O PRD e a arquitetura mencionam `npm run dev` como metodo de inicializacao e `AgentController.init()` como ponto de entrada dos subsistemas. A secao de shutdown do agent-controller.md define contrato de `shutdown()` mas nao especifica quem captura SIGTERM/SIGINT.

**Por que agora:**
E o primeiro arquivo que um desenvolvedor abre para entender onde o sistema comeca. Sem ele, nao ha ponto de entrada documentado.

---

## 3. Goals (Objetivos)

- [ ] G-01: Definir a funcao `main()` como ponto unico de entrada da aplicacao.
- [ ] G-02: Especificar a ordem de inicializacao dos subsistemas com validacao de dependencias.
- [ ] G-03: Conectar o bot Grammy (`Bot` instance) ao `AgentController` via callback de mensagem.
- [ ] G-04: Capturar sinais do SO (SIGTERM, SIGINT) e executar shutdown gracioso.

**Metricas de sucesso:**
| Metrica | Baseline atual | Target | Prazo |
|---------|---------------|--------|-------|
| Tempo de inicializacao completa | N/A | < 5s (excluindo download de modelos Whisper) | MVP |
| Falhas na inicializacao diagnosticadas | N/A | 100% com log claro do subsistema que falhou | MVP |

---

## 4. Non-Goals (Fora do Escopo)

- NG-01: O bootstrap nao faz hot-reload de codigo. Isso e responsabilidade do nodemon/tsx no `npm run dev`.
- NG-02: O bootstrap nao gerencia processos filhos (Whisper, ffmpeg). Isso e responsabilidade dos modulos que os invocam.

---

## 5. Ordem de Inicializacao

A inicializacao e sequencial e falha rapido: se um passo falha, os seguintes nao sao executados e o processo termina com codigo de erro.

1. **Carregar variaveis de ambiente:** Ler `.env` via `dotenv`. Validar que as variaveis obrigatorias existem (ver `configuration.md`). Se ausentes, logar erro fatal e `process.exit(1)`.
2. **Validar Token do Telegram (pre-flight):** Chamar `bot.api.getMe()` para validar que o `TELEGRAM_BOT_TOKEN` e valido antes de iniciar o polling. Se falhar (token invalido, rede indisponivel), logar erro fatal com a mensagem de erro da API e `process.exit(1)`. Este check detecta tokens invalidos imediatamente, sem esperar pela falha do polling no passo 9. Mantem o handler de erro do polling como defesa em profundidade.
3. **Validar dependencias de sistema:** 
   - Verificar presenca do binario `ffmpeg` no PATH ou no caminho configurado em `FFMPEG_BINARY`. O comando de busca e escolhido por plataforma: `where` no Windows, `which` nos demais - `where` nao existe fora do Windows e faria todo binario parecer ausente. Se o valor configurado ja e um caminho (contem separador), a verificacao e feita direto no disco: `where`/`which` so consultam o PATH e reportariam ausente um binario que existe. Se ausente, logar warning: `[Bootstrap] ffmpeg not found - voice input disabled.` - o sistema continua sem entrada de voz, mas nao aborta. Ver telegram-input.md RF-07.
   - Verificar presenca do binario `edge-tts` via `--version` (child_process), usando o caminho de `EDGE_TTS_BINARY`. Se ausente, logar warning: `[Bootstrap] edge-tts not found - voice output disabled.` - o sistema continua sem saida de voz, mas nao aborta. Ver telegram-output.md secao 8.3.
   - Verificar presenca do binario `whisper` no PATH ou no caminho configurado em `WHISPER_BINARY`. Se ausente, logar warning: `[Bootstrap] whisper not found - voice input disabled.` - o sistema continua sem STT, mas nao aborta. Ver telegram-input.md RF-05.
4. **Inicializar banco de dados:** `await MemoryManager.initialize()`. Cria conexao SQLite, executa PRAGMAs, cria tabelas se nao existirem.
5. **Inicializar ToolRegistry:** Registrar todas as tools built-in. Validar schemas.
6. **Inicializar ProviderFactory:** Registrar providers configurados em `LLM_PROVIDERS`. Verificar que as variaveis de ambiente de API key existem para todos os providers na cadeia de fallback. Se ausentes, logar erro fatal e `process.exit(1)`.
7. **Inicializar SkillLoader:** Carregar skills de `agents/skills/`. Validar dependencias de tools. Nao ha watcher de arquivos: o `AgentController` chama `reload()` a cada mensagem, entao o diretorio ja e relido antes de cada turno (ver `skill-user.md` 8.1).
8. **Inicializar AgentLoop:** Instanciar com `maxIterations` de `MAX_ITERATIONS` (default 5).
9. **Inicializar AgentController:** Injetar todas as dependencias. Chamar `await controller.init()`.
10. **Conectar TelegramInputHandler ao Grammy:** Instanciar `Bot` com token de `TELEGRAM_BOT_TOKEN`. Instanciar `TelegramInputHandler` passando `voiceEnabled: ffmpegAvailable && whisperAvailable` - o resultado das checagens do passo 3 precisa chegar ao handler, caso contrario ele aceita audio que nao tem como processar. Chamar `telegramInputHandler.start()` que registra os listeners filtrados por tipo de mensagem no Grammy e inicia o polling. Ver telegram-input.md secao 8.2 para o contrato de `start()`.
11. **Registrar handlers de shutdown:** `process.on("SIGTERM", shutdown)` e `process.on("SIGINT", shutdown)`.

---

## 6. Sequencia de Shutdown

1. Sinal recebido (SIGTERM ou SIGINT).
2. Log: `[Bootstrap] Shutdown signal received.`
3. `bot.stop()` - para o polling do Telegram.
5. `controller.shutdown()` - fecha o banco de dados e cancela loops pendentes.
6. Log: `[Bootstrap] Shutdown complete.`
7. `process.exit(0)`.

Timeout de seguranca: se o shutdown nao completar em 10 segundos, `process.exit(1)`.

---

## 7. Requisitos Funcionais

| ID | Requisito | Prioridade | Criterio de Aceite |
|----|-----------|-----------|-------------------|
| RF-01 | `main()` inicializa todos os subsistemas na ordem definida. | Must | `npm run dev` inicia o bot e ele responde a mensagens. |
| RF-02 | Falha na inicializacao de qualquer subsistema obrigatorio encerra o processo com codigo de erro e log especifico. | Must | Remover `.env` e iniciar -> processo termina com `[Bootstrap] Missing TELEGRAM_BOT_TOKEN` e exit code 1. |
| RF-03 | SIGTERM/SIGINT executa shutdown gracioso. | Must | Ctrl+C fecha o banco sem corromper e para o polling. |
| RF-04 | Timeout de shutdown (10s) forca `process.exit(1)`. | Must | Se o banco travar no close, o processo nao fica zumbi. |

---

## 8. Edge Cases e Tratamento de Erros

| Cenario | Trigger | Comportamento esperado |
|---------|---------|----------------------|
| EC-01: `.env` ausente | Arquivo `.env` nao existe. | `dotenv` nao lanca erro. Mas validacao de variaveis obrigatorias falha -> log com lista de variaveis faltantes -> exit(1). |
| EC-02: DB corrompido | `MemoryManager.initialize()` detecta schema invalido. | MemoryManager aplica estrategia "recriar se invalido" (renomeia .db para .bak, cria novo). Bootstrap loga warning e prossegue. |
| EC-03: API key invalida | Provider retorna 401 na validacao. | Bootstrap NAO valida API keys na inicializacao (a validacao e lazy, na primeira chamada ao provider). O bootstrap apenas verifica que as variaveis de ambiente existem. |
| EC-04: Grammy falha ao iniciar polling | Rede indisponivel ou token invalido. | `bot.start()` lanca excecao. Bootstrap captura, loga erro, e chama shutdown. |
| EC-05: Duas instancias competindo pelo mesmo bot token | Outro processo ou maquina esta rodando o GeneriClaw com o mesmo `TELEGRAM_BOT_TOKEN` e fazendo polling no mesmo endpoint. | Guarda tecnica: na inicializacao, o bootstrap cria um arquivo de lock (`./data/genericlaw.lock`) contendo o PID do processo. Se o arquivo ja existir e o PID nele contido corresponder a um processo Node.js vivo (verificado via `process.kill(pid, 0)` no Unix ou `tasklist` no Windows), o bootstrap recusa iniciar e loga: `[Bootstrap] Another instance is already running (PID <pid>). Exiting.` O lock file e removido durante `shutdown()`. Se o processo anterior crashou sem remover o lock, o bootstrap detecta PID morto, loga warning: `[Bootstrap] Stale lock file found (PID <pid> is dead). Removing and proceeding.` e prossegue. |

---

## 9. Integracoes e Dependencias

| Dependencia | Tipo | Impacto se indisponivel |
|-------------|------|------------------------|
| `dotenv` | Obrigatoria | Variaveis de ambiente nao carregadas -> inicializacao falha. |
| Grammy `Bot` | Obrigatoria | Sem bot, nao ha interface com Telegram. |
| AgentController | Obrigatoria | Central de todo o pipeline. |
| MemoryManager | Obrigatoria | Sem persistencia, sistema nao inicia. |

---

## 10. Plano de Rollout

1. Criar `Main.ts` com funcao `main()` e ordem de inicializacao.
2. Adicionar validacao de variaveis de ambiente obrigatorias.
3. Adicionar handlers de SIGTERM/SIGINT.
4. Configurar `npm run dev` para apontar para `Main.ts`.
5. Testar inicializacao limpa, inicializacao sem .env, e shutdown via Ctrl+C.

---

## 11. Open Questions

(Nenhuma no momento - este spec foi criado para resolver o gap de documentacao.)
