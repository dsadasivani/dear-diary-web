-- Old clients could start a second browser pairing after losing their local
-- pairing journal. Keep the most recent unapproved request for each account.
WITH ranked_pairings AS (
    SELECT account_id, pairing_id,
           row_number() OVER (
               PARTITION BY account_id
               ORDER BY requested_at DESC, pairing_id DESC
           ) AS request_rank
    FROM sync_pairing_requests
    WHERE pairing_status IN ('REQUESTED', 'SNAPSHOT_PREPARING')
), superseded_pairings AS (
    SELECT ranked.account_id, ranked.pairing_id
    FROM ranked_pairings ranked
    WHERE ranked.request_rank > 1
       OR EXISTS (
           SELECT 1
           FROM sync_pairing_requests active
           WHERE active.account_id = ranked.account_id
             AND active.pairing_status = 'KEY_PACKAGE_PENDING'
       )
)
UPDATE sync_pairing_requests pairing
SET pairing_status = 'REJECTED'
FROM superseded_pairings superseded
WHERE pairing.account_id = superseded.account_id
  AND pairing.pairing_id = superseded.pairing_id;

CREATE UNIQUE INDEX uq_sync_pairing_single_unapproved
    ON sync_pairing_requests (account_id)
    WHERE pairing_status IN ('REQUESTED', 'SNAPSHOT_PREPARING');
