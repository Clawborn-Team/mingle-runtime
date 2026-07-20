import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeKind } from "../runtime/driver.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export async function installOwnerContextSkill(kind: RuntimeKind, opts: { home: string }): Promise<string> {
  const root = kind === "claude-code"
    ? join(opts.home, ".claude", "skills")
    : kind === "codex"
      ? join(opts.home, ".codex", "skills")
      : kind === "openclaw"
        ? join(opts.home, ".openclaw", "workspace", "skills")
        : join(opts.home, ".workbuddy", "skills");
  const target = join(root, "mingle-owner-context", "SKILL.md");
  const packaged = join(HERE, "..", "..", "skills", "mingle-owner-context", "SKILL.md");
  const content = await readFile(packaged, "utf8");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
  return target;
}
