$ErrorActionPreference = 'Stop'

$Repo = if ($env:WF_INSTALL_REPO) { $env:WF_INSTALL_REPO } else { 'rodolfo-terriquez/workflowy-cli' }
$Version = if ($env:WF_VERSION) { $env:WF_VERSION } else { 'latest' }
$InstallDir = if ($env:WF_INSTALL_DIR) { $env:WF_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\workflowy-cli' }

function Write-Info($Message) {
  Write-Host "==> $Message" -ForegroundColor Blue
}

function Write-Warn($Message) {
  Write-Host "Warning: $Message" -ForegroundColor Yellow
}

$Arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
switch ($Arch) {
  'x64' { $Cpu = 'x64' }
  'arm64' { $Cpu = 'arm64' }
  default { throw "Unsupported CPU architecture: $Arch. Install from source instead: https://github.com/$Repo" }
}

if ($Version -eq 'latest') {
  Write-Info 'Finding latest wf release'
  $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest"
  $Version = $Release.tag_name
  if (-not $Version) { throw 'Could not determine latest release version from GitHub.' }
}

$Asset = "wf-$Version-windows-$Cpu.exe"
$DownloadUrl = "https://github.com/$Repo/releases/download/$Version/$Asset"
$TempFile = Join-Path ([System.IO.Path]::GetTempPath()) $Asset

Write-Info "Downloading $Asset"
Invoke-WebRequest -Uri $DownloadUrl -OutFile $TempFile

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$Dest = Join-Path $InstallDir 'wf.exe'
Move-Item -Force $TempFile $Dest

Write-Info "Installed wf to $Dest"

$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$PathParts = @()
if ($UserPath) { $PathParts = $UserPath -split ';' }

if ($PathParts -notcontains $InstallDir) {
  $NewUserPath = if ($UserPath) { "$UserPath;$InstallDir" } else { $InstallDir }
  [Environment]::SetEnvironmentVariable('Path', $NewUserPath, 'User')
  $env:Path = "$env:Path;$InstallDir"
  Write-Info "Added $InstallDir to your user PATH"
  Write-Warn 'Open a new terminal window if wf is not immediately available.'
}

try {
  $InstalledVersion = & $Dest --version
  Write-Info "wf version: $InstalledVersion"
} catch {
  Write-Warn "Installed, but the binary did not run successfully. Try: $Dest doctor"
}

Write-Host ''
Write-Host 'Next steps:'
Write-Host '  wf login'
Write-Host '  wf cache:sync'
Write-Host '  wf doctor'
