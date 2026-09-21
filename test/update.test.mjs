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
      if (args[0] === "view") return { code: 0, stdout: '"0.2.0"\n', stderr: "" };
      return { code: 0, stdout: "updated", stderr: "" };
    },
    skillStatus: () => [{ agent: "sealseek", installed: true, mode: "copy" }],
    skillInstall: (...args) => refreshed.push(args),
    runInherited: async () => ({ code: 0 })
  });
  assert.equal(result.updated, true);
  assert.deepEqual(calls[1], ["npm", "install", "--global", "@example/topaz@latest"]);
  assert.deepEqual(refreshed, [["sealseek", "copy", true]]);
  assert.equal(result.exitCode, 0);
});

test("registry failure warns without blocking the command", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "topazlabscli-update-fail-"));
  const result = await maybeAutoUpdate(["doctor"], { name: "@example/topaz", version: "0.1.1" }, {
    env: {},
    stateFile: path.join(temporary, "state.json"),
    loadConfig: () => ({ settings: { auto_update: true, update_check_hours: 6 } }),
    run: async () => ({ code: 1, stdout: "", stderr: "offline" })
  });
  assert.equal(result.warning, "offline");
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
