import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { resolveInWorkspace, isInsideWorkspace } from "../src/tools/registry.js";
import { CriarArquivoTool } from "../src/tools/criar-arquivo.js";
import { LerArquivoTool } from "../src/tools/ler-arquivo.js";

const WS = "./tmp/test-ws";

afterAll(() => {
  fs.rmSync("./tmp/test-ws", { recursive: true, force: true });
  fs.rmSync("./tmp/test-ws-evil", { recursive: true, force: true });
});

describe("resolveInWorkspace", () => {
  it("accepts paths inside the workspace", () => {
    expect(resolveInWorkspace(WS, "a.md")).not.toBeNull();
    expect(resolveInWorkspace(WS, "sub/dir/a.md")).not.toBeNull();
    expect(resolveInWorkspace(WS, ".")).not.toBeNull();
  });

  it("rejects a sibling directory sharing the workspace name as a prefix", () => {
    // o bug exato que startsWith() deixava passar: ./tmp/test-ws-evil comeca com ./tmp/test-ws
    expect(resolveInWorkspace(WS, "../test-ws-evil/secrets")).toBeNull();
  });

  it("rejects parent-directory escapes", () => {
    expect(resolveInWorkspace(WS, "../../etc/passwd")).toBeNull();
    expect(resolveInWorkspace(WS, "a/../../../b")).toBeNull();
  });

  it("treats the workspace root itself as inside", () => {
    const abs = path.resolve(process.cwd(), WS);
    expect(isInsideWorkspace(abs, abs)).toBe(true);
  });
});

describe("tools reject traversal", () => {
  it("criar_arquivo refuses to write outside the workspace", async () => {
    const tool = new CriarArquivoTool(WS);
    const r = await tool.execute({ path: "../test-ws-evil/pwned.md", content: "x" });
    expect(r.success).toBe(false);
    expect(r.error).toBe("path traversal");
    expect(fs.existsSync(path.resolve(process.cwd(), "./tmp/test-ws-evil/pwned.md"))).toBe(false);
  });

  it("criar_arquivo still writes normal paths, and ler_arquivo reads them back", async () => {
    const created = await new CriarArquivoTool(WS).execute({ path: "ok/a.md", content: "hello" });
    expect(created.success).toBe(true);

    const read = await new LerArquivoTool(WS).execute({ path: "ok/a.md" });
    expect(read.success).toBe(true);
    expect(read.output).toBe("hello");
  });

  it("refuses to clobber an existing file unless overwrite is set", async () => {
    const tool = new CriarArquivoTool(WS);
    expect((await tool.execute({ path: "dup.md", content: "original" })).success).toBe(true);

    const blocked = await tool.execute({ path: "dup.md", content: "clobbered" });
    expect(blocked.success).toBe(false);
    expect(blocked.error).toBe("already exists");
    expect((await new LerArquivoTool(WS).execute({ path: "dup.md" })).output).toBe("original");

    const forced = await tool.execute({ path: "dup.md", content: "replaced", overwrite: true });
    expect(forced.success).toBe(true);
    expect((await new LerArquivoTool(WS).execute({ path: "dup.md" })).output).toBe("replaced");
  });

  it("marks truncated reads so the model knows it saw only part of the file", async () => {
    const big = "a".repeat(20000);
    await new CriarArquivoTool(WS).execute({ path: "big.md", content: big, overwrite: true });

    const r = await new LerArquivoTool(WS).execute({ path: "big.md" });
    expect(r.success).toBe(true);
    expect(r.output).toContain("[...leitura parcial:");
    expect(r.output).toContain("bytes 0-8192 de 20000");
    expect(r.output).toContain("offset=8192");
    expect(r.output.length).toBeLessThan(big.length);

    // 50000 e limitado ao teto de 32768, mas isso ainda cobre os 11808 bytes
    // restantes, entao a segunda pagina conclui e nao traz marcador
    const rest = await new LerArquivoTool(WS).execute({ path: "big.md", maxBytes: 50000, offset: 8192 });
    expect(rest.output).not.toContain("leitura parcial");
    expect(r.output.slice(0, r.output.indexOf("\n\n[...")) + rest.output).toBe(big);
  });

  it("rejects absolute paths", async () => {
    const r = await new CriarArquivoTool(WS).execute({ path: path.resolve("/tmp/x.md"), content: "x" });
    expect(r.success).toBe(false);
  });
});

describe("BaseTool.validateArgs", () => {
  const tool = new CriarArquivoTool(WS);

  it("flags missing required parameters", () => {
    const v = tool.validateArgs({ path: "a.md" });
    expect(v.valid).toBe(false);
    expect(v.errors?.join()).toContain("content");
  });

  it("flags wrong types", () => {
    const v = tool.validateArgs({ path: 42, content: "x" });
    expect(v.valid).toBe(false);
    expect(v.errors?.join()).toContain("expected string");
  });

  it("accepts valid args", () => {
    expect(tool.validateArgs({ path: "a.md", content: "x" }).valid).toBe(true);
  });
});
