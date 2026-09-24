-- The compressed observation archive now owns permanent prediction history.
-- Production drops this legacy copy only after full backup restore and parity checks.
DO $$
BEGIN
    IF to_regclass('public.bus_stop_updates') IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM bus_stop_updates LIMIT 1)
           AND (SELECT COUNT(*) FROM bus_storage_backfill_progress
                WHERE name IN ('stop_archive', 'delay_samples')
                  AND last_id >= target_id) <> 2 THEN
            RAISE EXCEPTION 'Legacy bus backfill is incomplete; refusing to drop bus_stop_updates';
        END IF;
    END IF;
END $$;

DROP TABLE IF EXISTS bus_stop_updates;
