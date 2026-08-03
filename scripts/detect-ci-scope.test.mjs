import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyCiScope } from './detect-ci-scope.mjs';

const expected = (overrides = {}) => ({
  backend: false,
  web: false,
  browser: false,
  supabase: false,
  android: false,
  ...overrides,
});

test('selects only backend CI for backend changes', () => {
  assert.deepEqual(classifyCiScope(['backend/sync-api/src/main/App.java']).scope, expected({ backend: true }));
});

test('selects web and browser CI for frontend changes', () => {
  assert.deepEqual(classifyCiScope(['src/App.tsx']).scope, expected({ web: true, browser: true }));
});

test('adds Android CI for mobile bridge changes', () => {
  assert.deepEqual(
    classifyCiScope(['src/mobile/capacitorBootstrap.ts']).scope,
    expected({ web: true, browser: true, android: true }),
  );
});

test('selects only Android CI for native project changes', () => {
  assert.deepEqual(classifyCiScope(['android/app/build.gradle']).scope, expected({ android: true }));
});

test('selects only Supabase CI for Supabase migrations', () => {
  assert.deepEqual(classifyCiScope(['docs/supabase/018_migration.sql']).scope, expected({ supabase: true }));
});

test('skips application jobs for documentation and operations changes', () => {
  assert.deepEqual(classifyCiScope(['docs/testing.md', 'ops/prometheus/alerts.yml']).scope, expected());
});

test('combines scopes when multiple application areas change', () => {
  assert.deepEqual(
    classifyCiScope(['backend/sync-api/Dockerfile', 'tests/e2e/launch.spec.ts']).scope,
    expected({ backend: true, browser: true }),
  );
});

test('runs full CI for shared manifests and CI workflow changes', () => {
  const full = expected({ backend: true, web: true, browser: true, supabase: true, android: true });
  assert.deepEqual(classifyCiScope(['package-lock.json']).scope, full);
  assert.deepEqual(classifyCiScope(['.github/workflows/ci.yml']).scope, full);
});

test('fails safe to full CI for unclassified paths', () => {
  const result = classifyCiScope(['unexpected.config']);
  assert.equal(result.full, true);
  assert.deepEqual(result.unclassified, ['unexpected.config']);
  assert.deepEqual(result.scope, expected({ backend: true, web: true, browser: true, supabase: true, android: true }));
});
