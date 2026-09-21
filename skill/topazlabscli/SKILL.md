---
name: topazlabscli
description: Operate a configured remote Windows Topaz Video AI workstation through the stable topazlabscli CLI. Use for connection checks, Proteus model readiness, queued 480p-to-1080p enhancement jobs, status, download, cancellation, and installation diagnostics. Do not use for installing or licensing Topaz itself.
---

# TopazLabs CLI

Use the CLI as the single execution surface. Do not reproduce SSH, SFTP, queue, or Topaz FFmpeg commands manually when the CLI supports the operation.

## Input → Strategy → Output

- Input: a local video path or a job identifier, the user's requested action, and an already configured target. A processing request needs only the input path.
- Strategy: inspect capabilities and health, select the configured reachable endpoint, submit one deterministic preset to the serialized Windows queue, observe terminal state, and download only when requested.
- Output: structured CLI evidence, a job identifier and state, and for completed processing an explicitly requested local output file.

## Main Line

1. Resolve the CLI invocation once. Prefer `topazlabscli`. In a Windows SealSeek managed-copy installation, if the npm command shim cannot find `node`, read `.topazlabscli-runtime.json` beside this file and execute its `bin` with its `node`; the CLI creates and refreshes that local manifest. SealSeek-managed npm installs must retain its managed global prefix rather than writing into a Node version directory. Reuse the invocation for the rest of the task; do not disable automatic updates.
2. Run `topazlabscli capabilities --json` when the live contract is not already known.
3. Run `topazlabscli doctor --json` before the first job in a conversation or after a connection/model failure, and wait for its terminal result before continuing.
4. For a processing request, confirm the input exists. When the user does not name an output, let the CLI create `INPUT-BASENAME-topaz-1080p.EXT` beside the source.
5. Prefer `topazlabscli process INPUT --json` for submit, wait, and download as one operation. Add `--output OUTPUT` only when the user explicitly requests another destination. Use separate `job` commands when the user wants asynchronous control.
6. Inspect the final JSON. Completion requires `state=completed`, a successful download result, and a real local output file.
7. Report the selected target/endpoint, job ID, output path, preset/model, dimensions, and any warning or failure.

## Preset Boundary

`seedance-human-1080p` is the only built-in preset in version 0.2. It uses Proteus v4 (`prob-4`), preserves source FPS and aspect ratio, targets a 1080-pixel short edge, and relies on the remote queue's single concurrency slot. Do not silently substitute another model, frame interpolation, stabilization, motion deblur, or 4K output.

## Branches

- Connection failure: report `CONNECTION_FAILED` and the endpoint attempts. The CLI does not start, reconfigure, or grant access to a VPN.
- Worker/model not ready: run `worker status` or `model status`; stop with the returned dependency error. Installing/licensing Topaz and downloading models remain GUI administration tasks.
- Long-running work: use `job submit`, return the job ID, then `job wait` when the user asks to remain attached. Do not resubmit merely because a wait timed out.
- Cancellation: queued work may cancel immediately. A running task records a cancellation request but is not forcibly killed in version 0.2.
- Missing capability: return `CAPABILITY_UNAVAILABLE` or the CLI's structured error. Do not invent a platform-specific workaround.

## Configuration and Safety

Configuration, hostnames, addresses, usernames, SSH identities, VPN details, media, Topaz binaries, models, and credentials are external to this Skill and npm package. Installation does not grant access to a workstation. Treat the configured server and Topaz license as user-managed resources.

Before operational commands, the CLI performs a cached npm update check. It tries the user's current npm registry and then its built-in reachable-registry fallback without changing the user's global npm configuration. A newer stable package is installed from the same registry that answered the version check, installed Agent Skills are refreshed, and the original command resumes under the new version. The CLI resolves npm through the running Agent's Node installation when PATH is restricted. Registry, npm, and Skill-refresh failures produce a warning and continue with the installed version. Treat `doctor`'s `updates.registry` check as advisory; a failed update source does not make video processing unavailable.

Do not overwrite a local output unless the user has authorized that exact existing target. The remote worker retains job inputs, outputs, status, and logs for operator review; cleanup is an administrative action outside version 0.2.

## Skill Management

The npm package is the canonical source. Discover it with `topazlabscli skill source --json`; use `skill status`, `skill install`, and `skill update` for Codex and SealSeek targets. Windows SealSeek automatically receives a managed copy because its Skill loader rejects junctions that escape the workspace root; updates refresh that copy from the package. Do not edit installed links or copies as independent sources.

## QA and Evolution

Use `doctor --json` plus the final job status as runtime evidence. Do not leave health checks or job commands running without collecting their terminal result. New models, presets, cleanup rules, or worker behavior require an authorized package update with CLI, worker, Skill, capability, and test changes together.
