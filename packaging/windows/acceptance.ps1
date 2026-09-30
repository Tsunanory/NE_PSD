param(
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][string]$InstalledExe,
  [Parameter(Mandatory=$true)][string]$Publisher,
  [Parameter(Mandatory=$true)][string]$ElectronModules,
  [Parameter(Mandatory=$true)][string]$NodeModules,
  [string]$EvidencePath = (Join-Path $PSScriptRoot '..\..\docs\desktop\windows-acceptance.md')
)
$ErrorActionPreference = 'Stop'
$lines = [Collections.Generic.List[string]]::new()
$lines.Add('# Windows acceptance — observed run')
$lines.Add("Time: $((Get-Date).ToString('o'))")
$lines.Add("OS: $([Environment]::OSVersion.VersionString)")
$lines.Add("CPU: $env:PROCESSOR_ARCHITECTURE")
$lines.Add("Computer: $env:COMPUTERNAME")
$lines.Add("Installed path: $InstalledExe")
$lines.Add("Photoshop version: unverified")
$lines.Add("Model artifact: unverified")
function Run([string]$Name, [scriptblock]$Action) {
  try { $output = & $Action 2>&1 | Out-String; $code = $LASTEXITCODE; if ($null -eq $code) { $code = 0 }; $lines.Add("## $Name — exit $code"); $lines.Add('```text'); $lines.Add($output); $lines.Add('```'); if ($code -ne 0) { throw "$Name exit $code" } }
  catch { $lines.Add("BLOCKED — $Name`: $($_.Exception.Message)"); throw }
}
try {
  if (-not [Environment]::OSVersion.Platform.ToString().StartsWith('Win') -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -or [Environment]::OSVersion.Version.Build -lt 22000) { throw 'Windows 11 x64 host required' }
  foreach ($path in @($Installer,$InstalledExe,$ElectronModules,$NodeModules)) { if (-not (Test-Path -LiteralPath $path)) { throw "missing path: $path" } }
  $repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
  $manifest = Get-Content -LiteralPath (Join-Path $repo 'packaging\runtime-manifest.json') -Raw | ConvertFrom-Json
  if ($manifest.status -ne 'ready') { throw "runtime manifest blocked: $($manifest.missing -join '; ')" }
  $lines.Add("Manifest SHA256: $((Get-FileHash -LiteralPath (Join-Path $repo 'packaging\runtime-manifest.json') -Algorithm SHA256).Hash)")
  $lines.Add("Installer SHA256: $((Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash)")
  Run 'bundle' { & node (Join-Path $repo 'packaging\verify-bundle.mjs') (Join-Path $repo 'packaging\staged\win32-x64') }
  Run 'standalone native' { & (Join-Path (Split-Path $InstalledExe) 'resources\runtime\node.exe') (Join-Path $repo 'packaging\native-smoke.mjs') standalone-node $NodeModules }
  $env:ELECTRON_RUN_AS_NODE = '1'
  try { Run 'electron native' { & $InstalledExe (Join-Path $repo 'packaging\native-smoke.mjs') electron $ElectronModules } }
  finally { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
  Run 'signature' { & (Join-Path $PSScriptRoot 'verify-signature.ps1') -Installer $Installer -InstalledExe $InstalledExe -ExpectedPublisher $Publisher }
  Run 'path fixtures' { & (Join-Path $PSScriptRoot 'path-cases.ps1') -InstalledExe $InstalledExe -DisposableRoot (Join-Path $env:TEMP 'NE PSD Тест') }
  Run 'offline' { & (Join-Path $PSScriptRoot 'offline-check.ps1') -InstalledExe $InstalledExe -EvidencePath (Join-Path $env:TEMP 'ne-psd-offline.txt') }
  throw 'Real PSD/all-fit/100-asset/upgrade acceptance evidence remains required'
} catch { $lines.Add("BLOCKED — $($_.Exception.Message)") }
finally { $lines | Set-Content -LiteralPath $EvidencePath -Encoding UTF8 }
if ($lines | Where-Object { $_ -like 'BLOCKED*' }) { exit 2 }
