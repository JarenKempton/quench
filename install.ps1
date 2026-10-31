$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repo = 'JarenKempton/quench'
$release = if ($env:QUENCH_RELEASE) { $env:QUENCH_RELEASE } else { 'stable' }
$binDir = if ($env:QUENCH_INSTALL_DIR) { $env:QUENCH_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\quench' }
$base = if ($env:QUENCH_DOWNLOAD_BASE) { $env:QUENCH_DOWNLOAD_BASE.TrimEnd('/') } else { "https://github.com/$repo/releases" }

function Fail($message) {
  throw "quench install: $message"
}

$machine = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($machine -ne 'AMD64') { Fail "no Windows build for $machine; see https://github.com/$repo#install" }
$asset = 'quench-windows-x64.exe'

if ($release -eq 'stable') {
  $url = "$base/latest/download"
  $tag = @()
} else {
  $url = "$base/download/$release"
  $tag = @($release)
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) "quench-$([Guid]::NewGuid())"
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  try {
    foreach ($name in @($asset, 'SHA256SUMS')) {
      Invoke-WebRequest -UseBasicParsing -Uri "$url/$name" -OutFile (Join-Path $tmp $name)
    }
  } catch {
    $gh = Get-Command gh -ErrorAction SilentlyContinue
    if (-not $gh) { Fail "couldn't download $url/$asset. The repository is private for now: install gh and run gh auth login, then try again" }
    & gh auth status *> $null
    if ($LASTEXITCODE -ne 0) { Fail "couldn't download $url/$asset, and gh is not signed in: run gh auth login, then try again" }
    [Console]::Error.WriteLine('Direct download failed; using gh release download.')
    & gh release download @tag --repo $repo --pattern $asset --pattern SHA256SUMS --dir $tmp --clobber
    if ($LASTEXITCODE -ne 0) { Fail "gh couldn't download $asset from the $release release" }
  }

  if (-not (Test-Path (Join-Path $tmp 'SHA256SUMS'))) { Fail "the $release release has no SHA256SUMS" }
  $expected = $null
  foreach ($line in Get-Content (Join-Path $tmp 'SHA256SUMS')) {
    $fields = $line -split '\s+', 2
    if ($fields.Count -eq 2 -and $fields[1].TrimStart('*') -eq $asset) { $expected = $fields[0].ToLower() }
  }
  if (-not $expected) { Fail "SHA256SUMS has no entry for $asset" }
  $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp $asset)).Hash.ToLower()
  if ($actual -ne $expected) { Fail "checksum mismatch for ${asset}: expected $expected, got $actual" }

  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
  $target = Join-Path $binDir 'quench.exe'
  $old = Join-Path $binDir 'quench.old.exe'
  Remove-Item -Force $old -ErrorAction SilentlyContinue
  if (Test-Path $target) { Move-Item -Force $target $old }
  Move-Item -Force (Join-Path $tmp $asset) $target
  Write-Output "Installed quench ($release) to $target"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ((@($env:Path -split ';') + @("$userPath" -split ';')) -notcontains $binDir) {
  Write-Output 'Add it to your PATH:'
  Write-Output ("[Environment]::SetEnvironmentVariable('Path', '" + $binDir + ";' + [Environment]::GetEnvironmentVariable('Path', 'User'), 'User')")
}
