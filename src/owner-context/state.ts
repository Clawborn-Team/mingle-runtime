import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

type RefreshState = { fingerprint?: string; updatedAt?: string; status?: "success" | "failure"; error?: string };
export async function readRefreshState(path: string): Promise<RefreshState> {
  try { return JSON.parse(await readFile(path, "utf8")) as RefreshState; } catch { return {}; }
}
export async function writeRefreshState(path: string, state: RefreshState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}
