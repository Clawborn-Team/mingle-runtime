/**
 * Runtime identity for the platform-controlled auto-update handshake (§ managed
 * runtime updates). The daemon reports these on every Event Center poll
 * (X-Mingle-Runtime / -Version / -Capabilities); im-server compares the version to
 * its configured target and returns a `runtime.update` directive when we're behind.
 */
import { createRequire } from "node:module";

function readVersion(): string {
  try {
    // dist/version.js → ../package.json = the package root (present in the tarball).
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const RUNTIME_NAME = "mingle-runtime";
export const RUNTIME_VERSION = readVersion();
/** Capabilities we advertise; `runtime-update-v1` = "I understand + can apply a
 *  runtime.update directive by relaunching myself at the target version." */
export const RUNTIME_CAPABILITIES = ["runtime-update-v1"] as const;
