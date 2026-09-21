import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { binScript, updateStatePath } from "./paths.mjs";
import { run, runInherited } from "./process.mjs";
import { skillInstall, skillStatus } from "./skill.mjs";

const DEFAULT_INTERVAL_HOURS = 6;
const DEFAULT_MIRROR_REGISTRY = "https://registry.npmmirror.com/";
const UPDATE_TIMEOUT_MS = 8000;
const UPDATE_GUARD = "TOPAZLABSCLI_AUTO_UPDATE_GUARD";

function numericParts(version) {
  return String(version).replace(/^v/, "").split(/[.+-]/).slice(0, 3).map((part) => Number(part) || 0);
}

export function isNewerVersion(candidate, current) {
  const left = numericParts(candidate);
  const right = numericParts(current);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}

function readState(filename) {
  try { return JSON.parse(fs.readFileSync(filename, "utf8")); }
  catch { return {}; }
}

function writeState(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filename);
  try { fs.chmodSync(filename, 0o600); } catch {}
}

function automaticUpdateEnabled(config, env) {
  const override = env.TOPAZLABSCLI_AUTO_UPDATE?.toLowerCase();
  if (["0", "false", "off", "no"].includes(override)) return false;
  if (["1", "true", "on", "yes"].includes(override)) return true;
  return config.settings?.auto_update !== false;
}

function normalizeRegistry(value) {
  const text = String(value || "").trim();
  if (!/^https?:\/\//i.test(text)) return null;
  return text.endsWith("/") ? text : `${text}/`;
}

function uniqueRegistries(values) {
  return [...new Set(values.map(normalizeRegistry).filter(Boolean))];
}

export async function resolveUpdateRegistries(config, dependencies = {}) {
  const env = dependencies.env || process.env;
  const execute = dependencies.run || run;
  const configured = config.settings?.update_registry;
  const overrides = String(env.TOPAZLABSCLI_UPDATE_REGISTRY || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const preferred = configured && configured !== "auto" ? [configured] : [];
  let npmRegistry = null;
  try {
    const result = await execute("npm", ["config", "get", "registry"], {
      env,
      timeoutMs: dependencies.timeoutMs || UPDATE_TIMEOUT_MS
    });
    if (result.code === 0) npmRegistry = result.stdout.trim();
  } catch {}
  return uniqueRegistries([...overrides, ...preferred, npmRegistry, DEFAULT_MIRROR_REGISTRY]);
}

export async function queryLatestVersion(pkg, config, dependencies = {}) {
  const env = dependencies.env || process.env;
  const execute = dependencies.run || run;
  const registries = dependencies.registries || await resolveUpdateRegistries(config, dependencies);
  const attempts = [];
  for (const registry of registries) {
    let result;
    try {
      result = await execute("npm", ["view", pkg.name, "version", "--json", "--registry", registry], {
        env: {
          ...env,
          npm_config_fetch_timeout: env.npm_config_fetch_timeout || "5000",
          npm_config_fetch_retries: "0"
        },
        timeoutMs: dependencies.timeoutMs || UPDATE_TIMEOUT_MS
      });
    } catch (error) {
      attempts.push({ registry, ok: false, detail: error.message });
      continue;
    }
    if (result.code !== 0) {
      attempts.push({
        registry,
        ok: false,
        detail: result.timedOut ? "timed out" : (result.stderr.trim() || "registry query failed")
      });
      continue;
    }
    let latest;
    try { latest = JSON.parse(result.stdout.trim()); }
    catch { latest = result.stdout.trim().replace(/^"|"$/g, ""); }
    attempts.push({ registry, ok: true, latest });
    return { ok: true, latest, registry, attempts };
  }
  return { ok: false, attempts };
}

function registryFailureMessage(attempts) {
  if (!attempts.length) return "No valid npm update registry is configured.";
  return `Unable to check npm for updates: ${attempts.map((item) => `${item.registry} (${item.detail})`).join("; ")}`;
}

export async function installLatestPackage(pkg, latest, registry, dependencies = {}) {
  const env = dependencies.env || process.env;
  const execute = dependencies.run || run;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "topazlabscli-update-"));
  try {
    const packed = await execute("npm", ["pack", `${pkg.name}@${latest}`, "--json", "--pack-destination", temporary, "--registry", registry], {
      env,
      timeoutMs: dependencies.timeoutMs || UPDATE_TIMEOUT_MS
    });
    if (packed.code !== 0) return packed;
    let filename;
    try { filename = JSON.parse(packed.stdout.trim())[0]?.filename; }
    catch {}
    if (!filename) {
      return { ...packed, code: 1, stderr: packed.stderr || "npm pack did not return a package filename." };
    }
    return await execute("npm", ["install", "--global", path.join(temporary, filename)], {
      env,
      timeoutMs: dependencies.installTimeoutMs
    });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

export async function maybeAutoUpdate(rawArgs, pkg, dependencies = {}) {
  const env = dependencies.env || process.env;
  if (env[UPDATE_GUARD] === "1") return { checked: false, reason: "guard" };

  const config = (dependencies.loadConfig || loadConfig)();
  if (!automaticUpdateEnabled(config, env)) return { checked: false, reason: "disabled" };

  const stateFile = dependencies.stateFile || updateStatePath();
  const now = dependencies.now?.() || Date.now();
  const intervalHours = Number(config.settings?.update_check_hours ?? DEFAULT_INTERVAL_HOURS);
  const intervalMs = Math.max(0, intervalHours) * 60 * 60 * 1000;
  const state = readState(stateFile);
  if (intervalMs > 0 && state.registry && Number.isFinite(state.last_checked_at) && now - state.last_checked_at < intervalMs) {
    return { checked: false, reason: "fresh", latest: state.latest || null, registry: state.registry || null };
  }

  const query = await queryLatestVersion(pkg, config, dependencies);
  if (!query.ok) return { checked: true, warning: registryFailureMessage(query.attempts), attempts: query.attempts };

  const { latest, registry } = query;
  writeState(stateFile, { last_checked_at: now, latest, current: pkg.version, registry });
  if (!isNewerVersion(latest, pkg.version)) return { checked: true, updated: false, latest, registry, attempts: query.attempts };

  const getSkillStatus = dependencies.skillStatus || skillStatus;
  const installSkill = dependencies.skillInstall || skillInstall;
  const installedSkills = getSkillStatus("all").filter((item) => item.installed);
  let install;
  try {
    install = await installLatestPackage(pkg, latest, registry, dependencies);
  } catch (error) {
    return { checked: true, warning: `Automatic npm update failed: ${error.message}`, latest, registry };
  }
  if (install.code !== 0) {
    return { checked: true, warning: install.stderr.trim() || "Automatic npm update failed.", latest, registry };
  }
  const warnings = [];
  for (const item of installedSkills) {
    try { installSkill(item.agent, item.mode || "link", true); }
    catch (error) { warnings.push(`Skill refresh failed for ${item.agent}: ${error.message}`); }
  }

  const reexecute = dependencies.runInherited || runInherited;
  try {
    const child = await reexecute(process.execPath, [binScript, ...rawArgs], {
      env: { ...env, [UPDATE_GUARD]: "1" }
    });
    return { checked: true, updated: true, latest, registry, reexecuted: true, exitCode: child.code ?? 1, warnings };
  } catch (error) {
    warnings.push(`Updated package could not restart the command: ${error.message}`);
    return { checked: true, updated: true, latest, registry, warning: warnings.join(" ") };
  }
}

export function updateRegistryWarning(attempts) {
  return registryFailureMessage(attempts);
}
