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
  $multilineMessage = ""
  try {
    & (Join-Path $root "install.ps1") -CodexHome $testHome -SkipCliLink | Out-Null
  } catch {
    $rejected = $true
    $multilineMessage = $_.Exception.Message
  }
  if (-not $rejected) { throw "TOML-looking lines inside a multiline string were not rejected" }
  if ($multilineMessage -notmatch "Nothing was installed or registered" -or $multilineMessage -notmatch "then run the installer again") {
    throw "The multi-line string refusal did not say nothing was installed and how to proceed: $multilineMessage"
  }
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

  # A caller or profile that sets $PSNativeCommandUseErrorActionPreference to $true must not
  # turn Codex's non-zero strict-check exit into "could not run": the retired-key config still
  # installs with the warning.
  $nativeHome = Join-Path $testHome "native-pref-home"
  New-Item -ItemType Directory -Path $nativeHome | Out-Null
  [IO.File]::WriteAllText((Join-Path $nativeHome "config.toml"), $retired, [Text.UTF8Encoding]::new($false))
  $nativeScript = Join-Path $testHome "native-pref.ps1"
  [IO.File]::WriteAllText($nativeScript, "`$PSNativeCommandUseErrorActionPreference = `$true`n& '$(Join-Path $root "install.ps1")' -CodexHome '$nativeHome' -SkipCliLink *>&1 | Out-String`n", [Text.UTF8Encoding]::new($false))
  $nativeOutput = (& (Get-Process -Id $PID).Path -NoProfile -File $nativeScript 2>&1 | Out-String)
  if ($nativeOutput -notmatch "strict config check already rejects" -or $nativeOutput -match "could not run") { throw "With PSNativeCommandUseErrorActionPreference set to true, the retired-key config was not installed with the warning: $nativeOutput" }
  if ([IO.File]::ReadAllText((Join-Path $nativeHome "config.toml")) -notmatch '(?m)^status_line_use_colors = true$') { throw "The install did not proceed with PSNativeCommandUseErrorActionPreference set to true" }

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

  # An explicit access entry on config.toml survives the install: the candidate that replaces it is
  # a new file, so the installer copies the old file's access list onto it first. (BUILTIN\Guests
  # is not something a temp folder inherits, so its entry can only be the explicit one.)
  if ($IsWindows) {
    $aclHome = Join-Path $testHome "acl-home"
    New-Item -ItemType Directory -Path $aclHome | Out-Null
    $aclConfig = Join-Path $aclHome "config.toml"
    [IO.File]::WriteAllText($aclConfig, "[features]`nhooks = false`n", [Text.UTF8Encoding]::new($false))
    $guests = [Security.Principal.SecurityIdentifier]::new("S-1-5-32-546")
    $aclBefore = Get-Acl -LiteralPath $aclConfig
    $aclBefore.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($guests, "Read", "Allow"))
    Set-Acl -LiteralPath $aclConfig -AclObject $aclBefore
    $hasGuestEntry = {
      @((Get-Acl -LiteralPath $aclConfig).Access | Where-Object {
        $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $guests.Value -and
        $_.AccessControlType -eq "Allow" -and -not $_.IsInherited -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Read) -ne 0
      }).Count -eq 1
    }
    if (-not (& $hasGuestEntry)) { throw "The explicit access entry fixture was not set on config.toml" }
    # A fake codex that registers nothing and rewrites nothing: the real one rewrites config.toml
    # itself during `plugin add`, which would drop the entry before the installer's replace.
    $aclBin = Join-Path $testHome "acl-bin"
    New-Item -ItemType Directory -Path $aclBin | Out-Null
    [IO.File]::WriteAllText((Join-Path $aclBin "codex.cmd"), "@echo off`r`nexit /b 0`r`n", [Text.Encoding]::ASCII)
    $previousPath = $env:PATH
    try {
      $env:PATH = "$aclBin$([IO.Path]::PathSeparator)$previousPath"
      & (Join-Path $root "install.ps1") -CodexHome $aclHome -SkipCliLink 3>$null | Out-Null
    } finally {
      $env:PATH = $previousPath
    }
    if ([IO.File]::ReadAllText($aclConfig) -notmatch '(?m)^hooks = true$') { throw "The access-entry install did not update config.toml" }
    if (-not (& $hasGuestEntry)) { throw "The explicit access entry on config.toml did not survive the install replacing the file" }
    # A failure to copy the access list warns (once per replace) and the replace still happens.
    $aclFailScript = Join-Path $testHome "acl-fail.ps1"
    $aclMoveDefinition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq "Move-FileOverExisting" }, $true)
    [IO.File]::WriteAllText($aclFailScript, "function Get-Acl { throw 'simulated: no access list' }`n" + $aclMoveDefinition.Extent.Text + @'

$folder = $args[0]
[IO.File]::WriteAllText("$folder\from.txt", "new")
[IO.File]::WriteAllText("$folder\to.txt", "old")
Move-FileOverExisting "$folder\from.txt" "$folder\to.txt"
[IO.File]::ReadAllText("$folder\to.txt")
'@)
    $aclFailFolder = Join-Path $testHome "acl-fail"
    New-Item -ItemType Directory -Path $aclFailFolder | Out-Null
    $aclFailOutput = @(& (Get-Process -Id $PID).Path -NoProfile -File $aclFailScript $aclFailFolder 3>&1 | ForEach-Object { "$_" })
    if ($aclFailOutput[-1] -ne "new") { throw "A failed access-list copy stopped the replace: $($aclFailOutput -join ' | ')" }
    if (@($aclFailOutput | Where-Object { $_ -match "Could not copy the access permissions" }).Count -ne 1) { throw "A failed access-list copy did not warn exactly once: $($aclFailOutput -join ' | ')" }
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
      & (Join-Path $root "install.ps1") -CodexHome $restoreHome -SkipCliLink -WarningVariable restoreWarnings 3>$null | Out-Null
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
  # The warning says why it restored: Codex's own registration writes cannot be told apart
  # from anyone else's, so this case restores regardless.
  if (-not ($restoreWarnings | Where-Object { "$_" -match "Codex's own registration step" -and "$_" -match "original config.toml was restored" })) {
    throw "A restore after a failed registration did not say it came from Codex's own registration step: $($restoreWarnings -join ' | ')"
  }

  # With -SeatFile, a failure in Codex's registration puts settings.json back too: as it was
  # (its earlier contents), or removed when there was none before.
  foreach ($hadSettings in @($true, $false)) {
    $seatRestoreHome = Join-Path $testHome "seat-restore-home-$hadSettings"
    New-Item -ItemType Directory -Path (Join-Path $seatRestoreHome "cache-statusband-codex") | Out-Null
    [IO.File]::WriteAllText((Join-Path $seatRestoreHome "config.toml"), $original, [Text.UTF8Encoding]::new($false))
    $seatSettingsPath = Join-Path $seatRestoreHome "cache-statusband-codex\settings.json"
    $earlierSettings = "{`"version`":1,`"seatFile`":`"earlier-seat.txt`"}`n"
    if ($hadSettings) { [IO.File]::WriteAllText($seatSettingsPath, $earlierSettings, [Text.UTF8Encoding]::new($false)) }
    $seatWarnings = @()
    $previousPath = $env:PATH
    $seatRejected = $false
    try {
      $env:PATH = "$fakeBin$([IO.Path]::PathSeparator)$previousPath"
      try {
        & (Join-Path $root "install.ps1") -CodexHome $seatRestoreHome -SkipCliLink -SeatFile (Join-Path $testHome "new-seat.txt") -WarningVariable seatWarnings 3>$null | Out-Null
      } catch {
        $seatRejected = $true
      }
    } finally {
      $env:PATH = $previousPath
    }
    if (-not $seatRejected) { throw "A failed registration with -SeatFile was not reported" }
    if ([IO.File]::ReadAllText((Join-Path $seatRestoreHome "config.toml")) -ne $original) { throw "config.toml was not restored after a failed registration with -SeatFile" }
    if ($hadSettings) {
      if ([IO.File]::ReadAllText($seatSettingsPath) -ne $earlierSettings) { throw "settings.json was not put back after a failed registration" }
      if (-not ($seatWarnings | Where-Object { "$_" -match "settings.json was put back as it was" })) { throw "No warning said settings.json was put back: $($seatWarnings -join ' | ')" }
    } else {
      if (Test-Path -LiteralPath $seatSettingsPath) { throw "A settings.json that did not exist before the failed install was left behind" }
      if (-not ($seatWarnings | Where-Object { "$_" -match "settings.json did not exist before the install" })) { throw "No warning said the new settings.json was removed: $($seatWarnings -join ' | ')" }
    }
    if (@(Get-ChildItem -LiteralPath (Join-Path $seatRestoreHome "cache-statusband-codex") -Force -File | Where-Object { $_.Name -ne "settings.json" }).Count -ne 0) { throw "A temporary file was left beside settings.json" }
  }

  # settings.json is written before Codex's configuration is touched: when that write fails
  # (here a folder stands where settings.json belongs), config.toml is unchanged and nothing
  # was registered.
  $seatFirstHome = Join-Path $testHome "seat-first-home"
  New-Item -ItemType Directory -Path (Join-Path $seatFirstHome "cache-statusband-codex\settings.json") | Out-Null
  [IO.File]::WriteAllText((Join-Path $seatFirstHome "config.toml"), $original, [Text.UTF8Encoding]::new($false))
  $seatFirstFailed = $false
  try {
    & (Join-Path $root "install.ps1") -CodexHome $seatFirstHome -SkipCliLink -SeatFile (Join-Path $testHome "new-seat.txt") 3>$null | Out-Null
  } catch {
    $seatFirstFailed = $true
  }
  if (-not $seatFirstFailed) { throw "A settings.json that could not be written did not fail the install" }
  if ([IO.File]::ReadAllText((Join-Path $seatFirstHome "config.toml")) -ne $original) { throw "config.toml changed although settings.json could not be written" }
  if (Test-Path -LiteralPath (Join-Path $seatFirstHome "plugins")) { throw "The plugin was registered although settings.json could not be written" }

  # A failed registration with no earlier config.toml says so without claiming that Codex
  # registered the plugin.
  $noBackupHome = Join-Path $testHome "no-backup-home"
  $noBackupWarnings = @()
  $previousPath = $env:PATH
  $noBackupFailed = $false
  try {
    $env:PATH = "$fakeBin$([IO.Path]::PathSeparator)$previousPath"
    try {
      & (Join-Path $root "install.ps1") -CodexHome $noBackupHome -SkipCliLink -WarningVariable noBackupWarnings 3>$null | Out-Null
    } catch {
      $noBackupFailed = $true
    }
  } finally {
    $env:PATH = $previousPath
  }
  if (-not $noBackupFailed) { throw "A failed registration into a fresh home was not reported" }
  if (-not ($noBackupWarnings | Where-Object { "$_" -match "during Codex's own registration step" -and "$_" -match "no earlier config.toml" })) { throw "The no-backup warning did not say the registration step failed: $($noBackupWarnings -join ' | ')" }
  if ($noBackupWarnings | Where-Object { "$_" -match "after Codex registered the plugin" }) { throw "The no-backup warning claimed Codex registered the plugin although registration failed: $($noBackupWarnings -join ' | ')" }

  # Codex registers the plugin and leaves something in config.toml that the installer then
  # cannot edit: a multi-line string, or an array value with an unterminated quote. Either is
  # found after registration, so the refusal must put that fact first, must not say that
  # nothing was installed, registered or changed, and the original config.toml is put back.
  $lateCases = @(
    @{ Name = "multi-line-string"; Append = "echo note = '''x'''>> `"%CODEX_HOME%\config.toml`""; Reason = "multi-line string" },
    @{ Name = "unterminated-array"; Append = "echo [features]>> `"%CODEX_HOME%\config.toml`"`r`n  echo hooks = [^`"a>> `"%CODEX_HOME%\config.toml`""; Reason = "multi-line string, which the installer cannot edit" }
  )
  foreach ($case in $lateCases) {
    $lateBin = Join-Path $testHome "late-refusal-bin-$($case.Name)"
    New-Item -ItemType Directory -Path $lateBin | Out-Null
    $lateCodex = "@echo off`r`nif `"%1`"==`"app-server`" exit /b 0`r`nif `"%1`"==`"plugin`" if `"%2`"==`"marketplace`" if `"%3`"==`"add`" (`r`n  $($case.Append)`r`n  exit /b 0`r`n)`r`nexit /b 0`r`n"
    [IO.File]::WriteAllText((Join-Path $lateBin "codex.cmd"), $lateCodex, [Text.Encoding]::ASCII)
    $lateHome = Join-Path $testHome "late-refusal-home-$($case.Name)"
    New-Item -ItemType Directory -Path $lateHome | Out-Null
    [IO.File]::WriteAllText((Join-Path $lateHome "config.toml"), $original, [Text.UTF8Encoding]::new($false))
    $lateWarnings = @()
    $lateMessage = ""
    $previousPath = $env:PATH
    try {
      $env:PATH = "$lateBin$([IO.Path]::PathSeparator)$previousPath"
      try {
        & (Join-Path $root "install.ps1") -CodexHome $lateHome -SkipCliLink -WarningVariable lateWarnings 3>$null | Out-Null
      } catch {
        $lateMessage = $_.Exception.Message
      }
    } finally {
      $env:PATH = $previousPath
    }
    if (-not $lateMessage) { throw "[$($case.Name)] Something unsupported left by Codex's registration did not fail the install" }
    if ($lateMessage -match "Nothing was installed" -or $lateMessage -match "was not changed") { throw "[$($case.Name)] The refusal after registration still claimed nothing was installed or changed: $lateMessage" }
    if (-not $lateMessage.StartsWith("Codex had already registered the plugin when this was found, so the install stopped part-way; see the warning above for what was done with config.toml.")) { throw "[$($case.Name)] The refusal after registration did not lead with the fact that Codex had registered: $lateMessage" }
    if ($lateMessage -notmatch [regex]::Escape($case.Reason)) { throw "[$($case.Name)] The refusal after registration did not give the reason ($($case.Reason)): $lateMessage" }
    if ($lateMessage -notmatch "run the installer again") { throw "[$($case.Name)] The refusal after registration dropped its advice: $lateMessage" }
    if ($lateMessage -match "warning that follows") { throw "[$($case.Name)] The refusal still says the warning follows: $lateMessage" }
    if ([IO.File]::ReadAllText((Join-Path $lateHome "config.toml")) -ne $original) { throw "[$($case.Name)] config.toml was not restored after a refusal found after registration" }
    if (-not ($lateWarnings | Where-Object { "$_" -match "restored the original config.toml" })) { throw "[$($case.Name)] No warning said config.toml was restored after a refusal found after registration: $($lateWarnings -join ' | ')" }
  }

  # Codex registers the plugin and leaves config.toml as a hard link (a second name for the
  # same file). Resolve-ReplaceTarget refuses that after registration, so like the refusals above
  # it leads with that fact and does not say that nothing was changed.
  $linkBin = Join-Path $testHome "late-link-bin"
  New-Item -ItemType Directory -Path $linkBin | Out-Null
  $linkCodex = "@echo off`r`nif `"%1`"==`"app-server`" exit /b 0`r`nif `"%1`"==`"plugin`" if `"%2`"==`"marketplace`" if `"%3`"==`"add`" (`r`n  move /y `"%CODEX_HOME%\config.toml`" `"%CODEX_HOME%\shared.toml`" >nul`r`n  mklink /H `"%CODEX_HOME%\config.toml`" `"%CODEX_HOME%\shared.toml`" >nul`r`n  exit /b 0`r`n)`r`nexit /b 0`r`n"
  [IO.File]::WriteAllText((Join-Path $linkBin "codex.cmd"), $linkCodex, [Text.Encoding]::ASCII)
  $lateLinkHome = Join-Path $testHome "late-link-home"
  New-Item -ItemType Directory -Path $lateLinkHome | Out-Null
  [IO.File]::WriteAllText((Join-Path $lateLinkHome "config.toml"), $original, [Text.UTF8Encoding]::new($false))
  $lateLinkMessage = ""
  $previousPath = $env:PATH
  try {
    $env:PATH = "$linkBin$([IO.Path]::PathSeparator)$previousPath"
    try {
      & (Join-Path $root "install.ps1") -CodexHome $lateLinkHome -SkipCliLink 3>$null | Out-Null
    } catch {
      $lateLinkMessage = $_.Exception.Message
    }
  } finally {
    $env:PATH = $previousPath
  }
  if (-not $lateLinkMessage) { throw "A config.toml turned into a hard link by Codex's registration did not fail the install" }
  if ($lateLinkMessage -match "Nothing was changed" -or $lateLinkMessage -match "Nothing was installed") { throw "The hard-link refusal after registration still claimed nothing was changed: $lateLinkMessage" }
  if (-not $lateLinkMessage.StartsWith("Codex had already registered the plugin when this was found, so the install stopped part-way; see the warning above for what was done with config.toml.")) { throw "The hard-link refusal after registration did not lead with the fact that Codex had registered: $lateLinkMessage" }
  if ($lateLinkMessage -notmatch "is a hard link, so it has more than one name" -or $lateLinkMessage -notmatch "run the installer again") { throw "The hard-link refusal after registration lost its reason or advice: $lateLinkMessage" }

  # Codex registers the plugin and leaves config.toml as a symbolic link whose target is
  # missing. That is refused after registration with the same lead-in as the other late
  # refusals, not a raw file-read error and not "Nothing was changed". (Skipped where symbolic
  # links cannot be created.)
  $danglingProbe = Join-Path $testHome "late-dangling-probe"
  $danglingLinksWork = $true
  try {
    New-Item -ItemType SymbolicLink -Path $danglingProbe -Target (Join-Path $testHome "late-dangling-probe-target") -ErrorAction Stop | Out-Null
  } catch {
    $danglingLinksWork = $false
    Write-Host "Skipped the after-registration dangling symbolic link test: symbolic links cannot be created here."
  }
  if ($danglingLinksWork) {
    $dangleBin = Join-Path $testHome "late-dangle-bin"
    New-Item -ItemType Directory -Path $dangleBin | Out-Null
    $dangleCodex = "@echo off`r`nif `"%1`"==`"app-server`" exit /b 0`r`nif `"%1`"==`"plugin`" if `"%2`"==`"marketplace`" if `"%3`"==`"add`" (`r`n  del /f /q `"%CODEX_HOME%\config.toml`" >nul`r`n  mklink `"%CODEX_HOME%\config.toml`" `"%CODEX_HOME%\gone-target.toml`" >nul`r`n  exit /b 0`r`n)`r`nexit /b 0`r`n"
    [IO.File]::WriteAllText((Join-Path $dangleBin "codex.cmd"), $dangleCodex, [Text.Encoding]::ASCII)
    $lateDangleHome = Join-Path $testHome "late-dangle-home"
    New-Item -ItemType Directory -Path $lateDangleHome | Out-Null
    [IO.File]::WriteAllText((Join-Path $lateDangleHome "config.toml"), $original, [Text.UTF8Encoding]::new($false))
    $lateDangleMessage = ""
    $previousPath = $env:PATH
    try {
      $env:PATH = "$dangleBin$([IO.Path]::PathSeparator)$previousPath"
      try {
        & (Join-Path $root "install.ps1") -CodexHome $lateDangleHome -SkipCliLink 3>$null | Out-Null
      } catch {
        $lateDangleMessage = $_.Exception.Message
      }
    } finally {
      $env:PATH = $previousPath
    }
    if (-not $lateDangleMessage) { throw "A config.toml turned into a dangling symbolic link by Codex's registration did not fail the install" }
    if ($lateDangleMessage -match "Nothing was changed" -or $lateDangleMessage -match "Nothing was installed") { throw "The dangling-link refusal after registration still claimed nothing was changed: $lateDangleMessage" }
    if (-not $lateDangleMessage.StartsWith("Codex had already registered the plugin when this was found, so the install stopped part-way; see the warning above for what was done with config.toml.")) { throw "The dangling-link refusal after registration did not lead with the fact that Codex had registered (a raw error?): $lateDangleMessage" }
    if ($lateDangleMessage -notmatch "is a symbolic link to .*gone-target\.toml, which does not exist" -or $lateDangleMessage -notmatch "run the installer again") { throw "The dangling-link refusal after registration lost its reason or advice: $lateDangleMessage" }
  }

  # Codex leaves config.toml as a circular chain of symbolic links, or as a link to a folder.
  # Neither can be read or replaced; each is refused after registration with the same lead-in,
  # never a raw read error. (Skipped where symbolic links cannot be created.)
  if ($danglingLinksWork) {
    $oddLinkCases = @(
      @{ Name = "circular"; Make = "mklink `"%CODEX_HOME%\loop-a`" `"%CODEX_HOME%\loop-b`" >nul`r`n  mklink `"%CODEX_HOME%\loop-b`" `"%CODEX_HOME%\loop-a`" >nul`r`n  mklink `"%CODEX_HOME%\config.toml`" `"%CODEX_HOME%\loop-a`" >nul"; Reason = "is a symbolic link that cannot be followed" },
      @{ Name = "folder"; Make = "mkdir `"%CODEX_HOME%\a-folder`"`r`n  mklink /D `"%CODEX_HOME%\config.toml`" `"%CODEX_HOME%\a-folder`" >nul"; Reason = "is a symbolic link to the folder .*a-folder, not to a file" }
    )
    foreach ($case in $oddLinkCases) {
      $oddBin = Join-Path $testHome "late-$($case.Name)-bin"
      New-Item -ItemType Directory -Path $oddBin | Out-Null
      $oddCodex = "@echo off`r`nif `"%1`"==`"app-server`" exit /b 0`r`nif `"%1`"==`"plugin`" if `"%2`"==`"marketplace`" if `"%3`"==`"add`" (`r`n  del /f /q `"%CODEX_HOME%\config.toml`" >nul`r`n  $($case.Make)`r`n  exit /b 0`r`n)`r`nexit /b 0`r`n"
      [IO.File]::WriteAllText((Join-Path $oddBin "codex.cmd"), $oddCodex, [Text.Encoding]::ASCII)
      $oddHome = Join-Path $testHome "late-$($case.Name)-home"
      New-Item -ItemType Directory -Path $oddHome | Out-Null
      [IO.File]::WriteAllText((Join-Path $oddHome "config.toml"), $original, [Text.UTF8Encoding]::new($false))
      $oddMessage = ""
      $previousPath = $env:PATH
      try {
        $env:PATH = "$oddBin$([IO.Path]::PathSeparator)$previousPath"
        try {
          & (Join-Path $root "install.ps1") -CodexHome $oddHome -SkipCliLink 3>$null | Out-Null
        } catch {
          $oddMessage = $_.Exception.Message
        }
      } finally {
        $env:PATH = $previousPath
      }
      if (-not $oddMessage) { throw "A config.toml turned into a $($case.Name) symbolic link by Codex's registration did not fail the install" }
      if (-not $oddMessage.StartsWith("Codex had already registered the plugin when this was found, so the install stopped part-way; see the warning above for what was done with config.toml.")) { throw "The $($case.Name)-link refusal after registration did not lead with the fact that Codex had registered (a raw error?): $oddMessage" }
      if ($oddMessage -notmatch $case.Reason -or $oddMessage -notmatch "run the installer again") { throw "The $($case.Name)-link refusal after registration lost its reason or advice: $oddMessage" }
    }
  }

  # When npm cannot even be run (not on PATH), the failure is still reported as only the link
  # step failing, and the hooks-review and restart lines were already printed before it.
  $noNpmBin = Join-Path $testHome "no-npm-bin"
  New-Item -ItemType Directory -Path $noNpmBin | Out-Null
  [IO.File]::WriteAllText((Join-Path $noNpmBin "codex.cmd"), "@echo off`r`nexit /b 0`r`n", [Text.Encoding]::ASCII)
  $noNpmHome = Join-Path $testHome "no-npm-home"
  $noNpmMessage = ""
  $noNpmOutput = @()
  $previousPath = $env:PATH
  try {
    $env:PATH = "$noNpmBin$([IO.Path]::PathSeparator)$env:SystemRoot/System32"
    try {
      & (Join-Path $root "install.ps1") -CodexHome $noNpmHome 3>$null *>&1 | ForEach-Object { $noNpmOutput += "$_" }
    } catch {
      $noNpmMessage = $_.Exception.Message
    }
  } finally {
    $env:PATH = $previousPath
  }
  if ($noNpmMessage -notmatch "only the terminal command link was not made" -or $noNpmMessage -notmatch "nothing is rolled back") { throw "A missing npm was not described as only the link step failing: '$noNpmMessage'" }
  if ($noNpmMessage -notmatch "Could not check for an existing terminal command link") { throw "A missing npm was not reported as the check for an existing link failing: '$noNpmMessage'" }
  if ($noNpmMessage -match "settings.json") { throw "The link-step message mentioned settings.json although -SeatFile was not used: $noNpmMessage" }
  if (-not (($noNpmOutput -join "`n") -match "open /hooks in Codex to review and trust them") -or -not (($noNpmOutput -join "`n") -match "Restart Codex to load the plugin")) { throw "The hooks-review and restart lines were not printed before the link step: $($noNpmOutput -join ' | ')" }

  # A failing `npm link` is reported as only the link step failing: the plugin stays installed
  # and config.toml keeps its update (nothing is rolled back).
  $npmBin = Join-Path $testHome "npm-bin"
  New-Item -ItemType Directory -Path $npmBin | Out-Null
  [IO.File]::WriteAllText((Join-Path $npmBin "npm.cmd"), "@echo off`r`nif `"%1`"==`"root`" (`r`n  echo %~dp0no-global-root`r`n  exit /b 0`r`n)`r`nexit /b 1`r`n", [Text.Encoding]::ASCII)
  $npmHome = Join-Path $testHome "npm-home"
  $npmMessage = ""
  $previousPath = $env:PATH
  try {
    $env:PATH = "$npmBin$([IO.Path]::PathSeparator)$previousPath"
    try {
      & (Join-Path $root "install.ps1") -CodexHome $npmHome 3>$null | Out-Null
    } catch {
      $npmMessage = $_.Exception.Message
    }
  } finally {
    $env:PATH = $previousPath
  }
  if ($npmMessage -notmatch "npm link failed" -or $npmMessage -notmatch "plugin is already installed" -or $npmMessage -notmatch "only the terminal command link was not made") { throw "A failed npm link was not described as only the link step failing: $npmMessage" }
  if ($npmMessage -match "settings.json") { throw "The npm link message mentioned settings.json although -SeatFile was not used: $npmMessage" }
  $npmConfig = [IO.File]::ReadAllText((Join-Path $npmHome "config.toml"))
  if ($npmConfig -notmatch '(?m)^hooks = true$' -or $npmConfig -notmatch '(?m)^enabled\s*=\s*true\s*$') { throw "A failed npm link rolled back config.toml or the plugin" }

  # The link step enters the plugin folder by its literal path: a checkout whose path holds
  # wildcard characters (here "[1]") is not a pattern. A function named npm records where it ran.
  $bracketRoot = Join-Path $testHome "checkout[1]\codex"
  New-Item -ItemType Directory -Path (Split-Path -Parent $bracketRoot) | Out-Null
  Copy-Item -LiteralPath $root -Destination $bracketRoot -Recurse
  $global:CacheStatusbandTestLinkDir = Join-Path $testHome "bracket-link-dir.txt"
  function global:npm {
    if ($args[0] -eq "root") { $global:LASTEXITCODE = 0; return (Join-Path $env:TEMP "no-global-root") }
    [IO.File]::WriteAllText($global:CacheStatusbandTestLinkDir, (Get-Location).ProviderPath)
    $global:LASTEXITCODE = 0
  }
  $bracketMessage = ""
  try {
    try {
      & (Join-Path $bracketRoot "install.ps1") -CodexHome (Join-Path $testHome "bracket-home") 3>$null | Out-Null
    } catch {
      $bracketMessage = $_.Exception.Message
    }
  } finally {
    Remove-Item -Path Function:npm -ErrorAction SilentlyContinue
  }
  if ($bracketMessage) { throw "A checkout path with wildcard characters failed the install: $bracketMessage" }
  $bracketRan = [IO.File]::ReadAllText($global:CacheStatusbandTestLinkDir)
  if ($bracketRan -ne (Join-Path $bracketRoot "plugins\cache-statusband-codex")) { throw "npm link ran in '$bracketRan', not in the plugin folder of the wildcard-named checkout" }
  Remove-Variable -Name CacheStatusbandTestLinkDir -Scope Global -ErrorAction SilentlyContinue

  # An error while running `npm link` that is not "npm was not found" may have come from npm
  # itself, so it is reported as a failure with its message; only a missing command is "could
  # not be run". A function named npm stands in for the real one here.
  foreach ($linkCase in @(
    @{ Name = "other error"; Body = 'throw "refused by test"'; Expect = 'npm link failed \(refused by test\)'; Reject = 'could not be run' },
    @{ Name = "command not found"; Body = '& cache-statusband-test-no-such-command'; Expect = 'npm link could not be run \('; Reject ='npm link failed' }
  )) {
    $linkHome = Join-Path $testHome ("npm-error-home-" + ($linkCase.Name -replace '\W', '-'))
    $linkMessage = ""
    $global:CacheStatusbandTestLinkBody = [scriptblock]::Create($linkCase.Body)
    function global:npm {
      if ($args[0] -eq "root") { $global:LASTEXITCODE = 0; return (Join-Path $env:TEMP "no-global-root") }
      & $global:CacheStatusbandTestLinkBody
    }
    try {
      try {
        & (Join-Path $root "install.ps1") -CodexHome $linkHome 3>$null | Out-Null
      } catch {
        $linkMessage = $_.Exception.Message
      }
    } finally {
      Remove-Item -Path Function:npm -ErrorAction SilentlyContinue
      Remove-Variable -Name CacheStatusbandTestLinkBody -Scope Global -ErrorAction SilentlyContinue
    }
    if ($linkMessage -notmatch $linkCase.Expect) { throw "[$($linkCase.Name)] The npm link failure was not worded as expected: $linkMessage" }
    if ($linkMessage -match $linkCase.Reject) { throw "[$($linkCase.Name)] The npm link failure used the wrong wording: $linkMessage" }
    if ($linkMessage -notmatch "only the terminal command link was not made") { throw "[$($linkCase.Name)] The npm link failure was not described as only the link step failing: $linkMessage" }
  }

  # Re-running from another checkout path (a move or a fresh clone) re-points the marketplace
  # registration instead of failing with "already added from a different source".
  $copyRoot = Join-Path $testHome "checkout-b\codex"
  New-Item -ItemType Directory -Path (Split-Path -Parent $copyRoot) | Out-Null
  Copy-Item -LiteralPath $root -Destination $copyRoot -Recurse
  $repointHome = Join-Path $testHome "repoint-home"
  $outputA = (& (Join-Path $root "install.ps1") -CodexHome $repointHome -SkipCliLink *>&1 | Out-String)
  if ($outputA -match "Re-pointing") { throw "A first install said it was re-pointing a registration: $outputA" }
  $outputB = (& (Join-Path $copyRoot "install.ps1") -CodexHome $repointHome -SkipCliLink *>&1 | Out-String)
  if ($outputB -notmatch [regex]::Escape("Re-pointing the cache-statusband-codex-local marketplace registration: $root -> $copyRoot")) { throw "Moving the checkout did not say it was re-pointing the registration (old -> new): $outputB" }
  $repointed = [IO.File]::ReadAllText((Join-Path $repointHome "config.toml"))
  $sourceLine = [regex]::Match($repointed, '(?m)^\[marketplaces\.cache-statusband-codex-local\]\s*\r?\n(?:.*\r?\n)*?source\s*=\s*(?<value>.+?)\s*$').Groups['value'].Value
  if (-not $sourceLine.ToLowerInvariant().Contains("checkout-b")) { throw "The marketplace source is not the new checkout: $sourceLine" }
  $repointedPlugin = [regex]::Match($repointed, '(?ms)^\[plugins\."cache-statusband-codex@cache-statusband-codex-local"\]\s*\r?\n(?<body>.*?)(?=^\[|\z)')
  if (-not $repointedPlugin.Success -or $repointedPlugin.Groups['body'].Value -notmatch '(?m)^enabled\s*=\s*true\s*$') { throw "The plugin is not enabled after re-pointing the registration" }
  if ([regex]::Matches($repointed, '(?m)^\[marketplaces\.cache-statusband-codex-local\]').Count -ne 1) { throw "Re-pointing left the marketplace registered more than once" }
  # Running again from the same (new) path leaves the registration alone.
  $outputB2 = (& (Join-Path $copyRoot "install.ps1") -CodexHome $repointHome -SkipCliLink *>&1 | Out-String)
  if ($outputB2 -match "Re-pointing") { throw "Re-running from the registered checkout re-pointed the registration: $outputB2" }

  # Codex's own refusal ("already added from a different source") is what triggers a re-point,
  # not a comparison of paths: a junction to the same checkout is the same source and must not
  # say it is re-pointing.
  $junctionPath = Join-Path $testHome "junction-codex"
  $junctionMade = $false
  try {
    New-Item -ItemType Junction -Path $junctionPath -Target $root | Out-Null
    $junctionMade = $true
  } catch {
    Write-Host "Skipped the junction re-point check: a junction could not be created ($($_.Exception.Message))"
  }
  if ($junctionMade) {
    try {
      $junctionHome = Join-Path $testHome "junction-home"
      $junctionFirst = (& (Join-Path $root "install.ps1") -CodexHome $junctionHome -SkipCliLink *>&1 | Out-String)
      $junctionSecond = (& (Join-Path $junctionPath "install.ps1") -CodexHome $junctionHome -SkipCliLink *>&1 | Out-String)
      if ($junctionSecond -match "Re-pointing") { throw "Installing again through a junction to the same checkout said it was re-pointing: $junctionSecond" }
      if ([regex]::Matches([IO.File]::ReadAllText((Join-Path $junctionHome "config.toml")), '(?m)^\[marketplaces\.cache-statusband-codex-local\]').Count -ne 1) { throw "The junction install registered the marketplace more than once" }
    } finally {
      [IO.Directory]::Delete($junctionPath)
    }
  }

  # A re-point whose remove succeeds but whose second add fails: the original config.toml
  # (with the old marketplace source) is back, and settings.json is put back as it was. The fake
  # codex refuses the first add as "already added from a different source", the remove
  # deletes the registration from config.toml, and the second add fails.
  $failAddBin = Join-Path $testHome "fail-add-bin"
  New-Item -ItemType Directory -Path $failAddBin | Out-Null
  $failAddCodex = @'
@echo off
if "%1"=="app-server" exit /b 0
if not "%1"=="plugin" exit /b 0
if not "%2"=="marketplace" exit /b 0
if "%3"=="remove" goto remove
if not "%3"=="add" exit /b 0
if exist "%FAKE_STATE%\removed" goto secondadd
echo Error: marketplace 'cache-statusband-codex-local' is already added from a different source; remove it before adding this source 1>&2
exit /b 1
:secondadd
echo Error: second add failed 1>&2
exit /b 1
:remove
echo [history]> "%CODEX_HOME%\config.toml"
echo.> "%FAKE_STATE%\removed"
exit /b 0
'@
  [IO.File]::WriteAllText((Join-Path $failAddBin "codex.cmd"), $failAddCodex, [Text.Encoding]::ASCII)
  $failAddHome = Join-Path $testHome "fail-add-home"
  $failAddState = Join-Path $testHome "fail-add-state"
  New-Item -ItemType Directory -Path (Join-Path $failAddHome "cache-statusband-codex"), $failAddState | Out-Null
  $oldSourceConfig = "[history]`npersistence = `"save-all`"`n`n[marketplaces.cache-statusband-codex-local]`nsource_type = `"local`"`nsource = '\\?\C:\old\checkout'`n"
  [IO.File]::WriteAllText((Join-Path $failAddHome "config.toml"), $oldSourceConfig, [Text.UTF8Encoding]::new($false))
  $failAddSettingsPath = Join-Path $failAddHome "cache-statusband-codex\settings.json"
  $failAddEarlier = "{`"version`":1,`"seatFile`":`"earlier-seat.txt`"}`n"
  [IO.File]::WriteAllText($failAddSettingsPath, $failAddEarlier, [Text.UTF8Encoding]::new($false))
  $failAddOutput = @()
  $failAddFailed = $false
  $previousPath = $env:PATH
  try {
    $env:PATH = "$failAddBin$([IO.Path]::PathSeparator)$previousPath"
    $env:FAKE_STATE = $failAddState
    try {
      & (Join-Path $root "install.ps1") -CodexHome $failAddHome -SkipCliLink -SeatFile (Join-Path $testHome "new-seat.txt") -WarningVariable failAddWarnings *>&1 | ForEach-Object { $failAddOutput += "$_" }
    } catch {
      $failAddFailed = $true
    }
  } finally {
    $env:PATH = $previousPath
    Remove-Item Env:FAKE_STATE -ErrorAction SilentlyContinue
  }
  if (-not $failAddFailed) { throw "A re-point whose second add failed was not reported" }
  if (-not (($failAddOutput -join "`n") -match [regex]::Escape("Re-pointing the cache-statusband-codex-local marketplace registration: C:\old\checkout -> $root"))) { throw "The re-point did not name the old and new source: $($failAddOutput -join ' | ')" }
  if ([IO.File]::ReadAllText((Join-Path $failAddHome "config.toml")) -ne $oldSourceConfig) { throw "The old marketplace source is not back in config.toml after the re-point failed" }
  if ([IO.File]::ReadAllText($failAddSettingsPath) -ne $failAddEarlier) { throw "settings.json was not put back after the re-point failed" }

  # A config.toml that is a symbolic link stays a link: the edit lands on the file it points
  # at. The same for settings.json. (Skipped, with a message, where a link cannot be made.)
  $linkHome = Join-Path $testHome "link-home"
  $linkReal = Join-Path $testHome "link-real"
  New-Item -ItemType Directory -Path $linkHome, $linkReal, (Join-Path $linkHome "cache-statusband-codex") | Out-Null
  $realConfig = Join-Path $linkReal "real-config.toml"
  $realSettings = Join-Path $linkReal "real-settings.json"
  [IO.File]::WriteAllText($realConfig, "[history]`npersistence = `"save-all`"`n", [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($realSettings, "{`"version`":1,`"seatFile`":`"old-seat.txt`"}`n", [Text.UTF8Encoding]::new($false))
  $linksMade = $true
  try {
    New-Item -ItemType SymbolicLink -Path (Join-Path $linkHome "config.toml") -Target $realConfig -ErrorAction Stop | Out-Null
    New-Item -ItemType SymbolicLink -Path (Join-Path $linkHome "cache-statusband-codex\settings.json") -Target $realSettings -ErrorAction Stop | Out-Null
  } catch {
    $linksMade = $false
    Write-Host "SKIPPED the symbolic-link test: a symbolic link cannot be created here ($($_.Exception.Message))"
  }
  if ($linksMade) {
    & (Join-Path $root "install.ps1") -CodexHome $linkHome -SkipCliLink -SeatFile (Join-Path $linkReal "link-seat.txt") 3>$null | Out-Null
    foreach ($linkName in @("config.toml", "cache-statusband-codex\settings.json")) {
      if ((Get-Item -LiteralPath (Join-Path $linkHome $linkName) -Force).LinkType -ne "SymbolicLink") { throw "$linkName stopped being a symbolic link after the install" }
    }
    $linkedConfig = [IO.File]::ReadAllText($realConfig)
    if ($linkedConfig -notmatch '(?m)^hooks = true$' -or $linkedConfig -notmatch '(?m)^status_line_use_colors = true$') {
      throw "The file config.toml links to did not get the plugin's edit"
    }
    if ([IO.File]::ReadAllText($realSettings) -notmatch "link-seat\.txt") { throw "The file settings.json links to did not get the new seat" }
    if (@(Get-ChildItem -LiteralPath $linkReal -Force -File | Where-Object { $_.Name -like "*.tmp" }).Count -ne 0) { throw "A temporary file was left beside the link targets" }
  }

  # A hard-linked config.toml is refused before anything is changed or registered.
  $hardHome = Join-Path $testHome "hard-home"
  New-Item -ItemType Directory -Path $hardHome | Out-Null
  $hardOriginal = "[history]`npersistence = `"save-all`"`n"
  $hardOther = Join-Path $testHome "hard-other.toml"
  [IO.File]::WriteAllText($hardOther, $hardOriginal, [Text.UTF8Encoding]::new($false))
  New-Item -ItemType HardLink -Path (Join-Path $hardHome "config.toml") -Target $hardOther | Out-Null
  $hardMessage = ""
  try {
    & (Join-Path $root "install.ps1") -CodexHome $hardHome -SkipCliLink 3>$null | Out-Null
  } catch {
    $hardMessage = $_.Exception.Message
  }
  if ($hardMessage -notmatch "hard link") { throw "A hard-linked config.toml was not refused with a hard-link message: $hardMessage" }
  if ([IO.File]::ReadAllText((Join-Path $hardHome "config.toml")) -ne $hardOriginal -or [IO.File]::ReadAllText($hardOther) -ne $hardOriginal) { throw "A refused hard-linked config.toml was changed" }
  if (Test-Path -LiteralPath (Join-Path $hardHome "backups")) { throw "A refused hard-linked config.toml still took a backup (something was changed)" }

  # A symbolic link whose target is a hard-linked file is refused as well: the replacement would
  # land on the target and leave its other names with the old content.
  if ($linksMade) {
    $hardLinkHome = Join-Path $testHome "symlink-to-hard-home"
    New-Item -ItemType Directory -Path $hardLinkHome | Out-Null
    $hardLinkTarget = Join-Path $testHome "symlink-to-hard-target.toml"
    $hardLinkOther = Join-Path $testHome "symlink-to-hard-other.toml"
    [IO.File]::WriteAllText($hardLinkTarget, $hardOriginal, [Text.UTF8Encoding]::new($false))
    New-Item -ItemType HardLink -Path $hardLinkOther -Target $hardLinkTarget | Out-Null
    New-Item -ItemType SymbolicLink -Path (Join-Path $hardLinkHome "config.toml") -Target $hardLinkTarget | Out-Null
    $hardLinkMessage = ""
    try {
      & (Join-Path $root "install.ps1") -CodexHome $hardLinkHome -SkipCliLink 3>$null | Out-Null
    } catch {
      $hardLinkMessage = $_.Exception.Message
    }
    if ($hardLinkMessage -notmatch "hard link") { throw "A symbolic link to a hard-linked config.toml was not refused with a hard-link message: $hardLinkMessage" }
    if ([IO.File]::ReadAllText($hardLinkTarget) -ne $hardOriginal -or [IO.File]::ReadAllText($hardLinkOther) -ne $hardOriginal) { throw "A refused symbolic link to a hard-linked file still changed it" }
    if (Test-Path -LiteralPath (Join-Path $hardLinkHome "backups")) { throw "A refused link to a hard-linked config.toml still took a backup (something was changed)" }

    # A symbolic link whose target does not exist is refused with a clear message before any
    # change, for config.toml and (with -SeatFile) settings.json, not a raw file-not-found.
    foreach ($dangling in @("config.toml", "settings.json")) {
      $danglingHome = Join-Path $testHome "dangling-$dangling-home"
      New-Item -ItemType Directory -Path (Join-Path $danglingHome "cache-statusband-codex") | Out-Null
      $danglingLink = if ($dangling -eq "config.toml") { Join-Path $danglingHome "config.toml" } else { Join-Path $danglingHome "cache-statusband-codex\settings.json" }
      New-Item -ItemType SymbolicLink -Path $danglingLink -Target (Join-Path $testHome "does-not-exist-$dangling") | Out-Null
      $danglingMessage = ""
      try {
        & (Join-Path $root "install.ps1") -CodexHome $danglingHome -SkipCliLink -SeatFile (Join-Path $testHome "seat.txt") 3>$null | Out-Null
      } catch {
        $danglingMessage = $_.Exception.Message
      }
      if ($danglingMessage -notmatch "symbolic link to .*does-not-exist-$([regex]::Escape($dangling)), which does not exist" -or $danglingMessage -notmatch "Nothing was changed") {
        throw "A dangling symbolic $dangling was not refused with the missing-target message: $danglingMessage"
      }
      if (Test-Path -LiteralPath (Join-Path $danglingHome "backups")) { throw "A refused dangling $dangling still took a backup" }
      if (Test-Path -LiteralPath (Join-Path $danglingHome "plugins")) { throw "A refused dangling $dangling still installed the plugin" }
    }
  }

  # PowerShell's Constrained Language Mode cannot run the installer: it stops before anything
  # is changed, with one clear message.
  $clmHome = Join-Path $testHome "clm-home"
  $clmScript = Join-Path $testHome "run-in-clm.ps1"
  [IO.File]::WriteAllText($clmScript, @'
$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'
try { & $args[0] -CodexHome $args[1] -SkipCliLink } catch { $_.Exception.Message }
'@)
  $clmOutput = (& (Get-Process -Id $PID).Path -NoProfile -File $clmScript (Join-Path $root "install.ps1") $clmHome 2>&1 | Out-String)
  if ($clmOutput -notmatch "needs PowerShell's FullLanguage mode" -or $clmOutput -notmatch "Nothing was changed") { throw "Constrained Language Mode was not refused with the FullLanguage message: $clmOutput" }
  if (Test-Path -LiteralPath $clmHome) { throw "A refused Constrained Language Mode run still created the Codex home" }

  # When the native replace cannot be compiled, Move-FileOverExisting falls back to
  # Move-Item -Force and warns once (simulated here by an Add-Type that throws).
  $moveDefinition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq "Move-FileOverExisting" }, $true)
  $fallbackScript = Join-Path $testHome "move-fallback.ps1"
  [IO.File]::WriteAllText($fallbackScript, "function Add-Type { throw 'simulated: Add-Type is not allowed' }`n" + $moveDefinition.Extent.Text + @'

$folder = $args[0]
foreach ($n in 1..2) {
  [IO.File]::WriteAllText("$folder\from-$n.txt", "new-$n")
  [IO.File]::WriteAllText("$folder\to.txt", "old")
  Move-FileOverExisting "$folder\from-$n.txt" "$folder\to.txt"
}
[IO.File]::ReadAllText("$folder\to.txt")
'@)
  $fallbackFolder = Join-Path $testHome "move-fallback"
  New-Item -ItemType Directory -Path $fallbackFolder | Out-Null
  $fallbackOutput = @(& (Get-Process -Id $PID).Path -NoProfile -File $fallbackScript $fallbackFolder 3>&1 | ForEach-Object { "$_" })
  if ($fallbackOutput[-1] -ne "new-2") { throw "The Move-Item fallback did not replace the file: $($fallbackOutput -join ' | ')" }
  if (@($fallbackOutput | Where-Object { $_ -match "not atomic" }).Count -ne 1) { throw "The fallback did not warn exactly once that the replace is not atomic: $($fallbackOutput -join ' | ')" }

  # A foreign edit seen on the retry, then a failed validation: config.toml is NOT put back
  # to the backup (that would erase the other program's edit); the warning names the backup.
  $foreignBin = Join-Path $testHome "foreign-bin"
  New-Item -ItemType Directory -Path $foreignBin | Out-Null
  $foreignCodex = @'
@echo off
if "%1"=="plugin" if "%2"=="add" (
  echo.> "%FAKE_STATE%\armed"
  exit /b 0
)
if not "%1"=="app-server" exit /b 0
if not exist "%FAKE_STATE%\armed" exit /b 0
if exist "%FAKE_STATE%\done" (
  findstr /C:"edited by someone else" "%CODEX_HOME%\config.toml" >nul
  if errorlevel 1 exit /b 0
  findstr /C:"status_line_use_colors" "%CODEX_HOME%\config.toml" >nul
  if errorlevel 1 exit /b 0
  echo unknown field status_line_use_colors
  exit /b 1
)
echo.> "%FAKE_STATE%\done"
echo # edited by someone else>> "%FAKE_LIVE%"
exit /b 0
'@
  [IO.File]::WriteAllText((Join-Path $foreignBin "codex.cmd"), $foreignCodex, [Text.Encoding]::ASCII)
  $foreignHome = Join-Path $testHome "foreign-home"
  $foreignState = Join-Path $testHome "foreign-state"
  New-Item -ItemType Directory -Path $foreignHome, $foreignState | Out-Null
  $foreignOriginal = "[history]`npersistence = `"save-all`"`n"
  [IO.File]::WriteAllText((Join-Path $foreignHome "config.toml"), $foreignOriginal, [Text.UTF8Encoding]::new($false))
  $previousPath = $env:PATH
  $foreignMessage = ""
  $foreignWarnings = @()
  try {
    $env:PATH = "$foreignBin$([IO.Path]::PathSeparator)$previousPath"
    $env:FAKE_STATE = $foreignState
    $env:FAKE_LIVE = Join-Path $foreignHome "config.toml"
    try {
      & (Join-Path $root "install.ps1") -CodexHome $foreignHome -SkipCliLink -WarningVariable foreignWarnings 3>$null | Out-Null
    } catch {
      $foreignMessage = $_.Exception.Message
    }
  } finally {
    $env:PATH = $previousPath
    Remove-Item Env:FAKE_STATE, Env:FAKE_LIVE -ErrorAction SilentlyContinue
  }
  if ($foreignMessage -notmatch "rejected the candidate") { throw "The retried candidate was expected to fail validation: $foreignMessage" }
  $foreignAfter = [IO.File]::ReadAllText((Join-Path $foreignHome "config.toml"))
  if ($foreignAfter -notmatch '(?m)^# edited by someone else\r?$') { throw "A failure after an absorbed foreign edit restored the backup over that edit" }
  $foreignBackup = @(Get-ChildItem -LiteralPath (Join-Path $foreignHome "backups") -Recurse -Filter config.toml | Select-Object -First 1)
  if (-not ($foreignWarnings | Where-Object { "$_" -match "was not restored" -and "$_" -match [regex]::Escape($foreignBackup[0].FullName) })) {
    throw "The warning did not say config.toml was not restored and name the backup: $($foreignWarnings -join ' | ')"
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
  # The reader runs until the writer says it is finished (a safety deadline only stops a hang),
  # and counts only the opens made while the replacements were running.
  $swapState = [hashtable]::Synchronized(@{ Writing = $false; Done = $false })
  $swapReader = Start-ThreadJob -ArgumentList $swapTarget, $swapState -ScriptBlock {
    param($path, $state)
    $missing = 0
    $attempts = 0
    $deadline = [DateTime]::UtcNow.AddSeconds(120)
    while (-not $state.Done -and [DateTime]::UtcNow -lt $deadline) {
      if ($state.Writing) { $attempts += 1 }
      try {
        # Opened the way Node and Codex open files: allowing the file to be replaced under it.
        $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
        $stream.Dispose()
      } catch [IO.FileNotFoundException] { $missing += 1 } catch { }
    }
    [pscustomobject]@{ Missing = $missing; Attempts = $attempts }
  }
  Start-Sleep -Milliseconds 200
  $swapState.Writing = $true
  try {
    for ($n = 1; $n -le 1500; $n += 1) {
      $swapCandidate = Join-Path $swapFolder "candidate-$n.tmp"
      [IO.File]::WriteAllText($swapCandidate, "$n")
      Move-FileOverExisting $swapCandidate $swapTarget
    }
  } finally {
    $swapState.Done = $true
  }
  $swapResult = Receive-Job -Job $swapReader -Wait -AutoRemoveJob
  if ($swapResult.Missing -ne 0) { throw "A reader found the replaced file missing $($swapResult.Missing) time(s)" }
  # The reader must have been opening the file the whole time the replacements ran: a loop
  # that barely opened it could not have caught a gap, so a low count is a failed test.
  if ($swapResult.Attempts -le 100) { throw "The reader opened the file only $($swapResult.Attempts) times while the replacements ran, too few to show the replacements never left a gap" }
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
