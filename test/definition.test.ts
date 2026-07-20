import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAuthoredPersona, stripFrontmatter, extractMingleSection } from "../src/runtime/definition.js";
import type { InstalledBinding } from "../src/install/config.js";

function binding(over: Partial<InstalledBinding>): InstalledBinding {
  return { agentId: "agent_x", key: "k", imUrl: "http://im", runtimeKind: "claude-code", consumerId: "c", ...over };
}

let home: string;
beforeEach(async () => {
  home = await fs.mkdtemp(join(tmpdir(), "mingle-def-"));
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe("stripFrontmatter", () => {
  it("drops a leading --- YAML block and returns the body", () => {
    expect(stripFrontmatter("---\nname: a\nmingle_agent_id: a\n---\nI am A.")).toBe("I am A.");
  });
  it("returns the input unchanged when there is no frontmatter", () => {
    expect(stripFrontmatter("just a body")).toBe("just a body");
  });
  it("passes null through", () => {
    expect(stripFrontmatter(null)).toBeNull();
  });
});

describe("extractMingleSection", () => {
  const md = [
    "# Global codex rules",
    "always run tests.",
    "",
    "# Mingle Local Agent (mingle_agent_id: agent_x)",
    "You are CC, a private console.",
    "Interests: coding.",
    "",
    "# Something else",
    "unrelated.",
  ].join("\n");

  it("returns only the agent's own section (not the rest of the file)", () => {
    const s = extractMingleSection(md, "agent_x");
    expect(s).toContain("You are CC, a private console.");
    expect(s).toContain("Interests: coding.");
    expect(s).not.toContain("always run tests");
    expect(s).not.toContain("unrelated");
  });
  it("returns null when no section matches the agent id", () => {
    expect(extractMingleSection(md, "agent_other")).toBeNull();
  });
});

describe("loadAuthoredPersona", () => {
  it("claude-code: reads ~/.claude/agents/<id>.md with the frontmatter stripped", async () => {
    const dir = join(home, ".claude", "agents");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, "agent_x.md"), "---\nname: agent_x\nmingle_agent_id: agent_x\n---\nI am CC, the owner's private local agent.");
    const persona = await loadAuthoredPersona(binding({ runtimeKind: "claude-code" }), home);
    expect(persona).toBe("I am CC, the owner's private local agent.");
  });

  it("claude-code: returns null when no definition file was authored", async () => {
    expect(await loadAuthoredPersona(binding({ runtimeKind: "claude-code" }), home)).toBeNull();
  });

  it("codex: extracts the Mingle section from the working-dir AGENTS.md", async () => {
    const workdir = join(home, "proj");
    await fs.mkdir(workdir, { recursive: true });
    await fs.writeFile(
      join(workdir, "AGENTS.md"),
      "# Project rules\nbuild first.\n\n# Mingle Local Agent (mingle_agent_id: agent_x)\nI am CC on codex.\n",
    );
    const persona = await loadAuthoredPersona(binding({ runtimeKind: "codex", dir: workdir }), home);
    expect(persona).toContain("I am CC on codex.");
    expect(persona).not.toContain("build first");
  });

  it("codex: falls back to the global ~/.codex/AGENTS.md when the workdir has none", async () => {
    const codexDir = join(home, ".codex");
    await fs.mkdir(codexDir, { recursive: true });
    await fs.writeFile(join(codexDir, "AGENTS.md"), "# Mingle Local Agent (mingle_agent_id: agent_x)\nglobal CC.\n");
    const persona = await loadAuthoredPersona(binding({ runtimeKind: "codex", dir: join(home, "empty") }), home);
    expect(persona).toContain("global CC.");
  });

  it("codex: returns null when nothing was authored", async () => {
    expect(await loadAuthoredPersona(binding({ runtimeKind: "codex", dir: join(home, "empty") }), home)).toBeNull();
  });
});
