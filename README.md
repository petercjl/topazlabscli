# topazlabscli

`topazlabscli` is an npm-distributed CLI and portable Agent Skill for sending video-enhancement jobs to an authorized Windows workstation running Topaz Video AI. It uses the workstation's existing SSH service, Topaz installation, GPU, models, and license. Nothing in this package installs, redistributes, licenses, or unlocks Topaz software.

## Requirements

- Client: Node.js 20+, OpenSSH `ssh` and `sftp`.
- Worker: Windows, OpenSSH Server, Topaz Video AI with its bundled FFmpeg/FFprobe, a logged-in licensed user, and downloaded model files.
- Network access is configured separately. Each endpoint is ordinary user configuration; the package does not contain or manage VPN settings.

## Install

```powershell
npm install --global @petercjl/topazlabscli
topazlabscli skill install --agent all
```

The CLI checks npm for a newer stable release before operational commands, at most once every six hours. It first uses the registry already configured for npm and automatically tries `https://registry.npmmirror.com/` if that registry is unavailable. The successful registry is used to download the complete update tarball before the installed version is touched, without changing the user's `.npmrc`. When an update is available the CLI upgrades itself from that local tarball, refreshes installed Agent Skills, and then resumes the original command. It discovers npm through the running Node installation, preserves SealSeek's managed global prefix/cache, and discovers Windows OpenSSH through the standard system location, so it also works in Agent runtimes with a restricted `PATH`. A temporary registry outage does not block video processing. `topazlabscli update` forces an immediate manual update.

On Windows, SealSeek Skills are installed into `%USERPROFILE%\.sealseek\workspace\skills` when that workspace is present. The CLI automatically uses a managed copy because SealSeek rejects junctions that resolve outside the workspace Skill root; subsequent CLI updates refresh the copy from the npm package. The copy includes a local runtime manifest so the Agent can invoke the canonical package even when its PATH is restricted. `SEALSEEK_SKILLS_HOME` remains available as an explicit override.

## Configure a target

Use one or more SSH endpoints in priority order. A LAN-only user configures only the LAN entry.

```powershell
topazlabscli target add gpu-workstation `
  --endpoint lan=gpu-workstation `
  --user Administrator `
  --identity "$HOME\.ssh\gpu_workstation_ed25519" `
  --workspace "E:\topazlab_workspace" `
  --default
```

An authorized roaming user can add a second endpoint that resolves through their own VPN configuration:

```powershell
topazlabscli target add gpu-workstation `
  --endpoint lan=gpu-workstation `
  --endpoint vpn=gpu-workstation-vpn `
  --user Administrator `
  --identity "$HOME\.ssh\gpu_workstation_ed25519" `
  --workspace "E:\topazlab_workspace" `
  --default
```

The CLI tries endpoints in the order provided. It never starts or changes a VPN.

## Set up and check the worker

```powershell
topazlabscli connection check --json
topazlabscli worker install --json
topazlabscli doctor --json
topazlabscli model status --json
```

The worker uses a global Windows mutex and one queue consumer, so jobs from multiple clients run serially.

## Process a video

```powershell
topazlabscli process .\input.mp4 --json
```

Without `--output`, the CLI writes `input-topaz-1080p.mp4` beside the source video. An explicit `--output` remains available for automation.

Asynchronous form:

```powershell
topazlabscli job submit .\input.mp4 --json
topazlabscli job status JOB_ID --json
topazlabscli job wait JOB_ID --json
topazlabscli job download JOB_ID --output .\output-1080p.mp4 --json
```

Version 0.2 includes one preset: `seedance-human-1080p`, using Proteus v4 (`prob-4`), source FPS, aspect-preserving 1080p output, and NVIDIA H.264 encoding.

## Configuration

Configuration is stored outside the package:

- Windows: `%APPDATA%\topazlabscli\config.json`
- macOS/Linux: `${XDG_CONFIG_HOME:-~/.config}/topazlabscli/config.json`
- Override for testing or automation: `TOPAZLABSCLI_CONFIG`

Update registry selection is CLI-local. `settings set update-registry <url>` sets a preferred registry, and `settings set update-registry auto` restores automatic selection. `TOPAZLABSCLI_UPDATE_REGISTRY` can provide one or more comma-separated preferred registries for managed environments.

Do not publish configuration files, keys, internal addresses, media, Topaz model files, or authentication data.
