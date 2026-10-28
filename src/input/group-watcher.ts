import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { NewMessage, type NewMessageEvent } from "teleproto/events";
import type { AppConfig } from "../config.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { GroupMessage } from "../memory/group-repository.js";

type GroupsConfig = NonNullable<AppConfig["groups"]>;

interface WatchedChat {
  entity: unknown;
  title: string;
}

/**
 * Identificador canonico de um chat. O id vem como BigInteger em uns lugares e
 * number em outros; comparar as duas formas direto nunca casa, entao tudo vira
 * string por aqui — inclusive o que o script de login imprime.
 */
export function chatKey(id: unknown): string {
  return String(id ?? "");
}

/** Nome legivel do autor. Exportada para teste. */
export function senderName(sender: unknown, senderId: unknown): string {
  const s = sender as { firstName?: string; lastName?: string; username?: string; title?: string } | null;
  if (s) {
    const nome = [s.firstName, s.lastName].filter(Boolean).join(" ").trim();
    if (nome) return nome;
    if (s.username) return `@${s.username}`;
    if (s.title) return s.title;
  }
  return senderId ? `id:${chatKey(senderId)}` : "desconhecido";
}

/**
 * Converte uma mensagem do MTProto para o formato gravado, ou null quando nao ha
 * nada de texto a guardar (entradas/saidas de membro, foto sem legenda, enquete).
 * Exportada para teste.
 */
export function toGroupMessage(msg: unknown, chatId: string, chatTitle: string): GroupMessage | null {
  const m = msg as {
    id?: number;
    message?: string;
    date?: number;
    sender?: unknown;
    senderId?: unknown;
  };

  const text = (m.message || "").trim();
  if (!m.id || !text) return null;

  return {
    chatId,
    msgId: m.id,
    chatTitle,
    sender: senderName(m.sender, m.senderId),
    // date vem em segundos; o resto do banco guarda ISO
    date: new Date((m.date || 0) * 1000).toISOString(),
    text,
  };
}

export class TelegramGroupWatcher {
  private client: TelegramClient | null = null;
  private watched = new Map<string, WatchedChat>();
  private handler: ((event: NewMessageEvent) => void) | null = null;

  constructor(
    private config: GroupsConfig,
    private memory: MemoryManager
  ) {}

  async start(): Promise<void> {
    this.client = new TelegramClient(
      new StringSession(this.config.session),
      this.config.apiId,
      this.config.apiHash,
      { connectionRetries: 5 }
    );

    await this.client.connect();
    if (!(await this.client.checkAuthorization())) {
      throw new Error(
        "TELEGRAM_SESSION invalida ou expirada. Rode 'npm run telegram:login' para gerar outra."
      );
    }

    await this.resolveChats();
    await this.backfill();
    this.subscribe();
  }

  async stop(): Promise<void> {
    if (!this.client) return;
    if (this.handler) this.client.removeEventHandler(this.handler, new NewMessage({}));
    await this.client.disconnect();
    this.client = null;
  }

  /**
   * getDialogs antes de qualquer coisa: e ele que popula o cache de entidades do
   * cliente. Sem isso, getMessages por id cru falha com "Could not find the input
   * entity" em supergrupo, que e o tropeco classico do MTProto.
   */
  private async resolveChats(): Promise<void> {
    const dialogs = await this.client!.getDialogs({});
    const porId = new Map<string, WatchedChat>();

    for (const d of dialogs) {
      porId.set(chatKey(d.id), { entity: d.entity, title: d.title || chatKey(d.id) });
    }

    for (const id of this.config.chatIds) {
      const achado = porId.get(id);
      if (!achado) {
        console.warn(
          `[GroupWatcher] Grupo ${id} nao encontrado nas suas conversas. ` +
          `Confira o id com 'npm run telegram:login -- --listar' e que a conta ainda participa dele.`
        );
        continue;
      }
      this.watched.set(id, achado);
    }

    console.info(
      `[GroupWatcher] Observando ${this.watched.size} de ${this.config.chatIds.length} grupo(s) configurado(s).`
    );
  }

  /**
   * minId = ultima mensagem ja gravada, entao a primeira execucao puxa o historico
   * ate backfillLimit e as seguintes so o que chegou depois — sem ramo extra.
   * shortcut: se o bot ficar offline por mais de backfillLimit mensagens num grupo,
   * o miolo do intervalo nao e recuperado; subir o limite ou rodar um backfill manual
   */
  private async backfill(): Promise<void> {
    for (const [id, chat] of this.watched) {
      try {
        const desde = this.memory.groupMessages.maxMsgId(id);
        const mensagens = await this.client!.getMessages(chat.entity as never, {
          limit: this.config.backfillLimit,
          minId: desde,
        });

        const novas = mensagens
          .map((m) => toGroupMessage(m, id, chat.title))
          .filter((m): m is GroupMessage => m !== null);

        const gravadas = this.memory.saveGroupMessages(novas);
        console.info(`[GroupWatcher] ${chat.title}: ${gravadas} mensagem(ns) nova(s).`);
      } catch (err: unknown) {
        // um grupo problematico nao pode derrubar os outros nem o bot
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[GroupWatcher] Falha no backfill de ${chat.title}: ${msg}`);
      }
    }
  }

  /**
   * Filtra por chat aqui dentro em vez de passar `chats` ao NewMessage: aquele
   * caminho exige resolver as entidades de novo e falha calado quando uma delas
   * nao resolve.
   */
  private subscribe(): void {
    this.handler = (event: NewMessageEvent) => {
      const id = chatKey(event.chatId);
      const chat = this.watched.get(id);
      if (!chat) return;

      const gm = toGroupMessage(event.message, id, chat.title);
      if (!gm) return;

      try {
        this.memory.saveGroupMessages([gm]);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[GroupWatcher] Falha ao gravar mensagem de ${chat.title}: ${msg}`);
      }
    };

    this.client!.addEventHandler(this.handler, new NewMessage({}));
    console.info("[GroupWatcher] Escutando mensagens novas.");
  }
}
