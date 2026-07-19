/** Public API barrel for programmatic embedding of the Mingle Runtime. */
export { runCli } from "./cli.js";
export { startRuntime, resolveInstalledDriver } from "./runtime/factory.js";
export { runBindingLoop, startDaemon, toBinding } from "./runtime/daemon.js";
export { createHttpEventCenterClient } from "./im/http-client.js";
export {
  bindingsFromArgs,
  loadConfig,
  saveConfig,
  upsertBinding,
  defaultConfigPath,
  type InstalledBinding,
  type RuntimeConfig,
} from "./install/config.js";
export { describeInstall, ALL_RUNTIME_KINDS, type InstallDescriptor } from "./install/describe.js";
export { resolveDriver, driverCapabilities } from "./runtime/driver-registry.js";
