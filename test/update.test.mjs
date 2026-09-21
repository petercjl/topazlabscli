import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isNewerVersion, maybeAutoUpdate } from "../src/update.mjs";

test("semantic release comparison detects newer stable versions", () => {
  assert.equal(isNewerVersion("0.2.0", "0.1.1"), true);
  assert.equal(isNewerVersion("0.1.1", "0.1.1"), false);
  assert.equal(isNewerVersion("0.1.0", "0.1.1"), false);
});

test("automatic update installs latest, refreshes skills, and reexecutes once", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "topazlabscli-update-"));
  const calls = [];
  const refreshed = [];
  const result = await maybeAutoUpdate(["doctor", "--json"], { name: "@example/topaz", version: "0.1.1" }, {
    env: {},
    stateFile: path.join(temporary, "state.json"),
    loadConfig: () => ({ settings: { auto_update: true, update_check_hours: 6 } }),
    run: async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "config") return { code: 0, stdout: "https://registry.npmjs.org/\n", stderr: "" };
      if (args[0] === "view") return { code: 0, stdout: '"0.2.0"\n', stderr: "" };
      if (args[0] === "pack") return { code: 0, stdout: '[{"filename":"example-topaz-0.2.0.tgz"}]\n', stderr: "" };
      return { code: 0, stdout: "updated", stderr: "" };
    },
    skillStatus: () => [{ agent: "sealseek", installed: true, mode: "copy" }],
    skillInstall: (...args) => refreshed.push(args),
    runInherited: async () => ({ code: 0 })
  });
  assert.equal(result.updated, true);
  assert.equal(result.registry, "https://registry.npmjs.org/");
  assert.deepEqual(calls[2], ["npm", "pack", "@example/topaz@0.2.0", "--json", "--pack-destination", calls[2][5], "--registry", "https://registry.npmjs.org/"]);
  assert.deepEqual(calls[3].slice(0, 3), ["npm", "install", "--global"]);
  assert.match(calls[3][3], /example-topaz-0\.2\.0\.tgz$/);
  assert.deepEqual(refreshed, [["sealseek", "copy", true]]);
  assert.equal(result.exitCode, 0);
});

test("automatic update falls back to mirror and installs from the same registry", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "topazlabscli-update-mirror-"));
  const calls = [];
  const result = await maybeAutoUpdate(["doctor"], { name: "@example/topaz", version: "0.1.1" }, {
    env: {},
    stateFile: path.join(temporary, "state.json"),
    loadConfig: () => ({ settings: { auto_update: true, update_check_hours: 6, update_registry: "auto" } }),
    run: async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "config") return { code: 0, stdout: "https://registry.npmjs.org/\n", stderr: "" };
      if (args[0] === "view" && args.at(-1) === "https://registry.npmjs.org/") {
        return { code: 1, stdout: "", stderr: "network timeout", timedOut: true };
      }
      if (args[0] === "view") return { code: 0, stdout: '"0.2.0"\n', stderr: "" };
      if (args[0] === "pack") return { code: 0, stdout: '[{"filename":"example-topaz-0.2.0.tgz"}]\n', stderr: "" };
      return { code: 0, stdout: "updated", stderr: "" };
    },
    skillStatus: () => [],
    runInherited: async () => ({ code: 0 })
  });
  assert.equal(result.registry, "https://registry.npmmirror.com/");
  const packCall = calls.find((call) => call[1] === "pack");
  assert.equal(packCall.at(-1), "https://registry.npmmirror.com/");
  assert.deepEqual(calls.at(-1).slice(0, 3), ["npm", "install", "--global"]);
});

test("failed update download leaves the installed package untouched", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "topazlabscli-update-stage-fail-"));
  const calls = [];
  const result = await maybeAutoUpdate(["doctor"], { name: "@example/topaz", version: "0.1.1" }, {
    env: {},
    stateFile: path.join(temporary, "state.json"),
    registries: ["https://registry.example.test/"],
    loadConfig: () => ({ settings: { auto_update: true, update_check_hours: 6 } }),
    run: async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "view") return { code: 0, stdout: '"0.2.0"\n', stderr: "" };
      if (args[0] === "pack") return { code: 1, stdout: "", stderr: "download failed" };
      throw new Error("install must not run after a failed download");
    }
  });
  assert.equal(result.warning, "download failed");
  assert.equal(calls.some((call) => call[1] === "install"), false);
});

test("legacy update cache without a registry is refreshed immediately", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "topazlabscli-update-cache-"));
  const stateFile = path.join(temporary, "state.json");
  fs.writeFileSync(stateFile, JSON.stringify({ last_checked_at: Date.now(), latest: "0.2.2", current: "0.2.2" }));
  let views = 0;
  const result = await maybeAutoUpdate(["doctor"], { name: "@example/topaz", version: "0.2.3" }, {
    env: {},
    stateFile,
    registries: ["https://registry.example.test/"],
    loadConfig: () => ({ settings: { auto_update: true, update_check_hours: 6 } }),
    run: async () => {
      views += 1;
      return { code: 0, stdout: '"0.2.3"\n', stderr: "" };
    }
  });
  assert.equal(views, 1);
  assert.equal(result.registry, "https://registry.example.test/");
});

test("registry failure warns without blocking the command", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "topazlabscli-update-fail-"));
  const result = await maybeAutoUpdate(["doctor"], { name: "@example/topaz", version: "0.1.1" }, {
    env: {},
    stateFile: path.join(temporary, "state.json"),
    loadConfig: () => ({ settings: { auto_update: true, update_check_hours: 6 } }),
    run: async () => ({ code: 1, stdout: "", stderr: "offline" })
  });
  assert.match(result.warning, /Unable to check npm for updates/);
  assert.match(result.warning, /registry\.npmmirror\.com/);
  assert.equal(result.updated, undefined);
});

test("missing npm warns without blocking the command", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "topazlabscli-update-missing-"));
  const result = await maybeAutoUpdate(["doctor"], { name: "@example/topaz", version: "0.1.1" }, {
    env: {},
    stateFile: path.join(temporary, "state.json"),
    loadConfig: () => ({ settings: { auto_update: true, update_check_hours: 6 } }),
    run: async () => { throw new Error("spawn npm ENOENT"); }
  });
  assert.match(result.warning, /spawn npm ENOENT/);
  assert.equal(result.updated, undefined);
});

test("registry selection never writes npm configuration", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "topazlabscli-update-readonly-"));
  const calls = [];
  await maybeAutoUpdate(["doctor"], { name: "@example/topaz", version: "0.2.2" }, {
    env: {},
    stateFile: path.join(temporary, "state.json"),
    loadConfig: () => ({ settings: { auto_update: true, update_check_hours: 6, update_registry: "auto" } }),
    run: async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "config") return { code: 0, stdout: "https://registry.npmjs.org/\n", stderr: "" };
      return { code: 0, stdout: '"0.2.2"\n', stderr: "" };
    }
  });
  assert.equal(calls.some((call) => call[1] === "config" && call[2] === "set"), false);
});
