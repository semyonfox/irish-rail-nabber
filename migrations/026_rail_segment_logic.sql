-- which version of the segment rollup produced a day. days from an older
-- version are rolled up again by the daemon, newest first
ALTER TABLE rail_segment_rollup_days
    ADD COLUMN IF NOT EXISTS logic SMALLINT NOT NULL DEFAULT 1;
