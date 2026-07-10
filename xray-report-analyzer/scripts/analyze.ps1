# Simple wrapper to analyze a radiology report with the local runner.
# Loads secrets from C:\xray-agent\secrets.env, runs the pipeline, and opens the
# HTML report in your browser.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\analyze.ps1 test-data\case-2-ambiguous.txt
#   powershell -ExecutionPolicy Bypass -File scripts\analyze.ps1 test-data\case-3-disagreement.txt -Age 61 -Sex M -History "30 pack-year smoker"

param(
    [Parameter(Mandatory = $true, Position = 0)] [string]$File,
    [string]$Age = '',
    [string]$Sex = '',
    [string]$History = ''
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$SecretsFile = 'C:\xray-agent\secrets.env'

if (-not (Test-Path $SecretsFile)) { Write-Host "ERROR: $SecretsFile not found." -ForegroundColor Red; exit 1 }
foreach ($line in Get-Content $SecretsFile) {
    $t = $line.Trim()
    if ($t -eq '' -or $t.StartsWith('#') -or -not $t.Contains('=')) { continue }
    $i = $t.IndexOf('='); $k = $t.Substring(0, $i).Trim(); $v = $t.Substring($i + 1).Trim()
    if ($k -and $v -notlike '*PASTE*') { Set-Item "env:$k" $v }
}

# Pre-warm the Ollama model so the timed specialist call is not a cold load.
$ollamaModel = if ($env:OLLAMA_MODEL) { $env:OLLAMA_MODEL } else { 'orca-mini' }
$ollamaBase = if ($env:OLLAMA_BASE_URL) { $env:OLLAMA_BASE_URL } else { 'http://127.0.0.1:11434' }
try {
    Write-Host "Pre-warming Ollama model '$ollamaModel'..." -ForegroundColor DarkGray
    Invoke-RestMethod -Uri "$ollamaBase/api/chat" -Method Post -TimeoutSec 120 -ContentType 'application/json' `
        -Body (@{ model = $ollamaModel; messages = @(@{ role = 'user'; content = 'hi' }); stream = $false } | ConvertTo-Json) | Out-Null
} catch { Write-Host "  (warmup skipped: $($_.Exception.Message))" -ForegroundColor DarkGray }

$args = @((Join-Path $ProjectRoot 'scripts\run-local.mjs'), $File)
if ($Age)     { $args += @('--age', $Age) }
if ($Sex)     { $args += @('--sex', $Sex) }
if ($History) { $args += @('--history', $History) }

Push-Location $ProjectRoot
try { node @args } finally { Pop-Location }

# Open the newest HTML report if one was written.
$outDir = if ($env:XRAY_OUT_DIR) { $env:XRAY_OUT_DIR } else { 'C:\xray-agent\out' }
$latestHtml = Get-ChildItem $outDir -Filter 'report-*.html' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($latestHtml) {
    Write-Host "`nOpening report in browser: $($latestHtml.FullName)" -ForegroundColor Green
    Start-Process $latestHtml.FullName
}
