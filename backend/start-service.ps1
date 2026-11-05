param([string]$RootDir = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
$env:PYTHONUTF8 = '1'
$env:HF_HUB_OFFLINE = '1'
$env:TRANSFORMERS_OFFLINE = '1'
Set-Location $RootDir
# cmd owns native redirection; Windows PowerShell otherwise turns normal stderr
# log messages into terminating NativeCommandError records under Stop policy.
$command = '""' + $RootDir + '\venv\Scripts\python.exe" "' + $RootDir + '\voice_gateway.py" --config "' + $RootDir + '\server.json" >> "' + $RootDir + '\logs\gateway.log" 2>&1"'
& cmd.exe /d /s /c $command
exit $LASTEXITCODE
