-- the bus working tables churn every poll and every cleanup run, but the
-- default autovacuum waits for 20% of a table to be dead first. on
-- bus_delay_samples that was millions of rows, so the heap and its key kept
-- growing. vacuum them after 2% instead. the setting is only applied when it
-- differs, because this runs on every deploy
DO $$
DECLARE
    working_table TEXT;
BEGIN
    FOREACH working_table IN ARRAY ARRAY[
        'bus_delay_samples', 'bus_trip_update_freshness', 'bus_stop_live'
    ] LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_class
            WHERE oid = working_table::regclass
              AND reloptions @> ARRAY['autovacuum_vacuum_scale_factor=0.02']
        ) THEN
            EXECUTE format(
                'ALTER TABLE %I SET (autovacuum_vacuum_scale_factor = 0.02)',
                working_table
            );
        END IF;
    END LOOP;
END $$;
