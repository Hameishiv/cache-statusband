#Requires -Version 7.2
[CmdletBinding()]
param(
  [string]$CodexHome = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }),
  [string]$SeatFile,
  [switch]$SkipCliLink,
  [switch]$KeepExistingFooter
)

$ErrorActionPreference = "Stop"

# A relative -CodexHome follows the PowerShell location, not the process working
# directory that Codex and Node would later see.
$CodexHome = $PSCmdlet.GetUnresolvedProviderPathFromPSPath($CodexHome)

# A backup folder name that no earlier run can have used, even within the same second.
function New-BackupFolder([string]$Name) {
  $unique = (Get-Date -Format "yyyyMMdd-HHmmss") + "-" + [guid]::NewGuid().ToString("N").Substring(0, 8)
  $path = Join-Path (Join-Path $CodexHome "backups") "$Name-$unique"
  if (Test-Path -LiteralPath $path) { throw "Backup folder already exists: $path" }
  New-Item -ItemType Directory -Force -Path $path | Out-Null
  return $path
}

# Replaces $Destination with $Source in one step, so a reader opening $Destination at any
# moment finds the old file or the new one and never a missing file. On Windows that is an
# atomic replace (MoveFileEx with MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH);
# PowerShell's Move-Item -Force deletes the destination first, and a reader in that gap gets
# "file not found" (measured). Elsewhere a rename already replaces atomically. When the
# native call cannot be compiled (PowerShell's Constrained Language Mode refuses Add-Type)
# it falls back to Move-Item -Force and says once that the replace is then not atomic.
$script:nativeMoveWarned = $false
function Move-FileOverExisting([string]$Source, [string]$Destination) {
  if (-not $IsWindows) {
    Move-Item -LiteralPath $Source -Destination $Destination -Force
    return
  }
  try {
    if (-not ('CacheStatusband.NativeMove' -as [type])) {
      Add-Type -Namespace CacheStatusband -Name NativeMove -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
private static extern bool MoveFileExW(string existing, string replacement, uint flags);
public static void Replace(string source, string destination) {
  for (int attempt = 1; ; attempt++) {
    if (MoveFileExW(source, destination, 0x1 | 0x8)) { return; }
    int error = System.Runtime.InteropServices.Marshal.GetLastWin32Error();
    // 5 = access denied, 32 = sharing violation: another program (a scanner, a reader that
    // did not allow the replace) briefly has the file open. Try again shortly.
    if ((error == 5 || error == 32) && attempt < 10) { System.Threading.Thread.Sleep(50); continue; }
    throw new System.ComponentModel.Win32Exception(error, "Could not replace " + destination);
  }
}
'@
    }
  } catch {
    if (-not $script:nativeMoveWarned) {
      $script:nativeMoveWarned = $true
      Write-Warning "Could not set up an atomic file replace ($($_.Exception.Message)); replacing files with Move-Item -Force instead, which is not atomic: a program opening the file at that very moment could briefly find it missing."
    }
    Move-Item -LiteralPath $Source -Destination $Destination -Force
    return
  }
  [CacheStatusband.NativeMove]::Replace($Source, $Destination)
}

# The path a replacement of $Path must be made at. A plain file is itself. A symbolic link
# resolves to the file it points at, so the replacement lands on that file and the link stays
# a link (replacing the link itself would turn it into a regular file and leave the original
# it pointed at behind). A hard link is refused: a replacement would give this name new
# content and leave every other name for the old file with the old content.
function Resolve-ReplaceTarget([string]$Path, [string]$What) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if (-not $item) { return $Path }
  if ($item.LinkType -eq "HardLink") {
    throw "$What ($Path) is a hard link, so it has more than one name. Replacing it would leave the other names with the old content. Nothing was changed. Replace it with a regular file (or keep only the name you edit) and run the installer again."
  }
  if ($item.LinkType -eq "SymbolicLink") {
    $target = [IO.File]::ResolveLinkTarget($Path, $true)
    if ($target) { return $target.FullName }
  }
  return $Path
}

# The text of a file, or $null when there is none; and whether two such readings are the same.
function Read-TextOrNull([string]$Path) {
  if (Test-Path -LiteralPath $Path) { return [IO.File]::ReadAllText($Path) }
  return $null
}
function Test-SameText([AllowNull()][string]$A, [AllowNull()][string]$B) {
  if ($null -eq $A -or $null -eq $B) { return ($null -eq $A -and $null -eq $B) }
  return $A -ceq $B
}

function Set-TomlKey {
  param(
    [Parameter(Mandatory)][AllowEmptyString()][string]$Text,
    [Parameter(Mandatory)][string]$Section,
    [Parameter(Mandatory)][string]$Key,
    [Parameter(Mandatory)][string]$Value
  )

  if ($Text.Contains("'''") -or $Text.Contains('"""')) {
    throw "Cannot safely edit config.toml because it contains TOML multiline strings; configure hooks/footer manually or remove the multiline string first"
  }

  $lines = [Collections.Generic.List[string]]::new()
  foreach ($line in ($Text -split "`r?`n")) { $lines.Add($line) }
  while ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq "") { $lines.RemoveAt($lines.Count - 1) }
  # A byte-order mark is not whitespace, so left on the first line it would hide a header
  # there from every pattern below and the section would be added a second time.
  if ($lines.Count -gt 0 -and $lines[0].Length -gt 0 -and $lines[0][0] -eq [char]0xFEFF) { $lines[0] = $lines[0].Substring(1) }

  # How deep in brackets each line STARTS: a line inside a multi-line array (such as a
  # nested array's "[1, 2]," line) is a value, never a table header or a top-level key.
  $startDepth = [int[]]::new($lines.Count)
  $depth = 0
  for ($i = 0; $i -lt $lines.Count; $i += 1) {
    $startDepth[$i] = $depth
    $depth = [Math]::Max(0, $depth + (Get-TomlBracketDelta -Line $lines[$i]))
  }

  # A table written some other way than a plain [Section] header (dotted keys or an inline
  # table at the top level, a quoted header) would make the [Section] we append a duplicate
  # table, which Codex rejects. Refuse rather than guess how to merge into it.
  $sectionName = '(?:' + [Regex]::Escape($Section) + '|"' + [Regex]::Escape($Section) + '"|''' + [Regex]::Escape($Section) + ''')'
  $quotedHeaderPattern = '^\s*\[\s*["'']' + [Regex]::Escape($Section) + '["'']\s*\]'
  $topLevelPattern = '^\s*' + $sectionName + '\s*(?:\.|=)'
  $skipHint = if ($Section -eq "tui") { ", or rerun with -KeepExistingFooter to skip the footer edit" } else { "" }
  $inRootTable = $true
  for ($i = 0; $i -lt $lines.Count; $i += 1) {
    $line = $lines[$i]
    if ($startDepth[$i] -gt 0) { continue }
    if ($line -match $quotedHeaderPattern) {
      throw "config.toml defines [$Section] with a quoted header; configure the footer and hooks manually, or rewrite it as a plain [$Section] table first$skipHint"
    }
    if ($line -match '^\s*\[') { $inRootTable = $false }
    if ($inRootTable -and $line -match $topLevelPattern) {
      throw "config.toml defines the $Section table with dotted keys or an inline table; configure the footer and hooks manually, or rewrite it as a plain [$Section] table first$skipHint"
    }
  }

  $header = "[$Section]"
  $sectionPattern = '^\s*\[\s*' + [Regex]::Escape($Section) + '\s*\]\s*(?:#.*)?$'
  $sectionStarts = @()
  for ($i = 0; $i -lt $lines.Count; $i += 1) {
    if ($startDepth[$i] -eq 0 -and $lines[$i] -match $sectionPattern) { $sectionStarts += $i }
  }
  if ($sectionStarts.Count -gt 1) { throw "config.toml contains more than one [$Section] section" }
  $sectionStart = if ($sectionStarts.Count -eq 1) { $sectionStarts[0] } else { -1 }

  if ($sectionStart -lt 0) {
    if ($lines.Count -gt 0) { $lines.Add("") }
    $lines.Add($header)
    $lines.Add("$Key = $Value")
    return ($lines -join "`n") + "`n"
  }

  $sectionEnd = $lines.Count
  for ($i = $sectionStart + 1; $i -lt $lines.Count; $i += 1) {
    if ($startDepth[$i] -eq 0 -and $lines[$i] -match '^\s*\[{1,2}[^\]]') { $sectionEnd = $i; break }
  }
  $keyPattern = '^\s*' + [Regex]::Escape($Key) + '\s*='
  $keyLines = @()
  for ($i = $sectionStart + 1; $i -lt $sectionEnd; $i += 1) {
    if ($startDepth[$i] -eq 0 -and $lines[$i] -match $keyPattern) { $keyLines += $i }
  }
  if ($keyLines.Count -gt 1) { throw "config.toml contains more than one $Key assignment in [$Section]" }
  if ($keyLines.Count -eq 1) {
    $start = $keyLines[0]
    $equals = $lines[$start].IndexOf('=')
    $end = Find-TomlValueEnd -Lines $lines -Start $start -Equals $equals -Section $Section -Key $Key
    for ($i = $end; $i -ge $start; $i -= 1) { $lines.RemoveAt($i) }
    $lines.Insert($start, "$Key = $Value")
    return ($lines -join "`n") + "`n"
  }
  $lines.Insert($sectionStart + 1, "$Key = $Value")
  return ($lines -join "`n") + "`n"
}

# Net change in bracket depth over one line: [ and ] outside strings and comments. (Multi-line
# strings are refused before this is used, so a quote never stays open past the line.)
function Get-TomlBracketDelta {
  param([Parameter(Mandatory)][AllowEmptyString()][string]$Line)

  $delta = 0
  $quote = [char]0
  $escaped = $false
  foreach ($char in $Line.ToCharArray()) {
    if ($quote -ne [char]0) {
      if ($quote -eq '"' -and $escaped) { $escaped = $false; continue }
      if ($quote -eq '"' -and $char -eq '\') { $escaped = $true; continue }
      if ($char -eq $quote) { $quote = [char]0 }
      continue
    }
    if ($char -eq '#') { break }
    if ($char -eq '"' -or $char -eq "'") { $quote = $char; continue }
    if ($char -eq '[') { $delta += 1 } elseif ($char -eq ']') { $delta -= 1 }
  }
  return $delta
}

function Find-TomlValueEnd {
  param(
    [Collections.Generic.List[string]]$Lines,
    [Parameter(Mandatory)][int]$Start,
    [Parameter(Mandatory)][int]$Equals,
    [Parameter(Mandatory)][string]$Section,
    [Parameter(Mandatory)][string]$Key
  )

  $first = $Lines[$Start].Substring($Equals + 1).TrimStart()
  if ($first -match '^(true|false)\s*(?:#.*)?$') { return $Start }
  if (-not $first.StartsWith('[')) {
    throw "Cannot safely replace [$Section].$Key because its existing value is not a boolean or array"
  }

  $depth = 0
  $seenArray = $false
  $quote = [char]0
  $escaped = $false
  for ($lineIndex = $Start; $lineIndex -lt $Lines.Count; $lineIndex += 1) {
    $line = $Lines[$lineIndex]
    $column = if ($lineIndex -eq $Start) { $Equals + 1 } else { 0 }
    for (; $column -lt $line.Length; $column += 1) {
      $char = $line[$column]
      if ($quote -ne [char]0) {
        if ($quote -eq '"' -and $escaped) { $escaped = $false; continue }
        if ($quote -eq '"' -and $char -eq '\') { $escaped = $true; continue }
        if ($char -eq $quote) { $quote = [char]0 }
        continue
      }
      if ($char -eq '#') { break }
      if ($char -eq '"' -or $char -eq "'") { $quote = $char; continue }
      if ($char -eq '[') { $depth += 1; $seenArray = $true; continue }
      if ($char -eq ']') {
        $depth -= 1
        if ($depth -lt 0) { throw "Malformed array in [$Section].$Key" }
        if ($seenArray -and $depth -eq 0) {
          $rest = $line.Substring($column + 1)
          if ($rest -notmatch '^\s*(?:#.*)?$') { throw "Unexpected text after [$Section].$Key" }
          return $lineIndex
        }
      }
    }
    if ($quote -ne [char]0) {
      throw "Cannot safely replace [$Section].$Key because multiline strings are not supported"
    }
  }
  throw "Unterminated array in [$Section].$Key"
}

# Codex's reason for a failed startup check: its JSON error's data.detail (else message)
# when the output holds one, otherwise the output itself minus "WARNING:" lines; only then
# shortened to 500 characters.
function Get-CodexFailureDetail {
  param([AllowNull()]$Output)

  $lines = @(@($Output) | ForEach-Object { "$_" } | Where-Object { $_ -notmatch '^\s*WARNING:' })
  foreach ($line in $lines) {
    if ($line -notmatch '^\s*\{') { continue }
    try {
      $parsed = $line | ConvertFrom-Json -ErrorAction Stop
      $reason = if ($parsed.error.data.detail) { [string]$parsed.error.data.detail } elseif ($parsed.error.message) { [string]$parsed.error.message } else { "" }
      if ($reason.Trim()) { return ($reason.Trim() -replace '\s+', ' ') }
    } catch { }
  }
  $detail = (($lines | Out-String).Trim() -replace '\s+', ' ')
  if ($detail.Length -gt 500) { $detail = $detail.Substring(0, 500) }
  return $detail
}

# Runs Codex's startup config check on $Text in a throwaway CODEX_HOME: strict
# (--strict-config, which also rejects unknown keys) or plain. Returns Passed, CouldNotRun
# (the check itself did not run: spawn failure or Codex does not know the flag, which says
# nothing about the config) and Detail (Codex's reason).
function Test-CodexConfig {
  param(
    [Parameter(Mandatory)][AllowEmptyString()][string]$Text,
    [Parameter(Mandatory)][string]$CodexCommand,
    [switch]$Strict
  )

  $validationHome = Join-Path ([IO.Path]::GetTempPath()) ("cache-statusband-config-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $validationHome | Out-Null
  $previousCodexHome = $env:CODEX_HOME
  try {
    [IO.File]::WriteAllText((Join-Path $validationHome "config.toml"), $Text, [Text.UTF8Encoding]::new($false))
    $env:CODEX_HOME = $validationHome
    try {
      $checkArguments = @("app-server") + $(if ($Strict) { @("--strict-config") } else { @() }) + @("--print-startup-config")
      $validationOutput = & $CodexCommand @checkArguments 2>&1
    } catch {
      return [pscustomobject]@{ Passed = $false; CouldNotRun = $true; Detail = $_.Exception.Message }
    }
    if ($LASTEXITCODE -eq 0) { return [pscustomobject]@{ Passed = $true; CouldNotRun = $false; Detail = "" } }
    $detail = Get-CodexFailureDetail -Output $validationOutput
    $couldNotRun = $detail -match 'unexpected argument|unrecognized (option|subcommand)|Usage: codex'
    return [pscustomobject]@{ Passed = $false; CouldNotRun = $couldNotRun; Detail = $detail }
  } finally {
    $env:CODEX_HOME = $previousCodexHome
    if (Test-Path -LiteralPath $validationHome) {
      $resolved = (Resolve-Path -LiteralPath $validationHome).Path
      if ($resolved -eq $validationHome) { [IO.Directory]::Delete($resolved, $true) }
    }
  }
}

# Validates by difference. A config.toml that Codex's strict check already rejects (for
# example one holding a retired key, which plain startup tolerates) must not block the
# install, so the original is checked first: when it passes, the candidate has to pass the
# strict check too. When the original already fails the strict check, the candidate is
# checked with plain startup instead (no --strict-config): a candidate Codex cannot even
# load, such as a duplicate table, is still refused when the original loaded.
$script:strictCheckWarned = $false
function Assert-CodexConfig {
  param(
    [Parameter(Mandatory)][AllowEmptyString()][string]$Text,
    [Parameter(Mandatory)][string]$CodexCommand,
    [AllowNull()]$Original
  )

  if ($null -ne $Original) {
    $before = Test-CodexConfig -Text $Original -CodexCommand $CodexCommand -Strict
    if ($before.CouldNotRun) { throw "Codex could not run its strict config check, so config.toml was not validated: $($before.Detail)" }
    if (-not $before.Passed) {
      if (-not $script:strictCheckWarned) {
        $script:strictCheckWarned = $true
        Write-Warning "Codex's strict config check already rejects the current config.toml, so the plugin's edit to it is only checked against plain Codex startup: $($before.Detail)"
      }
      $plainBefore = Test-CodexConfig -Text $Original -CodexCommand $CodexCommand
      $plainAfter = Test-CodexConfig -Text $Text -CodexCommand $CodexCommand
      if ($plainBefore.CouldNotRun -or $plainAfter.CouldNotRun) {
        throw "Codex could not run its startup config check, so the candidate config.toml was not validated: $($plainAfter.Detail)"
      }
      if ($plainBefore.Passed -and -not $plainAfter.Passed) { throw "Codex rejected the candidate config.toml: $($plainAfter.Detail)" }
      if (-not $plainBefore.Passed) {
        Write-Warning "Codex cannot load the current config.toml at all, so the plugin's edit to it could not be validated: $($plainBefore.Detail)"
      }
      return
    }
  }
  $after = Test-CodexConfig -Text $Text -CodexCommand $CodexCommand -Strict
  if ($after.CouldNotRun) { throw "Codex could not run its strict config check, so the candidate config.toml was not validated: $($after.Detail)" }
  if (-not $after.Passed) { throw "Codex rejected the candidate config.toml: $($after.Detail)" }
}

$repositoryRoot = $PSScriptRoot
$pluginRoot = Join-Path $repositoryRoot "plugins\cache-statusband-codex"
$configPath = Join-Path $CodexHome "config.toml"
$codexCommand = Get-Command codex -All -ErrorAction Stop | Where-Object { $_.CommandType -eq "Application" } | Select-Object -First 1 -ExpandProperty Source
if (-not $codexCommand) { throw "The Codex CLI executable was not found on PATH" }

if (-not (Test-Path -LiteralPath $pluginRoot -PathType Container)) {
  throw "Plugin folder not found: $pluginRoot"
}

# Validate and resolve -SeatFile first: a bad value must fail before Codex's config is
# touched or the plugin is registered, not after.
$expandedSeatFile = $null
if ($PSBoundParameters.ContainsKey("SeatFile")) {
  if ([string]::IsNullOrWhiteSpace($SeatFile)) { throw "-SeatFile requires a non-empty path" }
  $expandedSeatFile = $SeatFile
  if ($expandedSeatFile -match '^~[\\/]') {
    $expandedSeatFile = Join-Path $env:USERPROFILE $expandedSeatFile.Substring(2)
  }
  $expandedSeatFile = $PSCmdlet.GetUnresolvedProviderPathFromPSPath($expandedSeatFile)
  if (-not (Test-Path -LiteralPath $expandedSeatFile -PathType Leaf)) {
    Write-Warning "Seat label file does not exist yet: $expandedSeatFile (until it holds a label no account, email or usage is shown, and sessions started in the meantime never show usage)"
  }
}

# A hard-linked config.toml or settings.json cannot be replaced safely; refuse before anything
# is changed or registered.
[void](Resolve-ReplaceTarget $configPath "config.toml")
if ($PSBoundParameters.ContainsKey("SeatFile")) {
  [void](Resolve-ReplaceTarget (Join-Path $CodexHome "cache-statusband-codex\settings.json") "settings.json")
}

function Set-StatusbandPreferences([string]$Text) {
  $Text = Set-TomlKey -Text $Text -Section "features" -Key "hooks" -Value "true"
  if (-not $KeepExistingFooter) {
    $footer = '["model-with-reasoning", "context-remaining", "five-hour-limit", "weekly-limit", "estimated-thread-cost", "current-dir", "git-branch"]'
    $Text = Set-TomlKey -Text $Text -Section "tui" -Key "status_line" -Value $footer
    $Text = Set-TomlKey -Text $Text -Section "tui" -Key "status_line_use_colors" -Value "true"
  }
  return $Text
}
New-Item -ItemType Directory -Force -Path $CodexHome | Out-Null
$originalConfigText = if (Test-Path -LiteralPath $configPath) { [IO.File]::ReadAllText($configPath) } else { $null }
$configText = Set-StatusbandPreferences -Text $(if ($null -ne $originalConfigText) { $originalConfigText } else { "" })
Assert-CodexConfig -Text $configText -CodexCommand $codexCommand -Original $originalConfigText

$backupConfig = $null
if (Test-Path -LiteralPath $configPath) {
  $backupRoot = New-BackupFolder "cache-statusband-codex"
  $backupConfig = Join-Path $backupRoot "config.toml"
  Copy-Item -LiteralPath $configPath -Destination $backupConfig
  Write-Host "Backed up config.toml to $backupRoot"
}

# Registration writes the live config.toml before the final merge is validated.
# If anything fails from here until the merged file is in place, put the original back.
$registrationDone = $false
$lastSeenConfigText = $null
$foreignEditSeen = $false
try {
  $previousCodexHome = $env:CODEX_HOME
  try {
    $env:CODEX_HOME = $CodexHome
    & $codexCommand plugin marketplace add $repositoryRoot
    if ($LASTEXITCODE -ne 0) { throw "codex plugin marketplace add failed ($LASTEXITCODE)" }
    & $codexCommand plugin add "cache-statusband-codex@cache-statusband-codex-local"
    if ($LASTEXITCODE -ne 0) { throw "codex plugin add failed ($LASTEXITCODE)" }
  } finally {
    $env:CODEX_HOME = $previousCodexHome
  }
  $registrationDone = $true
  # What config.toml holds once Codex has finished registering. Any later read that differs
  # from the previous one is an edit by something else, which a failure must not undo.
  $expectedConfigText = Read-TextOrNull $configPath

  # Registration writes marketplace/plugin settings. Merge into its result rather than
  # overwriting those writes with the pre-registration configuration. Validating takes a
  # while, so config.toml is read again just before the replace: if something else changed
  # it meanwhile, the candidate is rebuilt from the new text rather than written over that
  # change. The replace itself cannot be made conditional, so a change in the last instant
  # between that check and the replace is the one window left.
  $replaced = $false
  for ($attempt = 1; $attempt -le 3 -and -not $replaced; $attempt += 1) {
    $registeredConfigText = Read-TextOrNull $configPath
    $lastSeenConfigText = $registeredConfigText
    if (-not (Test-SameText $registeredConfigText $expectedConfigText)) { $foreignEditSeen = $true }
    $expectedConfigText = $registeredConfigText
    $configText = Set-StatusbandPreferences -Text $(if ($null -ne $registeredConfigText) { $registeredConfigText } else { "" })
    Assert-CodexConfig -Text $configText -CodexCommand $codexCommand -Original $registeredConfigText
    # A symbolic link is replaced at its target, with the candidate beside it (same folder,
    # so the replace stays atomic); the link remains a link.
    $configTarget = Resolve-ReplaceTarget $configPath "config.toml"
    $configCandidate = Join-Path (Split-Path -Parent $configTarget) (".config.toml.cache-statusband-" + [guid]::NewGuid().ToString("N") + ".tmp")
    try {
      [IO.File]::WriteAllText($configCandidate, $configText, [Text.UTF8Encoding]::new($false))
      if (Test-SameText (Read-TextOrNull $configPath) $registeredConfigText) {
        Move-FileOverExisting $configCandidate $configTarget
        $replaced = $true
      }
    } finally {
      if (Test-Path -LiteralPath $configCandidate) { Remove-Item -LiteralPath $configCandidate -Force }
    }
  }
  if (-not $replaced) {
    throw "config.toml kept changing while the installer was checking it (3 attempts), so the plugin's edit to it was not written and the file is left as it is now. Rerun the installer when nothing else is editing config.toml."
  }
} catch {
  if ($backupConfig) {
    # The original goes back only when nothing but the installer and Codex's own registration
    # has written config.toml since. A file changed by someone else is theirs: it is left as
    # it is, and the backup is named.
    $liveConfigText = Read-TextOrNull $configPath
    if ($registrationDone -and ($foreignEditSeen -or -not (Test-SameText $liveConfigText $lastSeenConfigText))) {
      Write-Warning "Installation failed, and config.toml was changed by something else while the installer ran, so it was not restored. It is left as it is now; your original is at $backupConfig"
    } else {
      try {
        $restoreTarget = Resolve-ReplaceTarget $configPath "config.toml"
        $restoreCandidate = Join-Path (Split-Path -Parent $restoreTarget) (".config.toml.cache-statusband-" + [guid]::NewGuid().ToString("N") + ".tmp")
        try {
          Copy-Item -LiteralPath $backupConfig -Destination $restoreCandidate
          Move-FileOverExisting $restoreCandidate $restoreTarget
        } finally {
          if (Test-Path -LiteralPath $restoreCandidate) { Remove-Item -LiteralPath $restoreCandidate -Force }
        }
        if ($registrationDone) {
          Write-Warning "Installation failed; restored the original config.toml from $backupConfig"
        } else {
          Write-Warning "Installation failed during Codex's own registration step. Its writes to config.toml cannot be told apart from anyone else's, so the original config.toml was restored from $backupConfig, and any change made to config.toml since that backup is gone."
        }
      } catch {
        Write-Warning "Installation failed and config.toml could not be restored automatically. Your original is at $backupConfig"
      }
    }
  } else {
    Write-Warning "Installation failed after Codex registered the plugin; there was no earlier config.toml to restore, so $configPath is left as Codex wrote it."
  }
  throw
}

if ($PSBoundParameters.ContainsKey("SeatFile")) {
  $settingsRoot = Join-Path $CodexHome "cache-statusband-codex"
  $settingsPath = Join-Path $settingsRoot "settings.json"
  New-Item -ItemType Directory -Force -Path $settingsRoot | Out-Null
  if (Test-Path -LiteralPath $settingsPath) {
    $settingsBackup = New-BackupFolder "cache-statusband-codex-settings"
    Copy-Item -LiteralPath $settingsPath -Destination (Join-Path $settingsBackup "settings.json")
  }
  $settingsJson = @{ version = 1; seatFile = $expandedSeatFile } | ConvertTo-Json
  # Written to a temporary file beside it and replaced in one step (Move-FileOverExisting), so a
  # session starting at that moment reads either the old settings.json or the new one, never a
  # half-written or missing file.
  # (A symbolic link is replaced at its target, with the temporary file beside that.)
  $settingsTarget = Resolve-ReplaceTarget $settingsPath "settings.json"
  $settingsCandidate = Join-Path (Split-Path -Parent $settingsTarget) (".settings.json.cache-statusband-" + [guid]::NewGuid().ToString("N") + ".tmp")
  try {
    [IO.File]::WriteAllText($settingsCandidate, $settingsJson + "`n", [Text.UTF8Encoding]::new($false))
    Move-FileOverExisting $settingsCandidate $settingsTarget
  } finally {
    if (Test-Path -LiteralPath $settingsCandidate) { Remove-Item -LiteralPath $settingsCandidate -Force }
  }
  Write-Host "Configured optional seat label file: $expandedSeatFile"
}

if (-not $SkipCliLink) {
  $reuseExistingLink = $false
  $npmRoot = (& npm root -g 2>$null | Select-Object -Last 1)
  if ($LASTEXITCODE -eq 0 -and $npmRoot) {
    $globalPackage = Join-Path ([string]$npmRoot).Trim() "cache-statusband-codex"
    if (Test-Path -LiteralPath $globalPackage) {
      $globalItem = Get-Item -LiteralPath $globalPackage -Force
      $linkTarget = if ($globalItem.Target) { [string](@($globalItem.Target)[0]) } else { "" }
      if ($linkTarget) {
        $expected = [IO.Path]::GetFullPath($pluginRoot).TrimEnd('\')
        $actual = [IO.Path]::GetFullPath($linkTarget).TrimEnd('\')
        $reuseExistingLink = $expected.Equals($actual, [StringComparison]::OrdinalIgnoreCase)
      }
    }
  }
  if ($reuseExistingLink) {
    Write-Host "CLI link already points to this checkout; keeping it."
  } else {
    Push-Location $pluginRoot
    try {
      & npm link
      if ($LASTEXITCODE -ne 0) { throw "npm link failed ($LASTEXITCODE). If another package owns the launcher, rerun with -SkipCliLink and inspect 'Get-Command cache-statusband-codex -All'." }
    } finally {
      Pop-Location
    }
  }
}

Write-Host "Installed the local Codex plugin and enabled hooks."
Write-Host "Codex does not run a plugin's hooks until they are reviewed: open /hooks in Codex to review and trust them (again after an update)."
if ($KeepExistingFooter) {
  Write-Host "Kept the existing footer. Run /statusline in Codex CLI to customize it."
} else {
  Write-Host "Configured the native Codex CLI status footer. Run /statusline to customize it."
}
Write-Host "The resume hook also runs in the Codex desktop app. Restart Codex to load the plugin."
