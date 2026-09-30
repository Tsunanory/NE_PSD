param([Parameter(Mandatory=$true)][string]$InstalledExe, [Parameter(Mandatory=$true)][string]$DisposableRoot)
$ErrorActionPreference = 'Stop'
if (-not [Environment]::OSVersion.Platform.ToString().StartsWith('Win')) { throw 'BLOCKED — Windows required' }
if (-not (Test-Path -LiteralPath $InstalledExe -PathType Leaf)) { throw 'BLOCKED — installed EXE missing' }
$root = [IO.Path]::GetFullPath($DisposableRoot)
New-Item -ItemType Directory -Force -Path $root | Out-Null
$deep = $root
while ($deep.Length -lt 290) { $deep = Join-Path $deep 'длинный путь NE PSD' }
New-Item -ItemType Directory -Force -Path $deep | Out-Null
$source = Join-Path $deep 'кот.png'; [IO.File]::WriteAllBytes($source, [byte[]](137,80,78,71,13,10,26,10))
$dest = Join-Path $deep 'Готовые работы'; New-Item -ItemType Directory -Force -Path $dest | Out-Null
[pscustomobject]@{Source=$source; SourceUtf16Length=$source.Length; Output=$dest; OutputUtf16Length=$dest.Length; Status='filesystem fixture only; installed GUI/Photoshop behavior requires acceptance run'}
