$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $root 'dev/local-sync-v2.compose.yml'
$envFile = Join-Path $root '.env'
$localDirectory = Join-Path $root '.local'

if (-not (Test-Path $envFile)) {
  throw 'Missing .env. Copy .env.example and configure the existing Google and Supabase values first.'
}

$values = @{}
Get-Content $envFile | ForEach-Object {
  if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
    $values[$Matches[1]] = $Matches[2].Trim().Trim('"').Trim("'")
  }
}
$supabaseUrl = $values['VITE_SUPABASE_URL'].TrimEnd('/')
if ($supabaseUrl -notmatch '^https://[^/]+\.supabase\.co$' -or $values['VITE_SUPABASE_ANON_KEY'].Length -lt 20) {
  throw 'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must reference a configured Supabase project.'
}

New-Item -ItemType Directory -Force -Path $localDirectory | Out-Null
docker compose -f $composeFile up -d

$postgresDeadline = (Get-Date).AddSeconds(60)
do {
  docker exec dear-diary-sync-postgres pg_isready -U dear_diary_sync -d dear_diary_sync *> $null
  if ($LASTEXITCODE -eq 0) { break }
  Start-Sleep -Seconds 2
} while ((Get-Date) -lt $postgresDeadline)
if ($LASTEXITCODE -ne 0) { throw 'Local PostgreSQL did not become ready.' }

$env:SYNC_DB_URL = 'jdbc:postgresql://localhost:5432/dear_diary_sync'
$env:SPRING_PROFILES_ACTIVE = 'development'
$env:SYNC_DB_USERNAME = 'dear_diary_sync'
$env:SYNC_DB_PASSWORD = 'dear_diary_local'
$env:SYNC_JWT_ENABLED = 'true'
$env:SYNC_JWT_ISSUER_URI = "$supabaseUrl/auth/v1"
$env:SYNC_JWT_JWK_SET_URI = "$supabaseUrl/auth/v1/.well-known/jwks.json"
$env:SYNC_JWT_AUDIENCE = 'authenticated'
$env:SYNC_CORS_ALLOWED_ORIGINS = 'http://localhost:3000,http://127.0.0.1:3000,https://localhost,capacitor://localhost'
$env:SYNC_OBJECT_STORE_ENABLED = 'true'
$env:SYNC_OBJECT_STORE_BUCKET = 'dear-diary-sync'
$env:SYNC_OBJECT_STORE_REGION = 'us-east-1'
$env:SYNC_OBJECT_STORE_ENDPOINT = 'http://localhost:9000'
$env:SYNC_OBJECT_STORE_PATH_STYLE = 'true'
$env:AWS_ACCESS_KEY_ID = 'dear_diary_local'
$env:AWS_SECRET_ACCESS_KEY = 'dear_diary_local_secret'

$backendListener = Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $backendListener) {
  $backendOut = Join-Path $localDirectory 'sync-backend.out.log'
  $backendError = Join-Path $localDirectory 'sync-backend.err.log'
  $backend = Start-Process -FilePath 'cmd.exe' -ArgumentList '/d', '/s', '/c', 'npm.cmd run backend:bootRun' `
    -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $backendOut `
    -RedirectStandardError $backendError -PassThru
  Set-Content -Path (Join-Path $localDirectory 'sync-backend.pid') -Value $backend.Id
}

$backendDeadline = (Get-Date).AddSeconds(90)
$backendReady = $false
do {
  try {
    $response = Invoke-WebRequest -UseBasicParsing 'http://localhost:8080/actuator/health' -TimeoutSec 3
    $backendReady = $response.StatusCode -eq 200
  } catch { Start-Sleep -Seconds 2 }
} while (-not $backendReady -and (Get-Date) -lt $backendDeadline)
if (-not $backendReady) { throw "Sync backend did not start. See $localDirectory/sync-backend.err.log." }

docker exec dear-diary-sync-postgres psql -U dear_diary_sync -d dear_diary_sync -v ON_ERROR_STOP=1 -c @'
UPDATE sync_protocol_config
SET snapshot_creation_enabled = TRUE,
    primary_recovery_enabled = TRUE,
    sync_v2_rollout_percentage = 100,
    updated_at = CURRENT_TIMESTAMP
WHERE config_id = 1;
UPDATE sync_kill_switches
SET engaged = FALSE,
    reason_code = NULL,
    updated_at = CURRENT_TIMESTAMP,
    updated_by = 'local-setup'
WHERE switch_name IN ('SNAPSHOT_CREATION', 'PRIMARY_RECOVERY');
'@ | Out-Null

$frontendListener = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $frontendListener) {
  $frontendOut = Join-Path $localDirectory 'web.out.log'
  $frontendError = Join-Path $localDirectory 'web.err.log'
  $frontend = Start-Process -FilePath 'cmd.exe' -ArgumentList '/d', '/s', '/c', 'npm.cmd run dev' `
    -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $frontendOut `
    -RedirectStandardError $frontendError -PassThru
  Set-Content -Path (Join-Path $localDirectory 'web.pid') -Value $frontend.Id
}

$frontendDeadline = (Get-Date).AddSeconds(60)
$frontendReady = $false
do {
  try {
    $response = Invoke-WebRequest -UseBasicParsing 'http://localhost:3000' -TimeoutSec 3
    $frontendReady = $response.StatusCode -eq 200
  } catch { Start-Sleep -Seconds 2 }
} while (-not $frontendReady -and (Get-Date) -lt $frontendDeadline)
if (-not $frontendReady) { throw "Web app did not start. See $localDirectory/web.err.log." }

$adb = Get-Command adb -ErrorAction SilentlyContinue
if ($adb) {
  try {
    $attachedDevices = @((& adb devices) | Where-Object { $_ -match "`tdevice$" } | ForEach-Object { ($_ -split "`t")[0] })
    foreach ($device in $attachedDevices) {
      & adb -s $device reverse tcp:8080 tcp:8080 | Out-Null
      & adb -s $device reverse tcp:9000 tcp:9000 | Out-Null
      Write-Host "  Emulator:      adb reverse tcp:8080 and tcp:9000 configured for $device"
    }
  } catch {
    Write-Warning "Could not configure adb reverse automatically. Run 'adb reverse tcp:8080 tcp:8080' and 'adb reverse tcp:9000 tcp:9000' before testing the Android app."
  }
}

Write-Host 'Dear Diary local Sync V2 stack is ready:'
Write-Host '  App:           http://localhost:3000'
Write-Host '  Backend:       http://localhost:8080/actuator/health'
Write-Host '  MinIO console: http://localhost:9001'
Write-Host '  Local logs:    .local/'
