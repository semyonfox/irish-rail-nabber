-- live boards and tracking only read the last few minutes, so the rail
-- hypertables keep one uncompressed day instead of up to two weeks.
-- new chunks span a day and compress after two days. compressed chunks still
-- merge into weekly ones through compress_chunk_time_interval = '7 days'.
-- existing chunks keep their 7-day range. this runs on every deploy, so the
-- policy is only replaced when it differs.
DO $$
DECLARE
    rail_table TEXT;
BEGIN
    FOREACH rail_table IN ARRAY ARRAY[
        'train_snapshots', 'station_events', 'train_movements', 'train_snapshots_hacon'
    ] LOOP
        PERFORM set_chunk_time_interval(rail_table::regclass, INTERVAL '1 day');

        IF NOT EXISTS (
            SELECT 1 FROM timescaledb_information.jobs
            WHERE hypertable_name = rail_table
              AND proc_name = 'policy_compression'
              AND (config->>'compress_after')::interval = INTERVAL '2 days'
        ) THEN
            PERFORM remove_compression_policy(rail_table::regclass, if_exists => TRUE);
            PERFORM add_compression_policy(rail_table::regclass, INTERVAL '2 days');
        END IF;
    END LOOP;
END $$;
