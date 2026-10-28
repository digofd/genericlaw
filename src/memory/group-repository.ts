import { Database } from "sql.js";

export interface GroupMessage {
  chatId: string;
  msgId: number;
  chatTitle: string;
  sender: string;
  text: string;
  date: string;
}

export interface GroupSummary {
  chatId: string;
  chatTitle: string;
  total: number;
  lastDate: string;
}

// montado em runtime: um byte nulo literal no fonte e invisivel e quebra editores
const NUL = new RegExp(String.fromCharCode(0), "g");

/**
 * Forma usada para busca: sem acento e em minusculas. Sem isso, procurar "acao"
 * em grupo brasileiro nao acha "ação" — sao conjuntos disjuntos no LIKE do SQLite,
 * que so dobra maiuscula/minuscula de ASCII e nao dobra acento nenhum.
 */
export function normalizar(texto: string): string {
  return texto.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

/**
 * Historico bruto dos grupos lidos pela conta pessoal (MTProto). Tabela separada
 * de `messages` de proposito: aquela tem FK para conversations e e podada pela
 * janela de contexto do agente, o que apagaria justamente o historico que
 * queremos guardar.
 */
export class SqliteGroupMessageRepository {
  constructor(private db: Database) {}

  /** Insere ignorando o que ja existe (PK chat_id+msg_id). Devolve quantas entraram. */
  save(messages: GroupMessage[]): number {
    if (messages.length === 0) return 0;

    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO group_messages (chat_id, msg_id, chat_title, sender, text, date, text_norm) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    const before = this.total();
    try {
      for (const m of messages) {
        // o byte nulo trunca a string dentro do sqlite e engoliria o resto da mensagem
        const texto = m.text.replace(NUL, "");
        stmt.run([m.chatId, m.msgId, m.chatTitle, m.sender, texto, m.date, normalizar(texto)]);
      }
    } finally {
      stmt.free();
    }
    return this.total() - before;
  }

  /** Maior msg_id ja gravado do grupo, ou 0. E o ponto de retomada do backfill. */
  maxMsgId(chatId: string): number {
    return this.scalar("SELECT COALESCE(MAX(msg_id), 0) AS v FROM group_messages WHERE chat_id = ?", [chatId]);
  }

  /** Mensagens posteriores a `afterMsgId`, em ordem cronologica. O passo do destilador. */
  since(chatId: string, afterMsgId: number, limit: number): GroupMessage[] {
    return this.query(
      "SELECT * FROM group_messages WHERE chat_id = ? AND msg_id > ? ORDER BY msg_id ASC LIMIT ?",
      [chatId, afterMsgId, limit]
    );
  }

  /** Quantas mensagens ainda nao passaram pelo destilador. */
  pendingCount(chatId: string, afterMsgId: number): number {
    return this.scalar(
      "SELECT COUNT(*) AS v FROM group_messages WHERE chat_id = ? AND msg_id > ?",
      [chatId, afterMsgId]
    );
  }

  /** Ate onde o conhecimento daquele grupo ja foi destilado. 0 = nunca destilado. */
  digestWatermark(chatId: string): number {
    return this.scalar("SELECT COALESCE(last_msg_id, 0) AS v FROM group_digest WHERE chat_id = ?", [chatId]);
  }

  setDigestWatermark(chatId: string, msgId: number): void {
    this.db.run(
      "INSERT INTO group_digest (chat_id, last_msg_id, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(chat_id) DO UPDATE SET last_msg_id = excluded.last_msg_id, updated_at = excluded.updated_at",
      [chatId, msgId, new Date().toISOString()]
    );
  }

  recent(chatId: string, limit: number): GroupMessage[] {
    const rows = this.query(
      "SELECT * FROM group_messages WHERE chat_id = ? ORDER BY msg_id DESC LIMIT ?",
      [chatId, limit]
    );
    return rows.reverse();
  }

  /**
   * Busca textual, ignorando acento e caixa (casa contra text_norm, nao text).
   * LIKE faz varredura na tabela inteira; para um agente pessoal (dezenas de
   * milhares de linhas) isso roda em milissegundos.
   * shortcut: sem indice de texto, migrar para FTS5 se a busca passar a demorar
   */
  search(termo: string, limit: number, chatId?: string): GroupMessage[] {
    // escapa os curingas do LIKE para que uma busca por "100%" nao vire "qualquer coisa"
    const padrao = `%${normalizar(termo).replace(/[\\%_]/g, "\\$&")}%`;
    const filtro = chatId ? "AND chat_id = ?" : "";
    const params: (string | number)[] = chatId ? [padrao, chatId, limit] : [padrao, limit];

    return this.query(
      `SELECT * FROM group_messages WHERE text_norm LIKE ? ESCAPE '\\' ${filtro} ORDER BY msg_id DESC LIMIT ?`,
      params
    );
  }

  /** Um resumo por grupo conhecido, do mais recente para o mais antigo. */
  groups(): GroupSummary[] {
    const stmt = this.db.prepare(
      `SELECT chat_id, MAX(chat_title) AS chat_title, COUNT(*) AS total, MAX(date) AS last_date
       FROM group_messages GROUP BY chat_id ORDER BY last_date DESC`
    );
    const out: GroupSummary[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      out.push({
        chatId: String(row.chat_id),
        chatTitle: String(row.chat_title || ""),
        total: Number(row.total || 0),
        lastDate: String(row.last_date || ""),
      });
    }
    stmt.free();
    return out;
  }

  private total(): number {
    return this.scalar("SELECT COUNT(*) AS v FROM group_messages", []);
  }

  private scalar(sql: string, params: (string | number)[]): number {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    let value = 0;
    if (stmt.step()) value = Number((stmt.getAsObject() as { v: number }).v || 0);
    stmt.free();
    return value;
  }

  private query(sql: string, params: (string | number)[]): GroupMessage[] {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const out: GroupMessage[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      out.push({
        chatId: String(row.chat_id),
        msgId: Number(row.msg_id),
        chatTitle: String(row.chat_title || ""),
        sender: String(row.sender || ""),
        text: String(row.text || ""),
        date: String(row.date || ""),
      });
    }
    stmt.free();
    return out;
  }
}
