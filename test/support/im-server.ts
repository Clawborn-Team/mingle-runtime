/**
 * Integration harness: spawn a REAL im-server against a DEDICATED Postgres db so
 * the runtime's HTTP client + consumer + delivery are exercised end-to-end over
 * real HTTP (not fakes). This is the coverage that would have caught the raw-event
 * wake build, the `from_account_id` reply shape, and the delivery-ok bugs.
 *
 * Own db `im_runtime_test` (NOT im_test / im_hosted_test): the team shares one
 * Postgres and each suite TRUNCATEs on boot, so a shared db would wipe another
 * suite's rows mid-run. Requires docker Postgres on :5433 (workspace docker-compose).
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const IM_SERVER_DIR = "/Users/diywang/codebase/im/im-server";
const TEST_DB = process.env.RUNTIME_TEST_DB ?? "postgres://im:im@localhost:5433/im_runtime_test";

export type RunningServer = { url: string; stop: () => Promise<void> };

function resetDb(): void {
  const dbName = TEST_DB.split("/").pop() ?? "im_runtime_test";
  try {
    execFileSync(
      "docker",
      ["exec", "-e", "PGPASSWORD=im", "im-postgres", "psql", "-U", "im", "-d", dbName, "-c",
        "TRUNCATE accounts RESTART IDENTITY CASCADE;"],
      { stdio: "ignore" },
    );
  } catch {
    // First run: tables don't exist yet; the spawned server migrate()s them on boot.
  }
}

/** Ensure the dedicated db exists (create if missing), then spawn im-server on it. */
export async function startImServer(): Promise<RunningServer> {
  try {
    execFileSync("docker", ["exec", "-e", "PGPASSWORD=im", "im-postgres", "createdb", "-U", "im", "im_runtime_test"],
      { stdio: "ignore" });
  } catch {
    // Already exists — fine.
  }
  resetDb();
  const port = 8700 + Math.floor(Math.random() * 200);
  const child: ChildProcess = spawn("npm", ["start"], {
    cwd: IM_SERVER_DIR,
    env: { ...process.env, PORT: String(port), DATABASE_URL: TEST_DB, COMPANION_RUNTIME: "off" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", () => {});

  const url = `http://localhost:${port}`;
  const deadline = Date.now() + 30_000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${url}/health`)).ok) { up = true; break; }
    } catch {
      /* not up yet */
    }
    await delay(300);
  }
  if (!up) { child.kill("SIGKILL"); throw new Error("im-server did not become healthy in time"); }

  return {
    url,
    stop: async () => {
      child.kill("SIGTERM");
      await delay(300);
      if (!child.killed) child.kill("SIGKILL");
    },
  };
}

async function api(url: string, method: string, path: string, opts: { auth?: string; body?: unknown } = {}) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(opts.auth ? { Authorization: `Bearer ${opts.auth}` } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

export async function provisionUser(url: string, username: string): Promise<{ apiKey: string; accountId: string }> {
  const { status, json } = await api(url, "POST", "/v1/users", { body: { username } });
  if (status !== 201) throw new Error(`provisionUser: ${status} ${JSON.stringify(json)}`);
  return { apiKey: json.api_key as string, accountId: (json.account as { id: string }).id };
}

export async function createLocalAgent(
  url: string,
  ownerApiKey: string,
  username: string,
  runtime: "openclaw" | "claude-code" | "codex" | "workbuddy" = "codex",
): Promise<{ apiKey: string; accountId: string }> {
  const { status, json } = await api(url, "POST", "/v1/agents", { auth: ownerApiKey, body: { username, kind: "local", runtime } });
  if (status !== 201) throw new Error(`createLocalAgent: ${status} ${JSON.stringify(json)}`);
  return { apiKey: json.api_key as string, accountId: (json.account as { id: string }).id };
}

export async function sendDm(url: string, senderApiKey: string, toAccountId: string, body: string): Promise<void> {
  const { status, json } = await api(url, "POST", "/v1/messages", { auth: senderApiKey, body: { to: toAccountId, body } });
  if (status !== 201) throw new Error(`sendDm: ${status} ${JSON.stringify(json)}`);
}

/** Read the 1:1 thread and return bodies sent BY `fromAccountId` (uses from_account_id). */
export async function repliesFrom(url: string, readerApiKey: string, peerAccountId: string, fromAccountId: string): Promise<string[]> {
  const { json } = await api(url, "GET", `/v1/messages?with=${peerAccountId}`, { auth: readerApiKey });
  const msgs = (json.messages as { from_account_id?: string; body?: string }[]) ?? [];
  return msgs.filter((m) => m.from_account_id === fromAccountId).map((m) => m.body ?? "");
}
