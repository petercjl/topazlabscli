import fs from "node:fs";
import path from "node:path";

function firstExisting(candidates, exists) {
  return candidates.find((candidate) => candidate && exists(candidate)) || null;
}

export function resolveExecutable(name, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const execPath = options.execPath || process.execPath;
  const exists = options.exists || fs.existsSync;
  const pathApi = platform === "win32" ? path.win32 : path;

  if (name === "node") {
    return { command: execPath, argsPrefix: [], resolution: "process.execPath" };
  }

  if (name === "npm") {
    if (env.TOPAZLABSCLI_NPM) {
      return { command: env.TOPAZLABSCLI_NPM, argsPrefix: [], resolution: "TOPAZLABSCLI_NPM" };
    }
    const npmExecPath = env.npm_execpath && pathApi.resolve(env.npm_execpath);
    const managedNpm = firstExisting([
      npmExecPath,
      pathApi.join(pathApi.dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js")
    ], exists);
    if (managedNpm) {
      const versionDirectory = pathApi.dirname(execPath);
      const versionsDirectory = pathApi.dirname(versionDirectory);
      const managedRoot = pathApi.basename(versionsDirectory).toLowerCase() === "versions"
        ? pathApi.dirname(versionsDirectory)
        : null;
      const managedPrefix = managedRoot && pathApi.join(managedRoot, "global");
      const managedCache = managedRoot && pathApi.join(managedRoot, "cache");
      const envPatch = managedPrefix && exists(managedPrefix)
        ? {
            npm_config_prefix: env.npm_config_prefix || managedPrefix,
            ...(managedCache && exists(managedCache) ? { npm_config_cache: env.npm_config_cache || managedCache } : {})
          }
        : {};
      return { command: execPath, argsPrefix: [managedNpm], envPatch, resolution: "managed-node-npm-cli" };
    }
  }

  if (platform === "win32" && ["ssh", "sftp"].includes(name)) {
    const override = env[`TOPAZLABSCLI_${name.toUpperCase()}`];
    if (override) return { command: override, argsPrefix: [], resolution: `TOPAZLABSCLI_${name.toUpperCase()}` };
    const windowsRoot = env.SystemRoot || env.WINDIR || "C:\\Windows";
    const openSsh = pathApi.join(windowsRoot, "System32", "OpenSSH", `${name}.exe`);
    if (exists(openSsh)) return { command: openSsh, argsPrefix: [], resolution: "windows-openssh" };
  }

  return { command: name, argsPrefix: [], resolution: "PATH" };
}
