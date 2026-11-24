WITH ranked AS (
    SELECT station_code, SUM(trains) AS trips,
           SUM(gain_sum_s)::double precision / 60 AS net_delay_minutes,
           SUM(gain_pos_sum_s)::double precision / 60 AS added_minutes,
           SUM(gain_sum_s)::double precision / SUM(trains) / 60 AS avg_gain_minutes,
           100 * ((SUM(dwell_sum_s) - SUM(sched_dwell_sum_s)) / NULLIF(SUM(sched_dwell_sum_s), 0))::double precision
               AS overrun_pct
    FROM rail_dwell_delay_hourly
    WHERE service_date BETWEEN $1 AND $2 AND hour_local >= $3 AND hour_local < $4
    GROUP BY station_code
    HAVING SUM(trains) >= $5 AND SUM(gain_sum_s) > 0
    ORDER BY net_delay_minutes DESC, station_code
    LIMIT $6
)
SELECT ranked.station_code, COALESCE(stations.station_desc, ranked.station_code) AS station_name,
       trips, net_delay_minutes, added_minutes, avg_gain_minutes, overrun_pct
FROM ranked
LEFT JOIN stations USING (station_code)
ORDER BY net_delay_minutes DESC, ranked.station_code
