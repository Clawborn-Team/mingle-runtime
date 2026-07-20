import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandHome, type InstalledBinding } from "../install/config.js";

/**
 * Load the owner-authored LOCAL agent definition to use as the turn persona.
 *
 * The local definition is the SOURCE OF TRUTH for who this agent is (product-vision
 * two-tier model): the runtime must answer AS that agent, not as a generic default.
 * We only fall back to DEFAULT_LOCAL_AGENT_PERSONA when the owner authored NOTHING —
 * i.e. this returns `null` and the caller supplies the default.
 *
 * Location is each CLI's native agent-definition format:
 *  - **claude-code** → `~/.claude/agents/<agentId>.md` (a subagent file). Strip the
 *    YAML frontmatter; the body is the persona.
 *  - **codex** → the Codex `AGENTS.md` (the binding's working dir first, then the
 *    global `~/.codex/AGENTS.md`). A shared AGENTS.md can hold unrelated project /
 *    global instructions, so we extract ONLY this agent's section, keyed by
 *    `mingle_agent_id: <agentId>` in its heading.
 */
export async function loadAuthoredPersona(
  ib: InstalledBinding,
  home: string = homedir(),
): Promise<string | null> {
  if (ib.runtimeKind === "claude-code") {
    const path = join(home, ".claude", "agents", `${ib.agentId}.md`);
    const body = stripFrontmatter(await readFileOrNull(path));
    return nonEmpty(body);
  }
  if (ib.runtimeKind === "codex") {
    const candidates = [
      ib.dir ? join(expandHome(ib.dir), "AGENTS.md") : null,
      join(home, ".codex", "AGENTS.md"),
    ].filter((p): p is string => Boolean(p));
    for (const path of candidates) {
      const section = extractMingleSection(await readFileOrNull(path), ib.agentId);
      if (section) return section;
    }
    return null;
  }
  return null;
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
}

function nonEmpty(s: string | null): string | null {
  const t = s?.trim();
  return t ? t : null;
}

/** Drop a leading `---\n … \n---` YAML frontmatter block, returning the body. */
export function stripFrontmatter(md: string | null): string | null {
  if (md == null) return null;
  const m = md.match(/^﻿?---\n[\s\S]*?\n---[ \t]*\n?/);
  return m ? md.slice(m[0].length) : md;
}

/** Extract the Markdown section whose heading carries `mingle_agent_id: <id>`, up to
 *  the next heading of the same-or-higher level (or EOF). Returns null if absent. */
export function extractMingleSection(md: string | null, agentId: string): string | null {
  if (md == null) return null;
  const lines = md.split("\n");
  const needle = `mingle_agent_id: ${agentId}`;
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const h = line.match(/^(#{1,6})\s/);
    if (h && line.includes(needle)) {
      start = i;
      level = h[1]!.length;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const h = (lines[i] ?? "").match(/^(#{1,6})\s/);
    if (h && h[1]!.length <= level) {
      end = i;
      break;
    }
  }
  return nonEmpty(lines.slice(start, end).join("\n"));
}
