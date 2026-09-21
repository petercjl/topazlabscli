import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { binScript, updateStatePath } from "./paths.mjs";
import { run, runInherited } from "./process.mjs";
import { skillInstall, skillStatus } from "./skill.mjs";

const DEFAULT_INTERVAL_HOURS = 6;
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
  if (intervalMs > 0 && Number.isFinite(state.last_checked_at) && now - state.last_checked_at < intervalMs) {
    return { checked: false, reason: "fresh", latest: state.latest || null };
  }

  const execute = dependencies.run || run;
  let query;
  try {
    query = await execute("npm", ["view", pkg.name, "version", "--json"], {
      env: { ...env, npm_config_fetch_timeout: env.npm_config_fetch_timeout || "5000", npm_config_fetch_retries: "0" }
    });
  } catch (error) {
    return { checked: true, warning: `Unable to check npm for updates: ${error.message}` };
  }
  if (query.code !== 0) {
    return { checked: true, warning: query.stderr.trim() || "Unable to check npm for updates." };
  }

  let latest;
  try { latest = JSON.parse(query.stdout.trim()); }
  catch { latest = query.stdout.trim().replace(/^"|"$/g, ""); }
  writeState(stateFile, { last_checked_at: now, latest, current: pkg.version });
  if (!isNewerVersion(latest, pkg.version)) return { checked: true, updated: false, latest };

  const getSkillStatus = dependencies.skillStatus || skillStatus;
  const installSkill = dependencies.skillInstall || skillInstall;
  const installedSkills = getSkillStatus("all").filter((item) => item.installed);
  let install;
  try {
    install = await execute("npm", ["install", "--global", `${pkg.name}@latest`], { env });
  } catch (error) {
    return { checked: true, warning: `Automatic npm update failed: ${error.message}`, latest };
  }
  if (install.code !== 0) {
    return { checked: true, warning: install.stderr.trim() || "Automatic npm update failed.", latest };
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
    return { checked: true, updated: true, latest, reexecuted: true, exitCode: child.code ?? 1, warnings };
  } catch (error) {
    warnings.push(`Updated package could not restart the command: ${error.message}`);
    return { checked: true, updated: true, latest, warning: warnings.join(" ") };
  }
}
