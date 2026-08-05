param(
  [ValidateSet('staging', 'production')]
  [string]$Environment = 'staging',
  [string]$OtlpEndpoint = '',
  [string]$FaroCollectorUrl = '',
  [string]$AwsRegion = 'ap-south-1',
  [string]$AmplifyAppId = 'd33b4rjnv35mrn',
  [string]$AmplifyBranch = 'staging'
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
  throw 'AWS CLI is required and must be authenticated for the Dear Diary AWS account.'
}

if (-not $OtlpEndpoint) {
  $OtlpEndpoint = Read-Host 'Grafana Cloud OTEL_EXPORTER_OTLP_ENDPOINT (ends in /otlp)'
}
if (-not $FaroCollectorUrl) {
  $FaroCollectorUrl = Read-Host 'Grafana Cloud Frontend Observability collector URL'
}
$authorization = Read-Host 'Grafana Cloud Authorization header value (starts with Basic)' -AsSecureString
$authorizationPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($authorization)

try {
  $authorizationValue = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($authorizationPointer).Trim()
  if ($authorizationValue.StartsWith('Authorization=', [StringComparison]::OrdinalIgnoreCase)) {
    $authorizationValue = $authorizationValue.Substring('Authorization='.Length)
  }
  $authorizationValue = $authorizationValue.Replace('Basic%20', 'Basic ')
  $OtlpEndpoint = $OtlpEndpoint.Trim().TrimEnd('/')
  $FaroCollectorUrl = $FaroCollectorUrl.Trim()

  if ($OtlpEndpoint -notmatch '^https://[^/]+\.grafana\.net/otlp$') {
    throw 'The OTLP endpoint must be an HTTPS Grafana Cloud endpoint ending in /otlp.'
  }
  if ($FaroCollectorUrl -notmatch '^https://[^/]+\.grafana\.net/collect/') {
    throw 'The Faro collector URL must be an HTTPS Grafana Cloud URL containing /collect/.'
  }
  if ($authorizationValue -notmatch '^Basic\s+\S+$') {
    throw 'The Authorization value must start with Basic followed by the Grafana-provided credential.'
  }

  aws sts get-caller-identity --no-cli-pager | Out-Null

  function Set-SecureParameter([string]$Name, [string]$Value) {
    $inputPath = [System.IO.Path]::GetTempFileName()
    try {
      @{
        Name      = $Name
        Type      = 'SecureString'
        Value     = $Value
        Overwrite = $true
      } | ConvertTo-Json -Compress | Set-Content -LiteralPath $inputPath -NoNewline
      aws ssm put-parameter --cli-input-json "file://$inputPath" --region $AwsRegion --no-cli-pager | Out-Null
    } finally {
      Remove-Item -LiteralPath $inputPath -Force -ErrorAction SilentlyContinue
    }
  }

  $parameterPrefix = "/dear-diary/$Environment"
  Set-SecureParameter "$parameterPrefix/grafana-otlp-endpoint" $OtlpEndpoint
  Set-SecureParameter "$parameterPrefix/grafana-otlp-authorization" $authorizationValue

  $branch = aws amplify get-branch --app-id $AmplifyAppId --branch-name $AmplifyBranch `
    --region $AwsRegion --output json --no-cli-pager | ConvertFrom-Json
  $environmentVariables = @{}
  if ($branch.branch.environmentVariables) {
    $branch.branch.environmentVariables.PSObject.Properties | ForEach-Object {
      $environmentVariables[$_.Name] = $_.Value
    }
  }
  $environmentVariables['VITE_GRAFANA_FARO_URL'] = $FaroCollectorUrl

  $amplifyInputPath = [System.IO.Path]::GetTempFileName()
  try {
    @{
      appId                = $AmplifyAppId
      branchName           = $AmplifyBranch
      environmentVariables = $environmentVariables
    } | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath $amplifyInputPath -NoNewline
    aws amplify update-branch --cli-input-json "file://$amplifyInputPath" --region $AwsRegion `
      --no-cli-pager | Out-Null
  } finally {
    Remove-Item -LiteralPath $amplifyInputPath -Force -ErrorAction SilentlyContinue
  }

  Write-Host "Grafana Cloud connection values are configured for $Environment."
  Write-Host 'Redeploy the frontend and backend to begin sending telemetry.'
} finally {
  if ($authorizationPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($authorizationPointer)
  }
  $authorizationValue = $null
}
