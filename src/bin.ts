#!/usr/bin/env node
/** `mingle-runtime` executable entry — parse argv, run the CLI, exit with its code. */
import { runCli } from "./cli.js";

runCli(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
