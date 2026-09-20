import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const worker = fs.readFileSync(path.resolve(import.meta.dirname, "..", "worker", "windows", "topazlabs-worker.ps1"), "utf8");

test("worker enforces the requested final resolution after Topaz inference", () => {
  assert.match(worker, /tvai_up=.*?,scale=w=\$\{targetWidth\}:h=\$\{targetHeight\}:flags=lanczos/);
});
