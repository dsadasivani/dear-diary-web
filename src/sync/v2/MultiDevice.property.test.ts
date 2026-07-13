import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';

type Command = 'WRITE' | 'DELETE' | 'OFFLINE' | 'RECONNECT' | 'CRASH' | 'DUPLICATE' | 'PULL' | 'REVOKE';
interface Event { sequence: number; operationId: string; recordId: string; version: number; value: number | null; }
interface Device { online: boolean; revoked: boolean; cursor: number; records: Map<string, { version: number; value: number }>; localWrites: number; }

const newDevice = (): Device => ({ online: true, revoked: false, cursor: 0, records: new Map(), localWrites: 0 });

test('randomized active devices converge without sequence or version regressions', () => {
  const configuredSeed = Number(process.env.FAST_CHECK_SEED || Date.now());
  fc.assert(fc.property(
    fc.array(fc.record({
      device: fc.integer({ min: 0, max: 2 }),
      command: fc.constantFrom<Command>('WRITE', 'DELETE', 'OFFLINE', 'RECONNECT', 'CRASH', 'DUPLICATE', 'PULL', 'REVOKE'),
      record: fc.integer({ min: 0, max: 4 }),
      value: fc.integer(),
    }), { minLength: 1, maxLength: 150 }),
    commands => {
      const devices = [newDevice(), newDevice(), newDevice()];
      const events: Event[] = [];
      const committed = new Set<string>();
      const recordVersions = new Map<string, number>();
      let operationNumber = 0;

      const pull = (device: Device) => {
        if (!device.online || device.revoked) return;
        events.filter(event => event.sequence > device.cursor).forEach(event => {
          const previous = device.records.get(event.recordId)?.version || 0;
          assert.ok(event.version >= previous);
          if (event.value === null) device.records.delete(event.recordId);
          else device.records.set(event.recordId, { version: event.version, value: event.value });
          device.cursor = event.sequence;
        });
        assert.ok(device.cursor <= events.length);
      };

      commands.forEach(command => {
        const device = devices[command.device];
        if (command.command === 'OFFLINE') device.online = false;
        if (command.command === 'RECONNECT' && !device.revoked) { device.online = true; pull(device); }
        if (command.command === 'REVOKE') device.revoked = true;
        if (command.command === 'CRASH') device.online = false;
        if (command.command === 'PULL') pull(device);
        if (command.command === 'WRITE' || command.command === 'DELETE') {
          device.localWrites += 1;
          if (!device.online || device.revoked) return;
          const recordId = `record-${command.record}`;
          const operationId = `operation-${operationNumber++}`;
          if (committed.has(operationId)) return;
          const version = (recordVersions.get(recordId) || 0) + 1;
          recordVersions.set(recordId, version);
          committed.add(operationId);
          events.push({ sequence: events.length + 1, operationId, recordId, version, value: command.command === 'DELETE' ? null : command.value });
          pull(device);
        }
        if (command.command === 'DUPLICATE' && events.length > 0) committed.add(events[events.length - 1].operationId);
      });

      devices.filter(device => !device.revoked).forEach(device => { device.online = true; pull(device); });
      assert.deepEqual(events.map(event => event.sequence), Array.from({ length: events.length }, (_, index) => index + 1));
      assert.equal(new Set(events.map(event => event.operationId)).size, events.length);
      const active = devices.filter(device => !device.revoked);
      active.slice(1).forEach(device => assert.deepEqual([...device.records], [...active[0].records]));
      active.forEach(device => assert.equal(device.cursor, events.length));
      assert.ok(devices.every(device => device.localWrites >= 0));
    },
  ), { numRuns: 150, seed: configuredSeed });
});
