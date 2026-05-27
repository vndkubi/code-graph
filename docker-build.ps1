param(
  [string]$Image = "mcp-code-graph:latest",
  [switch]$Run,
  [string]$ProjectPath = "",
  [switch]$Export,
  [string]$Out = "",
  [string]$CaCert = "",
  [switch]$Help
)

$ErrorActionPreference = "Stop"

function Show-Usage {
  @"
Usage:
  .\docker-build.ps1
  .\docker-build.ps1 -Run -ProjectPath D:\Personal\Projects\mall
  .\docker-build.ps1 -Export
  .\docker-build.ps1 -Export -Out D:\transfer\mcp-code-graph.tar.gz
  .\docker-build.ps1 -CaCert C:\temp\corp-root-ca.crt -Export

Options:
  -Run                 Build then start the MCP stdio proxy, mounting -ProjectPath.
  -ProjectPath <path>  Host project path to mount as /workspace.
  -Export              Build then export image to tar or tar.gz.
  -Out <file>          Output path for -Export.
  -Image <name:tag>    Docker image name. Default: mcp-code-graph:latest.
  -CaCert <file>       Add a PEM/CRT corporate CA certificate to the image.
  -Help                Show this help.
"@ | Write-Host
}

function Assert-LastExitCode {
  param([string]$Message)
  if ($LASTEXITCODE -ne 0) {
    throw $Message
  }
}

function Write-CertificateBuildHelp {
  Write-Host ""
  Write-Host "Docker build failed with UNABLE_TO_GET_ISSUER_CERT_LOCALLY." -ForegroundColor Yellow
  Write-Host "The container does not trust the HTTPS issuer used for npm downloads."
  Write-Host ""
  Write-Host "Fix:"
  Write-Host "  1. Export your corporate/root CA as PEM or CRT."
  Write-Host "  2. Rebuild with:"
  Write-Host "     .\docker-build.ps1 -CaCert C:\temp\corp-root-ca.crt"
  Write-Host ""
  Write-Host "Do not use npm strict-ssl=false; pass the issuer CA into the image instead."
}

function Compress-GzipFile {
  param(
    [string]$Source,
    [string]$Destination
  )

  $inputStream = [System.IO.File]::OpenRead($Source)
  try {
    $outputStream = [System.IO.File]::Create($Destination)
    try {
      $gzipStream = [System.IO.Compression.GzipStream]::new(
        $outputStream,
        [System.IO.Compression.CompressionLevel]::Optimal
      )
      try {
        $inputStream.CopyTo($gzipStream)
      } finally {
        $gzipStream.Dispose()
      }
    } finally {
      $outputStream.Dispose()
    }
  } finally {
    $inputStream.Dispose()
  }
}

if ($Help) {
  Show-Usage
  exit 0
}

$buildArgs = @("build", "-t", $Image)
if ($CaCert) {
  $resolvedCaCert = (Resolve-Path -LiteralPath $CaCert).Path
  $env:DOCKER_BUILDKIT = "1"
  $buildArgs += @("--secret", "id=codegraph_ca,src=$resolvedCaCert")
}
$buildArgs += "."

Write-Host "Building Docker image: $Image"
$buildLog = Join-Path ([System.IO.Path]::GetTempPath()) ("codegraph-docker-build-" + [System.Guid]::NewGuid().ToString("N") + ".log")
try {
  & docker @buildArgs 2>&1 | Tee-Object -FilePath $buildLog
  $dockerExitCode = $LASTEXITCODE
  if ($dockerExitCode -ne 0) {
    $logText = if (Test-Path -LiteralPath $buildLog) { Get-Content -Raw -LiteralPath $buildLog } else { "" }
    if ($logText -match "UNABLE_TO_GET_ISSUER_CERT_LOCALLY") {
      Write-CertificateBuildHelp
    }
    throw "Docker build failed."
  }
} finally {
  if (Test-Path -LiteralPath $buildLog) {
    Remove-Item -LiteralPath $buildLog -Force
  }
}
Write-Host "Image built: $Image"

if ($Export) {
  if (-not $Out) {
    $safeName = $Image.Replace(":", "-").Replace("/", "-")
    $Out = Join-Path $PSScriptRoot "$safeName.tar.gz"
  }

  $outDir = Split-Path -Parent $Out
  if ($outDir) {
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null
  }

  Write-Host ""
  Write-Host "Exporting image to: $Out"
  if ($Out.EndsWith(".gz", [System.StringComparison]::OrdinalIgnoreCase)) {
    $tempTar = Join-Path ([System.IO.Path]::GetTempPath()) ("codegraph-image-" + [System.Guid]::NewGuid().ToString("N") + ".tar")
    try {
      & docker save -o $tempTar $Image
      Assert-LastExitCode "Docker save failed."
      Compress-GzipFile -Source $tempTar -Destination $Out
    } finally {
      if (Test-Path -LiteralPath $tempTar) {
        Remove-Item -LiteralPath $tempTar -Force
      }
    }
  } else {
    & docker save -o $Out $Image
    Assert-LastExitCode "Docker save failed."
  }

  $size = (Get-Item -LiteralPath $Out).Length
  Write-Host ("Exported: {0} ({1:N1} MB)" -f $Out, ($size / 1MB))
  Write-Host ""
  Write-Host "Load on another machine:"
  Write-Host "  docker load -i `"$Out`""
}

if ($Run) {
  if (-not $ProjectPath) {
    throw "-Run requires -ProjectPath."
  }

  $absPath = (Resolve-Path -LiteralPath $ProjectPath).Path
  Write-Host ""
  Write-Host "Starting mcp-code-graph v2 MCP proxy"
  Write-Host "  Project: $absPath"
  Write-Host ""

  & docker run --rm -i `
    -v "${absPath}:/workspace:ro" `
    -v "codegraph-cache:/codegraph-home" `
    -e "CODEGRAPH_WORKSPACE_KEY=$absPath" `
    $Image `
    mcp --root /workspace --auto-refresh
  Assert-LastExitCode "Docker run failed."
}

if (-not $Run -and -not $Export) {
  Write-Host ""
  Write-Host "Next steps:"
  Write-Host ""
  Write-Host "  Run MCP stdio proxy against a project:"
  Write-Host "    .\docker-build.ps1 -Run -ProjectPath D:\Personal\Projects\mall"
  Write-Host ""
  Write-Host "  Export image for transfer:"
  Write-Host "    .\docker-build.ps1 -Export"
  Write-Host ""
  Write-Host "  VS Code/Copilot MCP command:"
  Write-Host '    docker run --rm -i -v "${workspaceFolder}:/workspace:ro" -v codegraph-cache:/codegraph-home -e CODEGRAPH_WORKSPACE_KEY="${workspaceFolder}" mcp-code-graph:latest mcp --root /workspace --auto-refresh'
}
