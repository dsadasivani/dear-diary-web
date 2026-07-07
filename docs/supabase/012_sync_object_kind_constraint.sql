-- Allow all sync object kinds introduced by partitioned sync and media thumbnails.
-- Apply after 011_fix_pairing_digest.sql.

alter table public.sync_objects
  drop constraint if exists sync_objects_object_kind_check;

alter table public.sync_objects
  add constraint sync_objects_object_kind_check
  check (
    object_kind in (
      'event',
      'media',
      'snapshot',
      'key_package',
      'manifest',
      'partition_snapshot',
      'thumbnail'
    )
  );
