param([Parameter(Mandatory=$true)][string]$Installer, [Parameter(Mandatory=$true)][string]$InstalledExe, [Parameter(Mandatory=$true)][string]$ExpectedPublisher)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -and $PSVersionTable.PSEdition -eq 'Core') { throw 'BLOCKED — Windows required' }
foreach ($path in @($Installer, $InstalledExe)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "BLOCKED — missing artifact: $path" }
  $sig = Get-AuthenticodeSignature -LiteralPath $path
  if ($sig.Status -ne 'Valid' -or -not $sig.SignerCertificate -or $sig.SignerCertificate.Subject -notlike "*$ExpectedPublisher*") { throw "BLOCKED — invalid signature/publisher: $path ($($sig.Status))" }
  if (-not $sig.TimeStamperCertificate) { throw "BLOCKED — timestamp missing: $path" }
  [pscustomobject]@{ Path=$path; Sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash; Status=$sig.Status; Publisher=$sig.SignerCertificate.Subject; TimestampAuthority=$sig.TimeStamperCertificate.Subject }
}
