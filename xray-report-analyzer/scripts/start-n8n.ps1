# Starts n8n with the X-Ray Report Analyzer fully provisioned.
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\start-n8n.ps1
#
# Reads secrets from C:\xray-agent\secrets.env (kept OUTSIDE OneDrive on
# purpose -- API keys must not sync to the cloud). On every start it:
#   1. loads env vars for the n8n process (keys for the Fan-out Code node),
#   2. upserts the two n8n credentials (fixed IDs, so workflow nodes stay attached),
#   3. upserts the workflow (fixed ID, so re-imports update instead of duplicate),
#   4. launches n8n.

$ErrorActionPreference = 'Stop'
$SecretsFile = 'C:\xray-agent\secrets.env'
$ProjectRoot = Split-Path -Parent $PSScriptRoot

# ---- 1. Load secrets ---------------------------------------------------------
if (-not (Test-Path $SecretsFile)) {
    Write-Host "ERROR: $SecretsFile not found. Create it (see secrets.env.example) and paste your API keys in." -ForegroundColor Red
    exit 1
}
$secrets = @{}
foreach ($line in Get-Content $SecretsFile) {
    $line = $line.Trim()
    if ($line -eq '' -or $line.StartsWith('#')) { continue }
    $idx = $line.IndexOf('=')
    if ($idx -lt 1) { continue }
    $secrets[$line.Substring(0, $idx).Trim()] = $line.Substring($idx + 1).Trim()
}

foreach ($required in @('GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'N8N_ENCRYPTION_KEY')) {
    if (-not $secrets[$required] -or $secrets[$required] -like '*PASTE*') {
        Write-Host "ERROR: $required is missing or still a placeholder in $SecretsFile" -ForegroundColor Red
        exit 1
    }
}

$env:GEMINI_API_KEY   = $secrets['GEMINI_API_KEY']
$env:DEEPSEEK_API_KEY = $secrets['DEEPSEEK_API_KEY']
$env:N8N_ENCRYPTION_KEY = $secrets['N8N_ENCRYPTION_KEY']
if ($secrets['OLLAMA_BASE_URL']) { $env:OLLAMA_BASE_URL = $secrets['OLLAMA_BASE_URL'] } else { $env:OLLAMA_BASE_URL = 'http://127.0.0.1:11434' }
if ($secrets['XRAY_OUT_DIR'])    { $env:XRAY_OUT_DIR = $secrets['XRAY_OUT_DIR'] }       else { $env:XRAY_OUT_DIR = 'C:\xray-agent\out' }
$env:NODE_FUNCTION_ALLOW_BUILTIN = 'fs,path'
# This build reads config + API keys from env vars (Triage URL expression uses
# $env.GEMINI_TRIAGE_MODEL; the Fan-out Code node reads $env.GEMINI_API_KEY etc).
# n8n blocks $env in expressions/code by default -> "access to env vars denied".
$env:N8N_BLOCK_ENV_ACCESS_IN_NODE = 'false'
# No-PHI-persistence compensating control: the web form needs executions saved
# to render its completion page, so auto-prune them aggressively instead.
$env:EXECUTIONS_DATA_PRUNE = 'true'
$env:EXECUTIONS_DATA_MAX_AGE = '1'            # delete execution data after 1 hour
$env:EXECUTIONS_DATA_PRUNE_MAX_COUNT = '50'   # and keep at most 50 records
# DeepSeek account has no balance (HTTP 402), so route specialist #3 AND the
# synthesis step to Gemini -- same as the local runner's --no-deepseek. Set to
# '0' in secrets.env once DeepSeek is funded to restore the 3-backend design.
if ($secrets['XRAY_NO_DEEPSEEK']) { $env:XRAY_NO_DEEPSEEK = $secrets['XRAY_NO_DEEPSEEK'] } else { $env:XRAY_NO_DEEPSEEK = '1' }
# Optional model / tuning overrides pass straight through if present in secrets.env
foreach ($opt in @('GEMINI_TRIAGE_MODEL','GEMINI_SPECIALIST_MODEL','GEMINI_SYNTHESIS_MODEL','DEEPSEEK_SPECIALIST_MODEL','DEEPSEEK_SYNTHESIS_MODEL','OLLAMA_MODEL','OLLAMA_TIMEOUT_MS','XRAY_FANOUT_CEILING_MS')) {
    if ($secrets[$opt]) { Set-Item -Path "env:$opt" -Value $secrets[$opt] }
}

New-Item -ItemType Directory -Force $env:XRAY_OUT_DIR | Out-Null

# ---- 2. Upsert + activate the workflow --------------------------------------
# Auth for all backends comes from the env vars above (GEMINI_API_KEY /
# DEEPSEEK_API_KEY read by the HTTP nodes and the Fan-out Code node), so there
# is no n8n credential store to provision. Import is idempotent (fixed ID).
$wf = Join-Path $ProjectRoot 'n8n\xray-report-analyzer.workflow.json'
n8n import:workflow --input="$wf" | Out-Null
try {
    n8n update:workflow --id=XrayReportAnal01 --active=true | Out-Null
    Write-Host "Workflow imported and ACTIVATED (id XrayReportAnal01)." -ForegroundColor Green
} catch {
    Write-Host "Workflow imported; activate it in the UI (toggle top-right)." -ForegroundColor Yellow
}

# ---- 3. Preflight + launch ---------------------------------------------------
$ollamaModel = if ($env:OLLAMA_MODEL) { $env:OLLAMA_MODEL } else { 'llama3.1:8b' }
try {
    Invoke-WebRequest -UseBasicParsing "$($env:OLLAMA_BASE_URL)/api/version" -TimeoutSec 5 | Out-Null
    Write-Host "Ollama reachable at $($env:OLLAMA_BASE_URL)." -ForegroundColor Green
    # Pre-warm the model so the first (timed) specialist call is not a cold load.
    Write-Host "Pre-warming Ollama model '$ollamaModel' (first load can take a minute)..." -ForegroundColor DarkGray
    try {
        Invoke-RestMethod -Uri "$($env:OLLAMA_BASE_URL)/api/chat" -Method Post -TimeoutSec 180 -ContentType 'application/json' `
            -Body (@{ model = $ollamaModel; messages = @(@{ role = 'user'; content = 'hi' }); stream = $false } | ConvertTo-Json) | Out-Null
        Write-Host "Ollama model warm." -ForegroundColor Green
    } catch { Write-Host "  (warmup skipped: $($_.Exception.Message))" -ForegroundColor DarkGray }
} catch {
    Write-Host "WARNING: Ollama not reachable at $($env:OLLAMA_BASE_URL) -- the pipeline will run degraded (2 of 3 specialists)." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Starting n8n at http://localhost:5678" -ForegroundColor Cyan
Write-Host "Form URL (after activating the workflow): http://localhost:5678/form/xray-report-intake" -ForegroundColor Cyan
n8n start
