import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { run } from "../src/process.mjs";
import { resolveExecutable } from "../src/runtime.mjs";
import { skillTarget } from "../src/paths.mjs";
import { effectiveSkillMode } from "../src/skill.mjs";

test("Windows SealSeek resolves npm through its managed Node runtime", () => {
  const execPath = "C:\\Users\\employee\\.sealseek\\binaries\\node\\versions\\22.22.2\\node.exe";
  const npmCli = path.win32.join(path.win32.dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const prefix = "C:\\Users\\employee\\.sealseek\\binaries\\node\\global";
  const cache = "C:\\Users\\employee\\.sealseek\\binaries\\node\\cache";
  const result = resolveExecutable("npm", {
    platform: "win32",
    execPath,
    env: {},
    exists: (candidate) => [npmCli, prefix, cache].includes(candidate)
  });
  assert.equal(result.command, execPath);
  assert.deepEqual(result.argsPrefix, [npmCli]);
  assert.equal(result.resolution, "managed-node-npm-cli");
  assert.deepEqual(result.envPatch, { npm_config_prefix: prefix, npm_config_cache: cache });
});

test("Windows resolves OpenSSH outside a sanitized PATH", () => {
  const expected = "D:\\Windows\\System32\\OpenSSH\\ssh.exe";
  const result = resolveExecutable("ssh", {
    platform: "win32",
    env: { SystemRoot: "D:\\Windows" },
    exists: (candidate) => candidate === expected
  });
  assert.equal(result.command, expected);
  assert.equal(result.resolution, "windows-openssh");
});

test("Windows SealSeek Skill target uses the active workspace", () => {
  const home = "C:\\Users\\employee";
  const workspace = path.win32.join(home, ".sealseek", "workspace");
  const target = skillTarget("sealseek", {
    platform: "win32",
    home,
    env: {},
    exists: (candidate) => candidate === workspace
  });
  assert.equal(target, path.win32.join(home, ".sealseek", "workspace", "skills", "topazlabscli"));
});

test("Windows SealSeek installs a managed copy instead of an escaped junction", () => {
  assert.equal(effectiveSkillMode("sealseek", "link", "win32"), "copy");
  assert.equal(effectiveSkillMode("codex", "link", "win32"), "link");
  assert.equal(effectiveSkillMode("sealseek", "link", "darwin"), "link");
});

test("missing executables return a structured process result", async () => {
  const result = await run("topazlabscli-command-that-does-not-exist", []);
  assert.equal(result.code, 127);
  assert.match(result.stderr, /ENOENT|not found/i);
});

test("process execution has a hard timeout", async () => {
  const result = await run("node", ["-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 50 });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
});
