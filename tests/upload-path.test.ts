import { describe, it, expect } from "vitest";
import { uploadPathFor } from "../src/input/input-handler.js";
import { resolveInWorkspace } from "../src/tools/registry.js";

describe("uploadPathFor", () => {
  it("keeps a markdown name as-is under uploads/", () => {
    expect(uploadPathFor("notas.md", false)).toBe("uploads/notas.md");
  });

  it("rewrites a pdf name to .md", () => {
    expect(uploadPathFor("Relatorio.PDF", true)).toBe("uploads/Relatorio.md");
    expect(uploadPathFor("contrato.pdf", true)).toBe("uploads/contrato.md");
  });

  it("strips directory components from the Telegram-supplied name", () => {
    expect(uploadPathFor("../../etc/passwd", false)).toBe("uploads/passwd");
    expect(uploadPathFor("a/b/c.md", false)).toBe("uploads/c.md");
  });

  it("replaces characters that are unsafe in a filename", () => {
    expect(uploadPathFor("re:la*to?rio.md", false)).toBe("uploads/re_la_to_rio.md");
  });

  it("falls back to a default when nothing usable is left", () => {
    expect(uploadPathFor("", false)).toBe("uploads/documento");
    expect(uploadPathFor("/", false)).toBe("uploads/documento");
  });

  it("always produces a path that stays inside the workspace", () => {
    for (const name of ["../../etc/passwd", "..\\..\\windows\\win.ini", "", "/", "x.md"]) {
      for (const isPdf of [true, false]) {
        expect(resolveInWorkspace("./tmp/test-ws", uploadPathFor(name, isPdf))).not.toBeNull();
      }
    }
  });
});
