import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PrivacySafeTelemetry,
  type TelemetryAttributes,
  type TelemetryEnvelope,
} from './Telemetry';
import { createGrafanaFaroConfig } from './GrafanaFaro';

test('telemetry exports only allowlisted low-cardinality attributes', async () => {
  const exported: TelemetryEnvelope[] = [];
  let now = 10;
  const telemetry = new PrivacySafeTelemetry(
    {
      export: async (batch) => {
        exported.push(...batch);
      },
    },
    10,
    60_000,
    () => now,
  );
  const unsafeAttributes = {
    record_type: 'NOTE',
    record_id: 'must-not-leak',
    object_url: 'must-not-leak',
  } as unknown as TelemetryAttributes;
  telemetry.counter('deardiary.sync.push.success', 1, unsafeAttributes);
  const span = telemetry.startSpan('operation.commit', { protocol_version: 2 });
  now = 15;
  span.end();
  await telemetry.flush();
  assert.equal(exported.length, 2);
  assert.deepEqual(exported[0].attributes, { record_type: 'NOTE' });
  assert.equal(exported[1].durationMs, 5);
  assert.equal(JSON.stringify(exported).includes('must-not-leak'), false);
});

test('telemetry rejects unregistered metric namespaces', () => {
  const telemetry = new PrivacySafeTelemetry({ export: async () => undefined });
  assert.throws(() => telemetry.counter('arbitrary.user.metric', 1));
});

test('Faro enables only the session instrumentation required by the collector', () => {
  const config = createGrafanaFaroConfig(
    'https://faro-collector.example.grafana.net/collect/example',
    'staging',
    'release-1',
  );

  assert.deepEqual(
    config.instrumentations?.map((instrumentation) => instrumentation.name),
    ['@grafana/faro-web-sdk:instrumentation-session'],
  );
  assert.deepEqual(config.metas, []);
  assert.equal(config.sessionTracking?.enabled, true);
  assert.equal(config.sessionTracking?.persistent, false);
  assert.equal(config.trackGeolocation, false);
});
