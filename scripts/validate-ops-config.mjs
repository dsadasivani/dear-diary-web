import { access, readFile } from 'node:fs/promises';

const dashboards = ['release-health', 'sync-health', 'integrity-health', 'dependency-health'];
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
}

const alerts = await readFile('ops/prometheus/alerts.yml', 'utf8');
for (const alert of [
  'SyncHashMismatch',
  'SyncInvariantViolation',
  'SyncSequenceRegression',
  'SyncUnexpectedDecryptionFailure',
  'SyncCommittedObjectMissing',
  'SyncDatabaseCorruption',
  'SyncCommitSuccessRateLow',
  'SyncNotificationBacklog',
  'SyncOutboxAgeHigh',
]) {
  if (!alerts.includes(`alert: ${alert}`)) throw new Error(`Missing Prometheus alert: ${alert}`);
}
await access('.github/workflows/security.yml');

const stagingTask = JSON.parse(
  await readFile('ops/aws/ecs/task-definition.staging.json', 'utf8'),
);
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

const stagingWorkflow = await readFile('.github/workflows/deploy-staging.yml', 'utf8');
for (const requiredDeploymentSetting of [
  '--platform linux/arm64',
  '--desired-count 1',
  'docker/setup-qemu-action@v3',
  'docker/setup-buildx-action@v3',
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

console.log('Operational dashboards, alerts, and security workflow validation passed.');
