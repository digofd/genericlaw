import { describe, it, expect } from "vitest";
import { wantsAudioReply } from "../src/input/input-handler.js";

describe("wantsAudioReply", () => {
  it("matches ordinary ways of asking for audio", () => {
    for (const text of [
      "mande o resumo em audio",      // the phrasing the old fixed list missed
      "mande o resumo em áudio",
      "responda em audio",
      "me manda por voz",
      "quero a resposta falada",
      "fale comigo",
      "PODE MANDAR EM ÁUDIO?",
    ]) {
      expect(wantsAudioReply(text), text).toBe(true);
    }
  });

  it("does not fire on ordinary messages", () => {
    for (const text of [
      "crie um arquivo chamado teste.md",
      "qual e o meu nome?",
      "resuma o documento",
      "liste os arquivos",
    ]) {
      expect(wantsAudioReply(text), text).toBe(false);
    }
  });

  it("requires a whole word, not a substring", () => {
    // "audiovisual" e "vozes" nao podem ser lidos como pedido de mensagem de voz
    expect(wantsAudioReply("fale sobre producao audiovisual")).toBe(false);
  });
});
