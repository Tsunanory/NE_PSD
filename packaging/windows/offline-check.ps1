param([Parameter(Mandatory=$true)][string]$InstalledExe, [Parameter(Mandatory=$true)][string]$EvidencePath)
$ErrorActionPreference = 'Stop'
if (-not [Environment]::OSVersion.Platform.ToString().StartsWith('Win')) { throw 'BLOCKED — Windows required' }
if (-not (Test-Path -LiteralPath $InstalledExe -PathType Leaf)) { throw 'BLOCKED — installed EXE missing' }
$active = @(Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.HardwareInterface })
if ($active.Count -gt 0) { throw "BLOCKED — disable external network adapters before offline run: $($active.Name -join ', ')" }
$start = Get-Date
$p = Start-Process -FilePath $InstalledExe -PassThru
Start-Sleep -Seconds 5
if ($p.HasExited -and $p.ExitCode -ne 0) { throw "BLOCKED — installed EXE exited $($p.ExitCode)" }
@("Offline check started: $($start.ToString('o'))", "Installed EXE: $InstalledExe", "PID: $($p.Id)", 'External adapters: down', 'Loopback/model/render completion and zero outbound requests require observed per-job evidence; launch alone is not acceptance.') | Set-Content -LiteralPath $EvidencePath -Encoding UTF8
throw 'BLOCKED — per-job offline render and outbound traffic evidence not supplied'
