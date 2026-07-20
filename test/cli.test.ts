import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.js";
import { loadConfig } from "../src/install/config.js";

describe("runCli", () => {
  let dir: string;
  let configPath: string;
  let logs: string[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mingle-cli-"));
    configPath = join(dir, "config.json");
    logs = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const log = (m: string) => logs.push(m);

  it("`add` writes the binding to config and reports it", async () => {
    const code = await runCli(
      ["add", "--agent", "agent_x", "--key", "k", "--im-url", "https://relay.test", "--runtime", "claude-code,codex"],
      { configPath, log },
    );
    expect(code).toBe(0);
    const cfg = await loadConfig(configPath);
    expect(cfg.bindings.map((b) => b.runtimeKind).sort()).toEqual(["claude-code", "codex"]);
    expect(logs.join("\n")).toMatch(/start/); // tells the user how to launch
  });

  it("`add` with bad args returns non-zero and does not write config", async () => {
    const code = await runCli(["add", "--agent", "only"], { configPath, log });
    expect(code).toBe(1);
    expect(await loadConfig(configPath)).toEqual({ bindings: [] });
  });

  it("`start` with no config tells the user to add first", async () => {
    const started: unknown[] = [];
    const code = await runCli(["start"], {
      configPath,
      log,
      startRuntime: async (c) => {
        started.push(c);
        return { done: Promise.resolve(), stop: async () => {} };
      },
    });
    expect(code).toBe(1);
    expect(started).toHaveLength(0);
  });

  it("`start` loads the config and launches the runtime (as a singleton), awaiting it", async () => {
    await runCli(["add", "--agent", "a", "--key", "k", "--im-url", "https://r", "--runtime", "codex"], { configPath, log });
    let launchedWith: number | undefined;
    let ensured = false;
    const code = await runCli(["start"], {
      configPath,
      log,
      ensureSingleton: async () => { ensured = true; },
      releaseSingleton: () => {},
      startRuntime: async (c) => {
        launchedWith = c.bindings.length;
        return { done: Promise.resolve(), stop: async () => {} };
      },
    });
    expect(code).toBe(0);
    expect(launchedWith).toBe(1);
    expect(ensured).toBe(true); // singleton claimed before launch
  });

  it("`setup` persists the binding and prints onboarding steps (name/intent + PATCH)", async () => {
    const code = await runCli(
      ["setup", "--agent", "agt", "--key", "k", "--im-url", "https://r", "--runtime", "claude-code", "--install-url", "https://x.tgz"],
      { configPath, log },
    );
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toMatch(/source of truth/i); // local definition is authoritative
    expect(out).toContain(".claude/agents/agt.md"); // claude-code → local subagent definition
    expect(out).toContain("mingle_agent_id: agt"); // Mingle id embedded in the local metadata
    expect(out).toContain("mingle-runtime start"); // launch daemon
    expect(out).toContain("/v1/me"); // mirror to Mingle
    expect(out).not.toContain('"k"'); // the api-key is read from config, never printed
  });

  it("`setup --runtime workbuddy` prints the WorkBuddy onboarding (own agent system + mirror)", async () => {
    const code = await runCli(
      ["setup", "--agent", "wb", "--key", "k", "--im-url", "https://r", "--runtime", "workbuddy", "--install-url", "https://x.tgz"],
      { configPath, log },
    );
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain(".workbuddy/skills"); // persist into WorkBuddy's own agent system
    expect(out).toContain("mingle_agent_id: wb"); // Mingle id embedded locally
    expect(out).toContain("mingle-runtime start"); // launch daemon
    expect(out).toContain("/v1/me"); // mirror identity up to Mingle
    expect(out).not.toContain('"k"'); // api-key never printed
  });

  it("unknown command prints usage with non-zero", async () => {
    const code = await runCli(["frobnicate"], { configPath, log });
    expect(code).toBe(1);
    expect(logs.join("\n")).toMatch(/mingle-runtime/);
  });
});
