param(
  [string]$SuitePath = (Join-Path $PSScriptRoot 'copilot-e2e-quality-suite.example.json'),
  [string]$RunDir = '',
  [string]$CodeGraphRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string[]]$Models = @(),
  [string[]]$TaskIds = @(),
  [string[]]$Modes = @(),
  [string[]]$DisabledMcpServers = @('codegraph', 'codegraph-hadoop', 'codegraph-elasticsearch', 'codegraph-bench'),
  # Path to the standalone Copilot CLI JS entry (npm-loader.js). When set, runs
  # `node <CopilotCli> <args>` instead of `gh copilot -- <args>` — for machines
  # with the npm `copilot` package but no gh CLI on PATH.
  [string]$CopilotCli = '',
  [int]$ParseWorkers = 4,
  [int]$CopilotTimeoutSeconds = 600,
  [switch]$SkipIndex,
  [switch]$DryRun,
  [switch]$KeepWorktrees
)

$ErrorActionPreference = 'Stop'

function New-SafeName([string]$Value) {
  return ($Value -replace '[^A-Za-z0-9_.-]', '_')
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

function Initialize-Workspace([pscustomobject]$Task, [string]$TaskRunDir, [string]$SuiteDir, [string]$CodeGraphRoot) {
  $sourceRoot = Resolve-BenchPath ([string]$Task.repoRoot) $SuiteDir $CodeGraphRoot
  if (-not (Test-Path $sourceRoot)) {
    throw "Task $($Task.id) repoRoot does not exist: $sourceRoot"
  }

  $mode = if ($Task.workspaceMode) { [string]$Task.workspaceMode } else { 'git-worktree' }
  $workspace = Join-Path $TaskRunDir 'workspace'
  New-Item -ItemType Directory -Force -Path $TaskRunDir | Out-Null

  if ($mode -eq 'copy') {
    Copy-Item -LiteralPath $sourceRoot -Destination $workspace -Recurse -Force
    Invoke-Git $workspace @('init') (Join-Path $TaskRunDir 'git-init.out') | Out-Null
    Invoke-Git $workspace @('add', '-A') (Join-Path $TaskRunDir 'git-add.out') | Out-Null
    Invoke-Git $workspace @(
      '-c', 'user.name=CodeGraph Bench',
      '-c', 'user.email=codegraph-bench@example.invalid',
      'commit',
      '-m',
      'baseline'
    ) (Join-Path $TaskRunDir 'git-commit.out') | Out-Null
  } elseif ($mode -eq 'git-worktree') {
    $parent = Split-Path -Parent $workspace
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    Invoke-Git $sourceRoot @('worktree', 'add', '--detach', $workspace, 'HEAD') (Join-Path $TaskRunDir 'git-worktree-add.out') | Out-Null
  } else {
    throw "Unsupported workspaceMode '$mode' for task $($Task.id). Use copy or git-worktree."
  }

  if ($Task.prePatch) {
    $patchPath = Join-Path $TaskRunDir 'pre.patch'
    [System.IO.File]::WriteAllText($patchPath, [string]$Task.prePatch, [System.Text.UTF8Encoding]::new($false))
    Invoke-Git $workspace @('apply', '--whitespace=nowarn', $patchPath) (Join-Path $TaskRunDir 'git-apply-prepatch.out') | Out-Null
    Invoke-Git $workspace @('add', '-A') (Join-Path $TaskRunDir 'git-add-prepatch.out') | Out-Null
    Invoke-Git $workspace @(
      '-c', 'user.name=CodeGraph Bench',
      '-c', 'user.email=codegraph-bench@example.invalid',
      'commit',
      '-m',
      'seed task state'
    ) (Join-Path $TaskRunDir 'git-commit-prepatch.out') | Out-Null
  }

  $baselineCommit = (Invoke-Git $workspace @('rev-parse', 'HEAD') (Join-Path $TaskRunDir 'git-baseline-rev.out')).Trim()
  return [pscustomobject]@{
    sourceRoot = $sourceRoot
    workspace = $workspace
    mode = $mode
    baselineCommit = $baselineCommit
  }
}

function Write-McpConfig([string]$Path, [string]$Workspace, [string]$WorkspaceKey, [string]$CodeGraphRoot, [string[]]$McpTools = @(), [bool]$ServerDefaultSurface = $false) {
  $cliPath = Join-Path $CodeGraphRoot 'dist\cli.js'
  $defaultMcpTools = @(
    'get_change_pack',
    'get_flow_pack',
    'get_research_pack',
    'get_context_packet',
    'review_patch',
    'search_symbol',
    'find_endpoints',
    'get_file_slice',
    'find_tests_for'
  )
  $args = @(
    $cliPath,
    'mcp',
    '--root',
    $Workspace,
    '--workspace-key',
    $WorkspaceKey,
    '--no-prewarm'
  )
  # Organic adoption runs must see the server's real default tool surface —
  # overriding it with --mcp-tools would erase the very variable being measured.
  if (-not $ServerDefaultSurface) {
    $toolsToExpose = if ($McpTools -and $McpTools.Count -gt 0) { @($McpTools) } else { $defaultMcpTools }
    $args += @('--mcp-tools', ($toolsToExpose -join ','))
  }
  $config = @{
    mcpServers = @{
      'codegraph-bench' = @{
        type = 'stdio'
        command = 'node'
        args = $args
      }
    }
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  [System.IO.File]::WriteAllText($Path, ($config | ConvertTo-Json -Depth 20), [System.Text.UTF8Encoding]::new($false))
}

function Invoke-CodeGraphIndex(
  [string]$Workspace,
  [string]$WorkspaceKey,
  [string]$RunDir,
  [string]$CodeGraphRoot,
  [int]$ParseWorkers
) {
  $stdout = Join-Path $RunDir 'index.stdout.json'
  $stderr = Join-Path $RunDir 'index.stderr.log'
  $indexArgs = @(
    (Join-Path $CodeGraphRoot 'dist\cli.js'),
    'index',
    '--root',
    $Workspace,
    '--workspace-key',
    $WorkspaceKey,
    '--parse-workers',
    [string]$ParseWorkers
  )
  return Invoke-CheckedNative 'node' $indexArgs $CodeGraphRoot $stdout $stderr 0
}

function Get-FinalAssistantContent([string]$JsonlPath) {
  $final = ''
  foreach ($line in (Get-Content -LiteralPath $JsonlPath -ErrorAction SilentlyContinue)) {
    if (-not $line.Trim()) { continue }
    try { $event = $line | ConvertFrom-Json } catch { continue }
    if ($event.type -eq 'assistant.message' -and $event.data -and $event.data.content) {
      $final = [string]$event.data.content
    }
  }
  return $final
}

function Get-CopilotShutdownUsage([string]$SessionId) {
  $eventsPath = Join-Path $HOME ".copilot\session-state\$SessionId\events.jsonl"
  if (-not (Test-Path $eventsPath)) {
    return [pscustomobject]@{ found = $false; reason = 'missing-session-events' }
  }
  $shutdown = $null
  foreach ($line in (Get-Content -LiteralPath $eventsPath)) {
    if (-not $line.Trim()) { continue }
    try { $event = $line | ConvertFrom-Json } catch { continue }
    if ($event.type -eq 'session.shutdown') { $shutdown = $event }
  }
  if (-not $shutdown) {
    return [pscustomobject]@{ found = $false; reason = 'missing-session-shutdown' }
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

function Get-TaskStringArray([pscustomobject]$Task, [string]$Name) {
  if (-not $Task -or -not $Task.PSObject.Properties[$Name]) { return @() }
  return @($Task.PSObject.Properties[$Name].Value | ForEach-Object { [string]$_ } | Where-Object { $_ })
}

function Invoke-CopilotTask(
  [pscustomobject]$Task,
  [pscustomobject]$Model,
  [string]$Mode,
  [string]$Workspace,
  [string]$McpConfigPath,
  [string]$TaskRunDir,
  [string[]]$DisabledMcpServers,
  [int]$TimeoutSeconds
) {
  $sessionId = [guid]::NewGuid().ToString()
  $stdout = Join-Path $TaskRunDir 'copilot.stdout.jsonl'
  $stderr = Join-Path $TaskRunDir 'copilot.stderr.log'
  $logDir = Join-Path $TaskRunDir 'copilot-logs'
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null

  $promptTemplate = if ($Mode -eq 'baseline' -and $Task.baselinePrompt) {
    [string]$Task.baselinePrompt
  } elseif ($Mode -eq 'organic' -and $Task.organicPrompt) {
    [string]$Task.organicPrompt
  } else {
    [string]$Task.prompt
  }
  if ($Mode -eq 'baseline' -and -not $Task.baselinePrompt) {
    $promptTemplate = $promptTemplate -replace 'Use only CodeGraph MCP server \$\{mcpServer\}[^.]*\.', 'Use normal repository tools.'
    $promptTemplate = $promptTemplate -replace 'Use only CodeGraph MCP server \$\{mcpServer\}', 'Use normal repository tools'
    $promptTemplate = $promptTemplate + ' Do not use CodeGraph or any MCP tool.'
  }
  if ($Mode -eq 'organic' -and -not $Task.organicPrompt) {
    # Organic adoption measurement: MCP stays available but the prompt must not
    # steer toward or away from it. Strip the forced-usage directive, add nothing.
    $promptTemplate = $promptTemplate -replace 'Use only CodeGraph MCP server \$\{mcpServer\}[^.]*\.', ''
    $promptTemplate = $promptTemplate -replace 'Use only CodeGraph MCP server \$\{mcpServer\}', ''
    $promptTemplate = ($promptTemplate -replace '\s{2,}', ' ').Trim()
  }
  $prompt = (Expand-BenchTemplate $promptTemplate @{
      mcpServer = 'codegraph-bench'
      workspace = $Workspace
      mode = $Mode
    }).
    Replace("`r", ' ').
    Replace("`n", ' \n ')

  # codegraph = MCP available + prompt forces usage; organic = MCP available,
  # neutral prompt (measures whether the model picks the tool on its own).
  $mcpEnabled = ($Mode -eq 'codegraph' -or $Mode -eq 'organic')
  $copilotArgs = @(
    'copilot',
    '--',
    '--output-format=json',
    '--allow-all-tools',
    "--add-dir=$Workspace",
    '--disable-builtin-mcps',
    '--no-ask-user',
    "--session-id=$sessionId",
    "--log-dir=$logDir",
    '--log-level=all',
    "--model=$($Model.id)"
  )
  if ($Mode -ne 'organic') {
    # Organic runs keep workspace instruction files (.github/copilot-instructions.md)
    # loaded — that file is one of the adoption levers being measured.
    $copilotArgs += '--no-custom-instructions'
  }
  if ($Model.effort) {
    $copilotArgs += "--effort=$($Model.effort)"
  }
  $copilotArgs += "--prompt=$prompt"
  foreach ($server in @($DisabledMcpServers)) {
    if (-not $server) { continue }
    if ($mcpEnabled -and $server -eq 'codegraph-bench') { continue }
    $copilotArgs += @('--disable-mcp-server', $server)
  }
  if ($mcpEnabled) {
    $copilotArgs += "--additional-mcp-config=@$McpConfigPath"
  }
  $denyTools = if ($Mode -eq 'codegraph') {
    Get-TaskStringArray $Task 'codegraphDenyTools'
  } elseif ($Mode -eq 'baseline') {
    Get-TaskStringArray $Task 'baselineDenyTools'
  } else {
    @()
  }
  foreach ($tool in @($denyTools)) {
    if (-not $tool) { continue }
    $copilotArgs += "--deny-tool=$tool"
  }

  $started = Get-Date
  $run = if ($CopilotCli) {
    Invoke-CheckedNative 'node' (@($CopilotCli) + @($copilotArgs | Select-Object -Skip 2)) $Workspace $stdout $stderr $TimeoutSeconds
  } else {
    Invoke-CheckedNative 'gh' $copilotArgs $Workspace $stdout $stderr $TimeoutSeconds
  }
  $ended = Get-Date

  return [pscustomobject]@{
    sessionId = $sessionId
    exitCode = $run.exitCode
    latencyMs = [int](($ended - $started).TotalMilliseconds)
    stdoutPath = $stdout
    stderrPath = $stderr
    logDir = $logDir
    finalAnswer = Get-FinalAssistantContent $stdout
  }
}

function Test-RegexList([string]$Name, [string]$Text, [object[]]$Patterns, [bool]$ShouldMatch) {
  $checks = [System.Collections.Generic.List[object]]::new()
  if ($null -eq $Patterns) { return @($checks) }
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
  return @($checks)
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

function Get-UntrackedDiffText([string]$Workspace, [string]$TaskRunDir) {
  $untrackedPath = Join-Path $TaskRunDir 'git-untracked-files.txt'
  Invoke-Git $Workspace @('ls-files', '--others', '--exclude-standard') $untrackedPath | Out-Null
  if (-not (Test-Path $untrackedPath)) { return '' }

  $builder = [System.Text.StringBuilder]::new()
  foreach ($file in (Get-Content -LiteralPath $untrackedPath | Where-Object { $_ })) {
    $normalized = Normalize-RepoPath $file
    $path = Join-Path $Workspace ($normalized -replace '/', '\')
    if (-not (Test-Path $path -PathType Leaf)) { continue }
    [void]$builder.AppendLine("diff --git a/$normalized b/$normalized")
    [void]$builder.AppendLine('--- /dev/null')
    [void]$builder.AppendLine("+++ b/$normalized")
    foreach ($line in (Get-Content -LiteralPath $path)) {
      [void]$builder.AppendLine("+$line")
    }
  }
  return $builder.ToString()
}

function Test-FileContains([string]$Workspace, [object[]]$Rules, [bool]$ShouldMatch) {
  $checks = [System.Collections.Generic.List[object]]::new()
  if ($null -eq $Rules) { return @($checks) }
  foreach ($rule in @($Rules)) {
    if ($null -eq $rule) { continue }
    $file = [string]$rule.file
    if (-not $file) { continue }
    $path = Join-Path $Workspace ($file -replace '/', '\')
    $text = if (Test-Path $path -PathType Leaf) { Get-Content -LiteralPath $path -Raw } else { '' }
    $pattern = if ($rule.regex) { [string]$rule.regex } else { [regex]::Escape([string]$rule.text) }
    $matched = $text -match $pattern
    $checks.Add([pscustomobject]@{
      name = if ($ShouldMatch) { 'fileContains' } else { 'fileNotContains' }
      file = $file
      pattern = $pattern
      passed = if ($ShouldMatch) { [bool]$matched } else { [bool](-not $matched) }
    })
  }
  return @($checks)
}

function Test-OrderedFileContains([string]$Workspace, [object[]]$Rules) {
  $checks = [System.Collections.Generic.List[object]]::new()
  if ($null -eq $Rules) { return @($checks) }
  foreach ($rule in @($Rules)) {
    if ($null -eq $rule) { continue }
    $file = [string]$rule.file
    if (-not $file) { continue }
    $path = Join-Path $Workspace ($file -replace '/', '\')
    $text = if (Test-Path $path -PathType Leaf) { Get-Content -LiteralPath $path -Raw } else { '' }
    $cursor = 0
    $missing = @()
    foreach ($pattern in @($rule.patterns)) {
      $regex = [regex]::new([string]$pattern, [System.Text.RegularExpressions.RegexOptions]::Singleline)
      $match = $regex.Match($text, $cursor)
      if (-not $match.Success) {
        $missing += [string]$pattern
        break
      }
      $cursor = $match.Index + $match.Length
    }
    $checks.Add([pscustomobject]@{
      name = 'orderedFileContains'
      file = $file
      patterns = @($rule.patterns)
      missing = $missing
      passed = ($missing.Count -eq 0)
    })
  }
  return @($checks)
}

function Invoke-ValidationCommands(
  [string]$Workspace,
  [object[]]$Commands,
  [string]$TaskRunDir,
  [string]$CodeGraphRoot,
  [string]$Phase
) {
  $checks = [System.Collections.Generic.List[object]]::new()
  if ($null -eq $Commands) { return @($checks) }
  $index = 0
  foreach ($command in @($Commands)) {
    if ($null -eq $command) { continue }
    $index++
    $name = if ($command.name) { [string]$command.name } else { "command-$index" }
    $stdout = Join-Path $TaskRunDir "validation-$index.stdout.log"
    $stderr = Join-Path $TaskRunDir "validation-$index.stderr.log"
    $expectedExitCode = if ($null -ne $command.expectedExitCode) { [int]$command.expectedExitCode } else { 0 }
    $timeout = if ($command.timeoutSeconds) { [int]$command.timeoutSeconds } else { 300 }
    $expandedCommand = Expand-BenchTemplate ([string]$command.command) @{
      workspace = $Workspace
      codeGraphRoot = $CodeGraphRoot
      taskRunDir = $TaskRunDir
      phase = $Phase
    }
    $run = Invoke-CheckedNative 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $expandedCommand) $Workspace $stdout $stderr $timeout
    $checks.Add([pscustomobject]@{
      name = 'validationCommand'
      phase = $Phase
      commandName = $name
      command = $expandedCommand
      expectedExitCode = $expectedExitCode
      actualExitCode = $run.exitCode
      timedOut = $run.timedOut
      stdoutPath = $stdout
      stderrPath = $stderr
      passed = ($run.exitCode -eq $expectedExitCode -and -not $run.timedOut)
    })
  }
  return @($checks)
}

function Test-TaskQuality(
  [pscustomobject]$Task,
  [string]$Workspace,
  [string]$BaselineRef,
  [string]$TaskRunDir,
  [string]$FinalAnswer,
  [string]$CodeGraphRoot
) {
  $checks = [System.Collections.Generic.List[object]]::new()
  $validation = $Task.validation
  if (-not $validation) {
    return [pscustomobject]@{ passed = $true; checks = @(); failedChecks = @(); changedFiles = @(); diffPath = $null }
  }

  $diffPath = Join-Path $TaskRunDir 'git-diff.patch'
  Invoke-Git $Workspace @('diff', '--no-ext-diff', '--unified=200', $BaselineRef, '--') $diffPath | Out-Null
  $diff = if (Test-Path $diffPath) { Get-Content -LiteralPath $diffPath -Raw } else { '' }
  $untrackedDiff = Get-UntrackedDiffText $Workspace $TaskRunDir
  if ($untrackedDiff) {
    $diff = $diff + "`n" + $untrackedDiff
    [System.IO.File]::WriteAllText($diffPath, $diff, [System.Text.UTF8Encoding]::new($false))
  }
  $changedFiles = @(Get-ChangedFilesSinceBaseline $Workspace $BaselineRef $TaskRunDir)

  if ($null -ne $validation.maxChangedFiles) {
    $checks.Add([pscustomobject]@{
      name = 'maxChangedFiles'
      expectedMax = [int]$validation.maxChangedFiles
      actual = $changedFiles.Count
      passed = ($changedFiles.Count -le [int]$validation.maxChangedFiles)
    })
  }

  foreach ($file in @($validation.requiredChangedFiles)) {
    if ($null -eq $file -or [string]$file -eq '') { continue }
    $normalized = Normalize-RepoPath ([string]$file)
    $checks.Add([pscustomobject]@{
      name = 'requiredChangedFile'
      file = $normalized
      passed = ($changedFiles -contains $normalized)
    })
  }

  foreach ($file in @($validation.forbiddenChangedFiles)) {
    if ($null -eq $file -or [string]$file -eq '') { continue }
    $normalized = Normalize-RepoPath ([string]$file)
    $checks.Add([pscustomobject]@{
      name = 'forbiddenChangedFile'
      file = $normalized
      passed = -not ($changedFiles -contains $normalized)
    })
  }

  foreach ($check in (Test-RegexList 'requiredDiffRegex' $diff @($validation.requiredDiffRegex) $true)) { $checks.Add($check) }
  foreach ($check in (Test-RegexList 'forbiddenDiffRegex' $diff @($validation.forbiddenDiffRegex) $false)) { $checks.Add($check) }
  foreach ($check in (Test-FileContains $Workspace @($validation.fileContains) $true)) { $checks.Add($check) }
  foreach ($check in (Test-FileContains $Workspace @($validation.fileNotContains) $false)) { $checks.Add($check) }
  foreach ($check in (Test-OrderedFileContains $Workspace @($validation.orderedFileContains))) { $checks.Add($check) }
  foreach ($check in (Test-RegexList 'goldenFact' $FinalAnswer @($validation.goldenFacts) $true)) { $checks.Add($check) }
  foreach ($check in (Test-RegexList 'forbiddenClaim' $FinalAnswer @($validation.forbiddenClaims) $false)) { $checks.Add($check) }
  foreach ($check in (Test-RegexList 'goldenFinding' $FinalAnswer @($validation.goldenFindings) $true)) { $checks.Add($check) }
  foreach ($check in (Test-RegexList 'expectedDagNode' $FinalAnswer @($validation.expectedDagNodes) $true)) { $checks.Add($check) }
  $addedDiff = (($diff -split "`r?`n") | Where-Object { $_.StartsWith('+') -and -not $_.StartsWith('+++') }) -join "`n"
  $removedDiff = (($diff -split "`r?`n") | Where-Object { $_.StartsWith('-') -and -not $_.StartsWith('---') }) -join "`n"
  foreach ($check in (Test-RegexList 'requiredAddedRegex' $addedDiff @($validation.requiredAddedRegex) $true)) { $checks.Add($check) }
  foreach ($check in (Test-RegexList 'forbiddenAddedRegex' $addedDiff @($validation.forbiddenAddedRegex) $false)) { $checks.Add($check) }
  foreach ($check in (Test-RegexList 'requiredRemovedRegex' $removedDiff @($validation.requiredRemovedRegex) $true)) { $checks.Add($check) }
  foreach ($check in (Test-RegexList 'forbiddenRemovedRegex' $removedDiff @($validation.forbiddenRemovedRegex) $false)) { $checks.Add($check) }
  foreach ($check in (Invoke-ValidationCommands $Workspace @($validation.commands) $TaskRunDir $CodeGraphRoot 'post')) { $checks.Add($check) }

  $failed = @($checks | Where-Object { -not $_.passed })
  return [pscustomobject]@{
    passed = ($failed.Count -eq 0)
    checks = @($checks)
    failedChecks = $failed
    changedFiles = $changedFiles
    diffPath = $diffPath
  }
}

function Remove-Workspace([pscustomobject]$WorkspaceInfo, [string]$TaskRunDir) {
  if ($KeepWorktrees) { return }
  if ($WorkspaceInfo.mode -eq 'git-worktree') {
    $out = Join-Path $TaskRunDir 'git-worktree-remove.out'
    Invoke-Git $WorkspaceInfo.sourceRoot @('worktree', 'remove', '--force', $WorkspaceInfo.workspace) $out | Out-Null
  }
}

function Get-NumericProperty([object]$Object, [string]$Name, [bool]$TreatMissingAsZero) {
  if ($null -eq $Object) { return $null }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value -or $property.Value -eq '') {
    if ($TreatMissingAsZero) { return [double]0 }
    return $null
  }
  return [double]$property.Value
}

function Get-SumProperty([object[]]$Rows, [string]$Name) {
  $sum = [double]0
  foreach ($row in @($Rows)) {
    $sum += (Get-NumericProperty $row $Name $true)
  }
  return $sum
}

function Get-AverageProperty([object[]]$Rows, [string]$Name) {
  $values = [System.Collections.Generic.List[double]]::new()
  foreach ($row in @($Rows)) {
    $value = Get-NumericProperty $row $Name $false
    if ($null -ne $value) { $values.Add($value) }
  }
  if ($values.Count -eq 0) { return 0 }
  return [int](($values | Measure-Object -Average).Average)
}

$suiteFullPath = Resolve-Path $SuitePath
$suiteDir = Split-Path -Parent $suiteFullPath.Path
$suite = Get-Content -LiteralPath $suiteFullPath.Path -Raw | ConvertFrom-Json
if (-not $RunDir) {
  $RunDir = Join-Path $CodeGraphRoot (".tmp-debug-home\copilot-e2e-quality\" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
New-Item -ItemType Directory -Force -Path $RunDir | Out-Null

$modelsToRun = if ($Models.Count -gt 0) {
  $Models |
    ForEach-Object { [string]$_ -split ',' } |
    Where-Object { $_ } |
    ForEach-Object { [pscustomobject]@{ id = $_.Trim(); effort = '' } }
} elseif ($suite.models) {
  @($suite.models)
} else {
  @([pscustomobject]@{ id = 'gpt-5-mini'; effort = 'low' })
}

$modesToRun = if ($Modes.Count -gt 0) {
  @($Modes | ForEach-Object { [string]$_ -split ',' } | Where-Object { $_ } | ForEach-Object { $_.Trim().ToLowerInvariant() })
} elseif ($suite.modes) {
  @($suite.modes | ForEach-Object { [string]$_ -split ',' } | Where-Object { $_ } | ForEach-Object { $_.Trim().ToLowerInvariant() })
} else {
  @('codegraph')
}
foreach ($mode in $modesToRun) {
  if ($mode -ne 'codegraph' -and $mode -ne 'baseline' -and $mode -ne 'organic') {
    throw "Unsupported mode '$mode'. Use codegraph, baseline, or organic."
  }
}

$tasksToRun = @($suite.tasks)
if ($TaskIds.Count -gt 0) {
  $taskIdsToRun = @(
    $TaskIds |
      ForEach-Object { [string]$_ -split ',' } |
      Where-Object { $_ } |
      ForEach-Object { $_.Trim() }
  )
  $taskSet = [System.Collections.Generic.HashSet[string]]::new([string[]]$taskIdsToRun)
  $tasksToRun = @($tasksToRun | Where-Object { $taskSet.Contains([string]$_.id) })
}

$runMeta = [pscustomobject]@{
  suitePath = $suiteFullPath.Path
  runDir = $RunDir
  codeGraphRoot = $CodeGraphRoot
  startedAt = (Get-Date).ToString('o')
  dryRun = [bool]$DryRun
  models = @($modelsToRun | ForEach-Object { $_.id })
  modes = @($modesToRun)
  taskIds = @($tasksToRun | ForEach-Object { $_.id })
  methodology = 'Fresh workspace and fresh Copilot session per prompt. Quality is validator pass/fail from diff, commands, tests, and golden facts/findings. Token usage is read from Copilot session.shutdown modelMetrics. Modes: codegraph = MCP + forced-usage prompt; baseline = no MCP; organic = MCP available, neutral prompt, workspace instruction files loaded (adoption measurement; score with scripts/adoption-score.mjs).'
}
$runMeta | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $RunDir 'run-meta.json') -Encoding UTF8

if ($DryRun) {
  $runMeta | ConvertTo-Json -Depth 20
  return
}

$results = [System.Collections.Generic.List[object]]::new()
foreach ($model in $modelsToRun) {
  foreach ($task in $tasksToRun) {
    foreach ($mode in $modesToRun) {
      $safeName = New-SafeName "$($task.id)__$($model.id)__$mode"
      $taskRunDir = Join-Path $RunDir $safeName
      New-Item -ItemType Directory -Force -Path $taskRunDir | Out-Null
      $workspaceInfo = $null
      try {
        $workspaceInfo = Initialize-Workspace $task $taskRunDir $suiteDir $CodeGraphRoot
        $mcpWorkspace = if ($task.mcpRoot) {
          Resolve-BenchPath ([string]$task.mcpRoot) $suiteDir $CodeGraphRoot
        } else {
          $workspaceInfo.workspace
        }
        $workspaceKey = if ($task.mcpWorkspaceKey) {
          Expand-BenchTemplate ([string]$task.mcpWorkspaceKey) @{
            workspace = $workspaceInfo.workspace
            sourceRoot = $workspaceInfo.sourceRoot
            mcpWorkspace = $mcpWorkspace
            taskId = $task.id
            model = $model.id
            mode = $mode
          }
        } else {
          "$($workspaceInfo.workspace)#codegraph-e2e#$($task.id)#$($model.id)#$mode#$(Get-Date -Format 'yyyyMMddHHmmss')"
        }
        $mcpConfigPath = Join-Path $taskRunDir 'mcp-config.json'

        $preChecks = @()
        if ($task.validation -and $task.validation.beforeCommands) {
          $preChecks = @(Invoke-ValidationCommands $workspaceInfo.workspace @($task.validation.beforeCommands) $taskRunDir $CodeGraphRoot 'before')
        }
        $prePassed = (@($preChecks | Where-Object { -not $_.passed }).Count -eq 0)

        if ($mode -eq 'codegraph' -or $mode -eq 'organic') {
          if (-not $SkipIndex) {
            $indexRun = Invoke-CodeGraphIndex $mcpWorkspace $workspaceKey $taskRunDir $CodeGraphRoot $ParseWorkers
            if ($indexRun.exitCode -ne 0) {
              throw "CodeGraph index failed for $($task.id) $($model.id) $mode with exit $($indexRun.exitCode)"
            }
          }
          $taskMcpTools = Get-TaskStringArray $task 'mcpTools'
          Write-McpConfig $mcpConfigPath $mcpWorkspace $workspaceKey $CodeGraphRoot $taskMcpTools ($mode -eq 'organic')
        }

        $copilot = Invoke-CopilotTask $task $model $mode $workspaceInfo.workspace $mcpConfigPath $taskRunDir $DisabledMcpServers $CopilotTimeoutSeconds
        $usage = Get-CopilotShutdownUsage $copilot.sessionId
        $validation = Test-TaskQuality $task $workspaceInfo.workspace $workspaceInfo.baselineCommit $taskRunDir $copilot.finalAnswer $CodeGraphRoot
        $allFailedChecks = @($preChecks | Where-Object { -not $_.passed }) + @($validation.failedChecks)
        $checkCount = @($preChecks).Count + @($validation.checks).Count
        $failedCheckCount = @($allFailedChecks).Count
        $qualityScore = if ($checkCount -gt 0) { [math]::Round((($checkCount - $failedCheckCount) / $checkCount) * 100, 2) } else { if ($copilot.exitCode -eq 0) { 100 } else { 0 } }

        $result = [pscustomobject]@{
          id = $task.id
          type = $task.type
          experiment = if ($task.experiment) { [string]$task.experiment } else { $null }
          family = if ($task.family) { [string]$task.family } else { $null }
          promptStrategy = if ($task.promptStrategy) { [string]$task.promptStrategy } else { $null }
          toolset = if ($task.toolset) { [string]$task.toolset } else { $null }
          mcpTools = if ($mode -eq 'codegraph' -or $mode -eq 'organic') { @(Get-TaskStringArray $task 'mcpTools') } else { @() }
          mode = $mode
          model = $model.id
          workspace = $workspaceInfo.workspace
          mcpWorkspace = if ($mode -eq 'codegraph' -or $mode -eq 'organic') { $mcpWorkspace } else { $null }
          mcpWorkspaceKey = if ($mode -eq 'codegraph' -or $mode -eq 'organic') { $workspaceKey } else { $null }
          baselineCommit = $workspaceInfo.baselineCommit
          sessionId = $copilot.sessionId
          exitCode = $copilot.exitCode
          latencyMs = $copilot.latencyMs
          quality = if ($copilot.exitCode -eq 0 -and $prePassed -and $validation.passed) { 'pass' } else { 'fail' }
          validatorPassed = ($prePassed -and $validation.passed)
          qualityScore = $qualityScore
          checksTotal = $checkCount
          checksFailed = $failedCheckCount
          beforeChecks = @($preChecks)
          failedChecks = @($allFailedChecks)
          changedFiles = @($validation.changedFiles)
          credit = if ($usage.found) { $usage.credit } else { $null }
          inputTokens = if ($usage.found) { $usage.inputTokens } else { $null }
          cachedInputTokens = if ($usage.found) { $usage.cachedInputTokens } else { $null }
          outputTokens = if ($usage.found) { $usage.outputTokens } else { $null }
          reasoningTokens = if ($usage.found) { $usage.reasoningTokens } else { $null }
          totalTokens = if ($usage.found) { $usage.totalTokens } else { $null }
          nonCachedTokens = if ($usage.found) { ($usage.inputTokens - $usage.cachedInputTokens + $usage.outputTokens) } else { $null }
          systemTokens = if ($usage.found) { $usage.systemTokens } else { $null }
          conversationTokens = if ($usage.found) { $usage.conversationTokens } else { $null }
          toolDefinitionsTokens = if ($usage.found) { $usage.toolDefinitionsTokens } else { $null }
          currentTokens = if ($usage.found) { $usage.currentTokens } else { $null }
          totalApiDurationMs = if ($usage.found) { $usage.totalApiDurationMs } else { $null }
          tokenSource = if ($usage.found) { 'copilot-session-shutdown' } else { $usage.reason }
          stdoutPath = $copilot.stdoutPath
          stderrPath = $copilot.stderrPath
          diffPath = $validation.diffPath
          taskRunDir = $taskRunDir
        }
        $results.Add($result)
        $results | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath (Join-Path $RunDir 'results.partial.json') -Encoding UTF8
        Write-Host ("completed {0} {1} {2}: quality={3} exit={4} inputTokens={5} outputTokens={6}" -f $task.id, $model.id, $mode, $result.quality, $result.exitCode, $result.inputTokens, $result.outputTokens)
      } catch {
        $result = [pscustomobject]@{
          id = $task.id
          type = $task.type
          experiment = if ($task.experiment) { [string]$task.experiment } else { $null }
          family = if ($task.family) { [string]$task.family } else { $null }
          promptStrategy = if ($task.promptStrategy) { [string]$task.promptStrategy } else { $null }
          toolset = if ($task.toolset) { [string]$task.toolset } else { $null }
          mode = $mode
          model = $model.id
          quality = 'fail'
          error = $_.Exception.Message
          taskRunDir = $taskRunDir
        }
        $results.Add($result)
        $results | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath (Join-Path $RunDir 'results.partial.json') -Encoding UTF8
        Write-Host ("failed {0} {1} {2}: {3}" -f $task.id, $model.id, $mode, $_.Exception.Message)
      } finally {
        if ($workspaceInfo) {
          Remove-Workspace $workspaceInfo $taskRunDir
        }
      }
    }
  }
}

$finalResults = @($results)
$summaryByModel = $finalResults |
  Group-Object mode, model |
  ForEach-Object {
    $group = @($_.Group)
    $first = $group[0]
    [pscustomobject]@{
      mode = $first.mode
      model = $first.model
      runs = $group.Count
      qualityPass = @($group | Where-Object quality -eq 'pass').Count
      avgLatencyMs = Get-AverageProperty $group 'latencyMs'
      credit = Get-SumProperty $group 'credit'
      inputTokens = [int](Get-SumProperty $group 'inputTokens')
      cachedInputTokens = [int](Get-SumProperty $group 'cachedInputTokens')
      outputTokens = [int](Get-SumProperty $group 'outputTokens')
      reasoningTokens = [int](Get-SumProperty $group 'reasoningTokens')
      totalTokens = [int](Get-SumProperty $group 'totalTokens')
    }
  }

$tokenSavingsByModel = @()
foreach ($modelName in @($finalResults | ForEach-Object { $_.model } | Sort-Object -Unique)) {
  if (-not $modelName) { continue }
  $baselineRows = @($finalResults | Where-Object { $_.model -eq $modelName -and $_.mode -eq 'baseline' })
  $codegraphRows = @($finalResults | Where-Object { $_.model -eq $modelName -and $_.mode -eq 'codegraph' })
  if ($baselineRows.Count -eq 0 -or $codegraphRows.Count -eq 0) { continue }

  $baselineInput = Get-SumProperty $baselineRows 'inputTokens'
  $codegraphInput = Get-SumProperty $codegraphRows 'inputTokens'
  $baselineTotal = Get-SumProperty $baselineRows 'totalTokens'
  $codegraphTotal = Get-SumProperty $codegraphRows 'totalTokens'
  $tokenSavingsByModel += [pscustomobject]@{
    model = $modelName
    baselineRuns = $baselineRows.Count
    codegraphRuns = $codegraphRows.Count
    baselineQualityPass = @($baselineRows | Where-Object quality -eq 'pass').Count
    codegraphQualityPass = @($codegraphRows | Where-Object quality -eq 'pass').Count
    baselineInputTokens = [int]$baselineInput
    codegraphInputTokens = [int]$codegraphInput
    inputTokenSavingPct = if ($baselineInput -gt 0) { [math]::Round((1 - ($codegraphInput / $baselineInput)) * 100, 2) } else { $null }
    baselineTotalTokens = [int]$baselineTotal
    codegraphTotalTokens = [int]$codegraphTotal
    totalTokenSavingPct = if ($baselineTotal -gt 0) { [math]::Round((1 - ($codegraphTotal / $baselineTotal)) * 100, 2) } else { $null }
  }
}

$summaryByType = $finalResults |
  Group-Object type |
  ForEach-Object {
    $group = @($_.Group)
    [pscustomobject]@{
      type = $_.Name
      runs = $group.Count
      qualityPass = @($group | Where-Object quality -eq 'pass').Count
    }
  }

$report = [pscustomobject]@{
  generatedAt = (Get-Date).ToString('o')
  methodology = $runMeta.methodology
  summaryByModel = @($summaryByModel)
  summaryByType = @($summaryByType)
  tokenSavingsByModel = @($tokenSavingsByModel)
  runs = $finalResults
}
$report | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath (Join-Path $RunDir 'quality-report.json') -Encoding UTF8
$summaryByModel | Format-Table -AutoSize | Out-String | Set-Content -LiteralPath (Join-Path $RunDir 'summary-by-model.txt') -Encoding UTF8
$summaryByType | Format-Table -AutoSize | Out-String | Set-Content -LiteralPath (Join-Path $RunDir 'summary-by-type.txt') -Encoding UTF8
$tokenSavingsByModel | Format-Table -AutoSize | Out-String | Set-Content -LiteralPath (Join-Path $RunDir 'token-savings-by-model.txt') -Encoding UTF8
$finalResults | Format-Table id, type, mode, model, quality, exitCode, latencyMs, inputTokens, outputTokens, totalTokens -AutoSize | Out-String | Set-Content -LiteralPath (Join-Path $RunDir 'run-details.txt') -Encoding UTF8

Write-Host "report: $(Join-Path $RunDir 'quality-report.json')"
