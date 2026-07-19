/**
 * Unified install descriptor (spec §9.1) — the honest, per-runtime facts the
 * installer + UI show a user picking a driver. This is the source of truth for
 * the install copy: it describes the REAL driver model (Codex App Server / Claude
 * Agent SDK / OpenClaw Gateway adapter, persistent resumable per-scope sessions),
 * never the retired "常驻连接器 + headless 驱动 (codex exec / claude -p)" model, and
 * it never claims claude.ai subscription reuse (§5.5).
 *
 * Pure data → deterministically testable and shareable with im-web copy.
 */
import type { RuntimeKind } from "../runtime/driver.js";

export const ALL_RUNTIME_KINDS: RuntimeKind[] = ["codex", "claude-code", "openclaw"];

export type InstallDescriptor = {
  kind: RuntimeKind;
  label: string;
  /** One-line description of what this runtime actually is. */
  summary: string;
  /** What the runtime drives + how sessions behave. */
  details: string[];
  /** Real auth methods the user must provide (empty when the Gateway owns auth). */
  auth: string[];
};

const DESCRIPTORS: Record<RuntimeKind, InstallDescriptor> = {
  codex: {
    kind: "codex",
    label: "Codex",
    summary: "通过 Codex App Server 驱动 Codex，持久、可恢复的按会话线程。",
    details: [
      "本机以 stdio 启动 codex app-server，一条连接管理多个 thread。",
      "每个会话（DM / 群 / 任务）对应一个 thread，重启后按 thread/resume 恢复，不掉线。",
      "每轮显式设置 cwd、sandbox、审批策略；停止用 turn/interrupt。",
    ],
    auth: ["Codex 登录（由 codex app-server 自行持有，Mingle 不接触其凭证）"],
  },
  "claude-code": {
    kind: "claude-code",
    label: "Claude",
    summary: "通过 Claude Agent SDK 驱动 Claude，显式 session_id、可跨进程 resume。",
    details: [
      "使用 @anthropic-ai/claude-agent-sdk 的 query()，每个 scope 保存明确的 session_id。",
      "重启后用 resume 恢复该会话，不靠 continue 猜“最近一次”。",
      "Mingle 能力以进程内 SDK-MCP 工具暴露，模型不持有长期 Agent 凭证。",
    ],
    // Honest auth surfacing (§5.5) — real methods only, no claude.ai claim.
    auth: [
      "Anthropic API key（ANTHROPIC_API_KEY）",
      "Amazon Bedrock（CLAUDE_CODE_USE_BEDROCK）",
      "Google Vertex（CLAUDE_CODE_USE_VERTEX）",
    ],
  },
  openclaw: {
    kind: "openclaw",
    label: "OpenClaw 龙虾",
    summary: "把 Mingle 接到你现有的 OpenClaw Gateway，作为 Gateway 适配器运行。",
    details: [
      "复用 OpenClaw 已有的 Gateway、Agent/session 路由和工具生命周期，不在本机重造。",
      "OpenClaw 的 session key 映射到同一套 Mingle scope 语义，群/@/私聊行为一致。",
      "同一 Agent 凭证同一时刻只有一个活跃 consumer。",
    ],
    auth: [],
  },
};

export function describeInstall(kind: RuntimeKind): InstallDescriptor {
  return DESCRIPTORS[kind];
}
