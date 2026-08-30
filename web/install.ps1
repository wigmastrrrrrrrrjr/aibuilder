# install.ps1 — aib (aibuilder terminal client) installer for Windows
# Usage: irm https://wigmastrrrrrrrrjr.github.io/aibuilder/install.ps1 | iex
$ErrorActionPreference = "Stop"

$Repo = "wigmastrrrrrrrrjr/aibuilder"
$Base = "https://github.com/$Repo/releases/latest/download"
$Prog = "aib"
$Asset = "aib-x86_64-pc-windows-msvc.exe"

function Get-Arch {
  $m = $env:PROCESSOR_ARCHITECTURE
  if ($m -eq "ARM64") { return "aarch64" }
  return "x86_64"
}

$arch = Get-Arch
if ($arch -ne "x86_64") {
  Write-Error "auto-install currently ships x86_64 builds; use cargo build --release from tui/"
}

$url = "$Base/$Asset"
$tmp = Join-Path $env:TEMP ($Prog + "-dl.exe")
$dest = Join-Path $env:LOCALAPPDATA "aib"
$bin = Join-Path $dest ($Prog + ".exe")

Write-Host "Downloading $Asset"
Invoke-WebRequest -Uri $url -OutFile $tmp

if (Test-Path $dest) { New-Item -ItemType Directory -Force -Path $dest | Out-Null }
New-Item -ItemType Directory -Force -Path $dest | Out-Null

Move-Item -Force $tmp $bin
Write-Host "Installed $Prog to $bin"

# add to current session + persist on PATH
$env:PATH = "$dest;$env:PATH"
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
$cur = $key.GetValue("Path", "").ToString()
if ($cur -notlike "*$dest*") {
  $key.SetValue("Path", "$dest;$cur", [Microsoft.Win32.RegistryValueKind]::ExpandString)
  Write-Host "Added $dest to your PATH (open a new terminal)."
}
$key.Close()

Write-Host ""
Write-Host "Next steps:"
Write-Host "  aib login          sign in (or create an account)"
Write-Host "  aib                start the terminal builder"
Write-Host "  aib --help         all commands"