param(
  [string]$RepoRoot = (Get-Location).Path,
  [string]$CodeGraphRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string]$CodeGraphHome = (Join-Path $CodeGraphRoot '.tmp-debug-home\copilot-review-proof'),
  [string]$OutDir = (Join-Path $CodeGraphRoot '.tmp-debug-home\copilot-review-proof-runs'),
  [string]$PromptFile = '',
  [string]$DiffFile = '',
  [string]$WorkspaceKey = '',
  [switch]$SkipIndex
)

$ErrorActionPreference = 'Stop'

function Require-Command($Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $Name"
  }
}

function Assert-GhReady {
  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $authOutput = & gh auth status 2>&1
  $authExitCode = $LASTEXITCODE
  $ErrorActionPreference = $oldPreference
  if ($authExitCode -ne 0) {
    throw "GitHub CLI is not authenticated. Run 'gh auth login' and make sure Copilot CLI access is enabled. gh output: $authOutput"
  }

  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $helpOutput = & gh copilot -- --help 2>&1
  $helpExitCode = $LASTEXITCODE
  $ErrorActionPreference = $oldPreference
  if ($helpExitCode -ne 0) {
    throw "Copilot CLI is not installed or not runnable through gh. Try 'gh copilot' after login, then rerun this script. gh output: $helpOutput"
  }
}

function Get-RepoDiff($Root, $DiffPath) {
  if ($DiffPath) {
    return Get-Content -LiteralPath $DiffPath -Raw
  }
  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $diff = & git -C $Root diff --no-ext-diff --unified=80 2>$null
  if (-not $diff) {
    $diff = & git -C $Root diff --cached --no-ext-diff --unified=80 2>$null
  }
  $ErrorActionPreference = $oldPreference
  return ($diff -join "`n")
}

function New-ReviewPrompt($Root, $DiffText, $PromptPath, $DiffPath) {
  if ($PromptPath) {
    return Get-Content -LiteralPath $PromptPath -Raw
  }
  $diffBlock = @(
    "The patch is stored at this path: $DiffPath",
    'Read that diff before reviewing.'
  ) -join "`n"
  return @(
    'You are doing a technical code review. Do not modify files.',
    '',
    'Review the referenced patch. Return Markdown with:',
    '1. Findings first, ordered by severity, each with file/line evidence.',
    '2. Missing tests or validation.',
    '3. Impacted endpoints/callers/dependents if known.',
    '4. A short summary only after findings.',
    '',
    $diffBlock,
    '',
    'If the CodeGraph MCP server is available, first use review_patch with focus "bug-risk" using the diff content from the file. Then use only the required follow-up tool calls it returns before writing findings; avoid broad filesystem search/read unless review_patch cannot resolve the patch.',
    'If CodeGraph is not available, use normal filesystem/search tools.',
    '',
    "Repository root: $Root"
  ) -join "`n"
}

function Write-McpConfig($Path, $RepoRoot, $CodeGraphRoot, $CodeGraphHome, $WorkspaceKey) {
  $cliPath = Join-Path $CodeGraphRoot 'dist\cli.js'
  $mcpArgs = @(
    $cliPath,
    'mcp',
    '--root',
    $RepoRoot,
    '--home',
    $CodeGraphHome
  )
  if ($WorkspaceKey) {
    $mcpArgs += @('--workspace-key', $WorkspaceKey)
  }
  $mcpArgs += '--no-prewarm'
  $config = @{
    mcpServers = @{
      codegraph = @{
        type = 'stdio'
        command = 'node'
        args = $mcpArgs
        env = @{}
        tools = @(
          'review_patch',
          'simulate_patch_impact',
          'get_file_slice',
          'get_file_summary',
          'trace_dependencies',
          'get_index_stats'
        )
      }
    }
  }
  $json = $config | ConvertTo-Json -Depth 12 -Compress
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
  return $json
}

function Invoke-CopilotReview($Name, $RepoRoot, $Prompt, $RunDir, $ExtraArgs) {
  $stdoutPath = Join-Path $RunDir "$Name.jsonl"
  $logDir = Join-Path $RunDir "$Name-logs"
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null

  $args = @(
    'copilot',
    '--output-format=json',
    '--allow-all-tools',
    '--allow-all-paths',
    "--log-dir=$logDir",
    '--log-level=all'
  ) + $ExtraArgs + @(
    '-p',
    $Prompt
  )

  Push-Location $RepoRoot
  try {
    $started = Get-Date
    $output = & gh @args 2>&1
    $exitCode = $LASTEXITCODE
    $ended = Get-Date
  } finally {
    Pop-Location
  }

  $output | Set-Content -LiteralPath $stdoutPath -Encoding UTF8

  return [pscustomobject]@{
    name = $Name
    exitCode = $exitCode
    durationMs = [int](($ended - $started).TotalMilliseconds)
    stdoutPath = $stdoutPath
    logDir = $logDir
  }
}

function Measure-CopilotRun($Run) {
  $files = @($Run.stdoutPath)
  if (Test-Path $Run.logDir) {
    $files += Get-ChildItem -LiteralPath $Run.logDir -Recurse -File | Select-Object -ExpandProperty FullName
  }

  $text = ''
  foreach ($file in $files) {
    try {
      $text += "`n" + (Get-Content -LiteralPath $file -Raw)
    } catch {
    }
  }

  $inputTokenMatches = [regex]::Matches($text, 'gen_ai\.usage\.input_tokens["\s:=,]+(\d+)')
  $outputTokenMatches = [regex]::Matches($text, 'gen_ai\.usage\.output_tokens["\s:=,]+(\d+)')
  $inputTokens = ($inputTokenMatches | ForEach-Object { [int]$_.Groups[1].Value } | Measure-Object -Sum).Sum
  $outputTokens = ($outputTokenMatches | ForEach-Object { [int]$_.Groups[1].Value } | Measure-Object -Sum).Sum
  $assistantOutputTokens = 0
  $finalContentChars = 0
  $toolStartCount = 0
  $toolNames = [System.Collections.Generic.HashSet[string]]::new()
  $premiumRequests = $null
  $totalApiDurationMs = $null
  $sessionDurationMs = $null

  foreach ($line in (Get-Content -LiteralPath $Run.stdoutPath -ErrorAction SilentlyContinue)) {
    if (-not $line.Trim()) { continue }
    try {
      $event = $line | ConvertFrom-Json
    } catch {
      continue
    }
    if ($event.type -eq 'assistant.message' -and $event.data) {
      if ($null -ne $event.data.outputTokens) {
        $assistantOutputTokens += [int]$event.data.outputTokens
      }
      if ($event.data.content) {
        $finalContentChars += [int](([string]$event.data.content).Length)
      }
      if ($event.data.toolRequests) {
        foreach ($toolRequest in @($event.data.toolRequests)) {
          $toolStartCount += 1
          if ($toolRequest.name) { [void]$toolNames.Add([string]$toolRequest.name) }
        }
      }
    } elseif ($event.type -eq 'result' -and $event.usage) {
      if ($null -ne $event.usage.premiumRequests) { $premiumRequests = [int]$event.usage.premiumRequests }
      if ($null -ne $event.usage.totalApiDurationMs) { $totalApiDurationMs = [int]$event.usage.totalApiDurationMs }
      if ($null -ne $event.usage.sessionDurationMs) { $sessionDurationMs = [int]$event.usage.sessionDurationMs }
    }
  }

  if (-not $outputTokens -and $assistantOutputTokens -gt 0) {
    $outputTokens = $assistantOutputTokens
  }

  return [pscustomobject]@{
    name = $Run.name
    exitCode = $Run.exitCode
    durationMs = $Run.durationMs
    stdoutPath = $Run.stdoutPath
    logDir = $Run.logDir
    outputChars = $text.Length
    estimatedTokens = [int][Math]::Ceiling($text.Length / 4)
    actualInputTokens = if ($inputTokens) { [int]$inputTokens } else { $null }
    actualOutputTokens = if ($outputTokens) { [int]$outputTokens } else { $null }
    assistantOutputTokens = if ($assistantOutputTokens) { [int]$assistantOutputTokens } else { $null }
    finalContentChars = $finalContentChars
    premiumRequests = $premiumRequests
    totalApiDurationMs = $totalApiDurationMs
    sessionDurationMs = $sessionDurationMs
    toolStartCount = $toolStartCount
    toolNames = @($toolNames | Sort-Object)
    tokenSource = if ($inputTokens -or $outputTokens) { 'copilot-jsonl/log' } else { 'estimated-from-captured-chars' }
    codegraphToolMentions = ([regex]::Matches($text, 'review_patch|simulate_patch_impact|get_file_slice|get_file_summary|trace_dependencies|get_index_stats')).Count
    rawFileMentions = ([regex]::Matches($text, 'readFile|grep|rg|Get-Content|cat\s')).Count
  }
}

function SavingPct($Baseline, $Optimized) {
  if (-not $Baseline -or $Baseline -le 0) { return $null }
  return [Math]::Round(1 - ($Optimized / $Baseline), 3)
}

Require-Command gh
Require-Command node
Require-Command git
Assert-GhReady

if (-not (Test-Path (Join-Path $CodeGraphRoot 'dist\cli.js'))) {
  throw "dist\cli.js not found. Run 'npm.cmd run build' in $CodeGraphRoot first."
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$runId = Get-Date -Format 'yyyyMMdd-HHmmss'
$runDir = Join-Path $OutDir $runId
New-Item -ItemType Directory -Force -Path $runDir | Out-Null

if (-not $SkipIndex) {
  $indexArgs = @((Join-Path $CodeGraphRoot 'dist\cli.js'), 'index', '--root', $RepoRoot, '--home', $CodeGraphHome)
  if ($WorkspaceKey) {
    $indexArgs += @('--workspace-key', $WorkspaceKey)
  }
  & node @indexArgs | Set-Content -LiteralPath (Join-Path $runDir 'prewarm-index.json') -Encoding UTF8
  if ($LASTEXITCODE -ne 0) { throw 'CodeGraph prewarm failed.' }
}

$diff = Get-RepoDiff $RepoRoot $DiffFile
if (-not $diff.Trim()) {
  throw 'No diff found. Pass -DiffFile or create working-tree/cached changes in the target repo.'
}
$diffPath = Join-Path $runDir 'review.diff'
$diff | Set-Content -LiteralPath $diffPath -Encoding UTF8

$prompt = New-ReviewPrompt $RepoRoot $diff $PromptFile $diffPath
$prompt | Set-Content -LiteralPath (Join-Path $runDir 'prompt.md') -Encoding UTF8

$mcpConfigPath = Join-Path $runDir 'codegraph-mcp.json'
Write-McpConfig $mcpConfigPath $RepoRoot $CodeGraphRoot $CodeGraphHome $WorkspaceKey | Out-Null

$baseline = Invoke-CopilotReview 'baseline-no-codegraph' $RepoRoot $prompt $runDir @('--disable-mcp-server=codegraph')
$withCodeGraph = Invoke-CopilotReview 'with-codegraph' $RepoRoot $prompt $runDir @("--additional-mcp-config=@$mcpConfigPath")

$baselineMetrics = Measure-CopilotRun $baseline
$codegraphMetrics = Measure-CopilotRun $withCodeGraph

$summary = [pscustomobject]@{
  repoRoot = $RepoRoot
  runDir = $runDir
  baseline = $baselineMetrics
  withCodeGraph = $codegraphMetrics
  comparison = [pscustomobject]@{
    estimatedTokenSavingPct = SavingPct $baselineMetrics.estimatedTokens $codegraphMetrics.estimatedTokens
    actualInputTokenSavingPct = SavingPct $baselineMetrics.actualInputTokens $codegraphMetrics.actualInputTokens
    actualOutputTokenSavingPct = SavingPct $baselineMetrics.actualOutputTokens $codegraphMetrics.actualOutputTokens
    durationChangePct = SavingPct $baselineMetrics.durationMs $codegraphMetrics.durationMs
    codegraphToolMentionsDelta = $codegraphMetrics.codegraphToolMentions - $baselineMetrics.codegraphToolMentions
    rawFileMentionsDelta = $codegraphMetrics.rawFileMentions - $baselineMetrics.rawFileMentions
  }
}

$summaryPath = Join-Path $runDir 'summary.json'
$summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $summaryPath -Encoding UTF8
$summary | ConvertTo-Json -Depth 8
