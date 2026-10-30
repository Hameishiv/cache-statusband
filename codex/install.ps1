[CmdletBinding()]
param(
  [string]$CodexHome = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }),
  [string]$SeatFile,
  [switch]$SkipCliLink,
  [switch]$KeepExistingFooter
)

$ErrorActionPreference = "Stop"

function Set-TomlKey {
  param(
    [Parameter(Mandatory)][string]$Text,
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

  $header = "[$Section]"
  $sectionPattern = '^\s*\[\s*' + [Regex]::Escape($Section) + '\s*\]\s*(?:#.*)?$'
  $sectionStarts = @()
  for ($i = 0; $i -lt $lines.Count; $i += 1) {
    if ($lines[$i] -match $sectionPattern) { $sectionStarts += $i }
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
    if ($lines[$i] -match '^\s*\[{1,2}[^\]]') { $sectionEnd = $i; break }
  }
  $keyPattern = '^\s*' + [Regex]::Escape($Key) + '\s*='
  $keyLines = @()
  for ($i = $sectionStart + 1; $i -lt $sectionEnd; $i += 1) {
    if ($lines[$i] -match $keyPattern) { $keyLines += $i }
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

function Assert-CodexConfig {
  param(
    [Parameter(Mandatory)][string]$Text,
    [Parameter(Mandatory)][string]$CodexCommand
  )

  $validationHome = Join-Path ([IO.Path]::GetTempPath()) ("cache-statusband-config-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $validationHome | Out-Null
  $previousCodexHome = $env:CODEX_HOME
  try {
    [IO.File]::WriteAllText((Join-Path $validationHome "config.toml"), $Text, [Text.UTF8Encoding]::new($false))
    $env:CODEX_HOME = $validationHome
    $validationOutput = & $CodexCommand app-server --strict-config --print-startup-config 2>&1
    if ($LASTEXITCODE -ne 0) {
      $detail = (($validationOutput | Out-String).Trim() -replace '\s+', ' ')
      if ($detail.Length -gt 500) { $detail = $detail.Substring(0, 500) }
      throw "Codex rejected the candidate config.toml: $detail"
    }
  } finally {
    $env:CODEX_HOME = $previousCodexHome
    if (Test-Path -LiteralPath $validationHome) {
      $resolved = (Resolve-Path -LiteralPath $validationHome).Path
      if ($resolved -eq $validationHome) { [IO.Directory]::Delete($resolved, $true) }
    }
  }
}

$repositoryRoot = $PSScriptRoot
$pluginRoot = Join-Path $repositoryRoot "plugins\cache-statusband-codex"
$configPath = Join-Path $CodexHome "config.toml"
$codexCommand = Get-Command codex -All -ErrorAction Stop | Where-Object { $_.CommandType -eq "Application" } | Select-Object -First 1 -ExpandProperty Source
if (-not $codexCommand) { throw "The Codex CLI executable was not found on PATH" }

if (-not (Test-Path -LiteralPath $pluginRoot -PathType Container)) {
  throw "Plugin folder not found: $pluginRoot"
}

New-Item -ItemType Directory -Force -Path $CodexHome | Out-Null
$configText = if (Test-Path -LiteralPath $configPath) { [IO.File]::ReadAllText($configPath) } else { "" }
$configText = Set-TomlKey -Text $configText -Section "features" -Key "hooks" -Value "true"
if (-not $KeepExistingFooter) {
  $footer = '["model-with-reasoning", "context-remaining", "five-hour-limit", "weekly-limit", "estimated-thread-cost", "current-dir", "git-branch"]'
  $configText = Set-TomlKey -Text $configText -Section "tui" -Key "status_line" -Value $footer
  $configText = Set-TomlKey -Text $configText -Section "tui" -Key "status_line_use_colors" -Value "true"
}
Assert-CodexConfig -Text $configText -CodexCommand $codexCommand

if (Test-Path -LiteralPath $configPath) {
  $backupRoot = Join-Path $CodexHome ("backups\cache-statusband-codex-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
  New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
  Copy-Item -LiteralPath $configPath -Destination (Join-Path $backupRoot "config.toml")
  Write-Host "Backed up config.toml to $backupRoot"
}

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

$configCandidate = Join-Path $CodexHome (".config.toml.cache-statusband-" + [guid]::NewGuid().ToString("N") + ".tmp")
try {
  [IO.File]::WriteAllText($configCandidate, $configText, [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $configCandidate -Destination $configPath -Force
} finally {
  if (Test-Path -LiteralPath $configCandidate) { Remove-Item -LiteralPath $configCandidate -Force }
}

if ($PSBoundParameters.ContainsKey("SeatFile")) {
  if ([string]::IsNullOrWhiteSpace($SeatFile)) { throw "-SeatFile requires a non-empty path" }
  $expandedSeatFile = $SeatFile
  if ($expandedSeatFile -match '^~[\\/]') {
    $expandedSeatFile = Join-Path $env:USERPROFILE $expandedSeatFile.Substring(2)
  }
  $expandedSeatFile = [IO.Path]::GetFullPath($expandedSeatFile)
  $settingsRoot = Join-Path $CodexHome "cache-statusband-codex"
  $settingsPath = Join-Path $settingsRoot "settings.json"
  New-Item -ItemType Directory -Force -Path $settingsRoot | Out-Null
  if (Test-Path -LiteralPath $settingsPath) {
    $settingsBackup = Join-Path $CodexHome ("backups\cache-statusband-codex-settings-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
    New-Item -ItemType Directory -Force -Path $settingsBackup | Out-Null
    Copy-Item -LiteralPath $settingsPath -Destination (Join-Path $settingsBackup "settings.json")
  }
  $settingsJson = @{ version = 1; seatFile = $expandedSeatFile } | ConvertTo-Json
  [IO.File]::WriteAllText($settingsPath, $settingsJson + "`n", [Text.UTF8Encoding]::new($false))
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
if ($KeepExistingFooter) {
  Write-Host "Kept the existing footer. Run /statusline in Codex CLI to customize it."
} else {
  Write-Host "Configured the native Codex CLI status footer. Run /statusline to customize it."
}
Write-Host "The resume hook also runs in the Codex desktop app. Restart Codex to load the plugin."
