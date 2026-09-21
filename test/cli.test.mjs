import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { defaultOutputPath } from "../src/cli.mjs";
import { probeMp4Dimensions } from "../src/media.mjs";

const root = path.resolve(import.meta.dirname, "..");
const bin = path.join(root, "bin", "topazlabscli.mjs");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

function cli(args, env = {}) {
  return spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", env: { ...process.env, TOPAZLABSCLI_AUTO_UPDATE: "off", ...env } });
}

test("version and capabilities are machine-readable", () => {
  const version = cli(["version"]);
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), pkg.version);
  const result = cli(["capabilities", "--json"]);
  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.presets[0].model, "prob-4");
});

test("target configuration preserves endpoint order", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "topazlabscli-test-"));
  const config = path.join(temporary, "config.json");
  const result = cli(["target", "add", "gpu", "--endpoint", "lan=gpu.local", "--endpoint", "vpn=gpu-vpn", "--user", "worker", "--default", "--json"], { TOPAZLABSCLI_CONFIG: config });
  assert.equal(result.status, 0, result.stderr);
  const stored = JSON.parse(fs.readFileSync(config, "utf8"));
  assert.deepEqual(stored.targets.gpu.endpoints.map((item) => item.name), ["lan", "vpn"]);
  if (process.platform !== "win32") assert.equal(fs.statSync(config).mode & 0o777, 0o600);
});

test("unknown command returns a structured error", () => {
  const result = cli(["nope", "--json"]);
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "COMMAND_UNKNOWN");
});

test("automatic update settings are persisted", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "topazlabscli-settings-"));
  const config = path.join(temporary, "config.json");
  const changed = cli(["settings", "set", "auto-update", "off", "--json"], { TOPAZLABSCLI_CONFIG: config });
  assert.equal(changed.status, 0, changed.stderr);
  const shown = cli(["settings", "show", "--json"], { TOPAZLABSCLI_CONFIG: config });
  assert.equal(JSON.parse(shown.stdout).data.auto_update, false);
  assert.equal(JSON.parse(shown.stdout).data.update_registry, "auto");
  const registry = cli(["settings", "set", "update-registry", "https://registry.example.test", "--json"], { TOPAZLABSCLI_CONFIG: config });
  assert.equal(registry.status, 0, registry.stderr);
  assert.equal(JSON.parse(registry.stdout).data.settings.update_registry, "https://registry.example.test");
});

test("process derives a predictable 1080p output path", () => {
  const result = defaultOutputPath(path.join("C:", "Videos", "input.mp4"));
  assert.equal(path.basename(result), "input-topaz-1080p.mp4");
});

test("processing uses an attached remote runner and worker version negotiation", () => {
  const source = fs.readFileSync(path.join(root, "src", "cli.mjs"), "utf8");
  assert.match(source, /const WORKER_VERSION = "0\.2\.0"/);
  assert.match(source, /await ensureWorker\(target, endpoint\)/);
  assert.match(source, /remoteAction\(target, endpoint, "Run", \{\}, \{ timeout: timeoutSeconds \}\)/);
  assert.doesNotMatch(source, /startPowerShellDetached\(target, endpoint/);
});

test("MP4 dimensions are read without invoking a remote ffprobe process", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "topazlabscli-mp4-"));
  const target = path.join(temporary, "sample.mp4");
  const box = (type, payload) => {
    const result = Buffer.alloc(8 + payload.length);
    result.writeUInt32BE(result.length, 0);
    result.write(type, 4, 4, "ascii");
    payload.copy(result, 8);
    return result;
  };
  const tkhdPayload = Buffer.alloc(84);
  tkhdPayload.writeUInt32BE(854 * 65536, 76);
  tkhdPayload.writeUInt32BE(480 * 65536, 80);
  fs.writeFileSync(target, Buffer.concat([box("ftyp", Buffer.alloc(8)), box("moov", box("trak", box("tkhd", tkhdPayload))) ]));
  assert.deepEqual(probeMp4Dimensions(target), { width: 854, height: 480 });
});
