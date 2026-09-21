import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { loadConfig, saveConfig, resolveTarget } from "./config.mjs";
import { configPath, workerScript } from "./paths.mjs";
import { CliError, requireValue } from "./errors.mjs";
import { run } from "./process.mjs";
import { probeMp4Dimensions } from "./media.mjs";
import { psLiteral, runPowerShell, selectEndpoint, sftpGet, sftpPut } from "./ssh.mjs";
import { skillInstall, skillSource, skillStatus } from "./skill.mjs";
import { installLatestPackage, maybeAutoUpdate, queryLatestVersion, updateRegistryWarning } from "./update.mjs";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");
const DEFAULT_PRESET = "seedance-human-1080p";
const WORKER_VERSION = "0.3.0";
const PRESETS = {
  "seedance-human-1080p": {
    id: "seedance-human-1080p",
    resolution: "1080p",
    short_edge: 1080,
    output: "aspect-preserving 1080p",
    model: "prob-4",
    tuning: "proteus-auto-v1",
    fps: "source",
    concurrency: 1
  },
  "seedance-human-1440p": {
    id: "seedance-human-1440p",
    resolution: "2k",
    short_edge: 1440,
    output: "aspect-preserving QHD/2K (1440p short edge)",
    model: "prob-4",
    tuning: "proteus-auto-v1",
    fps: "source",
    concurrency: 1
  }
};
const RESOLUTION_PRESETS = {
  "1080": "seedance-human-1080p",
  "1080p": "seedance-human-1080p",
  "fhd": "seedance-human-1080p",
  "1440": "seedance-human-1440p",
  "1440p": "seedance-human-1440p",
  "2k": "seedance-human-1440p",
  "qhd": "seedance-human-1440p"
};

const CAPABILITIES = {
  schema_version: 1,
  package: pkg.name,
  version: pkg.version,
  commands: ["version", "capabilities", "doctor", "settings", "target", "connection", "worker", "model", "job", "process", "skill", "update"],
  automatic_updates: { enabled_by_default: true, registry_check_hours: 6, registry_fallback: true, refreshes_installed_skills: true },
  default_preset: DEFAULT_PRESET,
  presets: Object.values(PRESETS),
  automatic_parameter_tuning: {
    id: "proteus-auto-v1",
    model: "prob-4",
    method: "Topaz Proteus automatic estimation",
    estimate_frames: 20,
    relative_offsets: { preblur: 0, noise: 0, details: 0, halo: 0, blur: 0, compression: 0 },
    recover_original_detail: 0.2
  },
  agents: { codex: "tested", sealseek_windows: "implemented" },
  worker_os: ["windows"],
  transport: ["ssh", "sftp"]
};

function option(args, name, { multiple = false } = {}) {
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name) {
      if (i + 1 >= args.length) throw new CliError("ARGUMENT_REQUIRED", `${name} requires a value.`);
      values.push(args[i + 1]);
      args.splice(i, 2);
      i -= 1;
    } else if (args[i].startsWith(`${name}=`)) {
      values.push(args[i].slice(name.length + 1));
      args.splice(i, 1);
      i -= 1;
    }
  }
  return multiple ? values : values.at(-1);
}

function flag(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function output(value, json) {
  if (json) process.stdout.write(`${JSON.stringify({ ok: true, data: value }, null, 2)}\n`);
  else if (typeof value === "string") process.stdout.write(`${value}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function help() {
  return `topazlabscli ${pkg.version}\n\n` +
    `Commands:\n` +
    `  version | capabilities | doctor\n` +
    `  settings show | set auto-update <on|off> | set update-check-hours <hours> | set update-registry <auto|url>\n` +
    `  target add <name> --endpoint <label=host>... --user <user> [--identity <path>] [--workspace <windows-path>] [--default]\n` +
    `  target list\n` +
    `  connection check [--target <name>]\n` +
    `  worker install|status [--target <name>]\n` +
    `  model status [--target <name>]\n` +
    `  job submit <video> [--target <name>] [--resolution 1080p|2k] [--preset <id>]\n` +
    `  job list [--target <name>]\n` +
    `  job status|wait|download|cancel <job-id> [--target <name>] [--output <path>]\n` +
    `  process <video> [--resolution 1080p|2k] [--output <path>] [--target <name>]\n` +
    `  skill source|status|install|update [--agent codex|sealseek|all] [--copy]\n` +
    `  update\n\nUse --json for machine-readable output.`;
}

function parseEndpoint(value) {
  const split = value.indexOf("=");
  const name = split > 0 ? value.slice(0, split) : "default";
  const address = split > 0 ? value.slice(split + 1) : value;
  const match = address.match(/^(.+?)(?::(\d+))?$/);
  if (!match || !match[1]) throw new CliError("ENDPOINT_INVALID", `Invalid endpoint: ${value}`);
  return { name, host: match[1], ...(match[2] ? { port: Number(match[2]) } : {}) };
}

function remoteRoot(target) {
  return target.workspace || "E:\\topazlab_workspace";
}

function workerInvocation(root, action, extra = "") {
  const script = `${root}\\.topazlabscli\\worker\\topazlabs-worker.ps1`;
  return `& ${psLiteral(script)} -Action ${psLiteral(action)} -Root ${psLiteral(root)} ${extra}`;
}

function parseRemoteJson(result, code = "REMOTE_ERROR") {
  if (result.code !== 0) throw new CliError(code, result.stderr.trim() || result.stdout.trim() || "Remote command failed.");
  const text = result.stdout.trim();
  try { return JSON.parse(text); }
  catch { throw new CliError("REMOTE_OUTPUT_INVALID", "Remote worker did not return valid JSON.", { output: text }); }
}

async function remoteAction(target, endpoint, action, params = {}, { timeout = 7 } = {}) {
  const encoded = Buffer.from(JSON.stringify(params), "utf8").toString("base64");
  const extra = Object.keys(params).length ? `-PayloadBase64 ${psLiteral(encoded)}` : "";
  return parseRemoteJson(await runPowerShell(target, endpoint, workerInvocation(remoteRoot(target), action, extra), { timeout }));
}

async function getConnectedTarget(requested) {
  const target = resolveTarget(loadConfig({ required: true }), requested);
  const selected = await selectEndpoint(target);
  return { target, ...selected };
}

async function installWorker(target, endpoint) {
  const root = remoteRoot(target);
  const remote = `${root}\\.topazlabscli\\worker\\topazlabs-worker.ps1`;
  const workerDirectory = `${root}\\.topazlabscli\\worker`;
  const prep = `$p=${psLiteral(workerDirectory)}; New-Item -ItemType Directory -Force -Path $p | Out-Null; [Console]::Out.Write('{"ok":true}')`;
  parseRemoteJson(await runPowerShell(target, endpoint, prep));
  await sftpPut(target, endpoint, workerScript, remote);
  return remoteAction(target, endpoint, "Install");
}

async function ensureWorker(target, endpoint) {
  let status = null;
  try { status = await remoteAction(target, endpoint, "Status"); }
  catch { /* Install or repair the worker below. */ }
  if (!status?.installed || status.worker_version !== WORKER_VERSION) return installWorker(target, endpoint);
  return status;
}

export function resolvePreset({ preset, resolution } = {}) {
  let resolved = preset || null;
  if (resolution) {
    const fromResolution = RESOLUTION_PRESETS[String(resolution).toLowerCase()];
    if (!fromResolution) throw new CliError("RESOLUTION_UNSUPPORTED", `Unsupported resolution: ${resolution}. Use 1080p or 2k.`);
    if (resolved && resolved !== fromResolution) throw new CliError("PRESET_CONFLICT", `Preset ${resolved} does not match resolution ${resolution}.`);
    resolved = fromResolution;
  }
  resolved ||= DEFAULT_PRESET;
  if (!PRESETS[resolved]) throw new CliError("PRESET_UNSUPPORTED", `Unsupported preset: ${resolved}`);
  return PRESETS[resolved];
}

async function submitJob(inputPath, requestedTarget, presetOptions = {}) {
  const input = path.resolve(inputPath);
  if (!fs.existsSync(input) || !fs.statSync(input).isFile()) throw new CliError("INPUT_NOT_FOUND", `Video not found: ${input}`);
  const preset = resolvePreset(presetOptions);
  let source;
  try { source = probeMp4Dimensions(input); }
  catch (error) { throw new CliError("INPUT_METADATA_UNSUPPORTED", `Could not read MP4 video dimensions: ${error.message}`); }
  const { target, endpoint, attempts } = await getConnectedTarget(requestedTarget);
  const id = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomBytes(3).toString("hex")}`;
  const safeName = path.basename(input).replace(/[^A-Za-z0-9._-]/g, "_");
  const worker = await ensureWorker(target, endpoint);
  const prepared = await remoteAction(target, endpoint, "Prepare", { id, input_name: safeName });
  await sftpPut(target, endpoint, input, prepared.input_path);
  const job = await remoteAction(target, endpoint, "Enqueue", { id, input_name: safeName, preset: preset.id, source_width: source.width, source_height: source.height });
  return { ...job, preset: preset.id, resolution: preset.resolution, tuning: preset.tuning, target: target.name, endpoint: endpoint.name, worker_version: worker.worker_version, connection_attempts: attempts };
}

async function runQueue(requestedTarget, timeoutSeconds = 86400) {
  const { target, endpoint } = await getConnectedTarget(requestedTarget);
  return { ...(await remoteAction(target, endpoint, "Run", {}, { timeout: timeoutSeconds })), target: target.name, endpoint: endpoint.name };
}

async function waitJob(id, requestedTarget, intervalSeconds = 10, timeoutSeconds = 86400) {
  const { target, endpoint } = await getConnectedTarget(requestedTarget);
  const started = Date.now();
  while (true) {
    const status = await remoteAction(target, endpoint, "JobStatus", { id });
    if (["completed", "failed", "cancelled"].includes(status.state)) return { ...status, target: target.name, endpoint: endpoint.name };
    if ((Date.now() - started) / 1000 > timeoutSeconds) throw new CliError("WAIT_TIMEOUT", `Timed out waiting for job ${id}.`);
    await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
  }
}

async function downloadJob(id, requestedTarget, outputPath) {
  const { target, endpoint } = await getConnectedTarget(requestedTarget);
  const status = await remoteAction(target, endpoint, "JobStatus", { id });
  if (status.state !== "completed") throw new CliError("JOB_NOT_COMPLETE", `Job ${id} is ${status.state}.`);
  const destination = path.resolve(outputPath || status.output_name || `${id}.mp4`);
  if (fs.existsSync(destination)) throw new CliError("OUTPUT_EXISTS", `Refusing to overwrite existing output: ${destination}`);
  await sftpGet(target, endpoint, status.output_path, destination);
  return { id, target: target.name, endpoint: endpoint.name, output: destination };
}

export function defaultOutputPath(inputPath, presetOptions = {}) {
  const resolved = path.resolve(inputPath);
  const extension = path.extname(resolved) || ".mp4";
  const preset = resolvePreset(presetOptions);
  const label = preset.resolution === "2k" ? "2k" : "1080p";
  return path.join(path.dirname(resolved), `${path.basename(resolved, path.extname(resolved))}-topaz-${label}${extension}`);
}

async function doctor(requestedTarget, updateInfo = null) {
  const checks = [];
  for (const command of ["ssh", "sftp", "node", "npm"]) {
    const args = command === "node" || command === "npm" ? ["--version"] : command === "sftp" ? ["-h"] : ["-V"];
    const result = await run(command, args);
    const detail = (result.stdout || result.stderr).trim().split("\n")[0];
    const ok = result.code === 0 || (command === "sftp" && /usage:\s*sftp/i.test(result.stderr));
    checks.push({
      id: `local.${command}`,
      ok,
      detail,
      resolved_command: result.resolvedCommand,
      resolution: result.resolution,
      timed_out: Boolean(result.timedOut)
    });
  }
  checks.push({ id: "config", ok: fs.existsSync(configPath()), detail: configPath() });
  if (updateInfo) {
    checks.push({
      id: "updates.registry",
      ok: Boolean(updateInfo.registry),
      required: false,
      detail: updateInfo.registry
        ? { registry: updateInfo.registry, latest: updateInfo.latest || null, checked: updateInfo.checked }
        : { warning: updateInfo.warning || "Update registry was not checked.", attempts: updateInfo.attempts || [] }
    });
  }
  if (requestedTarget || fs.existsSync(configPath())) {
    try {
      const { target, endpoint } = await getConnectedTarget(requestedTarget);
      checks.push({ id: "connection", ok: true, detail: `${target.name}/${endpoint.name}` });
      try {
        const status = await remoteAction(target, endpoint, "Status");
        checks.push({ id: "worker", ok: Boolean(status.installed), detail: status });
      } catch (error) {
        checks.push({ id: "worker", ok: false, detail: error.message });
      }
    } catch (error) {
      checks.push({ id: "connection", ok: false, detail: error.details || error.message });
    }
  }
  return { ok: checks.filter((item) => item.required !== false).every((item) => item.ok), checks };
}

export async function main(rawArgs) {
  const args = [...rawArgs];
  const json = flag(args, "--json");
  if (args.length === 0 || ["help", "--help", "-h"].includes(args[0])) return output(help(), false);
  const command = args.shift();
  if (command === "version" || command === "--version" || command === "-V") return output(pkg.version, json);
  if (command === "capabilities") return output(CAPABILITIES, json);

  let updateInfo = null;
  if (!["update", "settings"].includes(command)) {
    updateInfo = await maybeAutoUpdate(rawArgs, pkg);
    if (updateInfo.warning) process.stderr.write(`[AUTO_UPDATE_WARNING] ${updateInfo.warning}\n`);
    if (updateInfo.reexecuted) {
      process.exitCode = updateInfo.exitCode;
      return;
    }
  }

  if (command === "settings") {
    const action = args.shift() || "show";
    const config = loadConfig();
    if (action === "show") return output(config.settings, json);
    if (action === "set") {
      const name = requireValue(args.shift(), "SETTING_REQUIRED", "settings set requires a setting name.");
      const value = requireValue(args.shift(), "VALUE_REQUIRED", `settings set ${name} requires a value.`);
      if (name === "auto-update") {
        if (!["on", "off"].includes(value)) throw new CliError("SETTING_INVALID", "auto-update must be on or off.");
        config.settings.auto_update = value === "on";
      } else if (name === "update-check-hours") {
        const hours = Number(value);
        if (!Number.isFinite(hours) || hours < 0) throw new CliError("SETTING_INVALID", "update-check-hours must be zero or a positive number.");
        config.settings.update_check_hours = hours;
      } else if (name === "update-registry") {
        if (value !== "auto" && !/^https?:\/\//i.test(value)) throw new CliError("SETTING_INVALID", "update-registry must be auto or an http(s) URL.");
        config.settings.update_registry = value;
      } else throw new CliError("SETTING_UNKNOWN", `Unknown setting: ${name}`);
      const saved = saveConfig(config);
      return output({ path: saved, settings: config.settings }, json);
    }
    throw new CliError("COMMAND_UNKNOWN", `Unknown settings action: ${action}`);
  }

  if (command === "doctor") return output(await doctor(option(args, "--target"), updateInfo), json);

  if (command === "target") {
    const action = args.shift();
    if (action === "list") return output({ path: configPath(), ...loadConfig() }, json);
    if (action === "add") {
      const name = requireValue(args.shift(), "TARGET_REQUIRED", "target add requires a name.");
      const endpoints = option(args, "--endpoint", { multiple: true }).map(parseEndpoint);
      if (endpoints.length === 0) throw new CliError("ENDPOINT_REQUIRED", "Provide at least one --endpoint label=host.");
      const config = loadConfig();
      config.targets[name] = {
        user: option(args, "--user") || null,
        identity_file: option(args, "--identity") || null,
        workspace: option(args, "--workspace") || "E:\\topazlab_workspace",
        endpoints
      };
      if (flag(args, "--default") || !config.default_target) config.default_target = name;
      const saved = saveConfig(config);
      return output({ name, path: saved, target: config.targets[name], default: config.default_target === name }, json);
    }
    throw new CliError("COMMAND_UNKNOWN", `Unknown target action: ${action || ""}`);
  }

  if (command === "connection" && args.shift() === "check") {
    const { target, endpoint, attempts } = await getConnectedTarget(option(args, "--target"));
    return output({ target: target.name, selected: endpoint, attempts }, json);
  }

  if (command === "worker") {
    const action = args.shift();
    const requested = option(args, "--target");
    const { target, endpoint, attempts } = await getConnectedTarget(requested);
    if (action === "install") {
      const installed = await installWorker(target, endpoint);
      return output({ ...installed, target: target.name, endpoint: endpoint.name, connection_attempts: attempts }, json);
    }
    if (action === "status") return output(await remoteAction(target, endpoint, "Status"), json);
    throw new CliError("COMMAND_UNKNOWN", `Unknown worker action: ${action || ""}`);
  }

  if (command === "model" && args.shift() === "status") {
    const { target, endpoint } = await getConnectedTarget(option(args, "--target"));
    const status = await remoteAction(target, endpoint, "Status");
    return output({ model: "prob-4", ready: status.model_ready, definitions: status.model_definitions, weights: status.model_weights }, json);
  }

  if (command === "job") {
    const action = args.shift();
    const requested = option(args, "--target");
    if (action === "submit") return output(await submitJob(requireValue(args.shift(), "INPUT_REQUIRED", "job submit requires a video."), requested, { preset: option(args, "--preset"), resolution: option(args, "--resolution") }), json);
    if (action === "list") {
      const { target, endpoint } = await getConnectedTarget(requested);
      return output(await remoteAction(target, endpoint, "ListJobs"), json);
    }
    const id = requireValue(args.shift(), "JOB_ID_REQUIRED", `job ${action || ""} requires a job id.`);
    if (action === "status") {
      const { target, endpoint } = await getConnectedTarget(requested);
      return output(await remoteAction(target, endpoint, "JobStatus", { id }), json);
    }
    if (action === "wait") {
      const timeout = Number(option(args, "--timeout") || 86400);
      const interval = Number(option(args, "--interval") || 10);
      await runQueue(requested, timeout);
      return output(await waitJob(id, requested, interval, timeout), json);
    }
    if (action === "download") return output(await downloadJob(id, requested, option(args, "--output")), json);
    if (action === "cancel") {
      const { target, endpoint } = await getConnectedTarget(requested);
      return output(await remoteAction(target, endpoint, "Cancel", { id }), json);
    }
    throw new CliError("COMMAND_UNKNOWN", `Unknown job action: ${action || ""}`);
  }

  if (command === "process") {
    const input = requireValue(args.shift(), "INPUT_REQUIRED", "process requires a video.");
    const presetOptions = { preset: option(args, "--preset"), resolution: option(args, "--resolution") };
    const selectedPreset = resolvePreset(presetOptions);
    const destination = option(args, "--output") || defaultOutputPath(input, { preset: selectedPreset.id });
    const requested = option(args, "--target");
    const timeout = Number(option(args, "--timeout") || 86400);
    const submitted = await submitJob(input, requested, { preset: selectedPreset.id });
    const runner = await runQueue(requested, timeout);
    const finished = await waitJob(submitted.id, requested, Number(option(args, "--interval") || 10), timeout);
    if (finished.state !== "completed") throw new CliError("JOB_FAILED", `Job ${submitted.id} ended as ${finished.state}.`, finished);
    return output({ submitted, runner, finished, downloaded: await downloadJob(submitted.id, requested, destination) }, json);
  }

  if (command === "skill") {
    const action = args.shift();
    const agent = option(args, "--agent") || "all";
    if (action === "source") return output(skillSource(), json);
    if (action === "status") return output(skillStatus(agent), json);
    if (action === "install") return output(skillInstall(agent, flag(args, "--copy") ? "copy" : "link", false), json);
    if (action === "update") return output(skillInstall(agent, flag(args, "--copy") ? "copy" : "link", true), json);
    throw new CliError("COMMAND_UNKNOWN", `Unknown skill action: ${action || ""}`);
  }

  if (command === "update") {
    const config = loadConfig();
    const query = await queryLatestVersion(pkg, config);
    if (!query.ok) throw new CliError("UPDATE_FAILED", updateRegistryWarning(query.attempts), { attempts: query.attempts });
    const previousSkills = skillStatus("all");
    const result = await installLatestPackage(pkg, query.latest, query.registry);
    if (result.code !== 0) throw new CliError("UPDATE_FAILED", result.stderr.trim() || "npm update failed.");
    const skills = [];
    for (const existing of previousSkills.filter((item) => item.installed)) {
      skills.push(...skillInstall(existing.agent, existing.mode || "link", true));
    }
    return output({ package: pkg.name, updated: true, registry: query.registry, latest: query.latest, skills, detail: result.stdout.trim() }, json);
  }
  throw new CliError("COMMAND_UNKNOWN", `Unknown command: ${command}`);
}
