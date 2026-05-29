param(
  [string]$SuitePath = (Join-Path $PSScriptRoot 'copilot-real-repo-codegraph-compare-suite.example.json'),
  [string]$RunDir = '',
  [string]$CodeGraphRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string]$ExternalCodeGraphRoot = 'D:\Personal\Projects\codegraph',
  [string]$DatabaseUrl = 'postgres://codegraph:codegraph_local@127.0.0.1:54329/codegraph',
  [string[]]$Models = @('gpt-5.4-mini', 'claude-haiku-4.5'),
  [string[]]$Modes = @('baseline', 'internal', 'external'),
  [string[]]$TaskIds = @(),
  [int]$ParseWorkers = 8,
  [int]$CopilotTimeoutSeconds = 900,
  [switch]$SkipInternalIndex,
  [switch]$SkipExternalIndex,
  [switch]$DryRun,
  [switch]$KeepWorktrees
)

$ErrorActionPreference = 'Stop'

function Expand-ListParameter([string[]]$Values) {
  $items = [System.Collections.Generic.List[string]]::new()
  foreach ($value in @($Values)) {
    if ($null -eq $value) { continue }
    foreach ($part in ([string]$value -split ',')) {
      $trimmed = $part.Trim()
      if ($trimmed) { $items.Add($trimmed) }
    }
  }
  return @($items.ToArray())
}

$Models = Expand-ListParameter $Models
$Modes = Expand-ListParameter $Modes
$TaskIds = Expand-ListParameter $TaskIds

function New-SafeName([string]$Value) {
  return ($Value -replace '[^A-Za-z0-9_.-]', '_')
}

function Get-ShortHash([string]$Value) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
    $hash = $sha.ComputeHash($bytes)
    return (($hash[0..5] | ForEach-Object { $_.ToString('x2') }) -join '')
  } finally {
    $sha.Dispose()
  }
}

function Resolve-BenchPath([string]$Value, [string]$SuiteDir, [string]$CodeGraphRoot) {
  if (-not $Value) { return $Value }
  $expanded = $Value.Replace('${suiteDir}', $SuiteDir).Replace('${codeGraphRoot}', $CodeGraphRoot)
  if ([System.IO.Path]::IsPathRooted($expanded)) {
    return [System.IO.Path]::GetFullPath($expanded)
  }
  return [System.IO.Path]::GetFullPath((Join-Path $SuiteDir $expanded))
}

function Expand-BenchTemplate([string]$Value, [hashtable]$Values) {
  if ($null -eq $Value) { return '' }
  $expanded = $Value
  foreach ($key in $Values.Keys) {
    $expanded = $expanded.Replace('${' + $key + '}', [string]$Values[$key])
  }
  return $expanded
}

function ConvertTo-NativeArgument([string]$Argument) {
  if ($null -eq $Argument -or $Argument.Length -eq 0) { return '""' }
  if ($Argument -notmatch '[\s"]') { return $Argument }

  $builder = [System.Text.StringBuilder]::new()
  [void]$builder.Append('"')
  $backslashes = 0
  foreach ($char in $Argument.ToCharArray()) {
    if ($char -eq '\') {
      $backslashes++
      continue
    }
    if ($char -eq '"') {
      if ($backslashes -gt 0) {
        [void]$builder.Append('\' * ($backslashes * 2))
        $backslashes = 0
      }
      [void]$builder.Append('\"')
      continue
    }
    if ($backslashes -gt 0) {
      [void]$builder.Append('\' * $backslashes)
      $backslashes = 0
    }
    [void]$builder.Append($char)
  }
  if ($backslashes -gt 0) {
    [void]$builder.Append('\' * ($backslashes * 2))
  }
  [void]$builder.Append('"')
  return $builder.ToString()
}

function Join-NativeArguments([string[]]$Arguments) {
  return (($Arguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' ')
}

function Invoke-CheckedNative(
  [string]$FilePath,
  [string[]]$ArgumentList,
  [string]$WorkingDirectory,
  [string]$StdoutPath,
  [string]$StderrPath,
  [int]$TimeoutSeconds = 0
) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $StdoutPath), (Split-Path -Parent $StderrPath) | Out-Null
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $FilePath
  $startInfo.Arguments = Join-NativeArguments $ArgumentList
  $startInfo.WorkingDirectory = $WorkingDirectory
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  [void]$process.Start()
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()

  if ($TimeoutSeconds -gt 0) {
    $completed = $process.WaitForExit($TimeoutSeconds * 1000)
    if (-not $completed) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      $stdoutTask.Wait(1000) | Out-Null
      $stderrTask.Wait(1000) | Out-Null
      [System.IO.File]::WriteAllText($StdoutPath, $stdoutTask.Result, [System.Text.UTF8Encoding]::new($false))
      [System.IO.File]::WriteAllText($StderrPath, $stderrTask.Result, [System.Text.UTF8Encoding]::new($false))
      return [pscustomobject]@{ exitCode = 124; timedOut = $true }
    }
  } else {
    $process.WaitForExit()
  }

  $stdoutTask.Wait()
  $stderrTask.Wait()
  [System.IO.File]::WriteAllText($StdoutPath, $stdoutTask.Result, [System.Text.UTF8Encoding]::new($false))
  [System.IO.File]::WriteAllText($StderrPath, $stderrTask.Result, [System.Text.UTF8Encoding]::new($false))
  return [pscustomobject]@{ exitCode = $process.ExitCode; timedOut = $false }
}

function Invoke-Git([string]$Repo, [string[]]$GitArgs, [string]$OutPath) {
  $errPath = "$OutPath.err"
  $run = Invoke-CheckedNative 'git' $GitArgs $Repo $OutPath $errPath 0
  if ($run.exitCode -ne 0) {
    $stderr = if (Test-Path $errPath) { Get-Content -LiteralPath $errPath -Raw } else { '' }
    throw "git $($GitArgs -join ' ') failed in $Repo with exit $($run.exitCode): $stderr"
  }
  if (Test-Path $OutPath) {
    return Get-Content -LiteralPath $OutPath -Raw
  }
  return ''
}

function Normalize-RepoPath([string]$Path) {
  return ($Path -replace '\\', '/').TrimStart('./')
}

function Get-ChangedFilesSinceBaseline([string]$Workspace, [string]$BaselineRef, [string]$TaskRunDir) {
  $diffNamePath = Join-Path $TaskRunDir 'git-diff-name-only.txt'
  Invoke-Git $Workspace @('diff', '--name-only', $BaselineRef, '--') $diffNamePath | Out-Null
  $changed = [System.Collections.Generic.HashSet[string]]::new()
  if (Test-Path $diffNamePath) {
    foreach ($line in (Get-Content -LiteralPath $diffNamePath | Where-Object { $_ })) {
      [void]$changed.Add((Normalize-RepoPath $line))
    }
  }

  $statusPath = Join-Path $TaskRunDir 'git-status-porcelain.txt'
  Invoke-Git $Workspace @('status', '--porcelain') $statusPath | Out-Null
  if (Test-Path $statusPath) {
    foreach ($line in (Get-Content -LiteralPath $statusPath | Where-Object { $_ })) {
      $path = if ($line.Length -gt 3) { $line.Substring(3) } else { $line.Trim() }
      if ($path -match ' -> ') { $path = ($path -split ' -> ')[-1] }
      if ($path) { [void]$changed.Add((Normalize-RepoPath $path)) }
    }
  }

  $result = @()
  foreach ($item in $changed) { $result += $item }
  return @($result | Sort-Object)
}

function Get-FinalAssistantContent([string]$JsonlPath) {
  $final = ''
  $messageBuffers = @{}
  foreach ($line in (Get-Content -LiteralPath $JsonlPath -ErrorAction SilentlyContinue)) {
    if (-not $line.Trim()) { continue }
    if ($line -notlike '*"assistant.message*') { continue }
    try { $event = $line | ConvertFrom-Json } catch { continue }
    if ($event.type -eq 'assistant.message' -and $event.data -and $event.data.content) {
      $final = [string]$event.data.content
    } elseif ($event.type -eq 'assistant.message_start' -and $event.data -and $event.data.messageId) {
      $messageBuffers[[string]$event.data.messageId] = ''
    } elseif ($event.type -eq 'assistant.message_delta' -and $event.data -and $event.data.messageId) {
      $messageId = [string]$event.data.messageId
      if (-not $messageBuffers.ContainsKey($messageId)) { $messageBuffers[$messageId] = '' }
      $messageBuffers[$messageId] = [string]$messageBuffers[$messageId] + [string]$event.data.deltaContent
      $final = [string]$messageBuffers[$messageId]
    }
  }
  return $final
}

function Get-CopilotShutdownUsage([string]$SessionId) {
  $eventsPath = Join-Path $HOME ".copilot\session-state\$SessionId\events.jsonl"
  if (-not (Test-Path $eventsPath)) {
    return [pscustomobject]@{ found = $false; reason = 'missing-session-events' }
  }
  $shutdownLine = $null
  foreach ($line in (Get-Content -LiteralPath $eventsPath)) {
    if (-not $line.Trim()) { continue }
    if ($line -like '*"session.shutdown"*') { $shutdownLine = $line }
  }
  if (-not $shutdownLine) {
    return [pscustomobject]@{ found = $false; reason = 'missing-session-shutdown'; eventsPath = $eventsPath }
  }
  try { $shutdown = $shutdownLine | ConvertFrom-Json } catch {
    return [pscustomobject]@{ found = $false; reason = 'invalid-session-shutdown'; eventsPath = $eventsPath }
  }
  $metric = $shutdown.data.modelMetrics.PSObject.Properties | Select-Object -First 1
  $usage = $metric.Value.usage
  $premiumRequests = if ($null -ne $shutdown.data.totalPremiumRequests) { [double]$shutdown.data.totalPremiumRequests } else { 0 }
  $inputTokens = if ($null -ne $usage.inputTokens) { [int]$usage.inputTokens } else { 0 }
  $cachedInputTokens = if ($null -ne $usage.cacheReadTokens) { [int]$usage.cacheReadTokens } else { 0 }
  $outputTokens = if ($null -ne $usage.outputTokens) { [int]$usage.outputTokens } else { 0 }
  $reasoningTokens = if ($null -ne $usage.reasoningTokens) { [int]$usage.reasoningTokens } else { 0 }
  return [pscustomobject]@{
    found = $true
    modelKey = $metric.Name
    credit = $premiumRequests
    inputTokens = $inputTokens
    cachedInputTokens = $cachedInputTokens
    outputTokens = $outputTokens
    reasoningTokens = $reasoningTokens
    totalTokens = $inputTokens + $outputTokens
    totalApiDurationMs = if ($null -ne $shutdown.data.totalApiDurationMs) { [int]$shutdown.data.totalApiDurationMs } else { 0 }
    currentTokens = if ($null -ne $shutdown.data.currentTokens) { [int]$shutdown.data.currentTokens } else { 0 }
    systemTokens = if ($null -ne $shutdown.data.systemTokens) { [int]$shutdown.data.systemTokens } else { 0 }
    conversationTokens = if ($null -ne $shutdown.data.conversationTokens) { [int]$shutdown.data.conversationTokens } else { 0 }
    toolDefinitionsTokens = if ($null -ne $shutdown.data.toolDefinitionsTokens) { [int]$shutdown.data.toolDefinitionsTokens } else { 0 }
    eventsPath = $eventsPath
  }
}

function Get-ToolCallSummary([string]$JsonlPath) {
  $names = @{}
  $mcpNames = @{}
  $total = 0
  $mcpTotal = 0
  foreach ($line in (Get-Content -LiteralPath $JsonlPath -ErrorAction SilentlyContinue)) {
    if (-not $line.Trim()) { continue }
    if ($line -notlike '*"tool.execution_start"*') { continue }
    try { $event = $line | ConvertFrom-Json } catch { continue }
    if ($event.type -ne 'tool.execution_start' -or -not $event.data) { continue }
    $total++
    $toolName = if ($event.data.toolName) { [string]$event.data.toolName } else { 'unknown' }
    if (-not $names.ContainsKey($toolName)) { $names[$toolName] = 0 }
    $names[$toolName] = [int]$names[$toolName] + 1
    if ($event.data.mcpToolName -or $event.data.mcpServerName) {
      $mcpTotal++
      $mcpToolName = if ($event.data.mcpToolName) { [string]$event.data.mcpToolName } else { $toolName }
      if (-not $mcpNames.ContainsKey($mcpToolName)) { $mcpNames[$mcpToolName] = 0 }
      $mcpNames[$mcpToolName] = [int]$mcpNames[$mcpToolName] + 1
    }
  }
  return [pscustomobject]@{
    totalToolCalls = $total
    mcpToolCalls = $mcpTotal
    toolCallNames = [pscustomobject]$names
    mcpToolCallNames = [pscustomobject]$mcpNames
  }
}

function Test-RegexList([string]$Name, [string]$Text, [object[]]$Patterns, [bool]$ShouldMatch) {
  $checks = [System.Collections.Generic.List[object]]::new()
  if ($null -eq $Patterns) { return @() }
  foreach ($pattern in @($Patterns)) {
    if ($null -eq $pattern -or [string]$pattern -eq '') { continue }
    $matched = $Text -match [string]$pattern
    $passed = if ($ShouldMatch) { $matched } else { -not $matched }
    $checks.Add([pscustomobject]@{
      name = $Name
      expected = if ($ShouldMatch) { 'match' } else { 'not-match' }
      pattern = [string]$pattern
      passed = [bool]$passed
    })
  }
  return @($checks.ToArray())
}

function Test-TaskQuality(
  [pscustomobject]$Task,
  [string]$Workspace,
  [string]$BaselineRef,
  [string]$TaskRunDir,
  [string]$FinalAnswer,
  [int]$ExitCode
) {
  $checks = [System.Collections.Generic.List[object]]::new()
  $validation = $Task.validation
  $changedFiles = @(Get-ChangedFilesSinceBaseline $Workspace $BaselineRef $TaskRunDir)

  $checks.Add([pscustomobject]@{
    name = 'exitCode'
    expected = 0
    actual = $ExitCode
    passed = ($ExitCode -eq 0)
  })
  if ($validation -and $null -ne $validation.maxChangedFiles) {
    $checks.Add([pscustomobject]@{
      name = 'maxChangedFiles'
      expectedMax = [int]$validation.maxChangedFiles
      actual = $changedFiles.Count
      passed = ($changedFiles.Count -le [int]$validation.maxChangedFiles)
    })
  }
  if ($validation) {
    foreach ($check in (Test-RegexList 'goldenFact' $FinalAnswer @($validation.goldenFacts) $true)) { $checks.Add($check) }
    foreach ($check in (Test-RegexList 'forbiddenClaim' $FinalAnswer @($validation.forbiddenClaims) $false)) { $checks.Add($check) }
  }
  $checkArray = @($checks.ToArray())
  $failed = @($checkArray | Where-Object { -not $_.passed })
  $goldenChecks = @($checkArray | Where-Object { $_.name -eq 'goldenFact' })
  $goldenPassed = @($goldenChecks | Where-Object { $_.passed })
  return [pscustomobject]@{
    passed = ($failed.Count -eq 0)
    quality = if ($failed.Count -eq 0) { 'pass' } else { 'fail' }
    qualityScore = "$($goldenPassed.Count)/$($goldenChecks.Count)"
    checks = @($checkArray)
    failedChecks = @($failed)
    changedFiles = @($changedFiles)
  }
}

function Write-InternalMcpConfig(
  [string]$Path,
  [string]$Workspace,
  [string]$WorkspaceKey,
  [string]$HomeDir,
  [string]$CodeGraphRoot,
  [string]$DatabaseUrl
) {
  $cliPath = Join-Path $CodeGraphRoot 'dist\cli.js'
  $config = @{
    mcpServers = @{
      'internal-codegraph' = @{
        type = 'stdio'
        command = 'node'
        args = @(
          $cliPath,
          'mcp',
          '--root',
          $Workspace,
          '--workspace-key',
          $WorkspaceKey,
          '--home',
          $HomeDir,
          '--no-prewarm',
          '--mcp-tools',
          'get_research_pack,get_flow_pack,get_context_packet,search_symbol,search_code,get_file_slice,find_tests_for,search_files'
        )
        env = @{
          CODEGRAPH_DATABASE_URL = $DatabaseUrl
          CODEGRAPH_PG_POOL_MAX = '10'
        }
      }
    }
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  [System.IO.File]::WriteAllText($Path, ($config | ConvertTo-Json -Depth 20), [System.Text.UTF8Encoding]::new($false))
}

function Write-ExternalMcpConfig([string]$Path, [string]$Workspace, [string]$ExternalCliPath) {
  $config = @{
    mcpServers = @{
      'external-codegraph' = @{
        type = 'stdio'
        command = 'node'
        args = @($ExternalCliPath, 'serve', '--mcp', '--path', $Workspace, '--no-watch')
      }
    }
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  [System.IO.File]::WriteAllText($Path, ($config | ConvertTo-Json -Depth 20), [System.Text.UTF8Encoding]::new($false))
}

function Invoke-CodeGraphIndex(
  [string]$Workspace,
  [string]$WorkspaceKey,
  [string]$HomeDir,
  [string]$RunDir,
  [string]$CodeGraphRoot,
  [string]$DatabaseUrl,
  [int]$ParseWorkers
) {
  $stdout = Join-Path $RunDir 'internal-index.stdout.log'
  $stderr = Join-Path $RunDir 'internal-index.stderr.log'
  $env:CODEGRAPH_DATABASE_URL = $DatabaseUrl
  $env:CODEGRAPH_PG_POOL_MAX = '10'
  $indexArgs = @(
    (Join-Path $CodeGraphRoot 'dist\cli.js'),
    'index',
    '--root',
    $Workspace,
    '--workspace-key',
    $WorkspaceKey,
    '--home',
    $HomeDir,
    '--parse-workers',
    [string]$ParseWorkers
  )
  return Invoke-CheckedNative 'node' $indexArgs $CodeGraphRoot $stdout $stderr 0
}

function Invoke-ExternalCodeGraphIndex(
  [string]$Workspace,
  [string]$ExternalCliPath,
  [string]$RunDir,
  [string]$ExternalCodeGraphRoot
) {
  $stdout = Join-Path $RunDir 'external-index.stdout.log'
  $stderr = Join-Path $RunDir 'external-index.stderr.log'
  return Invoke-CheckedNative 'node' @($ExternalCliPath, 'init', $Workspace) $ExternalCodeGraphRoot $stdout $stderr 0
}

function New-RepoWorktree(
  [string]$SourceRoot,
  [string]$RunDir,
  [string]$CodeGraphHome
) {
  $repoLeaf = Split-Path -Leaf $SourceRoot
  $key = "$(New-SafeName $repoLeaf)-$(Get-ShortHash $SourceRoot)"
  $workspace = Join-Path $RunDir "worktrees\$key"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $workspace) | Out-Null
  Invoke-Git $SourceRoot @('worktree', 'add', '--detach', $workspace, 'HEAD') (Join-Path $RunDir "worktree-add-$key.out") | Out-Null
  $baselineCommit = (Invoke-Git $workspace @('rev-parse', 'HEAD') (Join-Path $RunDir "worktree-rev-$key.out")).Trim()
  return [pscustomobject]@{
    key = $key
    sourceRoot = $SourceRoot
    workspace = $workspace
    baselineCommit = $baselineCommit
    workspaceKey = "realrepo-$key"
    internalHome = Join-Path $CodeGraphHome $key
    indexDir = Join-Path $RunDir "indexes\$key"
  }
}

function Invoke-CopilotTask(
  [pscustomobject]$Task,
  [string]$Model,
  [string]$Mode,
  [pscustomobject]$WorkspaceInfo,
  [string]$McpConfigPath,
  [string]$TaskRunDir,
  [int]$TimeoutSeconds
) {
  $sessionId = [guid]::NewGuid().ToString()
  $stdout = Join-Path $TaskRunDir 'copilot.stdout.jsonl'
  $stderr = Join-Path $TaskRunDir 'copilot.stderr.log'
  $logDir = Join-Path $TaskRunDir 'copilot-logs'
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null

  $mcpServer = if ($Mode -eq 'internal') { 'internal-codegraph' } elseif ($Mode -eq 'external') { 'external-codegraph' } else { '' }
  $promptTemplate = if ($Mode -eq 'baseline' -and $Task.baselinePrompt) {
    [string]$Task.baselinePrompt
  } else {
    [string]$Task.prompt
  }
  $prompt = (Expand-BenchTemplate $promptTemplate @{
      mcpServer = $mcpServer
      workspace = $WorkspaceInfo.workspace
      mode = $Mode
    }).Replace("`r", ' ').Replace("`n", ' ')
  [System.IO.File]::WriteAllText((Join-Path $TaskRunDir 'prompt.txt'), $prompt, [System.Text.UTF8Encoding]::new($false))

  $copilotArgs = @(
    'copilot',
    '--',
    '--output-format=json',
    '--allow-all-tools',
    "--add-dir=$($WorkspaceInfo.workspace)",
    '--disable-builtin-mcps',
    '--no-custom-instructions',
    '--no-ask-user',
    "--session-id=$sessionId",
    "--log-dir=$logDir",
    '--log-level=all',
    "--model=$Model",
    "--prompt=$prompt"
  )

  $knownMcpServers = @('codegraph', 'codegraph-bench', 'codegraph-hadoop', 'codegraph-elasticsearch', 'internal-codegraph', 'external-codegraph')
  foreach ($server in $knownMcpServers) {
    if (-not $server) { continue }
    if (($Mode -eq 'internal' -and $server -eq 'internal-codegraph') -or ($Mode -eq 'external' -and $server -eq 'external-codegraph')) {
      continue
    }
    $copilotArgs += @('--disable-mcp-server', $server)
  }

  if ($Mode -eq 'internal' -or $Mode -eq 'external') {
    $copilotArgs += "--additional-mcp-config=@$McpConfigPath"
  }

  $started = Get-Date
  $run = Invoke-CheckedNative 'gh' $copilotArgs $WorkspaceInfo.workspace $stdout $stderr $TimeoutSeconds
  $ended = Get-Date
  $final = Get-FinalAssistantContent $stdout
  [System.IO.File]::WriteAllText((Join-Path $TaskRunDir 'final-output.txt'), $final, [System.Text.UTF8Encoding]::new($false))
  $toolSummary = Get-ToolCallSummary $stdout

  return [pscustomobject]@{
    sessionId = $sessionId
    exitCode = $run.exitCode
    timedOut = $run.timedOut
    latencyMs = [int](($ended - $started).TotalMilliseconds)
    stdoutPath = $stdout
    stderrPath = $stderr
    logDir = $logDir
    promptPath = Join-Path $TaskRunDir 'prompt.txt'
    finalAnswerPath = Join-Path $TaskRunDir 'final-output.txt'
    finalAnswer = $final
    totalToolCalls = $toolSummary.totalToolCalls
    mcpToolCalls = $toolSummary.mcpToolCalls
    toolCallNames = $toolSummary.toolCallNames
    mcpToolCallNames = $toolSummary.mcpToolCallNames
  }
}

function Write-ReportFiles([object[]]$Results, [string]$RunDir, [pscustomobject]$Suite) {
  $finalPath = Join-Path $RunDir 'quality-report.real-repo-comparison.json'
  $resultsPath = Join-Path $RunDir 'results.json'
  [System.IO.File]::WriteAllText($resultsPath, ($Results | ConvertTo-Json -Depth 80), [System.Text.UTF8Encoding]::new($false))

  $groups = @(
    $Results |
      Group-Object model, mode |
      ForEach-Object {
        $items = @($_.Group)
        $passed = @($items | Where-Object { $_.quality -eq 'pass' }).Count
        [pscustomobject]@{
          model = [string]$items[0].model
          mode = [string]$items[0].mode
          runs = $items.Count
          avgLatencySec = [math]::Round((($items | Measure-Object latencyMs -Average).Average / 1000), 1)
          inputTokens = [int64](($items | Measure-Object inputTokens -Sum).Sum)
          outputTokens = [int64](($items | Measure-Object outputTokens -Sum).Sum)
          totalTokens = [int64](($items | Measure-Object totalTokens -Sum).Sum)
          toolCalls = [int](($items | Measure-Object totalToolCalls -Sum).Sum)
          mcpToolCalls = [int](($items | Measure-Object mcpToolCalls -Sum).Sum)
          quality = "$passed/$($items.Count)"
        }
      }
  )

  $report = [pscustomobject]@{
    generatedAt = (Get-Date).ToString('o')
    suite = $Suite.name
    runDir = $RunDir
    summary = @($groups | Sort-Object model, mode)
    results = @($Results)
  }
  [System.IO.File]::WriteAllText($finalPath, ($report | ConvertTo-Json -Depth 100), [System.Text.UTF8Encoding]::new($false))

  $csvPath = Join-Path $RunDir 'quality-report.real-repo-comparison.csv'
  $Results |
    Select-Object taskId, repoName, model, mode, runIndex, quality, qualityScore, latencyMs, inputTokens, outputTokens, totalTokens, totalToolCalls, mcpToolCalls, promptPath, finalAnswerPath |
    Export-Csv -NoTypeInformation -Encoding UTF8 -Path $csvPath

  $summaryMdPath = Join-Path $RunDir 'quality-report.real-repo-comparison.md'
  $lines = [System.Collections.Generic.List[string]]::new()
  $lines.Add("# Real Repo CodeGraph Comparison")
  $lines.Add("")
  $lines.Add(('Run dir: `' + $RunDir + '`'))
  $lines.Add("")
  $lines.Add("| Model | Mode | Runs | Avg latency | Input | Output | Total | Tool calls | MCP calls | Quality |")
  $lines.Add("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
  foreach ($row in ($groups | Sort-Object model, mode)) {
    $lines.Add("| $($row.model) | $($row.mode) | $($row.runs) | $($row.avgLatencySec)s | $($row.inputTokens) | $($row.outputTokens) | $($row.totalTokens) | $($row.toolCalls) | $($row.mcpToolCalls) | $($row.quality) |")
  }
  $lines.Add("")
  $lines.Add('Per-run prompt and output files are linked in `quality-report.real-repo-comparison.csv`; full inline prompt/output is in `quality-report.real-repo-comparison.json`.')
  [System.IO.File]::WriteAllText($summaryMdPath, ($lines -join "`n"), [System.Text.UTF8Encoding]::new($false))

  return [pscustomobject]@{
    json = $finalPath
    csv = $csvPath
    markdown = $summaryMdPath
  }
}

$suitePathResolved = Resolve-BenchPath $SuitePath (Get-Location).Path $CodeGraphRoot
$suiteDir = Split-Path -Parent $suitePathResolved
$suite = Get-Content -LiteralPath $suitePathResolved -Raw | ConvertFrom-Json

if (-not $RunDir) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $RunDir = Join-Path $CodeGraphRoot ".tmp-debug-home\copilot-real-repo-codegraph-compare\$stamp"
}
$RunDir = [System.IO.Path]::GetFullPath($RunDir)
New-Item -ItemType Directory -Force -Path $RunDir | Out-Null

$externalCli = Join-Path $ExternalCodeGraphRoot 'dist\bin\codegraph.js'
if (-not (Test-Path (Join-Path $CodeGraphRoot 'dist\cli.js'))) {
  throw "Internal CodeGraph dist\cli.js not found. Run npm run build first."
}
if (-not (Test-Path $externalCli)) {
  throw "External CodeGraph CLI not found: $externalCli"
}

$selectedTasks = @($suite.tasks | Where-Object {
  $TaskIds.Count -eq 0 -or ($TaskIds -contains [string]$_.id)
})
if ($selectedTasks.Count -eq 0) { throw "No tasks selected." }

Write-Host "Run dir: $RunDir"
Write-Host "Tasks: $($selectedTasks.Count); models: $($Models -join ', '); modes: $($Modes -join ', ')"

$codeGraphHome = Join-Path $RunDir 'internal-codegraph-home'
$workspaceByRepo = @{}
foreach ($task in $selectedTasks) {
  $repoRoot = Resolve-BenchPath ([string]$task.repoRoot) $suiteDir $CodeGraphRoot
  if (-not (Test-Path $repoRoot)) { throw "repoRoot does not exist for task $($task.id): $repoRoot" }
  $repoRoot = [System.IO.Path]::GetFullPath($repoRoot)
  if (-not $workspaceByRepo.ContainsKey($repoRoot)) {
    Write-Host "Creating worktree for $repoRoot"
    $workspaceByRepo[$repoRoot] = New-RepoWorktree $repoRoot $RunDir $codeGraphHome
  }
  $task | Add-Member -NotePropertyName resolvedRepoRoot -NotePropertyValue $repoRoot -Force
}

foreach ($repoRoot in $workspaceByRepo.Keys) {
  $workspaceInfo = $workspaceByRepo[$repoRoot]
  New-Item -ItemType Directory -Force -Path $workspaceInfo.indexDir | Out-Null
  if (($Modes -contains 'internal') -and -not $SkipInternalIndex) {
    Write-Host "Indexing internal CodeGraph: $($workspaceInfo.key)"
    $run = Invoke-CodeGraphIndex $workspaceInfo.workspace $workspaceInfo.workspaceKey $workspaceInfo.internalHome $workspaceInfo.indexDir $CodeGraphRoot $DatabaseUrl $ParseWorkers
    if ($run.exitCode -ne 0) {
      throw "Internal CodeGraph index failed for $($workspaceInfo.workspace). See $($workspaceInfo.indexDir)."
    }
  }
  if (($Modes -contains 'external') -and -not $SkipExternalIndex) {
    Write-Host "Indexing external CodeGraph: $($workspaceInfo.key)"
    $run = Invoke-ExternalCodeGraphIndex $workspaceInfo.workspace $externalCli $workspaceInfo.indexDir $ExternalCodeGraphRoot
    if ($run.exitCode -ne 0) {
      throw "External CodeGraph index failed for $($workspaceInfo.workspace). See $($workspaceInfo.indexDir)."
    }
  }
}

if ($DryRun) {
  Write-Host "Dry run only. Worktrees kept under $RunDir"
  return
}

$results = [System.Collections.Generic.List[object]]::new()
$runIndex = 0
try {
  foreach ($model in $Models) {
    foreach ($task in $selectedTasks) {
      $workspaceInfo = $workspaceByRepo[[string]$task.resolvedRepoRoot]
      foreach ($mode in $Modes) {
        if (@('baseline', 'internal', 'external') -notcontains $mode) {
          throw "Unsupported mode: $mode"
        }
        $runIndex++
        $taskRunName = "$(New-SafeName $task.id)__$(New-SafeName $model)__$(New-SafeName $mode)"
        $taskRunDir = Join-Path $RunDir $taskRunName
        New-Item -ItemType Directory -Force -Path $taskRunDir | Out-Null
        $mcpConfigPath = Join-Path $taskRunDir 'mcp-config.json'
        if ($mode -eq 'internal') {
          Write-InternalMcpConfig $mcpConfigPath $workspaceInfo.workspace $workspaceInfo.workspaceKey $workspaceInfo.internalHome $CodeGraphRoot $DatabaseUrl
        } elseif ($mode -eq 'external') {
          Write-ExternalMcpConfig $mcpConfigPath $workspaceInfo.workspace $externalCli
        }

        Write-Host "[$runIndex] task=$($task.id) model=$model mode=$mode"
        $copilot = Invoke-CopilotTask $task $model $mode $workspaceInfo $mcpConfigPath $taskRunDir $CopilotTimeoutSeconds
        $usage = Get-CopilotShutdownUsage $copilot.sessionId
        $quality = Test-TaskQuality $task $workspaceInfo.workspace $workspaceInfo.baselineCommit $taskRunDir $copilot.finalAnswer $copilot.exitCode
        $promptText = Get-Content -LiteralPath $copilot.promptPath -Raw

        $result = [pscustomobject]@{
          taskId = [string]$task.id
          repoRoot = [string]$task.resolvedRepoRoot
          repoName = Split-Path -Leaf ([string]$task.resolvedRepoRoot)
          model = [string]$model
          mode = [string]$mode
          runIndex = $runIndex
          quality = $quality.quality
          qualityScore = $quality.qualityScore
          validatorPassed = $quality.passed
          inputTokens = if ($usage.found) { $usage.inputTokens } else { 0 }
          outputTokens = if ($usage.found) { $usage.outputTokens } else { 0 }
          totalTokens = if ($usage.found) { $usage.totalTokens } else { 0 }
          cachedInputTokens = if ($usage.found) { $usage.cachedInputTokens } else { 0 }
          reasoningTokens = if ($usage.found) { $usage.reasoningTokens } else { 0 }
          credit = if ($usage.found) { $usage.credit } else { 0 }
          tokenSourceFound = [bool]$usage.found
          tokenSource = if ($usage.found) { $usage.eventsPath } else { $usage.reason }
          totalToolCalls = $copilot.totalToolCalls
          mcpToolCalls = $copilot.mcpToolCalls
          toolCallNames = $copilot.toolCallNames
          mcpToolCallNames = $copilot.mcpToolCallNames
          latencyMs = $copilot.latencyMs
          exitCode = $copilot.exitCode
          timedOut = $copilot.timedOut
          sessionId = $copilot.sessionId
          workspace = $workspaceInfo.workspace
          baselineCommit = $workspaceInfo.baselineCommit
          promptPath = $copilot.promptPath
          finalAnswerPath = $copilot.finalAnswerPath
          stdoutPath = $copilot.stdoutPath
          stderrPath = $copilot.stderrPath
          prompt = $promptText
          finalAnswer = $copilot.finalAnswer
          changedFiles = $quality.changedFiles
          failedChecks = @($quality.failedChecks)
        }
        $results.Add($result)
        [System.IO.File]::WriteAllText((Join-Path $RunDir 'results.partial.json'), ($results.ToArray() | ConvertTo-Json -Depth 40), [System.Text.UTF8Encoding]::new($false))
      }
    }
  }
} finally {
  $reportPaths = Write-ReportFiles @($results) $RunDir $suite
  Write-Host "Report JSON: $($reportPaths.json)"
  Write-Host "Report CSV: $($reportPaths.csv)"
  Write-Host "Report MD: $($reportPaths.markdown)"

  if (-not $KeepWorktrees) {
    foreach ($repoRoot in $workspaceByRepo.Keys) {
      $workspaceInfo = $workspaceByRepo[$repoRoot]
      Write-Host "Removing worktree $($workspaceInfo.workspace)"
      Invoke-Git $repoRoot @('worktree', 'remove', '--force', $workspaceInfo.workspace) (Join-Path $RunDir "worktree-remove-$($workspaceInfo.key).out") | Out-Null
    }
  }
}
