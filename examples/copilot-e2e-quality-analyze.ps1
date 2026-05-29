param(
  [Parameter(Mandatory = $true)]
  [string[]]$ReportPath,
  [string[]]$SuitePath = @(),
  [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'

function Get-ObjectProperty([object]$Object, [string]$Name, [object]$Default = $null) {
  if ($null -eq $Object) { return $Default }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value) { return $Default }
  return $property.Value
}

function Get-NumberProperty([object]$Object, [string]$Name, [double]$Default = 0) {
  $value = Get-ObjectProperty $Object $Name $null
  if ($null -eq $value -or $value -eq '') { return $Default }
  return [double]$value
}

function Get-InputFiles([string[]]$Inputs, [string]$DefaultFilter) {
  $files = [System.Collections.Generic.List[string]]::new()
  foreach ($rawInput in @($Inputs)) {
    foreach ($input in @(([string]$rawInput -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
    if (-not $input) { continue }
    if (Test-Path -LiteralPath $input -PathType Container) {
      foreach ($file in (Get-ChildItem -LiteralPath $input -Recurse -Filter $DefaultFilter -File)) {
        $files.Add($file.FullName)
      }
      continue
    }
    foreach ($file in (Get-ChildItem -Path $input -File -ErrorAction SilentlyContinue)) {
      $files.Add($file.FullName)
    }
    }
  }
  return @($files | Sort-Object -Unique)
}

function Read-JsonFile([string]$Path) {
  return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function Infer-Experiment([string]$TaskId) {
  switch -Regex ($TaskId) {
    '^lowhint-strict-' { return 'low-hint-strict' }
    '^lowhint-hybrid-' { return 'low-hint-hybrid' }
    '^lowhint-slim-' { return 'low-hint-slim-tools' }
    '^graphfit-' { return 'graph-fit' }
    default { return 'unlabeled' }
  }
}

function Average-Property([object[]]$Rows, [string]$Name) {
  $values = [System.Collections.Generic.List[double]]::new()
  foreach ($row in @($Rows)) {
    $value = Get-ObjectProperty $row $Name $null
    if ($null -ne $value -and $value -ne '') { $values.Add([double]$value) }
  }
  if ($values.Count -eq 0) { return 0 }
  return ($values | Measure-Object -Average).Average
}

function Sum-Property([object[]]$Rows, [string]$Name) {
  $sum = [double]0
  foreach ($row in @($Rows)) {
    $sum += Get-NumberProperty $row $Name 0
  }
  return $sum
}

function Median([double[]]$Values) {
  $sorted = @($Values | Sort-Object)
  if ($sorted.Count -eq 0) { return 0 }
  $mid = [int][math]::Floor($sorted.Count / 2)
  if (($sorted.Count % 2) -eq 1) { return [double]$sorted[$mid] }
  return ([double]$sorted[$mid - 1] + [double]$sorted[$mid]) / 2
}

function Percent-Saving([double]$Baseline, [double]$CodeGraph) {
  if ($Baseline -le 0) { return $null }
  return (($Baseline - $CodeGraph) / $Baseline) * 100
}

function New-RunAggregate([object[]]$Rows) {
  $passCount = @($Rows | Where-Object { $_.quality -eq 'pass' }).Count
  return [pscustomobject]@{
    runs = $Rows.Count
    passRate = if ($Rows.Count -gt 0) { ($passCount / $Rows.Count) * 100 } else { 0 }
    qualityScore = Average-Property $Rows 'qualityScore'
    latencyMs = Average-Property $Rows 'latencyMs'
    inputTokens = Average-Property $Rows 'inputTokens'
    cachedInputTokens = Average-Property $Rows 'cachedInputTokens'
    outputTokens = Average-Property $Rows 'outputTokens'
    reasoningTokens = Average-Property $Rows 'reasoningTokens'
    totalTokens = Average-Property $Rows 'totalTokens'
    nonCachedTokens = Average-Property $Rows 'nonCachedTokens'
    toolDefinitionsTokens = Average-Property $Rows 'toolDefinitionsTokens'
  }
}

function Get-Decision(
  [int]$PairCount,
  [double]$BaselineQuality,
  [double]$CodeGraphQuality,
  [double]$QualityDelta,
  [double]$GrossSaving,
  [double]$MedianGrossSaving,
  [double]$NonCachedSaving
) {
  if ($PairCount -lt 3) { return 'needs-more-data' }
  if ($CodeGraphQuality + 0.01 -lt $BaselineQuality) { return 'do-not-apply-quality-regression' }
  if ($NonCachedSaving -ge 5 -and $MedianGrossSaving -gt 0) { return 'apply' }
  if ($QualityDelta -ge 10 -and $NonCachedSaving -ge -10) { return 'apply-for-quality' }
  if ($GrossSaving -ge 10 -and $MedianGrossSaving -gt 0 -and $NonCachedSaving -gt -20) { return 'maybe-apply-if-gross-token-is-the-budget' }
  return 'do-not-apply'
}

function New-SummaryRow([string]$ScopeType, [string]$Scope, [object[]]$Pairs) {
  $baselineGross = Sum-Property $Pairs 'baselineTotalTokens'
  $codegraphGross = Sum-Property $Pairs 'codegraphTotalTokens'
  $baselineNonCached = Sum-Property $Pairs 'baselineNonCachedTokens'
  $codegraphNonCached = Sum-Property $Pairs 'codegraphNonCachedTokens'
  $grossSaving = Percent-Saving $baselineGross $codegraphGross
  $nonCachedSaving = Percent-Saving $baselineNonCached $codegraphNonCached
  $medianGross = Median @($Pairs | ForEach-Object { [double]$_.grossSavingPct })
  $baselineQuality = Average-Property $Pairs 'baselineQualityScore'
  $codegraphQuality = Average-Property $Pairs 'codegraphQualityScore'
  $qualityDelta = Average-Property $Pairs 'qualityDeltaPts'

  return [pscustomobject]@{
    scopeType = $ScopeType
    scope = $Scope
    pairs = $Pairs.Count
    baselineQuality = [math]::Round($baselineQuality, 2)
    codegraphQuality = [math]::Round($codegraphQuality, 2)
    qualityDeltaPts = [math]::Round($qualityDelta, 2)
    grossSavingPct = if ($null -ne $grossSaving) { [math]::Round($grossSaving, 2) } else { $null }
    medianGrossSavingPct = [math]::Round($medianGross, 2)
    nonCachedSavingPct = if ($null -ne $nonCachedSaving) { [math]::Round($nonCachedSaving, 2) } else { $null }
    grossTokenWins = @($Pairs | Where-Object { $_.grossSavingPct -gt 0 }).Count
    nonCachedTokenWins = @($Pairs | Where-Object { $_.nonCachedSavingPct -gt 0 }).Count
    avgLatencyDeltaSec = [math]::Round((Average-Property $Pairs 'latencyDeltaSec'), 2)
    avgToolDefinitionDelta = [math]::Round((Average-Property $Pairs 'toolDefinitionDelta'), 2)
    decision = Get-Decision $Pairs.Count $baselineQuality $codegraphQuality $qualityDelta ([double]$grossSaving) $medianGross ([double]$nonCachedSaving)
  }
}

function Format-Percent([object]$Value) {
  if ($null -eq $Value) { return 'n/a' }
  return ('{0:n2}%' -f [double]$Value)
}

function Format-Number([object]$Value) {
  if ($null -eq $Value) { return 'n/a' }
  return ('{0:n2}' -f [double]$Value)
}

$reportFiles = Get-InputFiles $ReportPath 'quality-report*.json'
if ($reportFiles.Count -eq 0) {
  throw "No quality reports found from: $($ReportPath -join ', ')"
}

$taskMetaById = @{}
foreach ($suiteFile in (Get-InputFiles $SuitePath '*.json')) {
  $suite = Read-JsonFile $suiteFile
  foreach ($task in @($suite.tasks)) {
    $taskMetaById[[string]$task.id] = $task
  }
}

$rows = [System.Collections.Generic.List[object]]::new()
foreach ($reportFile in $reportFiles) {
  $report = Read-JsonFile $reportFile
  $runMetaPath = Join-Path (Split-Path -Parent $reportFile) 'run-meta.json'
  $runMeta = if (Test-Path -LiteralPath $runMetaPath) { Read-JsonFile $runMetaPath } else { $null }
  foreach ($run in @($report.runs)) {
    $taskId = [string](Get-ObjectProperty $run 'id' '')
    if (-not $taskId) { continue }
    $meta = if ($taskMetaById.ContainsKey($taskId)) { $taskMetaById[$taskId] } else { $null }
    $inputTokens = Get-NumberProperty $run 'inputTokens' 0
    $cachedInputTokens = Get-NumberProperty $run 'cachedInputTokens' 0
    $outputTokens = Get-NumberProperty $run 'outputTokens' 0
    $totalTokens = Get-NumberProperty $run 'totalTokens' ($inputTokens + $outputTokens)
    $nonCachedTokens = Get-ObjectProperty $run 'nonCachedTokens' $null
    if ($null -eq $nonCachedTokens -or $nonCachedTokens -eq '') {
      $nonCachedTokens = $inputTokens - $cachedInputTokens + $outputTokens
    }
    $qualityScore = Get-ObjectProperty $run 'qualityScore' $null
    if ($null -eq $qualityScore -or $qualityScore -eq '') {
      $qualityScore = if ([string](Get-ObjectProperty $run 'quality' '') -eq 'pass') { 100 } else { 0 }
    }
    $experiment = Get-ObjectProperty $run 'experiment' $null
    if (-not $experiment -and $meta) { $experiment = Get-ObjectProperty $meta 'experiment' $null }
    if (-not $experiment) { $experiment = Infer-Experiment $taskId }
    $family = Get-ObjectProperty $run 'family' $null
    if (-not $family -and $meta) { $family = Get-ObjectProperty $meta 'family' '' }
    $promptStrategy = Get-ObjectProperty $run 'promptStrategy' $null
    if (-not $promptStrategy -and $meta) { $promptStrategy = Get-ObjectProperty $meta 'promptStrategy' '' }
    $toolset = Get-ObjectProperty $run 'toolset' $null
    if (-not $toolset -and $meta) { $toolset = Get-ObjectProperty $meta 'toolset' '' }

    $rows.Add([pscustomobject]@{
      sourceReport = $reportFile
      suitePath = if ($runMeta) { Get-ObjectProperty $runMeta 'suitePath' '' } else { '' }
      id = $taskId
      type = [string](Get-ObjectProperty $run 'type' '')
      experiment = [string]$experiment
      family = [string]$family
      promptStrategy = [string]$promptStrategy
      toolset = [string]$toolset
      mode = [string](Get-ObjectProperty $run 'mode' '')
      model = [string](Get-ObjectProperty $run 'model' '')
      quality = [string](Get-ObjectProperty $run 'quality' '')
      qualityScore = [double]$qualityScore
      latencyMs = Get-NumberProperty $run 'latencyMs' 0
      inputTokens = $inputTokens
      cachedInputTokens = $cachedInputTokens
      outputTokens = $outputTokens
      reasoningTokens = Get-NumberProperty $run 'reasoningTokens' 0
      totalTokens = $totalTokens
      nonCachedTokens = [double]$nonCachedTokens
      toolDefinitionsTokens = Get-NumberProperty $run 'toolDefinitionsTokens' 0
      taskRunDir = [string](Get-ObjectProperty $run 'taskRunDir' '')
    })
  }
}

$pairs = [System.Collections.Generic.List[object]]::new()
foreach ($group in ($rows | Group-Object sourceReport, model, id)) {
  $baselineRows = @($group.Group | Where-Object { $_.mode -eq 'baseline' })
  $codegraphRows = @($group.Group | Where-Object { $_.mode -eq 'codegraph' })
  if ($baselineRows.Count -eq 0 -or $codegraphRows.Count -eq 0) { continue }

  $baseline = New-RunAggregate $baselineRows
  $codegraph = New-RunAggregate $codegraphRows
  $first = $group.Group[0]
  $grossSaving = Percent-Saving $baseline.totalTokens $codegraph.totalTokens
  $nonCachedSaving = Percent-Saving $baseline.nonCachedTokens $codegraph.nonCachedTokens
  $outputSaving = Percent-Saving $baseline.outputTokens $codegraph.outputTokens
  $pairs.Add([pscustomobject]@{
    sourceReport = $first.sourceReport
    id = $first.id
    type = $first.type
    experiment = $first.experiment
    family = $first.family
    promptStrategy = $first.promptStrategy
    toolset = $first.toolset
    model = $first.model
    baselineRuns = $baseline.runs
    codegraphRuns = $codegraph.runs
    baselineQualityScore = [math]::Round($baseline.qualityScore, 2)
    codegraphQualityScore = [math]::Round($codegraph.qualityScore, 2)
    qualityDeltaPts = [math]::Round(($codegraph.qualityScore - $baseline.qualityScore), 2)
    baselinePassRate = [math]::Round($baseline.passRate, 2)
    codegraphPassRate = [math]::Round($codegraph.passRate, 2)
    baselineTotalTokens = [math]::Round($baseline.totalTokens, 2)
    codegraphTotalTokens = [math]::Round($codegraph.totalTokens, 2)
    grossSavingPct = if ($null -ne $grossSaving) { [math]::Round($grossSaving, 2) } else { $null }
    baselineNonCachedTokens = [math]::Round($baseline.nonCachedTokens, 2)
    codegraphNonCachedTokens = [math]::Round($codegraph.nonCachedTokens, 2)
    nonCachedSavingPct = if ($null -ne $nonCachedSaving) { [math]::Round($nonCachedSaving, 2) } else { $null }
    outputSavingPct = if ($null -ne $outputSaving) { [math]::Round($outputSaving, 2) } else { $null }
    baselineLatencySec = [math]::Round(($baseline.latencyMs / 1000), 2)
    codegraphLatencySec = [math]::Round(($codegraph.latencyMs / 1000), 2)
    latencyDeltaSec = [math]::Round((($codegraph.latencyMs - $baseline.latencyMs) / 1000), 2)
    baselineToolDefinitionsTokens = [math]::Round($baseline.toolDefinitionsTokens, 2)
    codegraphToolDefinitionsTokens = [math]::Round($codegraph.toolDefinitionsTokens, 2)
    toolDefinitionDelta = [math]::Round(($codegraph.toolDefinitionsTokens - $baseline.toolDefinitionsTokens), 2)
  })
}

if ($pairs.Count -eq 0) {
  throw 'No baseline/codegraph pairs found.'
}

$summaryRows = [System.Collections.Generic.List[object]]::new()
$summaryRows.Add((New-SummaryRow 'overall' 'all' @($pairs)))
foreach ($group in ($pairs | Group-Object experiment)) {
  $summaryRows.Add((New-SummaryRow 'experiment' $group.Name @($group.Group)))
}
foreach ($group in ($pairs | Group-Object model)) {
  $summaryRows.Add((New-SummaryRow 'model' $group.Name @($group.Group)))
}
foreach ($group in ($pairs | Group-Object experiment, model)) {
  $summaryRows.Add((New-SummaryRow 'experiment+model' $group.Name @($group.Group)))
}

if (-not $OutDir) {
  $OutDir = Split-Path -Parent $reportFiles[0]
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$analysis = [pscustomobject]@{
  generatedAt = (Get-Date).ToString('o')
  reports = @($reportFiles)
  suites = @($taskMetaById.Keys | Sort-Object)
  summary = @($summaryRows)
  pairs = @($pairs)
}

$jsonPath = Join-Path $OutDir 'quality-analysis.json'
$mdPath = Join-Path $OutDir 'quality-analysis.md'
$csvPath = Join-Path $OutDir 'quality-analysis.pairs.csv'

$analysis | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $jsonPath -Encoding UTF8
$pairs | Export-Csv -LiteralPath $csvPath -NoTypeInformation -Encoding UTF8

$lines = [System.Collections.Generic.List[string]]::new()
$lines.Add('# CodeGraph Quality Analysis')
$lines.Add('')
$lines.Add("Generated: $($analysis.generatedAt)")
$lines.Add('')
$lines.Add('## Decision Summary')
$lines.Add('')
$lines.Add('| Scope type | Scope | Pairs | Quality base | Quality CodeGraph | Quality delta | Gross saving | Median gross saving | Non-cached saving | Gross wins | Non-cached wins | Latency delta | Decision |')
$lines.Add('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |')
foreach ($row in @($summaryRows | Sort-Object scopeType, scope)) {
  $lines.Add(('| {0} | {1} | {2} | {3} | {4} | {5} | {6} | {7} | {8} | {9} | {10} | {11}s | {12} |' -f
      $row.scopeType,
      $row.scope,
      $row.pairs,
      (Format-Number $row.baselineQuality),
      (Format-Number $row.codegraphQuality),
      (Format-Number $row.qualityDeltaPts),
      (Format-Percent $row.grossSavingPct),
      (Format-Percent $row.medianGrossSavingPct),
      (Format-Percent $row.nonCachedSavingPct),
      $row.grossTokenWins,
      $row.nonCachedTokenWins,
      (Format-Number $row.avgLatencyDeltaSec),
      $row.decision))
}
$lines.Add('')
$lines.Add('## Pair Details')
$lines.Add('')
$lines.Add('| Model | Experiment | Task | Quality delta | Gross saving | Non-cached saving | Output saving | Latency delta |')
$lines.Add('| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |')
foreach ($pair in @($pairs | Sort-Object model, experiment, type, id)) {
  $lines.Add(('| {0} | {1} | {2} | {3} | {4} | {5} | {6} | {7}s |' -f
      $pair.model,
      $pair.experiment,
      $pair.id,
      (Format-Number $pair.qualityDeltaPts),
      (Format-Percent $pair.grossSavingPct),
      (Format-Percent $pair.nonCachedSavingPct),
      (Format-Percent $pair.outputSavingPct),
      (Format-Number $pair.latencyDeltaSec)))
}
$lines -join "`n" | Set-Content -LiteralPath $mdPath -Encoding UTF8

Write-Host "analysis: $jsonPath"
Write-Host "summary:  $mdPath"
Write-Host "pairs:    $csvPath"
