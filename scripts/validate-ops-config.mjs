import { access, readFile } from 'node:fs/promises';

const dashboards = [
  'release-health',
  'sync-health',
  'integrity-health',
  'dependency-health',
  'observability-overview',
];
for (const name of dashboards) {
  const path = `ops/grafana/dashboards/${name}.json`;
  const dashboard = JSON.parse(await readFile(path, 'utf8'));
  if (
    !dashboard.uid ||
    !dashboard.title ||
    !Array.isArray(dashboard.panels) ||
    dashboard.panels.length === 0
  ) {
    throw new Error(`Invalid Grafana dashboard: ${path}`);
  }
  if (!dashboard.templating?.list?.some(({ name }) => name === 'metrics')) {
    throw new Error(`Grafana Cloud metrics data source variable is missing: ${path}`);
  }
}

const alerts = await readFile('ops/prometheus/alerts.yml', 'utf8');
for (const alert of [
  'SyncHashMismatch',
  'SyncInvariantViolation',
  'SyncSequenceRegression',
  'SyncUnexpectedDecryptionFailure',
  'SyncCommittedObjectMissing',
  'SyncDatabaseCorruption',
  'SyncApiUnavailable',
  'SyncCommitSuccessRateLow',
  'SyncHttpServerErrorRateHigh',
  'SyncNotificationBacklog',
  'SyncOutboxAgeHigh',
]) {
  if (!alerts.includes(`alert: ${alert}`)) throw new Error(`Missing Prometheus alert: ${alert}`);
}

await access('scripts/configure-grafana-cloud.ps1');
await access('.github/workflows/security.yml');

const stagingTask = JSON.parse(await readFile('ops/aws/ecs/task-definition.staging.json', 'utf8'));
if (
  stagingTask.cpu !== '512' ||
  stagingTask.memory !== '1024' ||
  stagingTask.runtimePlatform?.cpuArchitecture !== 'ARM64'
) {
  throw new Error('Staging ECS task must use the approved 0.5 vCPU, 1 GiB ARM64 profile.');
}

const stagingContainer = stagingTask.containerDefinitions?.find(({ name }) => name === 'Main');
if (stagingContainer?.cpu !== 512 || stagingContainer?.memoryReservation !== 1024) {
  throw new Error('Staging container resources must match the ARM64 task profile.');
}

const stagingEnvironment = Object.fromEntries(
  stagingContainer.environment.map(({ name, value }) => [name, value]),
);
for (const setting of [
  'SYNC_TRACING_ENABLED',
  'SYNC_OTLP_METRICS_ENABLED',
  'SYNC_OTLP_LOGS_ENABLED',
]) {
  if (stagingEnvironment[setting] !== 'true') {
    throw new Error(`Staging Grafana Cloud export must enable ${setting}.`);
  }
}
const stagingSecrets = new Set(stagingContainer.secrets.map(({ name }) => name));
for (const secret of ['SYNC_OTLP_BASE_ENDPOINT', 'SYNC_OTLP_AUTHORIZATION_HEADER']) {
  if (!stagingSecrets.has(secret))
    throw new Error(`Staging is missing Grafana Cloud secret: ${secret}`);
}

const backendConfig = await readFile('backend/sync-api/src/main/resources/application.yml', 'utf8');
for (const path of ['/v1/metrics', '/v1/logs', '/v1/traces']) {
  if (!backendConfig.includes(path)) throw new Error(`Backend OTLP export is missing ${path}.`);
}

const faroAdapter = await readFile('src/infrastructure/telemetry/GrafanaFaro.ts', 'utf8');
for (const privacyControl of ['instrumentations: []', 'metas: []', 'trackGeolocation: false']) {
  if (!faroAdapter.includes(privacyControl)) {
    throw new Error(`Grafana Faro privacy control is missing: ${privacyControl}`);
  }
}

const stagingWorkflow = await readFile('.github/workflows/deploy-staging.yml', 'utf8');
for (const requiredDeploymentSetting of [
  '--platform linux/arm64',
  '--desired-count 1',
  '--health-check-grace-period-seconds 300',
  '--cache-from type=gha,scope=staging-backend-arm64',
  '--cache-to type=gha,mode=max,scope=staging-backend-arm64',
  'docker/setup-qemu-action@v3',
  'docker/setup-buildx-action@v3',
  'SYNC_RELEASE_VERSION=${{ github.sha }}',
]) {
  if (!stagingWorkflow.includes(requiredDeploymentSetting)) {
    throw new Error(`Missing staging deployment setting: ${requiredDeploymentSetting}`);
  }
}

const stagingSchedule = await readFile('ops/aws/scheduler/staging-hours.yml', 'utf8');
for (const requiredScheduleSetting of [
  'AWS::Scheduler::Schedule',
  'Asia/Kolkata',
  'DesiredCount":1',
  'DesiredCount":0',
]) {
  if (!stagingSchedule.includes(requiredScheduleSetting)) {
    throw new Error(`Missing staging schedule setting: ${requiredScheduleSetting}`);
  }
}
if ((stagingSchedule.match(/Mode: 'OFF'/g) ?? []).length !== 2) {
  throw new Error('Scheduler flexible-window OFF values must be quoted to remain strings in YAML.');
}

const stagingDeployPolicy = JSON.parse(
  await readFile('ops/aws/iam/github-actions-staging-permissions.json', 'utf8'),
);
const stagingImageActions =
  stagingDeployPolicy.Statement.find(({ Sid }) => Sid === 'PushAndInspectStagingImages')?.Action ??
  [];
if (!stagingImageActions.includes('ecr:BatchGetImage')) {
  throw new Error('Staging deployment role must be able to read ECR manifests for Buildx pushes.');
}

console.log('Operational dashboards, alerts, and security workflow validation passed.');
