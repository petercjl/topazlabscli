import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const packageRoot = path.resolve(here, "..");
export const binScript = path.join(packageRoot, "bin", "topazlabscli.mjs");
export const bundledSkill = path.join(packageRoot, "skill", "topazlabscli");
export const workerScript = path.join(packageRoot, "worker", "windows", "topazlabs-worker.ps1");
export const tuningCatalog = path.join(packageRoot, "profiles", "proteus-advanced-v1.json");

export function configPath() {
  if (process.env.TOPAZLABSCLI_CONFIG) return path.resolve(process.env.TOPAZLABSCLI_CONFIG);
  const base = process.platform === "win32"
    ? (process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"))
    : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"));
  return path.join(base, "topazlabscli", "config.json");
}

export function updateStatePath() {
  if (process.env.TOPAZLABSCLI_UPDATE_STATE) return path.resolve(process.env.TOPAZLABSCLI_UPDATE_STATE);
  return path.join(path.dirname(configPath()), "update-state.json");
}

export function skillTarget(agent, options = {}) {
  const home = options.home || os.homedir();
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const exists = options.exists || fs.existsSync;
  const pathApi = platform === "win32" ? path.win32 : path;
  if (agent === "codex") {
    return pathApi.join(env.CODEX_HOME || pathApi.join(home, ".codex"), "skills", "topazlabscli");
  }
  if (agent === "sealseek") {
    if (env.SEALSEEK_SKILLS_HOME) return pathApi.join(env.SEALSEEK_SKILLS_HOME, "topazlabscli");
    const workspace = pathApi.join(home, ".sealseek", "workspace");
    const root = platform === "win32" && (exists(workspace) || exists(pathApi.dirname(workspace)))
      ? pathApi.join(workspace, "skills")
      : pathApi.join(home, ".agents", "skills");
    return pathApi.join(root, "topazlabscli");
  }
  throw new Error(`Unknown Agent: ${agent}`);
}
