---
name: topazlabscli
description: Operate a configured remote Windows Topaz Video AI workstation through the stable topazlabscli CLI. Use for connection checks, Proteus model readiness, content-adaptive 1080p or optional QHD/2K enhancement jobs, status, download, cancellation, and installation diagnostics. Do not use for installing or licensing Topaz itself.
---

# TopazLabs CLI

Use the CLI as the single execution surface. Do not reproduce SSH, SFTP, queue, or Topaz FFmpeg commands manually when the CLI supports the operation.

## Input → Strategy → Output

- Input: a local video path or a job identifier, the user's requested action, and an already configured target. A processing request needs only the input path.
- Strategy: inspect capabilities and health, keep 1080p as the default unless the user explicitly requests 2K, delegate low-level Proteus tuning to the versioned automatic-estimation policy, submit the bounded preset to the serialized Windows queue, observe terminal state, and download only when requested.
- Output: structured CLI evidence, a job identifier and state, and for completed processing an explicitly requested local output file.

## Main Line

1. Resolve the CLI invocation once. Prefer `topazlabscli`. In a Windows SealSeek managed-copy installation, if the npm command shim cannot find `node`, read `.topazlabscli-runtime.json` beside this file and execute its `bin` with its `node`; the CLI creates and refreshes that local manifest. SealSeek-managed npm installs must retain its managed global prefix rather than writing into a Node version directory. Reuse the invocation for the rest of the task; do not disable automatic updates.
2. Run `topazlabscli capabilities --json` when the live contract is not already known.
3. Run `topazlabscli doctor --json` before the first job in a conversation or after a connection/model failure, and wait for its terminal result before continuing.
4. For a processing request, confirm the input exists. Use the default 1080p preset when the user simply asks to enhance or upscale. When the user explicitly asks for 2K, QHD, or 1440p, add `--resolution 2k`. With no explicit output path, let the CLI create `INPUT-BASENAME-topaz-1080p.EXT` or `INPUT-BASENAME-topaz-2k.EXT` beside the source.
5. Prefer `topazlabscli process INPUT --json` for default 1080p or `topazlabscli process INPUT --resolution 2k --json` for QHD/2K. Add `--output OUTPUT` only when the user explicitly requests another destination. Use separate `job` commands when the user wants asynchronous control.
6. Inspect the final JSON. Completion requires `state=completed`, a successful download result, and a real local output file.
7. Report the selected target/endpoint, job ID, output path, preset/model, dimensions, and any warning or failure.

## Resolution And Tuning Boundary

The built-in presets are `seedance-human-1080p` and `seedance-human-1440p`. The first is always the default. The second means QHD/2K with a 1440-pixel short edge, preserving orientation and aspect ratio. Both use Proteus v4 (`prob-4`), source FPS, and the single remote queue slot.

Both presets use `proteus-auto-v1`. Topaz automatically estimates its six Proteus controls from a 20-frame window; the CLI applies zero relative offsets and recovers 20% original detail. This is the content-adaptive default. Do not invent or inject raw filter values. A different tuning profile is unavailable until it has representative A/B evidence and is shipped through CLI capabilities.

Do not silently substitute another model, frame interpolation, stabilization, motion deblur, or 4K output.

## Branches

- Connection failure: report `CONNECTION_FAILED` and the endpoint attempts. The CLI does not start, reconfigure, or grant access to a VPN.
- Worker/model not ready: run `worker status` or `model status`; stop with the returned dependency error. Installing/licensing Topaz and downloading models remain GUI administration tasks.
- Long-running work: use `job submit`, return the job ID, then `job wait` when the user asks to remain attached. Do not resubmit merely because a wait timed out.
- Remote runner loss: `process` and `job wait` keep the queue runner attached through the active SSH command instead of relying on a detached client process. `job status` and `job wait` convert an abandoned `running` record into a terminal `WORKER_LOST` failure. Report it and resubmit only when the user requests another processing attempt.
- Cancellation: queued work may cancel immediately. A running task records a cancellation request but is not forcibly killed in version 0.2.
- Unsupported resolution or tuning: return the CLI's structured `RESOLUTION_UNSUPPORTED`, `PRESET_UNSUPPORTED`, or capability error. Do not approximate 2K with DCI 2048×1080 and do not invent a tuning profile.
- Missing capability: return `CAPABILITY_UNAVAILABLE` or the CLI's structured error. Do not invent a platform-specific workaround.

## Configuration and Safety

Configuration, hostnames, addresses, usernames, SSH identities, VPN details, media, Topaz binaries, models, and credentials are external to this Skill and npm package. Installation does not grant access to a workstation. Treat the configured server and Topaz license as user-managed resources.

Before submitting a job, the CLI compares the remote worker version with its bundled worker and upgrades the remote worker when required. Queue execution stays attached to the invoking CLI command; the Agent must wait for the command's terminal JSON result and must not background or abandon it.

Before operational commands, the CLI performs a cached npm update check. It tries the user's current npm registry and then its built-in reachable-registry fallback without changing the user's global npm configuration. The exact version returned by that check is fully downloaded from the same registry before the installed version is touched, then installed Agent Skills are refreshed and the original command resumes under the new version. The CLI resolves npm through the running Agent's Node installation when PATH is restricted. Registry, npm, and Skill-refresh failures produce a warning and continue with the installed version. Treat `doctor`'s `updates.registry` check as advisory; a failed update source does not make video processing unavailable.

Do not overwrite a local output unless the user has authorized that exact existing target. The remote worker retains job inputs, outputs, status, and logs for operator review; cleanup is an administrative action outside version 0.3.

## Skill Management

The npm package is the canonical source. Discover it with `topazlabscli skill source --json`; use `skill status`, `skill install`, and `skill update` for Codex and SealSeek targets. Windows SealSeek automatically receives a managed copy because its Skill loader rejects junctions that escape the workspace root; updates refresh that copy from the package. Do not edit installed links or copies as independent sources.

## QA and Evolution

Use `doctor --json` plus the final job status as runtime evidence. Confirm `resolution`, `preset`, `model`, and `tuning.id` in the completed result. Do not leave health checks or job commands running without collecting their terminal result. New models, tuning policies, presets, cleanup rules, or worker behavior require an authorized package update with CLI, worker, Skill, capability, and test changes together.
