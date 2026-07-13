export const CLIENT_METRICS = [
  'deardiary.local_write.success', 'deardiary.local_write.failure', 'deardiary.local_write.duration_ms',
  'deardiary.database.open.success', 'deardiary.database.open.failure', 'deardiary.database.open.duration_ms',
  'deardiary.outbox.depth', 'deardiary.outbox.oldest_age_ms', 'deardiary.outbox.operation.duration_ms',
  'deardiary.outbox.operation.failure', 'deardiary.sync.push.success', 'deardiary.sync.push.failure',
  'deardiary.sync.pull.success', 'deardiary.sync.pull.failure', 'deardiary.sync.cycle.duration_ms',
  'deardiary.sync.sequence_lag', 'deardiary.sync.conflict.created',
  'deardiary.sync.integrity.hash_mismatch', 'deardiary.sync.integrity.decryption_failure',
  'deardiary.sync.integrity.invariant_failure', 'deardiary.auth.refresh.success',
  'deardiary.auth.refresh.failure', 'deardiary.realtime.connected', 'deardiary.realtime.disconnected',
  'deardiary.realtime.reconnect', 'deardiary.screen.home.load_ms', 'deardiary.screen.diary.load_ms',
  'deardiary.screen.search.duration_ms', 'deardiary.screen.stats.duration_ms',
  'deardiary.media.encrypt.duration_ms', 'deardiary.media.upload.duration_ms',
  'deardiary.media.download.duration_ms', 'deardiary.media.decode.duration_ms',
] as const;

export const SYNC_TRACE_SPANS = [
  'sync.cycle', 'protocol.fetch', 'auth.refresh', 'outbox.claim', 'outbox.operation',
  'record.load', 'event.serialize', 'event.encrypt', 'object.initiate', 'object.upload',
  'operation.commit', 'operation.reconcile', 'local.acknowledge', 'events.pull',
  'metadata.fetch', 'object.download', 'hash.verify', 'event.decrypt', 'event.validate',
  'event.apply', 'cursor.persist', 'cursor.acknowledge',
] as const;
