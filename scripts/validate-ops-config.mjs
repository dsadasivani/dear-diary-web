import { access, readFile } from 'node:fs/promises';

const dashboards = {
  'release-health': ['metrics', 'logs'],
  'sync-health': ['metrics'],
  'integrity-health': ['metrics', 'logs'],
  'dependency-health': ['metrics'],
  'observability-overview': ['metrics', 'logs', 'traces'],
  'logs-and-errors': ['logs'],
};
const dashboardUids = new Set();
const dashboardTitles = new Set();
for (const [name, requiredDataSources] of Object.entries(dashboards)) {
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
  if (dashboardUids.has(dashboard.uid) || dashboardTitles.has(dashboard.title)) {
    throw new Error(`Duplicate Grafana dashboard UID or title: ${path}`);
  }
  dashboardUids.add(dashboard.uid);
  dashboardTitles.add(dashboard.title);

  if (!dashboard.time?.from || !dashboard.time?.to || !dashboard.refresh) {
    throw new Error(`Grafana dashboard time range or refresh interval is missing: ${path}`);
  }
  const variables = new Set(dashboard.templating?.list?.map(({ name }) => name) ?? []);
  for (const dataSource of requiredDataSources) {
    if (!variables.has(dataSource)) {
      throw new Error(`Grafana ${dataSource} data source variable is missing: ${path}`);
    }
  }
  if (!variables.has('environment')) {
    throw new Error(`Grafana environment filter is missing: ${path}`);
  }

  const panelIds = new Set();
  for (const panel of dashboard.panels) {
    if (
      !panel.id ||
      panelIds.has(panel.id) ||
      !panel.title ||
      !panel.description ||
      !panel.gridPos
    ) {
      throw new Error(`Grafana panel metadata or layout is invalid in ${path}`);
    }
    panelIds.add(panel.id);
    if (!Array.isArray(panel.targets) || panel.targets.length === 0) {
      throw new Error(`Grafana panel has no query targets in ${path}: ${panel.title}`);
    }
    for (const target of panel.targets) {
      if (!target.refId || (!target.expr && !target.query)) {
        throw new Error(`Grafana query target is incomplete in ${path}: ${panel.title}`);
      }
    }
  }

  const serialized = JSON.stringify(dashboard);
  for (const retiredMetric of [
    'deardiary_sync_push_failure_total',
    'deardiary_sync_pull_failure_total',
    'deardiary_session_crash_total',
    'deardiary_session_start_total',
    'deardiary_sync_integrity_hash_mismatch_total',
    'deardiary_sync_integrity_invariant_failure_total',
  ]) {
    if (serialized.includes(retiredMetric)) {
      throw new Error(
        `Grafana dashboard references a metric the application does not emit: ${retiredMetric}`,
      );
    }
  }
}

const alerts = await readFile('ops/prometheus/alerts.yml', 'utf8');
for (const retiredMetric of [
  'deardiary_sync_integrity_hash_mismatch_total',
  'deardiary_sync_integrity_invariant_failure_total',
  'deardiary_sync_integrity_decryption_failure_total',
  'deardiary_sync_pull_failure_total',
  'deardiary_outbox_oldest_age_ms_bucket',
  'deardiary_session_crash_total',
  'deardiary_session_start_total',
  'deardiary_database_open_failure_total',
]) {
  if (alerts.includes(retiredMetric)) {
    throw new Error(
      `Prometheus alerts reference a metric the application does not emit: ${retiredMetric}`,
    );
  }
}
for (const alert of [
  'SyncHashMismatch',
  'SyncSequenceRegression',
  'SyncCommittedObjectMissing',
  'SyncDatabaseCorruption',
  'SyncApiUnavailable',
  'SyncCommitSuccessRateLow',
  'SyncHttpServerErrorRateHigh',
  'SyncNotificationBacklog',
]) {
  if (!alerts.includes(`alert: ${alert}`)) throw new Error(`Missing Prometheus alert: ${alert}`);
}

await access('scripts/configure-grafana-cloud.ps1');
await access('.github/workflows/security.yml');

const stagingTask = JSON.parse(await readFile('ops/aws/ecs/task-definition.staging.json', 'utf8'));
if (
  stagingTask.cpu !== '256' ||
  stagingTask.memory !== '1024' ||
  stagingTask.runtimePlatform?.cpuArchitecture !== 'ARM64'
) {
  throw new Error('Staging ECS task must use the approved 0.25 vCPU, 1 GiB ARM64 profile.');
}

const stagingContainer = stagingTask.containerDefinitions?.find(({ name }) => name === 'Main');
if (stagingContainer?.cpu !== 256 || stagingContainer?.memoryReservation !== 1024) {
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
for (const privacyControl of [
  'instrumentations: [new SessionInstrumentation()]',
  'metas: []',
  'trackGeolocation: false',
]) {
  if (!faroAdapter.includes(privacyControl)) {
    throw new Error(`Grafana Faro privacy control is missing: ${privacyControl}`);
  }
}

const webHeaders = await readFile('customHttp.yml', 'utf8');
if (!webHeaders.includes('https://*.grafana.net')) {
  throw new Error('The web Content Security Policy must allow the Grafana Faro collector.');
}

const stagingWorkflow = await readFile('.github/workflows/deploy-staging.yml', 'utf8');
for (const requiredDeploymentSetting of [
  '--platform linux/arm64',
  '--target lambda',
  '--cache-from type=gha,scope=staging-lambda-arm64',
  '--cache-to type=gha,mode=max,scope=staging-lambda-arm64',
  'docker/setup-qemu-action@v3',
  'docker/setup-buildx-action@v3',
  'aws lambda update-function-code',
  'aws lambda update-function-configuration',
  'aws lambda wait function-updated',
  'aws ssm get-parameter',
  'Protected endpoint returned $auth_status without a JWT; expected 401.',
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
  'State: DISABLED',
]) {
  if (!stagingSchedule.includes(requiredScheduleSetting)) {
    throw new Error(`Missing staging schedule setting: ${requiredScheduleSetting}`);
  }
}
if ((stagingSchedule.match(/Mode: 'OFF'/g) ?? []).length !== 2) {
  throw new Error('Scheduler flexible-window OFF values must be quoted to remain strings in YAML.');
}
if ((stagingSchedule.match(/State: DISABLED/g) ?? []).length !== 2) {
  throw new Error('Both legacy ECS schedules must remain disabled after the Lambda migration.');
}

const ecrLifecyclePolicy = JSON.parse(
  await readFile('ops/aws/ecr/lifecycle-policy.staging.json', 'utf8'),
);
const ecrRetentionRule = ecrLifecyclePolicy.rules?.find(
  ({ selection }) => selection?.tagStatus === 'any',
);
if (
  ecrRetentionRule?.selection?.countType !== 'imageCountMoreThan' ||
  ecrRetentionRule.selection.countNumber !== 10 ||
  ecrRetentionRule.action?.type !== 'expire'
) {
  throw new Error('Staging ECR lifecycle policy must retain the latest 10 images.');
}

const lambdaTemplate = await readFile('ops/aws/lambda/sync-api.staging.yml', 'utf8');
for (const requiredLambdaSetting of [
  'PackageType: Image',
  '- arm64',
  'MemorySize: 2048',
  "SYNC_DB_MAX_POOL_SIZE: '2'",
  "SYNC_SCHEDULING_ENABLED: 'false'",
  "SYNC_TRACING_ENABLED: 'false'",
  'AWS_LWA_ASYNC_INIT',
  'AWS_LWA_READINESS_CHECK_PATH',
  'Type: AWS::Lambda::Url',
  'InvokedViaFunctionUrl: true',
]) {
  if (!lambdaTemplate.includes(requiredLambdaSetting)) {
    throw new Error(`Missing staging Lambda setting: ${requiredLambdaSetting}`);
  }
}

const syncApiDockerfile = await readFile('backend/sync-api/Dockerfile', 'utf8');
for (const requiredLambdaImageSetting of [
  'AS lambda',
  'public.ecr.aws/awsguru/aws-lambda-adapter:1.0.0',
  'FROM runtime AS ecs',
]) {
  if (!syncApiDockerfile.includes(requiredLambdaImageSetting)) {
    throw new Error(`Missing Lambda image setting: ${requiredLambdaImageSetting}`);
  }
}

const schedulingConfig = await readFile(
  'backend/sync-api/src/main/java/com/deardiary/sync/config/SchedulingConfig.java',
  'utf8',
);
if (
  !schedulingConfig.includes(
    '@ConditionalOnProperty(name = "sync.scheduling.enabled", havingValue = "true", matchIfMissing = true)',
  )
) {
  throw new Error('Spring scheduling must be explicitly disableable for Lambda containers.');
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
const stagingLambdaActions =
  stagingDeployPolicy.Statement.find(({ Sid }) => Sid === 'DeployTheStagingLambda')?.Action ?? [];
for (const action of [
  'lambda:GetFunction',
  'lambda:GetFunctionUrlConfig',
  'lambda:UpdateFunctionCode',
  'lambda:UpdateFunctionConfiguration',
]) {
  if (!stagingLambdaActions.includes(action)) {
    throw new Error(`Staging deployment role is missing ${action}.`);
  }
}
if (
  stagingDeployPolicy.Statement.find(({ Sid }) => Sid === 'ReadStagingParametersForLambda')
    ?.Action !== 'ssm:GetParameter'
) {
  throw new Error('Staging deployment role must read the scoped staging parameters for Lambda.');
}

console.log('Operational dashboards, alerts, and security workflow validation passed.');
