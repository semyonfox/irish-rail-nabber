-- the archive keeps update_hash as the first 8 bytes of the SHA-256 in a
-- bigint. the 64-char hex text doesn't compress and was 71% of every stop
-- observation chunk. compressed hourly chunks also merge into daily ones.
--
-- this runs on every deploy. it converts the column only while the table is
-- empty, so a fresh install starts compact and a populated archive is left to
-- scripts/compact_bus_archive.py, which rebuilds it without blocking the
-- collector. the daemon writes whichever type the column has.
DO $$
DECLARE
    archive TEXT;
    is_empty BOOLEAN;
BEGIN
    FOREACH archive IN ARRAY ARRAY['bus_stop_observations', 'bus_vehicle_observations'] LOOP
        IF EXISTS (
            SELECT 1 FROM pg_attribute
            WHERE attrelid = archive::regclass AND attname = 'update_hash'
              AND NOT attisdropped AND atttypid = 'text'::regtype
        ) THEN
            EXECUTE format('SELECT NOT EXISTS (SELECT 1 FROM %I)', archive) INTO is_empty;
            IF is_empty THEN
                EXECUTE format(
                    'ALTER TABLE %I ALTER COLUMN update_hash TYPE BIGINT
                     USING (''x'' || left(update_hash, 16))::bit(64)::bigint',
                    archive
                );
            END IF;
        END IF;
    END LOOP;

    FOREACH archive IN ARRAY ARRAY[
        'bus_stop_observations', 'bus_vehicle_observations', 'bus_trip_observations'
    ] LOOP
        IF EXISTS (
            SELECT 1 FROM timescaledb_information.hypertable_columnstore_settings
            WHERE hypertable = archive::regclass AND compress_interval_length IS NULL
        ) THEN
            EXECUTE format(
                'ALTER TABLE %I SET (timescaledb.compress_chunk_time_interval = ''1 day'')',
                archive
            );
        END IF;
    END LOOP;
END $$;
