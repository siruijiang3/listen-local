$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
& '.qa/qwen-fast-env/Scripts/python.exe' -u 'scripts/realtime-server.py'
