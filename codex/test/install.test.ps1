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
  # Re-running with another seat replaces settings.json in place (via a temporary file that
  # is gone afterwards) and keeps the earlier one in a backup.
  & (Join-Path $root "install.ps1") -CodexHome $freshHome -SkipCliLink -SeatFile (Join-Path $seatDirectory "second-seat.txt") 3>$null | Out-Null
  $settingsFolder = Join-Path $freshHome "cache-statusband-codex"
  $replaced = Get-Content -LiteralPath (Join-Path $settingsFolder "settings.json") -Raw | ConvertFrom-Json
  if ($replaced.seatFile -ne (Join-Path $seatDirectory "second-seat.txt")) { throw "A second install did not replace settings.json" }
  $leftovers = @(Get-ChildItem -LiteralPath $settingsFolder -Force -File | Where-Object { $_.Name -ne "settings.json" })
  if ($leftovers.Count -ne 0) { throw "The settings.json update left a temporary file behind: $($leftovers.Name -join ', ')" }

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

  # A root-level multi-line array (its lines can start with [) must not end the "root table"
  # for the dotted-key check: tui.status_line after it is still refused, with the way out named.
  $arrayHome = Join-Path $testHome "array-home"
  New-Item -ItemType Directory -Path $arrayHome | Out-Null
  $arrayText = "matrix = [`n  [1, 2],`n  [3, 4],`n]`ntui.status_line = [`"model`"]`n`n[features]`nhooks = true`n"
  [IO.File]::WriteAllText((Join-Path $arrayHome "config.toml"), $arrayText, [Text.UTF8Encoding]::new($false))
  $arrayMessage = ""
  try {
    & (Join-Path $root "install.ps1") -CodexHome $arrayHome -SkipCliLink 3>$null | Out-Null
  } catch {
    $arrayMessage = $_.Exception.Message
  }
  if ($arrayMessage -notmatch "tui table with dotted keys or an inline table") { throw "A dotted tui key after a multi-line array was not refused with the dotted-key message: $arrayMessage" }
  if ($arrayMessage -notmatch "-KeepExistingFooter") { throw "The refusal did not name -KeepExistingFooter as the way to skip the footer edit: $arrayMessage" }
  if ([IO.File]::ReadAllText((Join-Path $arrayHome "config.toml")) -ne $arrayText) { throw "The live config changed after the dotted tui key was refused" }
  # ...and with the footer edit skipped, that same file installs.
  & (Join-Path $root "install.ps1") -CodexHome $arrayHome -SkipCliLink -KeepExistingFooter 3>$null | Out-Null
  if ([IO.File]::ReadAllText((Join-Path $arrayHome "config.toml")) -notmatch '(?m)^tui\.status_line = \["model"\]$') { throw "-KeepExistingFooter changed the existing dotted footer" }

  # A line inside a multi-line array that merely LOOKS like a quoted [tui] header is a value.
  $lookalikeHome = Join-Path $testHome "lookalike-home"
  New-Item -ItemType Directory -Path $lookalikeHome | Out-Null
  [IO.File]::WriteAllText((Join-Path $lookalikeHome "config.toml"), "names = [`n  [`"tui`"],`n]`n", [Text.UTF8Encoding]::new($false))
  & (Join-Path $root "install.ps1") -CodexHome $lookalikeHome -SkipCliLink 3>$null | Out-Null
  $lookalikeAfter = [IO.File]::ReadAllText((Join-Path $lookalikeHome "config.toml"))
  if ($lookalikeAfter -notmatch '(?m)^\[tui\]$' -or $lookalikeAfter -notmatch '(?m)^status_line_use_colors = true$') { throw "An array value that looks like a quoted tui header blocked the footer edit" }

  # A config.toml that starts with a byte-order mark: the header on its first line is still
  # recognised, so no second [features] table is added.
  $bomHome = Join-Path $testHome "bom-home"
  New-Item -ItemType Directory -Path $bomHome | Out-Null
  [IO.File]::WriteAllText((Join-Path $bomHome "config.toml"), "[features]`nhooks = false`n", [Text.UTF8Encoding]::new($true))
  if ([IO.File]::ReadAllBytes((Join-Path $bomHome "config.toml"))[0] -ne 0xEF) { throw "The BOM fixture was written without a BOM" }
  & (Join-Path $root "install.ps1") -CodexHome $bomHome -SkipCliLink 3>$null | Out-Null
  $bomAfter = [IO.File]::ReadAllText((Join-Path $bomHome "config.toml"))
  if ([regex]::Matches($bomAfter, '(?m)^\[features\]').Count -ne 1) { throw "A BOM-prefixed config.toml got a duplicate [features] table" }
  if ($bomAfter -notmatch '(?m)^hooks = true$') { throw "A BOM-prefixed config.toml did not get hooks enabled" }
  # Set-TomlKey itself, given text that still holds the mark (ReadAllText normally drops it).
  $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $root "install.ps1"), [ref]$null, [ref]$null)
  foreach ($name in @("Set-TomlKey", "Get-TomlBracketDelta", "Find-TomlValueEnd")) {
    $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    . ([scriptblock]::Create($definition.Extent.Text))
  }
  $withMark = Set-TomlKey -Text ([string][char]0xFEFF + "[features]`nhooks = false`n") -Section "features" -Key "hooks" -Value "true"
  if ($withMark -ne "[features]`nhooks = true`n") { throw "Set-TomlKey did not see a header behind a byte-order mark: $withMark" }

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
  # Replacing a file must never leave a gap in which it does not exist: a reader hammering
  # the file while it is replaced over and over must always find it.
  foreach ($name in @("Move-FileOverExisting")) {
    $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    . ([scriptblock]::Create($definition.Extent.Text))
  }
  $swapFolder = Join-Path $testHome "swap"
  New-Item -ItemType Directory -Path $swapFolder | Out-Null
  $swapTarget = Join-Path $swapFolder "target.json"
  [IO.File]::WriteAllText($swapTarget, "0")
  $swapReader = Start-ThreadJob -ArgumentList $swapTarget -ScriptBlock {
    param($path)
    $missing = 0
    $deadline = [DateTime]::UtcNow.AddSeconds(8)
    while ([DateTime]::UtcNow -lt $deadline) {
      try {
        # Opened the way Node and Codex open files: allowing the file to be replaced under it.
        $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
        $stream.Dispose()
      } catch [IO.FileNotFoundException] { $missing += 1 } catch { }
    }
    $missing
  }
  Start-Sleep -Milliseconds 200
  for ($n = 1; $n -le 1500; $n += 1) {
    $swapCandidate = Join-Path $swapFolder "candidate-$n.tmp"
    [IO.File]::WriteAllText($swapCandidate, "$n")
    Move-FileOverExisting $swapCandidate $swapTarget
  }
  $swapMissing = [int](Receive-Job -Job $swapReader -Wait -AutoRemoveJob)
  if ($swapMissing -ne 0) { throw "A reader found the replaced file missing $swapMissing time(s)" }
  if ([IO.File]::ReadAllText($swapTarget) -ne "1500") { throw "The last replacement did not land" }

  # Something else edits config.toml while the installer is validating its candidate (the fake
  # codex appends to the live file during the first check after registration). The installer
  # must rebuild from the new text and keep that edit rather than overwrite it.
  $raceBin = Join-Path $testHome "race-bin"
  New-Item -ItemType Directory -Path $raceBin | Out-Null
  $raceCodex = @'
@echo off
if "%1"=="plugin" if "%2"=="add" (
  echo.> "%FAKE_STATE%\armed"
  exit /b 0
)
if not "%1"=="app-server" exit /b 0
if not exist "%FAKE_STATE%\armed" exit /b 0
if "%FAKE_ONCE%"=="1" if exist "%FAKE_STATE%\done" exit /b 0
echo.> "%FAKE_STATE%\done"
echo # edited by someone else>> "%FAKE_LIVE%"
exit /b 0
'@
  [IO.File]::WriteAllText((Join-Path $raceBin "codex.cmd"), $raceCodex, [Text.Encoding]::ASCII)
  $previousPath = $env:PATH
  try {
    $env:PATH = "$raceBin$([IO.Path]::PathSeparator)$previousPath"
    foreach ($once in @("1", "0")) {
      $raceHome = Join-Path $testHome "race-home-$once"
      $raceState = Join-Path $testHome "race-state-$once"
      New-Item -ItemType Directory -Path $raceHome, $raceState | Out-Null
      $raceOriginal = "[history]`npersistence = `"save-all`"`n"
      [IO.File]::WriteAllText((Join-Path $raceHome "config.toml"), $raceOriginal, [Text.UTF8Encoding]::new($false))
      $env:FAKE_STATE = $raceState
      $env:FAKE_LIVE = Join-Path $raceHome "config.toml"
      $env:FAKE_ONCE = $once
      $raceMessage = ""
      try {
        & (Join-Path $root "install.ps1") -CodexHome $raceHome -SkipCliLink 3>$null | Out-Null
      } catch {
        $raceMessage = $_.Exception.Message
      }
      $raceAfter = [IO.File]::ReadAllText((Join-Path $raceHome "config.toml"))
      if ($raceAfter -notmatch '(?m)^# edited by someone else\r?$') { throw "An edit made to config.toml during validation was lost (once=$once)" }
      if ($once -eq "1") {
        if ($raceMessage) { throw "A single concurrent edit should be absorbed by a retry, but the install failed: $raceMessage" }
        if ($raceAfter -notmatch '(?m)^status_line_use_colors = true$') { throw "The retried install did not apply the plugin's edit" }
      } else {
        if ($raceMessage -notmatch "kept changing") { throw "Endless concurrent edits were not reported: $raceMessage" }
        if ($raceAfter -match '(?m)^status_line_use_colors') { throw "The plugin's edit was written despite a concurrent change" }
        if ($raceAfter -eq $raceOriginal) { throw "The original config.toml was restored over a concurrent edit" }
      }
      if (@(Get-ChildItem -LiteralPath $raceHome -Force -File | Where-Object { $_.Name -like "*.tmp" }).Count -ne 0) { throw "A temporary config file was left behind (once=$once)" }
    }
  } finally {
    $env:PATH = $previousPath
    Remove-Item Env:FAKE_STATE, Env:FAKE_LIVE, Env:FAKE_ONCE -ErrorAction SilentlyContinue
  }
  Write-Output "install_config_test=passed"
} finally {
  if (Test-Path -LiteralPath $testHome) {
    $resolved = (Resolve-Path -LiteralPath $testHome).Path
    if ($resolved -ne $testHome) { throw "Unexpected test path: $resolved" }
    [IO.Directory]::Delete($resolved, $true)
  }
}
