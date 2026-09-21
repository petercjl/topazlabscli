import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const worker = fs.readFileSync(path.resolve(import.meta.dirname, "..", "worker", "windows", "topazlabs-worker.ps1"), "utf8");

test("worker enforces the requested final resolution after Topaz inference", () => {
  assert.match(worker, /tvai_up=.*?,scale=w=\$\{targetWidth\}:h=\$\{targetHeight\}:flags=lanczos/);
});

test("worker supports default 1080p and optional QHD 2K output", () => {
  assert.match(worker, /seedance-human-1080p/);
  assert.match(worker, /seedance-human-1440p/);
  assert.match(worker, /\$shortEdge = 1080/);
  assert.match(worker, /\$shortEdge = 1440/);
  assert.match(worker, /-topaz-\$\{resolution\}\.mp4/);
});

test("worker records and applies Proteus automatic estimation", () => {
  assert.match(worker, /id = 'proteus-auto-v1'/);
  assert.match(worker, /estimate_frames = 20/);
  assert.match(worker, /estimate=20:blend=0\.2/);
});

test("worker keeps the SSH runner attached and returns structured terminal state", () => {
  assert.doesNotMatch(worker, /ValidateSet\([^\n]*'Start'/);
  assert.match(worker, /runner = 'attached-ssh'; state = 'already-running'/);
  assert.match(worker, /runner = 'attached-ssh'; state = 'idle'/);
});

test("worker converts abandoned running jobs into structured failures", () => {
  assert.match(worker, /error_code = 'WORKER_LOST'/);
  assert.match(worker, /Repair-StaleJobs/);
});
