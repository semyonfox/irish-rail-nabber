WITH notices AS (
    SELECT 'RAIL' AS mode, alert_key, head AS title, body AS description, category,
           starts_at, ends_at, first_seen, last_seen, revisions,
           location_codes, NULL::bigint AS feed_version_id,
           '{}'::text[] AS route_ids, '{}'::text[] AS stop_ids, '{}'::text[] AS agency_ids,
           NULL::jsonb AS active_periods, INTERVAL '10 minutes' AS poll_grace,
           CASE WHEN impact_computed_at IS NOT NULL THEN corridor_codes END AS corridor_codes,
           CASE WHEN impact_computed_at IS NOT NULL THEN impact_events END AS impact_events,
           CASE WHEN impact_computed_at IS NOT NULL THEN impact_avg_late END AS impact_avg_late,
           CASE WHEN impact_computed_at IS NOT NULL THEN baseline_avg_late END AS baseline_avg_late,
           CASE WHEN impact_computed_at IS NOT NULL THEN pre_avg_late END AS pre_avg_late,
           CASE WHEN impact_computed_at IS NOT NULL THEN pre_baseline_avg_late END AS pre_baseline_avg_late,
           CASE WHEN impact_computed_at IS NOT NULL THEN impact_window_end END AS impact_window_end,
           impact_computed_at IS NOT NULL AND impact_window_end IS NULL AS never_ran
    FROM rail_service_alerts
    WHERE ($1::text IS NULL OR $1 = 'RAIL')
      AND ($2::text IS NULL OR category = $2)
      AND ($3::text IS NULL OR alert_key = $3)
      AND ($4::date IS NULL OR ends_at >= ($4::timestamp AT TIME ZONE 'Europe/Dublin'))
      AND ($5::date IS NULL OR starts_at < (($5 + 1)::timestamp AT TIME ZONE 'Europe/Dublin'))

    UNION ALL

    SELECT 'BUS', alert_key, header, description, category,
           starts_at, ends_at, first_seen, last_seen, revisions,
           '{}', feed_version_id, route_ids, stop_ids, agency_ids,
           active_periods, INTERVAL '30 minutes', NULL, NULL, NULL, NULL, NULL, NULL, NULL, false
    FROM bus_service_alerts
    WHERE ($1 IS NULL OR $1 = 'BUS')
      AND ($2 IS NULL OR category = $2)
      AND ($3 IS NULL OR alert_key = $3)
      AND ($4 IS NULL OR ends_at IS NULL OR ends_at >= ($4::timestamp AT TIME ZONE 'Europe/Dublin'))
      AND ($5 IS NULL OR COALESCE(starts_at, first_seen) < (($5 + 1)::timestamp AT TIME ZONE 'Europe/Dublin'))
), page AS (
    SELECT *
    FROM notices
    WHERE $4 IS NULL OR last_seen + poll_grace >= NOW()
       OR GREATEST(COALESCE(starts_at, first_seen), last_seen + poll_grace)
            >= ($4::timestamp AT TIME ZONE 'Europe/Dublin')
    ORDER BY COALESCE(starts_at, first_seen) DESC, mode, alert_key
    LIMIT $6 OFFSET $7
)
SELECT mode, alert_key, title, description, category,
       CASE
           WHEN ends_at IS NOT NULL AND last_seen + poll_grace < LEAST(NOW(), ends_at)
               THEN 'WITHDRAWN_EARLY'
           WHEN ends_at <= NOW() OR last_seen + poll_grace < NOW() THEN 'ENDED'
           WHEN starts_at > NOW() THEN 'SCHEDULED'
           WHEN jsonb_array_length(active_periods) > 0 AND NOT EXISTS (
               SELECT 1 FROM jsonb_array_elements(active_periods) AS periods(period)
               WHERE ((period->>0) IS NULL OR (period->>0)::timestamptz <= NOW())
                 AND ((period->>1) IS NULL OR (period->>1)::timestamptz > NOW())
           ) THEN 'BETWEEN_WINDOWS'
           ELSE 'ACTIVE'
       END AS status,
       to_json(starts_at) #>> '{}' AS starts_at,
       to_json(ends_at) #>> '{}' AS ends_at,
       to_json(first_seen) #>> '{}' AS first_seen,
       to_json(last_seen) #>> '{}' AS last_seen,
       to_json(impact_window_end) #>> '{}' AS impact_window_end,
       revisions, location_codes, corridor_codes, impact_events, impact_avg_late, never_ran,
       baseline_avg_late, pre_avg_late, pre_baseline_avg_late, agency_ids,
       ARRAY(
           SELECT COALESCE(NULLIF(route.route_short_name, ''), NULLIF(route.route_long_name, ''), ids.id)
           FROM unnest(page.route_ids) WITH ORDINALITY AS ids(id, position)
           LEFT JOIN bus_routes route ON (route.feed_version_id, route.route_id) = (page.feed_version_id, ids.id)
           ORDER BY ids.position
       ) AS routes,
       ARRAY(
           SELECT COALESCE(NULLIF(stop.stop_name, ''), ids.id)
           FROM unnest(page.stop_ids) WITH ORDINALITY AS ids(id, position)
           LEFT JOIN bus_stops stop ON (stop.feed_version_id, stop.stop_id) = (page.feed_version_id, ids.id)
           ORDER BY ids.position
       ) AS stops
FROM page
ORDER BY COALESCE(page.starts_at, page.first_seen) DESC, mode, alert_key
