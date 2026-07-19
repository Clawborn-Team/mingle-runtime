/**
 * The OpenClaw Gateway surface the driver adapts (spec §5.6). OpenClaw already
 * has a mature Gateway, agent/session routing, channel + tool lifecycle — so the
 * Mingle Runtime does NOT re-implement it and does NOT spawn `openclaw` to scrape
 * stdout. The `OpenClawDriver` talks to this structural interface (learned from
 * `openclaw-mingle/src/inbound.ts` — inbound.run / reply / session), so:
 *  - a Mingle scope_key maps to the Gateway's session key,
 *  - one wake runs exactly one Gateway turn,
 *  - the Gateway owns the agent loop, tools, and channel routing.
 *
 * The real binding to a live `PluginRuntime` is provided at the edge (dynamic /
 * optional), so the core builds without an OpenClaw dependency.
 */

export type GatewayTurnResult = {
  /** The agent's reply text (what should go back to the wake's reply target). */
  reply?: string;
  /** Tools the Gateway ran this turn, if it reports them. */
  tools?: { id: string; name: string; ok: boolean }[];
};

export interface OpenClawGateway {
  /** Open (or ensure) a Gateway session for a Mingle scope; returns its key/id. */
  openSession(input: { bindingId: string; scopeKey: string }): Promise<{ sessionKey: string }>;
  /** Resume an existing Gateway session by key. */
  resumeSession(sessionKey: string): Promise<{ sessionKey: string }>;
  /** Run ONE turn: hand the (already structured) input to the Gateway, get a reply. */
  runTurn(input: { sessionKey: string; input: string; signal?: AbortSignal }): Promise<GatewayTurnResult>;
  /** Cooperatively stop the running turn for a session. */
  interrupt(sessionKey: string): Promise<void>;
  closeSession(sessionKey: string): Promise<void>;
}

export type FakeGatewayOptions = {
  reply?: string;
  fail?: boolean;
};

/** In-memory Gateway double for unit tests. */
export class FakeGateway implements OpenClawGateway {
  readonly openedKeys: string[] = [];
  lastInput = "";
  private counter = 0;
  private readonly reply: string;
  private readonly fail: boolean;

  constructor(opts: FakeGatewayOptions = {}) {
    this.reply = opts.reply ?? "ok";
    this.fail = opts.fail ?? false;
  }

  async openSession(input: { bindingId: string; scopeKey: string }): Promise<{ sessionKey: string }> {
    this.openedKeys.push(input.scopeKey);
    // A distinct gateway session per (binding, scope).
    return { sessionKey: `oc-${input.bindingId}-${input.scopeKey}-${++this.counter}` };
  }

  async resumeSession(sessionKey: string): Promise<{ sessionKey: string }> {
    return { sessionKey };
  }

  async runTurn(input: { sessionKey: string; input: string }): Promise<GatewayTurnResult> {
    this.lastInput = input.input;
    if (this.fail) throw new Error("gateway turn failed");
    return { reply: this.reply };
  }

  async interrupt(): Promise<void> {
    /* no-op for the fake */
  }

  async closeSession(): Promise<void> {
    /* no-op for the fake */
  }
}
