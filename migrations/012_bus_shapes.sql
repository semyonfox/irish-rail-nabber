-- GTFS route alignments for the active bus feed.

ALTER TABLE transit_feed_versions
    ADD COLUMN IF NOT EXISTS shapes_imported BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS bus_shape_points (
    feed_version_id BIGINT NOT NULL
        REFERENCES transit_feed_versions(id) ON DELETE CASCADE,
    shape_id TEXT NOT NULL,
    shape_pt_sequence BIGINT NOT NULL CHECK (shape_pt_sequence >= 0),
    shape_pt_lat DOUBLE PRECISION NOT NULL
        CHECK (shape_pt_lat BETWEEN -90 AND 90),
    shape_pt_lon DOUBLE PRECISION NOT NULL
        CHECK (shape_pt_lon BETWEEN -180 AND 180),
    shape_dist_traveled DOUBLE PRECISION
        CHECK (shape_dist_traveled IS NULL OR shape_dist_traveled >= 0),
    PRIMARY KEY (feed_version_id, shape_id, shape_pt_sequence)
);

COMMENT ON TABLE bus_shape_points IS
    'GTFS shapes for the active feed only; inactive versions are rehydrated before activation';
