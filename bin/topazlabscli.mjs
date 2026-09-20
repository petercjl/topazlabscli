#!/usr/bin/env node
import { main } from "../src/cli.mjs";

main(process.argv.slice(2)).catch((error) => {
  const json = process.argv.includes("--json");
  const payload = {
    ok: false,
    error: {
      code: error.code || "UNEXPECTED_ERROR",
      message: error.message || String(error),
      details: error.details || null
    }
  };
  if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stderr.write(`[${payload.error.code}] ${payload.error.message}\n`);
  process.exitCode = Number.isInteger(error.exitCode) ? error.exitCode : 1;
});
