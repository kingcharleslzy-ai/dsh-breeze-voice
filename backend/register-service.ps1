param([string]$RootDir = $PSScriptRoot, [string]$TaskName = 'BreezeVoice-DSH-Gateway')
$ErrorActionPreference = 'Stop'
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { throw "Task already exists: $TaskName. Inspect it before replacing." }
$arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $RootDir + '\start-service.ps1" -RootDir "' + $RootDir + '"'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments -WorkingDirectory $RootDir
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Settings $settings -Description 'Private DSH voice gateway. Manual start; models unload when idle.' | Out-Null
Start-ScheduledTask -TaskName $TaskName
