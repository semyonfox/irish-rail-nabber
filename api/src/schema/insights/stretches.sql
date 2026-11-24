WITH hourly AS (
    SELECT NULL::bigint AS feed_version_id, from_code AS from_id, to_code AS to_id, service_date,
           trains AS trips, gain_sum_s, gain_pos_sum_s, gain_sq_sum, run_sum_s, sched_run_sum_s
    FROM rail_segment_delay_hourly
    WHERE $1::text = 'RAIL' AND service_date BETWEEN $2 AND $3
      AND hour_local >= $4 AND hour_local < $5

    UNION ALL

    SELECT feed_version_id, from_stop_id, to_stop_id, service_date, trips,
           gain_sum_s, gain_pos_sum_s, gain_sq_sum, run_sum_s, sched_run_sum_s
    FROM bus_segment_delay_hourly
    WHERE $1 = 'BUS' AND service_date BETWEEN $2 AND $3
      AND hour_local >= $4 AND hour_local < $5
), ranked AS (
    SELECT MAX(feed_version_id) AS feed_version_id, from_id, to_id, SUM(trips) AS trips,
           -- one bit per date in the range (at most 31), so grouping needs no distinct sort
           bit_count(bit_or((1 << (service_date - $2))::bit(31)))::int AS days_with_data,
           SUM(gain_sum_s)::double precision / 60 AS net_delay_minutes,
           SUM(gain_pos_sum_s)::double precision / 60 AS added_minutes,
           SUM(gain_sum_s)::double precision / SUM(trips) AS avg_gain_s,
           SUM(gain_sq_sum)::double precision / SUM(trips) AS mean_square_s,
           100 * ((SUM(run_sum_s) - SUM(sched_run_sum_s)) / NULLIF(SUM(sched_run_sum_s), 0))::double precision
               AS overrun_pct
    FROM hourly
    GROUP BY from_id, to_id
    HAVING SUM(trips) >= $6 AND SUM(gain_sum_s) > 0
    ORDER BY net_delay_minutes DESC, from_id, to_id
    LIMIT $7
)
SELECT from_id, to_id,
       COALESCE(from_station.station_desc, from_stop.stop_name, from_id) AS from_name,
       COALESCE(to_station.station_desc, to_stop.stop_name, to_id) AS to_name,
       COALESCE(from_station.latitude::double precision, from_stop.stop_lat) AS from_lat,
       COALESCE(from_station.longitude::double precision, from_stop.stop_lon) AS from_lon,
       COALESCE(to_station.latitude::double precision, to_stop.stop_lat) AS to_lat,
       COALESCE(to_station.longitude::double precision, to_stop.stop_lon) AS to_lon,
       trips, days_with_data, net_delay_minutes, added_minutes, avg_gain_s / 60 AS avg_gain_minutes,
       sqrt(GREATEST(mean_square_s - avg_gain_s * avg_gain_s, 0)) / 60 AS stddev_minutes,
       median.lower_s AS median_gain_lower_s, median.upper_s AS median_gain_upper_s,
       bus_detail.gain_at_least_two_minutes_pct,
       overrun_pct, COALESCE(bus_detail.routes, '{}') AS routes
FROM ranked
LEFT JOIN stations from_station ON $1 = 'RAIL' AND from_station.station_code = from_id
LEFT JOIN stations to_station ON $1 = 'RAIL' AND to_station.station_code = to_id
LEFT JOIN bus_stops from_stop ON (from_stop.feed_version_id, from_stop.stop_id) = (ranked.feed_version_id, from_id)
LEFT JOIN bus_stops to_stop ON (to_stop.feed_version_id, to_stop.stop_id) = (ranked.feed_version_id, to_id)
LEFT JOIN LATERAL (
    WITH bus_hours AS MATERIALIZED (
        SELECT bus.gain_hist, bus.route_ids
        FROM bus_segment_delay_hourly bus
        WHERE $1 = 'BUS' AND (bus.from_stop_id, bus.to_stop_id) = (from_id, to_id)
          AND bus.service_date BETWEEN $2 AND $3 AND bus.hour_local >= $4 AND bus.hour_local < $5
    )
    SELECT ARRAY(
               SELECT DISTINCT COALESCE(NULLIF(route.route_short_name, ''), NULLIF(route.route_long_name, ''), ids.id)
               FROM bus_hours
               CROSS JOIN LATERAL unnest(route_ids) AS ids(id)
               LEFT JOIN bus_routes route ON (route.feed_version_id, route.route_id) = (ranked.feed_version_id, ids.id)
               ORDER BY 1
           ) AS routes,
           MIN(bucket) FILTER (WHERE cumulative >= (ranked.trips + 1) / 2) AS median_bucket,
           (100 * SUM(CASE WHEN bucket BETWEEN 9 AND 10 THEN n ELSE 0 END) / NULLIF(SUM(n), 0))::double precision
               AS gain_at_least_two_minutes_pct
    FROM (
        SELECT bucket, SUM(n) AS n, SUM(SUM(n)) OVER (ORDER BY bucket) AS cumulative
        FROM bus_hours
        CROSS JOIN LATERAL unnest(gain_hist) WITH ORDINALITY AS histogram(n, bucket)
        GROUP BY bucket
    ) counts
) bus_detail ON $1 = 'BUS'
LEFT JOIN LATERAL (
    SELECT edges[median_bucket] AS lower_s, edges[median_bucket + 1] AS upper_s
    FROM (VALUES (ARRAY[NULL, -300, -120, -60, -30, 0, 30, 60, 120, 300, NULL])) AS buckets(edges)
) median ON $1 = 'BUS'
ORDER BY net_delay_minutes DESC, from_id, to_id
