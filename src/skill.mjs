import fs from "node:fs";
import path from "node:path";
import { bundledSkill, skillTarget } from "./paths.mjs";
import { CliError } from "./errors.mjs";

const agents = ["codex", "sealseek"];

export function skillSource() {
  return { path: bundledSkill, exists: fs.existsSync(path.join(bundledSkill, "SKILL.md")) };
}

export function skillStatus(selected = "all") {
  const names = selected === "all" ? agents : [selected];
  return names.map((agent) => {
    const target = skillTarget(agent);
    let installed = false;
    let mode = null;
    if (fs.existsSync(target)) {
      installed = true;
      mode = fs.lstatSync(target).isSymbolicLink() ? "link" : "copy";
    }
    return { agent, target, installed, mode, source: bundledSkill };
  });
}

function installOne(agent, mode, update) {
  const target = skillTarget(agent);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    if (!update) throw new CliError("SKILL_ALREADY_INSTALLED", `Skill target already exists: ${target}`);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) fs.unlinkSync(target);
    else fs.rmSync(target, { recursive: true, force: true });
  }
  if (mode === "copy") fs.cpSync(bundledSkill, target, { recursive: true });
  else fs.symlinkSync(bundledSkill, target, process.platform === "win32" ? "junction" : "dir");
  return { agent, target, mode };
}

export function skillInstall(selected = "all", mode = "link", update = false) {
  const names = selected === "all" ? agents : [selected];
  for (const name of names) if (!agents.includes(name)) throw new CliError("AGENT_UNSUPPORTED", `Unsupported Agent: ${name}`);
  return names.map((name) => installOne(name, mode, update));
}
