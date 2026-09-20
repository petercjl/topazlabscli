import fs from "node:fs";
import path from "node:path";
import { configPath } from "./paths.mjs";
import { CliError } from "./errors.mjs";

export function emptyConfig() {
  return { schema_version: 1, default_target: null, targets: {} };
}

export function loadConfig({ required = false } = {}) {
  const filename = configPath();
  if (!fs.existsSync(filename)) {
    if (required) throw new CliError("CONFIG_NOT_FOUND", `Configuration not found: ${filename}`);
    return emptyConfig();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (parsed.schema_version !== 1 || typeof parsed.targets !== "object") {
      throw new Error("unsupported configuration schema");
    }
    return parsed;
  } catch (error) {
    throw new CliError("CONFIG_INVALID", `Cannot read configuration: ${error.message}`, { path: filename });
  }
}

export function saveConfig(config) {
  const filename = configPath();
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  if (fs.existsSync(filename)) fs.copyFileSync(filename, `${filename}.bak`);
  const temporary = `${filename}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filename);
  try { fs.chmodSync(filename, 0o600); } catch {}
  return filename;
}

export function resolveTarget(config, requested) {
  const name = requested || config.default_target;
  if (!name) throw new CliError("TARGET_REQUIRED", "Specify --target or configure a default target.");
  const target = config.targets[name];
  if (!target) throw new CliError("TARGET_NOT_FOUND", `Unknown target: ${name}`);
  if (!Array.isArray(target.endpoints) || target.endpoints.length === 0) {
    throw new CliError("TARGET_INVALID", `Target ${name} has no endpoints.`);
  }
  return { name, ...target };
}
