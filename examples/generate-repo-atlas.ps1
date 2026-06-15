param(
  [string]$RepoRoot = (Get-Location).Path,
  [string]$CodeGraphRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string]$OutDir = (Join-Path $CodeGraphRoot '.tmp-debug-home\repo-atlas-runs'),
  [ValidateSet('json', 'markdown')]
  [string]$Format = 'markdown',
  [ValidateSet('micro', 'compact', 'full')]
  [string]$Profile = 'compact',
  [int]$MaxModules = 12,
  [int]$MaxEntrypoints = 30,
  [int]$MaxHotspots = 25,
  [int]$ParseWorkers = 0,
  [string]$WorkspaceKey = '',
  [switch]$SkipBuild,
  [switch]$SkipIndex,
  [switch]$IncludeGenerated,
  [switch]$NoTests
)

$ErrorActionPreference = 'Stop'

function Require-Command($Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $Name"
  }
}

Require-Command node

$repo = (Resolve-Path $RepoRoot).Path
$cliPath = Join-Path $CodeGraphRoot 'dist\cli.js'
if (-not $SkipBuild -and -not (Test-Path $cliPath)) {
  Require-Command npm.cmd
  Push-Location $CodeGraphRoot
  try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) {
      throw "npm.cmd run build failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
}

if (-not (Test-Path $cliPath)) {
  throw "CodeGraph CLI not found at $cliPath. Run npm.cmd run build or omit -SkipBuild."
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$extension = if ($Format -eq 'markdown') { 'md' } else { 'json' }
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outPath = Join-Path $OutDir "repo-atlas-$timestamp.$extension"

$commonArgs = @(
  $cliPath,
  'atlas',
  '--root',
  $repo,
  '--format',
  $Format,
  '--profile',
  $Profile,
  '--max-modules',
  [string]$MaxModules,
  '--max-entrypoints',
  [string]$MaxEntrypoints,
  '--max-hotspots',
  [string]$MaxHotspots,
  '--out',
  $outPath
)

if ($WorkspaceKey) {
  $commonArgs += @('--workspace-key', $WorkspaceKey)
}
if ($ParseWorkers -gt 0) {
  $commonArgs += @('--parse-workers', [string]$ParseWorkers)
}
if ($SkipIndex) {
  $commonArgs += '--no-index'
}
if ($IncludeGenerated) {
  $commonArgs += '--include-generated'
}
if ($NoTests) {
  $commonArgs += '--no-tests'
}

$started = Get-Date
& node @commonArgs
$exitCode = $LASTEXITCODE
$ended = Get-Date
if ($exitCode -ne 0) {
  throw "codegraph atlas failed with exit code $exitCode"
}

[pscustomobject]@{
  repoRoot = $repo
  out = $outPath
  format = $Format
  profile = $Profile
  durationMs = [int](($ended - $started).TotalMilliseconds)
} | ConvertTo-Json -Depth 6
