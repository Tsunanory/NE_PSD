$ErrorActionPreference = 'Stop'
$evidence = Join-Path $PSScriptRoot '..\..\docs\desktop\windows-acceptance.md'
@("BLOCKED — Windows host unavailable or acceptance not executed", "OS: $([Environment]::OSVersion)", "Timestamp: $(Get-Date -Format o)") | Set-Content -Encoding UTF8 $evidence
Write-Error "BLOCKED — Windows acceptance requires Windows 11 x64, staged vendor runtime, Photoshop and qualified model"
