import { describe, it, expect, vi } from "vitest";
import { pickRuntimeUpdate, applySelfUpdate, type RuntimeUpdateDirective } from "../src/runtime/self-update.js";

const upd = (over: Partial<RuntimeUpdateDirective> = {}): RuntimeUpdateDirective => ({
  id: "mingle-runtime:0.1.7",
  type: "runtime.update",
  runtime: "mingle-runtime",
  version: "0.1.7",
  install_url: "https://x/releases/download/v0.1.7/mingle-runtime.tgz",
  ...over,
});

describe("pickRuntimeUpdate", () => {
  it("picks a newer runtime.update directive for mingle-runtime", () => {
    expect(pickRuntimeUpdate([upd()], "0.1.6")?.version).toBe("0.1.7");
  });

  it("ignores when we are already at or above the target", () => {
    expect(pickRuntimeUpdate([upd({ version: "0.1.6" })], "0.1.6")).toBeUndefined();
    expect(pickRuntimeUpdate([upd({ version: "0.1.5" })], "0.1.6")).toBeUndefined();
  });

  it("ignores directives for another runtime, wrong type, or missing fields", () => {
    expect(pickRuntimeUpdate([upd({ runtime: "openclaw-mingle" })], "0.1.6")).toBeUndefined();
    expect(pickRuntimeUpdate([upd({ type: "plugin.update" })], "0.1.6")).toBeUndefined();
    expect(pickRuntimeUpdate([upd({ install_url: undefined })], "0.1.6")).toBeUndefined();
    expect(pickRuntimeUpdate([upd({ version: undefined })], "0.1.6")).toBeUndefined();
    expect(pickRuntimeUpdate(undefined, "0.1.6")).toBeUndefined();
  });

  it("tolerates a leading v on either side", () => {
    expect(pickRuntimeUpdate([upd({ version: "v0.2.0" })], "v0.1.6")?.version).toBe("v0.2.0");
  });
});

describe("applySelfUpdate", () => {
  it("relaunches npx at the target install_url (detached) then exits", () => {
    const spawn = vi.fn((_cmd: string, _args: string[], _opts: unknown) => ({ unref: vi.fn() }));
    const exit = vi.fn();
    applySelfUpdate(upd(), { spawn, exit, log: () => {} });
    expect(spawn).toHaveBeenCalledOnce();
    const [cmd, args] = spawn.mock.calls[0]!;
    expect(cmd).toBe("npx");
    expect(args).toEqual(["--yes", "-p", upd().install_url, "mingle-runtime", "start"]);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
