import { describe, it, expect } from "vitest";
import { loadClaudeQuery } from "../src/claude/real-query.js";
import { ClaudeAgentDriver } from "../src/claude/driver.js";
import { detectClaudeAuth } from "../src/claude/auth.js";
import type { RuntimeEvent } from "../src/runtime/driver.js";
import { parseWakePacket } from "../src/protocol/wake-packet.js";
import { dmWakePacket } from "./fixtures/wake-packets.js";

/** Only run when the real SDK is installed AND some auth is configured. */
async function ready(): Promise<boolean> {
  const q = await loadClaudeQuery();
  return q !== null && detectClaudeAuth().available;
}

const available = await ready();
const maybe = available ? it : it.skip;

describe("Claude Agent SDK smoke (real SDK + real auth)", () => {
  maybe("runs one real turn end-to-end through the driver", async () => {
    const query = (await loadClaudeQuery())!;
    const driver = new ClaudeAgentDriver({ query, cwd: process.cwd(), allowedTools: [] });
    const session = await driver.openSession({ bindingId: "b1", scopeKey: "dm:p1" });
    expect(session.ref.providerSessionId).toBeTruthy();

    const events: RuntimeEvent[] = [];
    for await (const ev of driver.runTurn({ session, packet: parseWakePacket(dmWakePacket) })) {
      events.push(ev);
    }
    expect(events[0]?.type).toBe("turn.started");
    expect(events.at(-1)?.type === "turn.completed" || events.at(-1)?.type === "turn.failed").toBe(true);
  }, 60_000);
});
