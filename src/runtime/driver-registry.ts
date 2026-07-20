/**
 * Driver registry — resolve an `AgentRuntimeDriver` by `runtime_kind` and expose
 * each kind's declared capabilities so the runtime degrades the UI honestly per
 * driver (§5.2, §9.2). Drivers still don't import each other; this is the one
 * place that knows all three, and each driver's heavy deps are injected (so the
 * core imports no provider SDK to construct one).
 */
import type { AgentRuntimeDriver, RuntimeCapabilities, RuntimeKind } from "./driver.js";
import { CodexAppServerDriver, type CodexDriverOptions } from "../codex/driver.js";
import { ClaudeAgentDriver, type ClaudeDriverOptions } from "../claude/driver.js";
import { OpenClawDriver, type OpenClawDriverOptions } from "../openclaw/driver.js";
import { WorkBuddyAcpDriver, type WorkBuddyDriverOptions } from "../workbuddy/driver.js";

export type DriverDeps = {
  codex?: CodexDriverOptions;
  claude?: ClaudeDriverOptions;
  openclaw?: OpenClawDriverOptions;
  workbuddy?: WorkBuddyDriverOptions;
};

export function resolveDriver(kind: RuntimeKind, deps: DriverDeps): AgentRuntimeDriver {
  switch (kind) {
    case "codex":
      if (!deps.codex) throw new Error("resolveDriver: codex deps (client) required for the codex driver");
      return new CodexAppServerDriver(deps.codex);
    case "claude-code":
      if (!deps.claude) throw new Error("resolveDriver: claude deps (query) required for the claude-code driver");
      return new ClaudeAgentDriver(deps.claude);
    case "openclaw":
      if (!deps.openclaw) throw new Error("resolveDriver: openclaw deps (gateway) required for the openclaw driver");
      return new OpenClawDriver(deps.openclaw);
    case "workbuddy":
      if (!deps.workbuddy) throw new Error("resolveDriver: workbuddy deps (client) required for the workbuddy driver");
      return new WorkBuddyAcpDriver(deps.workbuddy);
  }
}

/** Static capability descriptor per kind — for honest UI degrade without needing
 *  to construct a driver (or its provider deps). Kept in sync with each driver. */
const CAPABILITIES: Record<RuntimeKind, RuntimeCapabilities> = {
  codex: { streaming: true, tools: true, approvals: true, fileChanges: true, resume: true },
  "claude-code": { streaming: true, tools: true, approvals: true, fileChanges: true, resume: true },
  openclaw: { streaming: false, tools: true, approvals: false, fileChanges: false, resume: true },
  workbuddy: { streaming: true, tools: true, approvals: true, fileChanges: false, resume: true },
};

export function driverCapabilities(kind: RuntimeKind): RuntimeCapabilities {
  return CAPABILITIES[kind];
}
