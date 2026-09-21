import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const worker = fs.readFileSync(path.resolve(import.meta.dirname, "..", "worker", "windows", "topazlabs-worker.ps1"), "utf8");

test("worker enforces the requested final resolution after Topaz inference", () => {
  assert.match(worker, /tvai_up=.*?,scale=w=\$\{Width\}:h=\$\{Height\}:flags=lanczos/);
});

test("worker supports default 1080p and optional QHD 2K output", () => {
  assert.match(worker, /seedance-human-1080p/);
  assert.match(worker, /seedance-human-1440p/);
  assert.match(worker, /\$shortEdge = 1080/);
  assert.match(worker, /\$shortEdge = 1440/);
  assert.match(worker, /-topaz-\$\{suffix\}\.mp4/);
});

test("worker records and applies Proteus automatic estimation", () => {
  assert.match(worker, /id = 'proteus-auto-v1'/);
  assert.match(worker, /estimate_frames = 20/);
  assert.match(worker, /New-TopazFilter/);
  assert.match(worker, /recover_original_detail = 0\.2/);
});

test("worker keeps advanced tuning non-default and profile-bound", () => {
  assert.match(worker, /'preview', 'advanced-full'/);
  assert.match(worker, /Get-TuningProfile/);
  assert.match(worker, /proteus-advanced-v1\.json/);
  assert.match(worker, /topaz-proteus-relative-to-auto/);
  assert.doesNotMatch(worker, /payload\.relative_offsets/);
});

test("worker creates source, default, candidate, and side-by-side evidence", () => {
  assert.match(worker, /source-samples\.mp4/);
  assert.match(worker, /source-samples-lossless\.mkv/);
  assert.match(worker, /'-c:v', 'ffv1'/);
  assert.match(worker, /source-contact-sheet\.jpg/);
  assert.match(worker, /default-auto\.mp4/);
  assert.match(worker, /candidate-\$\(\[string\]\$Job\.tuning_profile\)\.mp4/);
  assert.match(worker, /comparison-contact-sheet\.jpg/);
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
