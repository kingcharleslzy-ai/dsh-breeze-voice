param(
  [ValidateSet('status','start','stop','restart')][string]$Action='status',
  [string]$RootDir=$PSScriptRoot,
  [string]$TaskName='BreezeVoice-DSH-Gateway'
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$root=(Resolve-Path $RootDir).Path
if (!(Test-Path (Join-Path $root 'server.json'))) { throw 'Missing deployment config' }
if ($Action -eq 'stop' -or $Action -eq 'restart') {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  # Scheduled Task termination can leave Windows venv child interpreters alive.
  # Match only the exact gateway/worker paths of this deployment, never all Python.
  $gateway=[regex]::Escape((Join-Path $root 'voice_gateway.py'))
  $worker=[regex]::Escape((Join-Path $root 'tts_worker.py'))
  $asr=[regex]::Escape((Join-Path $root 'asr_worker.py'))
  $owned=@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match ($gateway+'(?:"|\s|$)') -or $_.CommandLine -match ($worker+'(?:"|\s|$)') -or $_.CommandLine -match ($asr+'(?:"|\s|$)') })
  $ids=@($owned | ForEach-Object ProcessId)
  foreach($p in $owned) {
    if($ids -notcontains $p.ParentProcessId) { & taskkill /PID $p.ProcessId /T /F | Out-Null }
  }
}
if ($Action -eq 'restart') {
  for($i=0;$i -lt 50;$i++) {
    if((Get-ScheduledTask -TaskName $TaskName).State -ne 'Running') { break }
    Start-Sleep -Milliseconds 100
  }
}
if ($Action -eq 'start' -or $Action -eq 'restart') { Start-ScheduledTask -TaskName $TaskName }
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName,State
