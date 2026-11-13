#Requires -Version 7.2
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$testHome = Join-Path ([IO.Path]::GetTempPath()) ("cache-statusband-install-test-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $testHome | Out-Null

try {
  $config = @'
[features]
hooks = false

[tui] # existing footer settings
status_line = [
  "model",
  "weekly-limit",
]
status_line_use_colors = false

[history]
persistence = "save-all"
'@
  [IO.File]::WriteAllText((Join-Path $testHome "config.toml"), $config, [Text.UTF8Encoding]::new($false))
  & (Join-Path $root "install.ps1") -CodexHome $testHome -SkipCliLink | Out-Null

  $updated = [IO.File]::ReadAllText((Join-Path $testHome "config.toml"))
  $tuiSections = [regex]::Matches($updated, '(?m)^\s*\[\s*tui\s*\]\s*(?:#.*)?$').Count
  if ($tuiSections -ne 1) { throw "Expected one [tui] section, found $tuiSections" }
  if ($updated -match '(?m)^\s*"(model|weekly-limit)"\s*,?\s*$') { throw "Old multiline footer entries were left behind" }
  if ($updated -notmatch '(?m)^status_line = \["model-with-reasoning", "context-remaining", "five-hour-limit", "weekly-limit", "estimated-thread-cost", "current-dir", "git-branch"\]$') {
    throw "The recommended footer was not written"
  }
  if ($updated -notmatch '(?m)^status_line_use_colors = true$') { throw "Footer colors were not enabled" }
  if ($updated -notmatch '(?m)^persistence = "save-all"$') { throw "An unrelated TOML setting was not preserved" }
  if ($updated -notmatch '(?m)^\[marketplaces\.cache-statusband-codex-local\]') {
    throw "The installer erased its marketplace registration"
  }
  $pluginSection = [regex]::Match($updated, '(?ms)^\[plugins\."cache-statusband-codex@cache-statusband-codex-local"\]\s*\r?\n(?<body>.*?)(?=^\[|\z)')
  if (-not $pluginSection.Success -or $pluginSection.Groups['body'].Value -notmatch '(?m)^enabled\s*=\s*true\s*$') {
    throw "The installed plugin is not persistently enabled"
  }

  $unsupported = @'
[features]
hooks = true

[tui]
status_line = "model"
'@
  [IO.File]::WriteAllText((Join-Path $testHome "config.toml"), $unsupported, [Text.UTF8Encoding]::new($false))
  $rejected = $false
  try {
    & (Join-Path $root "install.ps1") -CodexHome $testHome -SkipCliLink | Out-Null
  } catch {
    $rejected = $true
  }
  if (-not $rejected) { throw "An unsupported existing footer value was not rejected" }
  if ([IO.File]::ReadAllText((Join-Path $testHome "config.toml")) -ne $unsupported) {
    throw "The live config changed after candidate rejection"
  }

  $instructions = @'
developer_instructions = '''
[tui]
status_line = ["model"]
status_line_use_colors = false
'''
'@
  [IO.File]::WriteAllText((Join-Path $testHome "config.toml"), $instructions, [Text.UTF8Encoding]::new($false))
  $rejected = $false
  try {
    & (Join-Path $root "install.ps1") -CodexHome $testHome -SkipCliLink | Out-Null
  } catch {
    $rejected = $true
  }
  if (-not $rejected) { throw "TOML-looking lines inside a multiline string were not rejected" }
  if ([IO.File]::ReadAllText((Join-Path $testHome "config.toml")) -ne $instructions) {
    throw "Multiline instructions changed during candidate rejection"
  }
  # A fresh Codex home has no config.toml at all; a relative -SeatFile must resolve
  # against the PowerShell location, not the process working directory.
  $freshHome = Join-Path $testHome "fresh-home"
  $seatDirectory = Join-Path $testHome "seat-dir"
  New-Item -ItemType Directory -Path $seatDirectory | Out-Null
  Push-Location $seatDirectory
  try {
    & (Join-Path $root "install.ps1") -CodexHome $freshHome -SkipCliLink -SeatFile "active-seat.txt" 3>$null | Out-Null
  } finally {
    Pop-Location
  }
  $freshConfig = [IO.File]::ReadAllText((Join-Path $freshHome "config.toml"))
  if ($freshConfig -notmatch '(?m)^hooks = true$') { throw "A fresh Codex home did not get hooks enabled" }
  $settings = Get-Content -LiteralPath (Join-Path $freshHome "cache-statusband-codex\settings.json") -Raw | ConvertFrom-Json
  if ($settings.seatFile -ne (Join-Path $seatDirectory "active-seat.txt")) {
    throw "A relative -SeatFile did not resolve against the PowerShell location: $($settings.seatFile)"
  }

  # A relative -CodexHome follows the PowerShell location too: the Codex and Node
  # children are started in the process working directory, which Set-Location leaves behind.
  $relativeParent = Join-Path $testHome "relative-parent"
  New-Item -ItemType Directory -Path $relativeParent | Out-Null
  Push-Location $relativeParent
  try {
    [Environment]::CurrentDirectory = $testHome
    & (Join-Path $root "install.ps1") -CodexHome "rel-codex-home" -SkipCliLink 3>$null | Out-Null
  } finally {
    Pop-Location
    [Environment]::CurrentDirectory = (Get-Location).Path
  }
  if (-not (Test-Path -LiteralPath (Join-Path $relativeParent "rel-codex-home/config.toml"))) {
    throw "A relative -CodexHome was not resolved against the PowerShell location"
  }
  if (Test-Path -LiteralPath (Join-Path $testHome "rel-codex-home")) {
    throw "A relative -CodexHome was resolved against the process working directory"
  }

  # Two runs in the same second must not share or overwrite a backup: the first backup
  # keeps the original config.toml.
  $backupHome = Join-Path $testHome "backup-home"
  New-Item -ItemType Directory -Path $backupHome | Out-Null
  $originalConfig = "[history]`npersistence = `"save-all`"`n"
  [IO.File]::WriteAllText((Join-Path $backupHome "config.toml"), $originalConfig, [Text.UTF8Encoding]::new($false))
  & (Join-Path $root "install.ps1") -CodexHome $backupHome -SkipCliLink 3>$null | Out-Null
  & (Join-Path $root "install.ps1") -CodexHome $backupHome -SkipCliLink 3>$null | Out-Null
  $backups = @(Get-ChildItem -LiteralPath (Join-Path $backupHome "backups") -Directory | Where-Object { $_.Name -like "cache-statusband-codex-2*" })
  if ($backups.Count -ne 2) { throw "Expected two distinct backups from two runs, found $($backups.Count)" }
  $holdsOriginal = @($backups | Where-Object { [IO.File]::ReadAllText((Join-Path $_.FullName "config.toml")) -eq $originalConfig })
  if ($holdsOriginal.Count -ne 1) { throw "The first run's backup of the original config.toml was lost or overwritten" }

  # An empty or blank -SeatFile must be rejected before anything is changed or registered.
  foreach ($blank in @("", "   ")) {
    $blankHome = Join-Path $testHome "blank-seat-home"
    $rejected = $false
    try {
      & (Join-Path $root "install.ps1") -CodexHome $blankHome -SkipCliLink -SeatFile $blank 3>$null | Out-Null
    } catch {
      $rejected = $_.Exception.Message -match "SeatFile"
    }
    if (-not $rejected) { throw "A blank -SeatFile ('$blank') was not rejected with a -SeatFile error" }
    if (Test-Path -LiteralPath $blankHome) { throw "A rejected -SeatFile still created or changed the Codex home" }
  }

  # A config.toml Codex's strict check already rejects (a retired key passes plain startup
  # but fails --strict-config) must not block the install: it installs with a warning.
  $retiredHome = Join-Path $testHome "retired-key-home"
  New-Item -ItemType Directory -Path $retiredHome | Out-Null
  $retired = "[features]`nhooks = true`nbogus_retired_key = true`n"
  [IO.File]::WriteAllText((Join-Path $retiredHome "config.toml"), $retired, [Text.UTF8Encoding]::new($false))
  $retiredWarnings = @()
  & (Join-Path $root "install.ps1") -CodexHome $retiredHome -SkipCliLink -WarningVariable retiredWarnings 3>$null | Out-Null
  if (-not ($retiredWarnings | Where-Object { "$_" -match "strict config check already rejects" })) {
    throw "A config.toml with a retired key did not produce the could-not-validate warning"
  }
  $retiredAfter = [IO.File]::ReadAllText((Join-Path $retiredHome "config.toml"))
  if ($retiredAfter -notmatch '(?m)^bogus_retired_key = true$') { throw "The retired key was removed from config.toml" }
  if ($retiredAfter -notmatch '(?m)^status_line_use_colors = true$') { throw "The install did not proceed past the retired key" }
  if (@($retiredWarnings | Where-Object { "$_" -match "strict config check already rejects" }).Count -ne 1) {
    throw "The strict-check warning was not printed exactly once"
  }
  $realCodex = Get-Command codex -All | Where-Object { $_.CommandType -eq "Application" } | Select-Object -First 1 -ExpandProperty Source
  $previousCodexHome = $env:CODEX_HOME
  $env:CODEX_HOME = $retiredHome
  try {
    & $realCodex app-server --print-startup-config *> $null
    $plainExit = $LASTEXITCODE
  } finally {
    # Put back what was there, and leave the variable unset only if it was unset before.
    if ($null -eq $previousCodexHome) { Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue } else { $env:CODEX_HOME = $previousCodexHome }
  }
  if ($plainExit -ne 0) { throw "The installed config.toml with a retired key does not pass plain Codex startup" }

  # The same retired key plus a footer written with dotted keys: the plugin cannot add a
  # [tui] table without duplicating it, so the install is refused and config.toml untouched.
  $dottedHome = Join-Path $testHome "dotted-home"
  New-Item -ItemType Directory -Path $dottedHome | Out-Null
  $dotted = "[features]`nhooks = true`nbogus_retired_key = true`n"
  foreach ($head in @("tui.status_line = [`"model`"]`n", "tui = { status_line = [`"model`"] }`n")) {
    $dottedText = $head + $dotted
    [IO.File]::WriteAllText((Join-Path $dottedHome "config.toml"), $dottedText, [Text.UTF8Encoding]::new($false))
    $rejected = $false
    try {
      & (Join-Path $root "install.ps1") -CodexHome $dottedHome -SkipCliLink 3>$null | Out-Null
    } catch {
      $rejected = $_.Exception.Message -match "tui table with dotted keys or an inline table"
    }
    if (-not $rejected) { throw "A footer defined with dotted keys or an inline table was not refused with a tui error: $($head.Trim())" }
    if ([IO.File]::ReadAllText((Join-Path $dottedHome "config.toml")) -ne $dottedText) {
      throw "The live config changed after a dotted-key footer was refused"
    }
  }
  $quotedText = "[`"tui`"]`nstatus_line = [`"model`"]`n" + $dotted
  [IO.File]::WriteAllText((Join-Path $dottedHome "config.toml"), $quotedText, [Text.UTF8Encoding]::new($false))
  $rejected = $false
  try {
    & (Join-Path $root "install.ps1") -CodexHome $dottedHome -SkipCliLink 3>$null | Out-Null
  } catch {
    $rejected = $_.Exception.Message -match '\[tui\] with a quoted header'
  }
  if (-not $rejected) { throw "A quoted [`"tui`"] header was not refused" }
  if ([IO.File]::ReadAllText((Join-Path $dottedHome "config.toml")) -ne $quotedText) {
    throw "The live config changed after a quoted tui header was refused"
  }

  # When the ORIGINAL already fails the strict check, a candidate that Codex cannot even
  # load (plain startup rejects it) is still refused; the fake codex fails strict for any
  # config and plain startup only once the plugin's footer edit is present.
  $plainBin = Join-Path $testHome "plain-bin"
  New-Item -ItemType Directory -Path $plainBin | Out-Null
  $plainCodex = @'
@echo off
if not "%1"=="app-server" exit /b 0
if "%2"=="--strict-config" (
  echo WARNING: noisy line that is not the reason
  echo unknown field bogus_retired_key
  exit /b 1
)
findstr /C:"status_line_use_colors" "%CODEX_HOME%\config.toml" >nul
if errorlevel 1 exit /b 0
echo {"error":{"code":-32600,"data":{"detail":"config.toml:5:1: duplicate key"},"message":"failed to load configuration"}}
exit /b 1
'@
  [IO.File]::WriteAllText((Join-Path $plainBin "codex.cmd"), $plainCodex, [Text.Encoding]::ASCII)
  $plainHome = Join-Path $testHome "plain-home"
  New-Item -ItemType Directory -Path $plainHome | Out-Null
  $plainOriginal = "[history]`npersistence = `"save-all`"`nbogus_retired_key = true`n"
  [IO.File]::WriteAllText((Join-Path $plainHome "config.toml"), $plainOriginal, [Text.UTF8Encoding]::new($false))
  $previousPath = $env:PATH
  $plainMessage = ""
  try {
    $env:PATH = "$plainBin$([IO.Path]::PathSeparator)$previousPath"
    try {
      & (Join-Path $root "install.ps1") -CodexHome $plainHome -SkipCliLink 3>$null | Out-Null
    } catch {
      $plainMessage = $_.Exception.Message
    }
  } finally {
    $env:PATH = $previousPath
  }
  if ($plainMessage -notmatch "rejected the candidate") { throw "A candidate plain startup rejects was not refused when the original failed strict: $plainMessage" }
  if ($plainMessage -notmatch "duplicate key") { throw "Codex's JSON detail was not shown: $plainMessage" }
  if ($plainMessage -match "WARNING:|\{") { throw "Codex's warning line or raw JSON was shown instead of its reason: $plainMessage" }
  if ([IO.File]::ReadAllText((Join-Path $plainHome "config.toml")) -ne $plainOriginal) {
    throw "The live config changed after plain startup rejected the candidate"
  }

  # A candidate that WE break (the original passes the strict check, the edit does not)
  # still throws and leaves config.toml untouched.
  $strictBin = Join-Path $testHome "strict-bin"
  New-Item -ItemType Directory -Path $strictBin | Out-Null
  $strictCodex = @'
@echo off
if not "%1"=="app-server" exit /b 0
findstr /C:"status_line_use_colors" "%CODEX_HOME%\config.toml" >nul
if errorlevel 1 exit /b 0
echo unknown field status_line_use_colors
exit /b 1
'@
  [IO.File]::WriteAllText((Join-Path $strictBin "codex.cmd"), $strictCodex, [Text.Encoding]::ASCII)
  $strictHome = Join-Path $testHome "strict-home"
  New-Item -ItemType Directory -Path $strictHome | Out-Null
  $strictOriginal = "[history]`npersistence = `"save-all`"`n"
  [IO.File]::WriteAllText((Join-Path $strictHome "config.toml"), $strictOriginal, [Text.UTF8Encoding]::new($false))
  $previousPath = $env:PATH
  $rejected = $false
  try {
    $env:PATH = "$strictBin$([IO.Path]::PathSeparator)$previousPath"
    try {
      & (Join-Path $root "install.ps1") -CodexHome $strictHome -SkipCliLink 3>$null | Out-Null
    } catch {
      $rejected = $_.Exception.Message -match "rejected the candidate"
    }
  } finally {
    $env:PATH = $previousPath
  }
  if (-not $rejected) { throw "A candidate broken by the plugin's own edit was not rejected" }
  if ([IO.File]::ReadAllText((Join-Path $strictHome "config.toml")) -ne $strictOriginal) {
    throw "The live config changed after the plugin's own edit was rejected"
  }

  # A failure after Codex registered the plugin must put the original config.toml back.
  $fakeBin = Join-Path $testHome "fake-bin"
  New-Item -ItemType Directory -Path $fakeBin | Out-Null
  $fakeCodex = @'
@echo off
if "%1"=="app-server" exit /b 0
if "%1"=="plugin" if "%2"=="marketplace" (
  echo [marketplaces.partial]>> "%CODEX_HOME%\config.toml"
  exit /b 1
)
exit /b 0
'@
  [IO.File]::WriteAllText((Join-Path $fakeBin "codex.cmd"), $fakeCodex, [Text.Encoding]::ASCII)
  $restoreHome = Join-Path $testHome "restore-home"
  New-Item -ItemType Directory -Path $restoreHome | Out-Null
  $original = "[history]`npersistence = `"save-all`"`n"
  [IO.File]::WriteAllText((Join-Path $restoreHome "config.toml"), $original, [Text.UTF8Encoding]::new($false))
  $previousPath = $env:PATH
  $rejected = $false
  try {
    $env:PATH = "$fakeBin$([IO.Path]::PathSeparator)$previousPath"
    try {
      & (Join-Path $root "install.ps1") -CodexHome $restoreHome -SkipCliLink 3>$null | Out-Null
    } catch {
      $rejected = $true
    }
  } finally {
    $env:PATH = $previousPath
  }
  if (-not $rejected) { throw "A failed registration was not reported" }
  if ([IO.File]::ReadAllText((Join-Path $restoreHome "config.toml")) -ne $original) {
    throw "The original config.toml was not restored after a failed registration"
  }
  Write-Output "install_config_test=passed"
} finally {
  if (Test-Path -LiteralPath $testHome) {
    $resolved = (Resolve-Path -LiteralPath $testHome).Path
    if ($resolved -ne $testHome) { throw "Unexpected test path: $resolved" }
    [IO.Directory]::Delete($resolved, $true)
  }
}
