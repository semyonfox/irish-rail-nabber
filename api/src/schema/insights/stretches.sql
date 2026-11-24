WITH hourly AS (
    SELECT NULL::bigint AS feed_version_id, from_code AS from_id, to_code AS to_id,
           trains AS trips, gain_sum_s, gain_pos_sum_s, gain_sq_sum, run_sum_s, sched_run_sum_s
    FROM rail_segment_delay_hourly
    WHERE $1::text = 'RAIL' AND service_date BETWEEN $2 AND $3
      AND hour_local >= $4 AND hour_local < $5

    UNION ALL

    SELECT feed_version_id, from_stop_id, to_stop_id, trips,
           gain_sum_s, gain_pos_sum_s, gain_sq_sum, run_sum_s, sched_run_sum_s
    FROM bus_segment_delay_hourly
    WHERE $1 = 'BUS' AND service_date BETWEEN $2 AND $3
      AND hour_local >= $4 AND hour_local < $5
), ranked AS (
    SELECT feed_version_id, from_id, to_id, SUM(trips) AS trips,
           SUM(gain_pos_sum_s)::double precision / 60 AS added_minutes,
           SUM(gain_sum_s)::double precision / SUM(trips) AS avg_gain_s,
           SUM(gain_sq_sum)::double precision / SUM(trips) AS mean_square_s,
           100 * ((SUM(run_sum_s) - SUM(sched_run_sum_s)) / NULLIF(SUM(sched_run_sum_s), 0))::double precision
               AS overrun_pct
    FROM hourly
    GROUP BY feed_version_id, from_id, to_id
    HAVING SUM(trips) >= $6 AND SUM(gain_pos_sum_s) > 0
    ORDER BY added_minutes DESC, feed_version_id, from_id, to_id
    LIMIT $7
)
SELECT ranked.feed_version_id, from_id, to_id,
       COALESCE(from_station.station_desc, from_stop.stop_name, from_id) AS from_name,
       COALESCE(to_station.station_desc, to_stop.stop_name, to_id) AS to_name,
       COALESCE(from_station.latitude::double precision, from_stop.stop_lat) AS from_lat,
       COALESCE(from_station.longitude::double precision, from_stop.stop_lon) AS from_lon,
       COALESCE(to_station.latitude::double precision, to_stop.stop_lat) AS to_lat,
       COALESCE(to_station.longitude::double precision, to_stop.stop_lon) AS to_lon,
       trips, added_minutes, avg_gain_s / 60 AS avg_gain_minutes,
       sqrt(GREATEST(mean_square_s - avg_gain_s * avg_gain_s, 0)) / 60 AS stddev_minutes,
       overrun_pct,
       ARRAY(
           SELECT DISTINCT COALESCE(NULLIF(route.route_short_name, ''), NULLIF(route.route_long_name, ''), ids.id)
           FROM bus_segment_delay_hourly bus
           CROSS JOIN LATERAL unnest(bus.route_ids) AS ids(id)
           LEFT JOIN bus_routes route ON (route.feed_version_id, route.route_id) = (bus.feed_version_id, ids.id)
           WHERE (bus.feed_version_id, bus.from_stop_id, bus.to_stop_id) = (ranked.feed_version_id, from_id, to_id)
             AND bus.service_date BETWEEN $2 AND $3 AND bus.hour_local >= $4 AND bus.hour_local < $5
           ORDER BY 1
       ) AS routes
FROM ranked
LEFT JOIN stations from_station ON ranked.feed_version_id IS NULL AND from_station.station_code = from_id
LEFT JOIN stations to_station ON ranked.feed_version_id IS NULL AND to_station.station_code = to_id
LEFT JOIN bus_stops from_stop ON (from_stop.feed_version_id, from_stop.stop_id) = (ranked.feed_version_id, from_id)
LEFT JOIN bus_stops to_stop ON (to_stop.feed_version_id, to_stop.stop_id) = (ranked.feed_version_id, to_id)
ORDER BY added_minutes DESC, ranked.feed_version_id, from_id, to_id
