import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { run } from "./process.mjs";
import { resolveExecutable } from "./runtime.mjs";
import { CliError } from "./errors.mjs";

function destination(target, endpoint) {
  return target.user ? `${target.user}@${endpoint.host}` : endpoint.host;
}

function commonArgs(target, endpoint, { timeout = 7 } = {}) {
  const args = ["-o", "BatchMode=yes", "-o", `ConnectTimeout=${timeout}`];
  if (target.identity_file) args.push("-i", target.identity_file);
  if (endpoint.port) args.push("-p", String(endpoint.port));
  return args;
}

export function encodePowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

export async function runPowerShell(target, endpoint, script, { timeout = 7 } = {}) {
  const args = [...commonArgs(target, endpoint, { timeout }), destination(target, endpoint),
    "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(script)];
  return run("ssh", args, { timeoutMs: (timeout + 3) * 1000 });
}

export function startPowerShellDetached(target, endpoint, script) {
  const args = [...commonArgs(target, endpoint, { timeout: 10 }), destination(target, endpoint),
    "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(script)];
  const executable = resolveExecutable("ssh");
  const child = spawn(executable.command, [...executable.argsPrefix, ...args], { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  child.unref();
  return child.pid;
}

export async function selectEndpoint(target) {
  const attempts = [];
  for (const endpoint of target.endpoints) {
    const result = await runPowerShell(target, endpoint, "[Console]::Out.Write('TOPAZLABSCLI_OK')");
    const ok = result.code === 0 && result.stdout.includes("TOPAZLABSCLI_OK");
    attempts.push({
      name: endpoint.name,
      host: endpoint.host,
      ok,
      timed_out: Boolean(result.timedOut),
      error: ok ? null : result.stderr.trim()
    });
    if (ok) return { endpoint, attempts };
  }
  throw new CliError("CONNECTION_FAILED", `No endpoint is reachable for target ${target.name}.`, { attempts });
}

function quoteSftp(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function windowsToSftp(remotePath) {
  const normalized = String(remotePath).replaceAll("\\", "/");
  if (/^[A-Za-z]:\//.test(normalized)) return `/${normalized}`;
  return normalized;
}

export async function sftpPut(target, endpoint, localPath, remotePath) {
  if (!fs.existsSync(localPath)) throw new CliError("INPUT_NOT_FOUND", `Local file not found: ${localPath}`);
  const args = ["-b", "-", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
  if (target.identity_file) args.push("-i", target.identity_file);
  if (endpoint.port) args.push("-P", String(endpoint.port));
  args.push(destination(target, endpoint));
  const input = `put ${quoteSftp(path.resolve(localPath))} ${quoteSftp(windowsToSftp(remotePath))}\n`;
  const result = await run("sftp", args, { input, timeoutMs: 15000 });
  if (result.code !== 0) throw new CliError("UPLOAD_FAILED", result.stderr.trim() || "SFTP upload failed.");
  return result;
}

export async function sftpGet(target, endpoint, remotePath, localPath) {
  fs.mkdirSync(path.dirname(path.resolve(localPath)), { recursive: true });
  const args = ["-b", "-", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
  if (target.identity_file) args.push("-i", target.identity_file);
  if (endpoint.port) args.push("-P", String(endpoint.port));
  args.push(destination(target, endpoint));
  const input = `get ${quoteSftp(windowsToSftp(remotePath))} ${quoteSftp(path.resolve(localPath))}\n`;
  const result = await run("sftp", args, { input, timeoutMs: 15000 });
  if (result.code !== 0) throw new CliError("DOWNLOAD_FAILED", result.stderr.trim() || "SFTP download failed.");
  return result;
}

export function psLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}
