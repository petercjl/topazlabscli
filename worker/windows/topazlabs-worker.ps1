param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Install', 'Status', 'Prepare', 'AnalysisPrepare', 'AnalysisRun', 'Enqueue', 'Run', 'JobStatus', 'ListJobs', 'Cancel')]
  [string]$Action,
  [Parameter(Mandatory = $true)]
  [string]$Root,
  [string]$PayloadBase64
)

$ErrorActionPreference = 'Stop'
$WorkerVersion = '0.4.0'
$StateRoot = Join-Path $Root '.topazlabscli'
$QueueRoot = Join-Path $StateRoot 'queue'
$JobsRoot = Join-Path $StateRoot 'jobs'
$AnalysesRoot = Join-Path $StateRoot 'analyses'
$WorkerRoot = Join-Path $StateRoot 'worker'
$ConfigPath = Join-Path $StateRoot 'worker-config.json'
$RunnerStatePath = Join-Path $StateRoot 'runner.json'
$TuningCatalogPath = Join-Path $WorkerRoot 'proteus-advanced-v1.json'

function Write-Json($Value) {
  [Console]::Out.Write(($Value | ConvertTo-Json -Depth 8 -Compress))
}

function Read-Payload {
  if ([string]::IsNullOrWhiteSpace($PayloadBase64)) { return @{} }
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadBase64))
  return $json | ConvertFrom-Json
}

function Ensure-Directories {
  @($StateRoot, $QueueRoot, $JobsRoot, $AnalysesRoot, $WorkerRoot) | ForEach-Object {
    New-Item -ItemType Directory -Force -Path $_ | Out-Null
  }
}

function Analysis-Directory([string]$Id) {
  Assert-SafeName $Id 'analysis id'
  return Join-Path $AnalysesRoot $Id
}

function Read-TuningCatalog {
  if (-not (Test-Path -LiteralPath $TuningCatalogPath)) { throw 'Advanced tuning catalog is missing.' }
  $catalog = Get-Content -Raw -LiteralPath $TuningCatalogPath | ConvertFrom-Json
  if ([int]$catalog.schema_version -ne 1 -or [string]$catalog.policy_id -ne 'proteus-advanced-v1') { throw 'Advanced tuning catalog is invalid.' }
  return $catalog
}

function Get-TuningProfile([string]$Id) {
  Assert-SafeName $Id 'tuning profile'
  $catalog = Read-TuningCatalog
  $profile = $catalog.profiles.PSObject.Properties[$Id].Value
  if ($null -eq $profile) { throw 'Unsupported advanced tuning profile.' }
  foreach ($parameter in @('preblur', 'noise', 'details', 'halo', 'blur', 'compression')) {
    $value = [double]$profile.relative_offsets.$parameter
    $bounds = @($catalog.parameter_bounds.$parameter)
    if ($value -lt [double]$bounds[0] -or $value -gt [double]$bounds[1]) { throw "Advanced tuning profile exceeds the safe $parameter bounds." }
  }
  $blendBounds = @($catalog.parameter_bounds.blend)
  if ([double]$profile.blend -lt [double]$blendBounds[0] -or [double]$profile.blend -gt [double]$blendBounds[1]) { throw 'Advanced tuning profile exceeds the safe blend bounds.' }
  return @{ catalog = $catalog; profile = $profile; id = $Id }
}

function Get-OutputDimensions([string]$Preset, [int]$Width, [int]$Height) {
  if ($Preset -eq 'seedance-human-1080p') { $shortEdge = 1080; $resolution = '1080p' }
  elseif ($Preset -eq 'seedance-human-1440p') { $shortEdge = 1440; $resolution = '2k' }
  else { throw 'Unsupported preset.' }
  if ($Width -le 0 -or $Height -le 0) { throw 'Source dimensions are missing.' }
  if ($Width -ge $Height) {
    $targetHeight = $shortEdge
    $targetWidth = [int](2 * [Math]::Round(([double]$shortEdge * $Width / $Height) / 2.0))
  } else {
    $targetWidth = $shortEdge
    $targetHeight = [int](2 * [Math]::Round(([double]$shortEdge * $Height / $Width) / 2.0))
  }
  return @{ width = $targetWidth; height = $targetHeight; resolution = $resolution }
}

function Format-Number([double]$Value) {
  return $Value.ToString('0.###', [Globalization.CultureInfo]::InvariantCulture)
}

function New-TopazFilter([int]$Width, [int]$Height, $Tuning) {
  $offsets = $Tuning.relative_offsets
  return "tvai_up=model=prob-4:scale=0:w=${Width}:h=${Height}:preblur=$(Format-Number ([double]$offsets.preblur)):noise=$(Format-Number ([double]$offsets.noise)):details=$(Format-Number ([double]$offsets.details)):halo=$(Format-Number ([double]$offsets.halo)):blur=$(Format-Number ([double]$offsets.blur)):compression=$(Format-Number ([double]$offsets.compression)):estimate=$([int]$Tuning.estimate_frames):blend=$(Format-Number ([double]$Tuning.recover_original_detail)):device=0:vram=1:instances=1,scale=w=${Width}:h=${Height}:flags=lanczos"
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

function Invoke-TopazRender($Config, [string]$InputPath, [string]$OutputPath, [int]$Width, [int]$Height, $Tuning, [string]$LogPath, [switch]$NoAudio) {
  $env:TVAI_MODEL_DIR = [string]$Config.model_dir
  $env:TVAI_MODEL_DATA_DIR = [string]$Config.model_data_dir
  $filter = New-TopazFilter $Width $Height $Tuning
  $arguments = @('-hide_banner', '-nostdin', '-y', '-strict', '2', '-i', $InputPath, '-sws_flags', 'spline+accurate_rnd+full_chroma_int', '-vf', $filter, '-map', '0:v:0')
  if ($NoAudio) { $arguments += @('-an') }
  else { $arguments += @('-map', '0:a?', '-map_metadata', '0') }
  $arguments += @('-c:v', 'h264_nvenc', '-preset', 'p5', '-cq', '18', '-b:v', '0', '-pix_fmt', 'yuv420p')
  if (-not $NoAudio) { $arguments += @('-c:a', 'aac', '-b:a', '192k') }
  $arguments += @('-fps_mode', 'passthrough', '-movflags', '+faststart', $OutputPath)
  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & $Config.ffmpeg @arguments 2>&1 | Tee-Object -FilePath $LogPath | Out-Null
  $exit = $LASTEXITCODE
  $ErrorActionPreference = $oldPreference
  if ($exit -ne 0 -or -not (Test-Path -LiteralPath $OutputPath)) { throw "Topaz ffmpeg failed with exit code $exit. See $LogPath" }
}

function New-DefaultTuning {
  return @{ id = 'proteus-auto-v1'; method = 'topaz-proteus-estimate'; estimate_frames = 20; recover_original_detail = 0.2; relative_offsets = @{ preblur = 0; noise = 0; details = 0; halo = 0; blur = 0; compression = 0 } }
}

function New-AdvancedTuning([string]$ProfileId) {
  $selected = Get-TuningProfile $ProfileId
  return @{
    id = [string]$selected.catalog.policy_id
    method = 'topaz-proteus-relative-to-auto'
    profile = $ProfileId
    estimate_frames = [int]$selected.catalog.estimate_frames
    recover_original_detail = [double]$selected.profile.blend
    relative_offsets = $selected.profile.relative_offsets
    catalog = 'proteus-advanced-v1.json'
  }
}

function Invoke-PreviewJob($Job, $Config) {
  $id = [string]$Job.id
  $jobDir = Job-Directory $id
  $outputDir = Join-Path $jobDir 'output'
  $analysisDir = Analysis-Directory ([string]$Job.analysis_id)
  $analysisPath = Join-Path $analysisDir 'analysis.json'
  if (-not (Test-Path -LiteralPath $analysisPath)) { throw 'Analysis not found.' }
  $analysis = Get-Content -Raw -LiteralPath $analysisPath | ConvertFrom-Json
  $samplePath = Join-Path $analysisDir 'artifacts\source-samples-lossless.mkv'
  if (-not (Test-Path -LiteralPath $samplePath)) { throw 'Lossless analysis sample reel is missing.' }
  $dimensions = Get-OutputDimensions ([string]$Job.preset) ([int]$analysis.source_width) ([int]$analysis.source_height)
  $defaultTuning = New-DefaultTuning
  $candidateTuning = New-AdvancedTuning ([string]$Job.tuning_profile)
  $defaultPath = Join-Path $outputDir 'default-auto.mp4'
  $candidateName = "candidate-$([string]$Job.tuning_profile).mp4"
  $candidatePath = Join-Path $outputDir $candidateName
  $comparisonPath = Join-Path $outputDir 'comparison.mp4'
  $contactPath = Join-Path $outputDir 'comparison-contact-sheet.jpg'
  Set-JobStatus $id @{ state = 'running'; job_type = 'preview'; started_at = (Get-Date).ToUniversalTime().ToString('o'); analysis_id = [string]$Job.analysis_id; preset = [string]$Job.preset; resolution = $dimensions.resolution; tuning = $candidateTuning } | Out-Null
  Invoke-TopazRender $Config $samplePath $defaultPath $dimensions.width $dimensions.height $defaultTuning (Join-Path (Join-Path $jobDir 'logs') 'default-auto.log') -NoAudio
  Invoke-TopazRender $Config $samplePath $candidatePath $dimensions.width $dimensions.height $candidateTuning (Join-Path (Join-Path $jobDir 'logs') 'candidate.log') -NoAudio
  $compareFilter = '[0:v]scale=640:-2[s];[1:v]scale=640:-2[d];[2:v]scale=640:-2[c];[s][d][c]hstack=inputs=3[v]'
  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & $Config.ffmpeg -hide_banner -nostdin -y -i $samplePath -i $defaultPath -i $candidatePath -filter_complex $compareFilter -map '[v]' -an -c:v h264_nvenc -preset p5 -cq 18 -b:v 0 -pix_fmt yuv420p -movflags +faststart $comparisonPath 2>&1 | Set-Content -LiteralPath (Join-Path (Join-Path $jobDir 'logs') 'comparison.log')
  $compareExit = $LASTEXITCODE
  & $Config.ffmpeg -hide_banner -nostdin -y -i $comparisonPath -vf 'fps=1/2,tile=1x5' -frames:v 1 $contactPath 2>&1 | Set-Content -LiteralPath (Join-Path (Join-Path $jobDir 'logs') 'contact-sheet.log')
  $contactExit = $LASTEXITCODE
  $ErrorActionPreference = $oldPreference
  if ($compareExit -ne 0) { throw 'Could not create the comparison preview.' }
  if ($contactExit -ne 0) { throw 'Could not create the comparison contact sheet.' }
  $artifacts = @(
    @{ kind = 'default-preview'; name = 'default-auto.mp4'; path = $defaultPath },
    @{ kind = 'candidate-preview'; name = $candidateName; path = $candidatePath },
    @{ kind = 'side-by-side-preview'; name = 'comparison.mp4'; path = $comparisonPath },
    @{ kind = 'contact-sheet'; name = 'comparison-contact-sheet.jpg'; path = $contactPath }
  )
  Set-JobStatus $id @{ state = 'completed'; completed_at = (Get-Date).ToUniversalTime().ToString('o'); job_type = 'preview'; width = $dimensions.width; height = $dimensions.height; model = 'prob-4'; artifacts = $artifacts; tuning = $candidateTuning } | Out-Null
}

function Invoke-Job($Job, $Config) {
  if ([string]$Job.job_type -eq 'preview') { Invoke-PreviewJob $Job $Config; return }
  $id = [string]$Job.id
  $jobDir = Job-Directory $id
  $outputDir = Join-Path $jobDir 'output'
  $advanced = [string]$Job.job_type -eq 'advanced-full'
  if ($advanced) {
    $analysisDir = Analysis-Directory ([string]$Job.analysis_id)
    $analysis = Get-Content -Raw -LiteralPath (Join-Path $analysisDir 'analysis.json') | ConvertFrom-Json
    $inputPath = Join-Path (Join-Path $analysisDir 'input') ([string]$analysis.input_name)
    $inputName = [string]$analysis.input_name
    $sourceWidth = [int]$analysis.source_width
    $sourceHeight = [int]$analysis.source_height
    $tuning = New-AdvancedTuning ([string]$Job.tuning_profile)
  } else {
    $inputPath = Join-Path (Join-Path $jobDir 'input') ([string]$Job.input_name)
    $inputName = [string]$Job.input_name
    $sourceWidth = [int]$Job.source_width
    $sourceHeight = [int]$Job.source_height
    $tuning = New-DefaultTuning
  }
  if (-not (Test-Path -LiteralPath $inputPath)) { throw "Input file is missing: $inputPath" }
  if (-not (Test-Path -LiteralPath $Config.ffmpeg)) { throw "Topaz ffmpeg is missing: $($Config.ffmpeg)" }
  $dimensions = Get-OutputDimensions ([string]$Job.preset) $sourceWidth $sourceHeight
  $suffix = if ($advanced) { "$($dimensions.resolution)-$([string]$Job.tuning_profile)" } else { $dimensions.resolution }
  $outputName = ([IO.Path]::GetFileNameWithoutExtension($inputName)) + "-topaz-${suffix}.mp4"
  $outputPath = Join-Path $outputDir $outputName
  $logPath = Join-Path (Join-Path $jobDir 'logs') 'topaz-ffmpeg.log'
  Set-JobStatus $id @{ state = 'running'; job_type = $(if ($advanced) { 'advanced-full' } else { 'default' }); started_at = (Get-Date).ToUniversalTime().ToString('o'); input_path = $inputPath; output_path = $outputPath; output_name = $outputName; preset = [string]$Job.preset; resolution = $dimensions.resolution; tuning = $tuning } | Out-Null
  Invoke-TopazRender $Config $inputPath $outputPath $dimensions.width $dimensions.height $tuning $logPath
  $size = (Get-Item -LiteralPath $outputPath).Length
  Set-JobStatus $id @{ state = 'completed'; completed_at = (Get-Date).ToUniversalTime().ToString('o'); output_path = $outputPath; output_name = $outputName; output_bytes = $size; width = $dimensions.width; height = $dimensions.height; model = 'prob-4'; preset = [string]$Job.preset; resolution = $dimensions.resolution; tuning = $tuning } | Out-Null
}

Ensure-Directories

switch ($Action) {
  'Install' {
    if (-not (Test-Path -LiteralPath $TuningCatalogPath)) { throw 'Bundled advanced tuning catalog was not installed.' }
    Read-TuningCatalog | Out-Null
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
  'AnalysisPrepare' {
    $payload = Read-Payload
    $id = [string]$payload.id
    $name = [string]$payload.input_name
    Assert-SafeName $id 'analysis id'
    Assert-SafeName $name 'input name'
    $analysisDir = Analysis-Directory $id
    @('input', 'artifacts', 'logs') | ForEach-Object { New-Item -ItemType Directory -Force -Path (Join-Path $analysisDir $_) | Out-Null }
    $inputPath = Join-Path (Join-Path $analysisDir 'input') $name
    @{ id = $id; state = 'uploading'; input_name = $name; input_path = $inputPath; updated_at = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $analysisDir 'analysis.json') -Encoding UTF8
    Write-Json @{ ok = $true; id = $id; input_path = $inputPath }
  }
  'AnalysisRun' {
    $payload = Read-Payload
    $id = [string]$payload.id
    $analysisDir = Analysis-Directory $id
    $inputName = [string]$payload.input_name
    Assert-SafeName $inputName 'input name'
    $inputPath = Join-Path (Join-Path $analysisDir 'input') $inputName
    if (-not (Test-Path -LiteralPath $inputPath)) { throw 'Analysis input is missing.' }
    $config = Read-WorkerConfig
    $probeLines = & $config.ffprobe -v error -show_entries 'format=duration,bit_rate:stream=index,codec_type,width,height,avg_frame_rate,r_frame_rate,bit_rate' -of json $inputPath 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'ffprobe failed while analyzing the video.' }
    $probeText = ($probeLines | Out-String)
    $probe = $probeText | ConvertFrom-Json
    $duration = [double]::Parse([string]$probe.format.duration, [Globalization.CultureInfo]::InvariantCulture)
    if ($duration -le 0) { throw 'Video duration is invalid.' }
    $clipDuration = [Math]::Min(3.0, $duration)
    $centers = @(0.15, 0.5, 0.85)
    $starts = @($centers | ForEach-Object { [Math]::Max(0.0, [Math]::Min($duration - $clipDuration, ($duration * $_) - ($clipDuration / 2.0))) })
    $processingSamplePath = Join-Path $analysisDir 'artifacts\source-samples-lossless.mkv'
    $samplePath = Join-Path $analysisDir 'artifacts\source-samples.mp4'
    $contactPath = Join-Path $analysisDir 'artifacts\source-contact-sheet.jpg'
    $sampleArgs = @('-hide_banner', '-nostdin', '-y')
    foreach ($start in $starts) { $sampleArgs += @('-ss', (Format-Number $start), '-t', (Format-Number $clipDuration), '-i', $inputPath) }
    $sampleArgs += @('-filter_complex', '[0:v]setpts=PTS-STARTPTS[v0];[1:v]setpts=PTS-STARTPTS[v1];[2:v]setpts=PTS-STARTPTS[v2];[v0][v1][v2]concat=n=3:v=1:a=0[v]', '-map', '[v]', '-an', '-c:v', 'ffv1', '-level', '3', '-pix_fmt', 'yuv420p', $processingSamplePath)
    $oldPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $config.ffmpeg @sampleArgs 2>&1 | Set-Content -LiteralPath (Join-Path $analysisDir 'logs\sample-reel.log')
    $sampleExit = $LASTEXITCODE
    & $config.ffmpeg -hide_banner -nostdin -y -i $processingSamplePath -an -c:v h264_nvenc -preset p5 -cq 18 -b:v 0 -pix_fmt yuv420p -movflags +faststart $samplePath 2>&1 | Set-Content -LiteralPath (Join-Path $analysisDir 'logs\source-preview.log')
    $previewExit = $LASTEXITCODE
    & $config.ffmpeg -hide_banner -nostdin -y -i $processingSamplePath -vf 'fps=1,scale=480:-2,tile=3x3' -frames:v 1 $contactPath 2>&1 | Set-Content -LiteralPath (Join-Path $analysisDir 'logs\contact-sheet.log')
    $contactExit = $LASTEXITCODE
    $ErrorActionPreference = $oldPreference
    if ($sampleExit -ne 0) { throw 'Could not create the source sample reel.' }
    if ($previewExit -ne 0) { throw 'Could not create the source sample preview.' }
    if ($contactExit -ne 0) { throw 'Could not create the source contact sheet.' }
    $videoStream = @($probe.streams | Where-Object { $_.codec_type -eq 'video' })[0]
    $artifacts = @(
      @{ kind = 'source-sample-reel'; name = 'source-samples.mp4'; path = $samplePath },
      @{ kind = 'source-contact-sheet'; name = 'source-contact-sheet.jpg'; path = $contactPath }
    )
    $analysis = @{
      ok = $true; id = $id; state = 'analyzed'; policy = 'proteus-advanced-v1'; input_name = $inputName; input_path = $inputPath
      source_width = [int]$payload.source_width; source_height = [int]$payload.source_height; duration_seconds = $duration
      format_bitrate = [string]$probe.format.bit_rate; video_bitrate = [string]$videoStream.bit_rate; average_frame_rate = [string]$videoStream.avg_frame_rate
      sample_duration_seconds = $clipDuration; sample_starts_seconds = $starts; preset = [string]$payload.preset; artifacts = $artifacts
      analyzed_at = (Get-Date).ToUniversalTime().ToString('o')
    }
    $analysis | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $analysisDir 'analysis.json') -Encoding UTF8
    Write-Json $analysis
  }
  'Enqueue' {
    $payload = Read-Payload
    $id = [string]$payload.id
    Assert-SafeName $id 'job id'
    $jobType = if ([string]::IsNullOrWhiteSpace([string]$payload.job_type)) { 'default' } else { [string]$payload.job_type }
    if (@('default', 'preview', 'advanced-full') -notcontains $jobType) { throw 'Unsupported job type.' }
    if ($jobType -eq 'default') { Assert-SafeName ([string]$payload.input_name) 'input name' }
    else {
      Assert-SafeName ([string]$payload.analysis_id) 'analysis id'
      Get-TuningProfile ([string]$payload.tuning_profile) | Out-Null
      if (-not (Test-Path -LiteralPath (Join-Path (Analysis-Directory ([string]$payload.analysis_id)) 'analysis.json'))) { throw 'Analysis not found.' }
    }
    if (@('seedance-human-1080p', 'seedance-human-1440p') -notcontains [string]$payload.preset) { throw 'Unsupported preset.' }
    $jobDir = Job-Directory $id
    @('input', 'output', 'logs') | ForEach-Object { New-Item -ItemType Directory -Force -Path (Join-Path $jobDir $_) | Out-Null }
    $queuePath = Join-Path $QueueRoot "$id.json"
    $payload | ConvertTo-Json | Set-Content -LiteralPath "$queuePath.tmp" -Encoding UTF8
    Move-Item -Force -LiteralPath "$queuePath.tmp" -Destination $queuePath
    $resolution = if ($payload.preset -eq 'seedance-human-1440p') { '2k' } else { '1080p' }
    $queuedTuning = if ($jobType -eq 'default') { @{ id = 'proteus-auto-v1'; method = 'topaz-proteus-estimate'; estimate_frames = 20 } } else { New-AdvancedTuning ([string]$payload.tuning_profile) }
    $queuedStatus = @{ state = 'queued'; job_type = $jobType; queued_at = (Get-Date).ToUniversalTime().ToString('o'); preset = $payload.preset; resolution = $resolution; tuning = $queuedTuning }
    if ($jobType -ne 'default') { $queuedStatus.analysis_id = [string]$payload.analysis_id }
    Set-JobStatus $id $queuedStatus | Out-Null
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
          $failedJobDir = Job-Directory ([string]$job.id)
          @('input', 'output', 'logs') | ForEach-Object { New-Item -ItemType Directory -Force -Path (Join-Path $failedJobDir $_) | Out-Null }
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
