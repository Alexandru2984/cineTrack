-- Resolve any duplicate reservations created by the old check-then-insert flow
-- before enforcing one non-failed import per account.
WITH ranked AS (
    SELECT
        id,
        ROW_NUMBER() OVER (
            PARTITION BY user_id
            ORDER BY
                CASE status
                    WHEN 'completed' THEN 0
                    WHEN 'running' THEN 1
                    ELSE 2
                END,
                created_at
        ) AS position
    FROM import_jobs
    WHERE status IN ('pending', 'running', 'completed')
)
UPDATE import_jobs
SET
    status = 'failed',
    error = 'Import superseded by another job',
    updated_at = NOW()
WHERE id IN (SELECT id FROM ranked WHERE position > 1);

CREATE UNIQUE INDEX import_jobs_one_nonfailed_per_user
    ON import_jobs (user_id)
    WHERE status IN ('pending', 'running', 'completed');

UPDATE import_jobs
SET error = LEFT(error, 500)
WHERE error IS NOT NULL AND char_length(error) > 500;

ALTER TABLE import_jobs
    ADD CONSTRAINT import_jobs_error_length CHECK (
        error IS NULL OR char_length(error) <= 500
    );
