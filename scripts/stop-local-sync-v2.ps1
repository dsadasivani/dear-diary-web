$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
foreach ($port in 3000, 8080) {
  $listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  foreach ($listener in $listeners) {
    Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
  }
}
Start-Sleep -Seconds 2
docker compose -f (Join-Path $root 'dev/local-sync-v2.compose.yml') down
Write-Host 'Dear Diary local Sync V2 stack stopped. Docker volumes were retained.'
