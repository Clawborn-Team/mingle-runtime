import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  bindingsFromArgs,
  loadConfig,
  saveConfig,
  upsertBinding,
  defaultConfigPath,
} from "../src/install/config.js";

describe("bindingsFromArgs", () => {
  it("parses a single-runtime add into one binding", () => {
    const [b, ...rest] = bindingsFromArgs([
      "--agent", "agent_x", "--key", "k_secret", "--im-url", "https://relay.test", "--runtime", "claude-code",
    ]);
    expect(rest).toHaveLength(0);
    expect(b).toMatchObject({
      agentId: "agent_x",
      key: "k_secret",
      imUrl: "https://relay.test",
      runtimeKind: "claude-code",
    });
    expect(b!.consumerId).toContain("agent_x");
    expect(b!.consumerId).toContain("claude-code");
  });

  it("splits comma-separated --runtime into one binding per runtime, sharing the agent", () => {
    const bs = bindingsFromArgs([
      "--agent", "a1", "--key", "k", "--im-url", "https://r", "--runtime", "claude-code,codex",
    ]);
    expect(bs.map((b) => b.runtimeKind)).toEqual(["claude-code", "codex"]);
    expect(new Set(bs.map((b) => b.consumerId)).size).toBe(2); // distinct consumer ids
  });

  it("carries optional --dir and --model through", () => {
    const [b] = bindingsFromArgs([
      "--agent", "a", "--key", "k", "--im-url", "https://r", "--runtime", "codex", "--dir", "/repo", "--model", "gpt-x",
    ]);
    expect(b).toMatchObject({ dir: "/repo", model: "gpt-x" });
  });

  it("expands a leading ~ in --dir (the install command quotes it, so the shell won't)", () => {
    const [b] = bindingsFromArgs([
      "--agent", "a", "--key", "k", "--im-url", "https://r", "--runtime", "claude-code", "--dir", "~/codebase/im",
    ]);
    expect(b!.dir).toBe(join(homedir(), "codebase/im"));
    expect(b!.dir).not.toContain("~"); // never a literal tilde (breaks the provider cwd)
  });

  it("rejects a missing required flag", () => {
    expect(() => bindingsFromArgs(["--agent", "a", "--runtime", "codex"])).toThrow(/requires/);
  });

  it("rejects an unknown runtime kind", () => {
    expect(() =>
      bindingsFromArgs(["--agent", "a", "--key", "k", "--im-url", "https://r", "--runtime", "gemini"]),
    ).toThrow(/unknown runtime/);
  });

  it("rejects an empty --runtime", () => {
    expect(() =>
      bindingsFromArgs(["--agent", "a", "--key", "k", "--im-url", "https://r"]),
    ).toThrow(/runtime/);
  });
});

describe("config persistence", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mingle-cfg-"));
    path = join(dir, "config.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns an empty config when the file is absent", async () => {
    expect(await loadConfig(path)).toEqual({ bindings: [] });
  });

  it("round-trips a saved config", async () => {
    const [b] = bindingsFromArgs(["--agent", "a", "--key", "k", "--im-url", "https://r", "--runtime", "codex"]);
    await saveConfig({ bindings: [b!] }, path);
    const loaded = await loadConfig(path);
    expect(loaded.bindings).toHaveLength(1);
    expect(loaded.bindings[0]).toMatchObject({ agentId: "a", runtimeKind: "codex" });
  });

  it("upsertBinding replaces same (agent,runtime) in place but appends a new runtime", () => {
    let cfg = { bindings: [] as ReturnType<typeof bindingsFromArgs> };
    const [b1] = bindingsFromArgs(["--agent", "a", "--key", "k1", "--im-url", "https://r", "--runtime", "codex"]);
    cfg = upsertBinding(cfg, b1!);
    const [b2] = bindingsFromArgs(["--agent", "a", "--key", "k2", "--im-url", "https://r", "--runtime", "codex"]);
    cfg = upsertBinding(cfg, b2!); // same (a, codex) → replace, rotated key
    expect(cfg.bindings).toHaveLength(1);
    expect(cfg.bindings[0]!.key).toBe("k2");
    const [b3] = bindingsFromArgs(["--agent", "a", "--key", "k3", "--im-url", "https://r", "--runtime", "claude-code"]);
    cfg = upsertBinding(cfg, b3!); // different runtime → append
    expect(cfg.bindings).toHaveLength(2);
  });

  it("defaultConfigPath honors MINGLE_CONFIG_DIR", () => {
    const prev = process.env.MINGLE_CONFIG_DIR;
    process.env.MINGLE_CONFIG_DIR = "/tmp/xyz";
    expect(defaultConfigPath()).toBe("/tmp/xyz/config.json");
    if (prev === undefined) delete process.env.MINGLE_CONFIG_DIR;
    else process.env.MINGLE_CONFIG_DIR = prev;
  });
});
