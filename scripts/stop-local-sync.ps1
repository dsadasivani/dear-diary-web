$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
foreach ($port in 3000, 8080) {
  $listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  foreach ($listener in $listeners) {
    Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
  }
}
Start-Sleep -Seconds 2
docker compose -f (Join-Path $root 'dev/local-sync.compose.yml') down
Write-Host 'Loredays local sync stack stopped. Docker volumes were retained.'
