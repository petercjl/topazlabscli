import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const packageRoot = path.resolve(here, "..");
export const bundledSkill = path.join(packageRoot, "skill", "topazlabscli");
export const workerScript = path.join(packageRoot, "worker", "windows", "topazlabs-worker.ps1");

export function configPath() {
  if (process.env.TOPAZLABSCLI_CONFIG) return path.resolve(process.env.TOPAZLABSCLI_CONFIG);
  const base = process.platform === "win32"
    ? (process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"))
    : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"));
  return path.join(base, "topazlabscli", "config.json");
}

export function skillTarget(agent) {
  const home = os.homedir();
  if (agent === "codex") {
    return path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "skills", "topazlabscli");
  }
  if (agent === "sealseek") {
    return path.join(process.env.SEALSEEK_SKILLS_HOME || path.join(home, ".agents", "skills"), "topazlabscli");
  }
  throw new Error(`Unknown Agent: ${agent}`);
}
