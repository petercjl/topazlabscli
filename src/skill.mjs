import fs from "node:fs";
import path from "node:path";
import { binScript, bundledSkill, packageRoot, skillTarget } from "./paths.mjs";
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

export function effectiveSkillMode(agent, requestedMode, platform = process.platform) {
  if (platform === "win32" && agent === "sealseek" && requestedMode === "link") return "copy";
  return requestedMode;
}

function writeRuntimeManifest(target) {
  const manifest = {
    schema: "topazlabscli-skill-runtime",
    schema_version: 1,
    node: process.execPath,
    bin: binScript,
    package_root: packageRoot
  };
  fs.writeFileSync(path.join(target, ".topazlabscli-runtime.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

function installOne(agent, mode, update) {
  const effectiveMode = effectiveSkillMode(agent, mode);
  const target = skillTarget(agent);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    if (!update) throw new CliError("SKILL_ALREADY_INSTALLED", `Skill target already exists: ${target}`);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) fs.unlinkSync(target);
    else fs.rmSync(target, { recursive: true, force: true });
  }
  if (effectiveMode === "copy") {
    fs.cpSync(bundledSkill, target, { recursive: true });
    writeRuntimeManifest(target);
  } else fs.symlinkSync(bundledSkill, target, process.platform === "win32" ? "junction" : "dir");
  return { agent, target, mode: effectiveMode, source: bundledSkill };
}

export function skillInstall(selected = "all", mode = "link", update = false) {
  const names = selected === "all" ? agents : [selected];
  for (const name of names) if (!agents.includes(name)) throw new CliError("AGENT_UNSUPPORTED", `Unsupported Agent: ${name}`);
  return names.map((name) => installOne(name, mode, update));
}
