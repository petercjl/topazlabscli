import { spawn } from "node:child_process";
import { resolveExecutable } from "./runtime.mjs";

export function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const executable = resolveExecutable(command, { env: options.env || process.env });
    const child = spawn(executable.command, [...executable.argsPrefix, ...args], {
      cwd: options.cwd,
      env: { ...(options.env || process.env), ...(executable.envPatch || {}) },
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer = null;
    const finish = (value) => {
      if (timer) clearTimeout(timer);
      resolve({ ...value, resolvedCommand: executable.command, resolution: executable.resolution, timedOut });
    };
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish({ code: 127, signal: null, stdout, stderr: stderr || error.message, error: error.message }));
    child.on("close", (code, signal) => finish({ code, signal, stdout, stderr }));
    if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, options.timeoutMs);
      timer.unref?.();
    }
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    }
  });
}

export function runInherited(command, args, options = {}) {
  return new Promise((resolve) => {
    const executable = resolveExecutable(command, { env: options.env || process.env });
    const child = spawn(executable.command, [...executable.argsPrefix, ...args], {
      cwd: options.cwd,
      env: { ...(options.env || process.env), ...(executable.envPatch || {}) },
      stdio: "inherit",
      windowsHide: true
    });
    child.on("error", (error) => resolve({ code: 127, signal: null, error: error.message }));
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
}
