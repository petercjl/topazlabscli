param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Install', 'Status', 'Prepare', 'Enqueue', 'Run', 'JobStatus', 'ListJobs', 'Cancel')]
  [string]$Action,
  [Parameter(Mandatory = $true)]
  [string]$Root,
  [string]$PayloadBase64
)

$ErrorActionPreference = 'Stop'
$WorkerVersion = '0.3.0'
$StateRoot = Join-Path $Root '.topazlabscli'
$QueueRoot = Join-Path $StateRoot 'queue'
$JobsRoot = Join-Path $StateRoot 'jobs'
$WorkerRoot = Join-Path $StateRoot 'worker'
$ConfigPath = Join-Path $StateRoot 'worker-config.json'
$RunnerStatePath = Join-Path $StateRoot 'runner.json'

function Write-Json($Value) {
  [Console]::Out.Write(($Value | ConvertTo-Json -Depth 8 -Compress))
}

function Read-Payload {
  if ([string]::IsNullOrWhiteSpace($PayloadBase64)) { return @{} }
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadBase64))
  return $json | ConvertFrom-Json
}

function Ensure-Directories {
  @($StateRoot, $QueueRoot, $JobsRoot, $WorkerRoot) | ForEach-Object {
    New-Item -ItemType Directory -Force -Path $_ | Out-Null
  }
}

function Assert-SafeName([string]$Value, [string]$Field) {
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch '^[A-Za-z0-9._-]+$') {
    throw "Invalid $Field."
  }
}

function Read-WorkerConfig {
  if (-not (Test-Path -LiteralPath $ConfigPath)) { throw 'Worker is not installed.' }
  return Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json
}

function Job-Directory([string]$Id) {
  Assert-SafeName $Id 'job id'
  return Join-Path $JobsRoot $Id
}

function Status-Path([string]$Id) {
  return Join-Path (Job-Directory $Id) 'status.json'
}

function Set-JobStatus([string]$Id, [hashtable]$Values) {
  $path = Status-Path $Id
  $current = @{}
  if (Test-Path -LiteralPath $path) {
    $existing = Get-Content -Raw -LiteralPath $path | ConvertFrom-Json
    $existing.PSObject.Properties | ForEach-Object { $current[$_.Name] = $_.Value }
  }
  $Values.Keys | ForEach-Object { $current[$_] = $Values[$_] }
  $current['id'] = $Id
  $current['updated_at'] = (Get-Date).ToUniversalTime().ToString('o')
  $temporary = "$path.tmp"
  $current | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporary -Encoding UTF8
  Move-Item -Force -LiteralPath $temporary -Destination $path
  return $current
}

function Get-ModelStatus($Config) {
  $definition = Join-Path $Config.model_dir 'prob-4.json'
  $weights = @(Get-ChildItem -LiteralPath $Config.model_data_dir -Filter 'prob-v4-*.tz' -ErrorAction SilentlyContinue)
  return @{
    model_ready = ((Test-Path -LiteralPath $definition) -and $weights.Count -gt 0)
    model_definitions = @{ path = $definition; exists = (Test-Path -LiteralPath $definition) }
    model_weights = @{ path = $Config.model_data_dir; count = $weights.Count }
  }
}

function Test-JobProcessActive([string]$Id) {
  $escaped = [Regex]::Escape($Id)
  return $null -ne (Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -match '^(ffmpeg|ffprobe)\.exe$' -and $_.CommandLine -match $escaped
  } | Select-Object -First 1)
}

function Test-RunnerProcessActive {
  if (-not (Test-Path -LiteralPath $RunnerStatePath)) { return $false }
  try {
    $runner = Get-Content -Raw -LiteralPath $RunnerStatePath | ConvertFrom-Json
    $process = Get-Process -Id ([int]$runner.pid) -ErrorAction SilentlyContinue
    return ($null -ne $process -and $process.ProcessName -eq 'powershell')
  } catch { return $false }
}

function Repair-StaleJobs {
  if (Test-RunnerProcessActive) { return }
  Get-ChildItem -LiteralPath $JobsRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $statusPath = Join-Path $_.FullName 'status.json'
    if (-not (Test-Path -LiteralPath $statusPath)) { return }
    $status = Get-Content -Raw -LiteralPath $statusPath | ConvertFrom-Json
    if ($status.state -eq 'running' -and -not (Test-JobProcessActive ([string]$status.id))) {
      Set-JobStatus ([string]$status.id) @{ state = 'failed'; completed_at = (Get-Date).ToUniversalTime().ToString('o'); error_code = 'WORKER_LOST'; error = 'The remote queue runner exited before the job completed. Resubmit the job.' } | Out-Null
    }
  }
}

function Invoke-Job($Job, $Config) {
  $id = [string]$Job.id
  $jobDir = Job-Directory $id
  $inputPath = Join-Path (Join-Path $jobDir 'input') ([string]$Job.input_name)
  $outputDir = Join-Path $jobDir 'output'
  $preset = [string]$Job.preset
  if ($preset -eq 'seedance-human-1080p') {
    $shortEdge = 1080
    $resolution = '1080p'
  } elseif ($preset -eq 'seedance-human-1440p') {
    $shortEdge = 1440
    $resolution = '2k'
  } else {
    throw 'Unsupported preset.'
  }
  $outputName = ([IO.Path]::GetFileNameWithoutExtension([string]$Job.input_name)) + "-topaz-${resolution}.mp4"
  $outputPath = Join-Path $outputDir $outputName
  $logPath = Join-Path (Join-Path $jobDir 'logs') 'topaz-ffmpeg.log'
  if (-not (Test-Path -LiteralPath $inputPath)) { throw "Input file is missing: $inputPath" }
  if (-not (Test-Path -LiteralPath $Config.ffmpeg)) { throw "Topaz ffmpeg is missing: $($Config.ffmpeg)" }

  $tuning = @{ id = 'proteus-auto-v1'; method = 'topaz-proteus-estimate'; estimate_frames = 20; recover_original_detail = 0.2; relative_offsets = @{ preblur = 0; noise = 0; details = 0; halo = 0; blur = 0; compression = 0 } }
  Set-JobStatus $id @{ state = 'running'; started_at = (Get-Date).ToUniversalTime().ToString('o'); input_path = $inputPath; output_path = $outputPath; output_name = $outputName; preset = $preset; resolution = $resolution; tuning = $tuning } | Out-Null
  $width = [int]$Job.source_width
  $height = [int]$Job.source_height
  if ($width -le 0 -or $height -le 0) { throw 'Source dimensions are missing from the queued job.' }
  if ($width -ge $height) {
    $targetHeight = $shortEdge
    $targetWidth = [int](2 * [Math]::Round(([double]$shortEdge * $width / $height) / 2.0))
  } else {
    $targetWidth = $shortEdge
    $targetHeight = [int](2 * [Math]::Round(([double]$shortEdge * $height / $width) / 2.0))
  }
  $env:TVAI_MODEL_DIR = [string]$Config.model_dir
  $env:TVAI_MODEL_DATA_DIR = [string]$Config.model_data_dir
  $filter = "tvai_up=model=prob-4:scale=0:w=${targetWidth}:h=${targetHeight}:preblur=0:noise=0:details=0:halo=0:blur=0:compression=0:estimate=20:blend=0.2:device=0:vram=1:instances=1,scale=w=${targetWidth}:h=${targetHeight}:flags=lanczos"
  $arguments = @(
    '-hide_banner', '-nostdin', '-y', '-strict', '2', '-i', $inputPath,
    '-sws_flags', 'spline+accurate_rnd+full_chroma_int', '-vf', $filter,
    '-map', '0:v:0', '-map', '0:a?', '-map_metadata', '0',
    '-c:v', 'h264_nvenc', '-preset', 'p5', '-cq', '18', '-b:v', '0', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-fps_mode', 'passthrough', '-movflags', '+faststart', $outputPath
  )
  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & $Config.ffmpeg @arguments 2>&1 | Tee-Object -FilePath $logPath | Out-Null
  $exit = $LASTEXITCODE
  $ErrorActionPreference = $oldPreference
  if ($exit -ne 0 -or -not (Test-Path -LiteralPath $outputPath)) { throw "Topaz ffmpeg failed with exit code $exit. See $logPath" }
  $size = (Get-Item -LiteralPath $outputPath).Length
  Set-JobStatus $id @{ state = 'completed'; completed_at = (Get-Date).ToUniversalTime().ToString('o'); output_path = $outputPath; output_name = $outputName; output_bytes = $size; width = $targetWidth; height = $targetHeight; model = 'prob-4'; preset = $preset; resolution = $resolution; tuning = $tuning } | Out-Null
}

Ensure-Directories

switch ($Action) {
  'Install' {
    if (-not (Test-Path -LiteralPath $ConfigPath)) {
      $config = @{
        schema_version = 1
        worker_version = $WorkerVersion
        ffmpeg = 'C:\Program Files\Topaz Labs LLC\Topaz Video AI\ffmpeg.exe'
        ffprobe = 'C:\Program Files\Topaz Labs LLC\Topaz Video AI\ffprobe.exe'
        model_dir = 'C:\ProgramData\Topaz Labs LLC\Topaz Video AI\models'
        model_data_dir = 'E:\topazlabs_model'
        concurrency = 1
      }
      $config | ConvertTo-Json | Set-Content -LiteralPath $ConfigPath -Encoding UTF8
    }
    $current = Read-WorkerConfig
    $current.worker_version = $WorkerVersion
    $current | ConvertTo-Json | Set-Content -LiteralPath $ConfigPath -Encoding UTF8
    Repair-StaleJobs
    $model = Get-ModelStatus $current
    Write-Json @{ ok = $true; installed = $true; worker_version = $WorkerVersion; root = $Root; runner = 'attached-ssh'; model_ready = $model.model_ready }
  }
  'Status' {
    $installed = Test-Path -LiteralPath $ConfigPath
    if (-not $installed) { Write-Json @{ ok = $true; installed = $false; root = $Root }; break }
    $config = Read-WorkerConfig
    $model = Get-ModelStatus $config
    $queued = @(Get-ChildItem -LiteralPath $QueueRoot -Filter '*.json' -ErrorAction SilentlyContinue).Count
    Write-Json @{ ok = $true; installed = $true; worker_version = $config.worker_version; root = $Root; concurrency = $config.concurrency; queued = $queued; ffmpeg = @{ path = $config.ffmpeg; exists = (Test-Path -LiteralPath $config.ffmpeg) }; ffprobe = @{ path = $config.ffprobe; exists = (Test-Path -LiteralPath $config.ffprobe) }; model_ready = $model.model_ready; model_definitions = $model.model_definitions; model_weights = $model.model_weights }
  }
  'Prepare' {
    $payload = Read-Payload
    $id = [string]$payload.id
    $name = [string]$payload.input_name
    Assert-SafeName $id 'job id'
    Assert-SafeName $name 'input name'
    $jobDir = Job-Directory $id
    @('input', 'output', 'logs') | ForEach-Object { New-Item -ItemType Directory -Force -Path (Join-Path $jobDir $_) | Out-Null }
    $inputPath = Join-Path (Join-Path $jobDir 'input') $name
    Set-JobStatus $id @{ state = 'uploading'; input_name = $name; input_path = $inputPath } | Out-Null
    Write-Json @{ ok = $true; id = $id; input_path = $inputPath }
  }
  'Enqueue' {
    $payload = Read-Payload
    $id = [string]$payload.id
    Assert-SafeName $id 'job id'
    Assert-SafeName ([string]$payload.input_name) 'input name'
    if (@('seedance-human-1080p', 'seedance-human-1440p') -notcontains [string]$payload.preset) { throw 'Unsupported preset.' }
    $queuePath = Join-Path $QueueRoot "$id.json"
    $payload | ConvertTo-Json | Set-Content -LiteralPath "$queuePath.tmp" -Encoding UTF8
    Move-Item -Force -LiteralPath "$queuePath.tmp" -Destination $queuePath
    $resolution = if ($payload.preset -eq 'seedance-human-1440p') { '2k' } else { '1080p' }
    Set-JobStatus $id @{ state = 'queued'; queued_at = (Get-Date).ToUniversalTime().ToString('o'); preset = $payload.preset; resolution = $resolution; tuning = @{ id = 'proteus-auto-v1'; method = 'topaz-proteus-estimate'; estimate_frames = 20 } } | Out-Null
    Write-Json @{ ok = $true; id = $id; state = 'queued' }
  }
  'Run' {
    $created = $false
    $mutex = New-Object Threading.Mutex($true, 'Global\TopazLabsCliQueue', [ref]$created)
    if (-not $created) { Write-Json @{ ok = $true; runner = 'attached-ssh'; state = 'already-running' }; exit 0 }
    try {
      @{ pid = $PID; started_at = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $RunnerStatePath -Encoding UTF8
      $config = Read-WorkerConfig
      while ($true) {
        $next = Get-ChildItem -LiteralPath $QueueRoot -Filter '*.json' | Sort-Object CreationTimeUtc, Name | Select-Object -First 1
        if ($null -eq $next) {
          Start-Sleep -Seconds 2
          $next = Get-ChildItem -LiteralPath $QueueRoot -Filter '*.json' | Sort-Object CreationTimeUtc, Name | Select-Object -First 1
          if ($null -eq $next) { break }
        }
        $job = Get-Content -Raw -LiteralPath $next.FullName | ConvertFrom-Json
        Remove-Item -Force -LiteralPath $next.FullName
        $cancelPath = Join-Path (Job-Directory ([string]$job.id)) 'cancel.requested'
        if (Test-Path -LiteralPath $cancelPath) {
          Set-JobStatus ([string]$job.id) @{ state = 'cancelled'; completed_at = (Get-Date).ToUniversalTime().ToString('o') } | Out-Null
          continue
        }
        try { Invoke-Job $job $config }
        catch {
          Set-JobStatus ([string]$job.id) @{ state = 'failed'; completed_at = (Get-Date).ToUniversalTime().ToString('o'); error = $_.Exception.Message } | Out-Null
        }
      }
    } finally {
      Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $RunnerStatePath
      $mutex.ReleaseMutex()
      $mutex.Dispose()
    }
    Write-Json @{ ok = $true; runner = 'attached-ssh'; state = 'idle' }
  }
  'JobStatus' {
    $payload = Read-Payload
    $path = Status-Path ([string]$payload.id)
    if (-not (Test-Path -LiteralPath $path)) { throw 'Job not found.' }
    Repair-StaleJobs
    [Console]::Out.Write((Get-Content -Raw -LiteralPath $path).Trim())
  }
  'ListJobs' {
    $items = @()
    Get-ChildItem -LiteralPath $JobsRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      $path = Join-Path $_.FullName 'status.json'
      if (Test-Path -LiteralPath $path) {
        $items += (Get-Content -Raw -LiteralPath $path | ConvertFrom-Json)
      }
    }
    $items = @($items | Sort-Object updated_at -Descending)
    Write-Json @{ ok = $true; jobs = $items }
  }
  'Cancel' {
    $payload = Read-Payload
    $id = [string]$payload.id
    $statusPath = Status-Path $id
    if (-not (Test-Path -LiteralPath $statusPath)) { throw 'Job not found.' }
    $status = Get-Content -Raw -LiteralPath $statusPath | ConvertFrom-Json
    if ($status.state -eq 'running') {
      New-Item -ItemType File -Force -Path (Join-Path (Job-Directory $id) 'cancel.requested') | Out-Null
      Set-JobStatus $id @{ cancel_requested = $true } | Out-Null
      Write-Json @{ ok = $true; id = $id; state = 'running'; cancel_requested = $true; note = 'The current ffmpeg process is not forcibly terminated.' }
    } elseif ($status.state -eq 'queued' -or $status.state -eq 'uploading') {
      Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath (Join-Path $QueueRoot "$id.json")
      Set-JobStatus $id @{ state = 'cancelled'; completed_at = (Get-Date).ToUniversalTime().ToString('o') } | Out-Null
      Write-Json @{ ok = $true; id = $id; state = 'cancelled' }
    } else {
      Write-Json @{ ok = $true; id = $id; state = $status.state; changed = $false }
    }
  }
}
