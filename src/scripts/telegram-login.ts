/**
 * Login unico da conta pessoal no MTProto, para o bot poder ler historico de grupo.
 * Imprime a TELEGRAM_SESSION e lista os grupos com seus ids.
 *
 *   npm run telegram:login            login (ou relogin) e lista os grupos
 *   npm run telegram:login -- --listar  so lista, usando a sessao ja existente
 */
import dotenv from "dotenv";
import readline from "readline";
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { chatKey } from "../input/group-watcher.js";

// Uma interface para o script inteiro: criando uma por pergunta, a primeira
// consome o buffer de stdin e as seguintes so veem EOF e nunca respondem.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });

function perguntar(texto: string, oculto = false): Promise<string> {
  const escrever = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput;
  return new Promise((resolve) => {
    // EOF (stdin sem tty, pipe esgotado) fecha a interface sem chamar o callback;
    // resolver vazio faz cair na validacao em vez de travar o processo.
    rl.once("close", () => resolve(""));
    rl.question(texto, (resposta) => {
      if (oculto) {
        (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = escrever;
        process.stdout.write("\n");
      }
      resolve(resposta.trim());
    });
    // so depois do question(): e ele que imprime o prompt
    if (oculto) (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
  });
}

async function main(): Promise<void> {
  dotenv.config();

  const soListar = process.argv.includes("--listar");

  const apiId = Number(process.env.TELEGRAM_API_ID) || Number(await perguntar("api_id (my.telegram.org): "));
  const apiHash = process.env.TELEGRAM_API_HASH || (await perguntar("api_hash: "));

  if (!apiId || !apiHash) {
    console.error("api_id e api_hash sao obrigatorios. Pegue os dois em https://my.telegram.org -> API development tools");
    process.exit(1);
  }

  const sessaoExistente = process.env.TELEGRAM_SESSION || "";
  if (soListar && !sessaoExistente) {
    console.error("--listar precisa de uma TELEGRAM_SESSION no .env. Rode sem a flag para gerar uma.");
    process.exit(1);
  }

  const client = new TelegramClient(new StringSession(sessaoExistente), apiId, apiHash, { connectionRetries: 5 });

  if (soListar) {
    await client.connect();
    if (!(await client.checkAuthorization())) {
      console.error("Sessao invalida ou expirada. Rode sem --listar para gerar outra.");
      process.exit(1);
    }
  } else {
    await client.start({
      phoneNumber: () => perguntar("Telefone (com DDI, ex +5511999998888): "),
      phoneCode: () => perguntar("Codigo recebido no Telegram: "),
      password: () => perguntar("Senha 2FA (nao sera exibida): ", true),
      onError: (err) => console.error(`[login] ${err}`),
    });

    const sessao = (client.session as StringSession).save();
    console.info(
      "\n=== TELEGRAM_SESSION ===\n" +
      `${sessao}\n` +
      "========================\n" +
      "Cole no .env como TELEGRAM_SESSION=...\n" +
      "ATENCAO: esta string da acesso total a sua conta. Trate como senha e nao comite.\n"
    );
  }

  const dialogs = await client.getDialogs({});
  const grupos = dialogs.filter((d) => d.isGroup || d.isChannel);

  console.info(`\nGrupos e canais da conta (${grupos.length}):\n`);
  for (const d of grupos) {
    console.info(`  ${chatKey(d.id).padEnd(16)}  ${d.title || "(sem titulo)"}`);
  }
  console.info(
    "\nCopie os ids que quiser acompanhar para o .env, separados por virgula:\n" +
    "  TELEGRAM_GROUP_IDS=-1001111111111,-1002222222222\n"
  );

  rl.close();
  await client.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(`[login] Falhou: ${err}`);
  process.exit(1);
});
