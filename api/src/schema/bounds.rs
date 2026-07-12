//! Bounds for numeric GraphQL resolver inputs.
//!
//! Keep these limits next to the schema so direct GraphQL callers receive the
//! same protection as callers using the chat wrapper.

/// Clamp a public numeric input to its inclusive, documented range before it
/// is bound into a SQL query.
pub(crate) fn clamp_i32(value: i32, min: i32, max: i32) -> i32 {
    debug_assert!(min <= max);
    value.clamp(min, max)
}

/// `stationBoard.limit`: 1 through 200 rows.
pub(crate) const STATION_BOARD_LIMIT: (i32, i32) = (1, 200);
/// `trainHistory.hours`: one hour through one week.
pub(crate) const TRAIN_HISTORY_HOURS: (i32, i32) = (1, 168);
/// `hourlyDelays.hours` and `stationDelayStats.hours`: one hour through one week.
pub(crate) const ANALYTICS_HOURS: (i32, i32) = (1, 168);
/// `stationDelayStats.limit`: 1 through 100 stations.
pub(crate) const STATION_DELAY_STATS_LIMIT: (i32, i32) = (1, 100);
/// `routeReliability.hours`: one hour through 30 days.
pub(crate) const ROUTE_RELIABILITY_HOURS: (i32, i32) = (1, 720);
/// `routeReliability.minTrains`: require between 1 and 20 trains.
pub(crate) const ROUTE_RELIABILITY_MIN_TRAINS: (i32, i32) = (1, 20);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_station_board_limit_clamps_invalid_inputs() {
        let (min, max) = STATION_BOARD_LIMIT;
        assert_eq!(clamp_i32(-1, min, max), min);
        assert_eq!(clamp_i32(0, min, max), min);
        assert_eq!(clamp_i32(i32::MAX, min, max), max);
    }

    #[test]
    fn paid_analytics_inputs_clamp_invalid_inputs() {
        let (hours_min, hours_max) = ANALYTICS_HOURS;
        let (limit_min, limit_max) = STATION_DELAY_STATS_LIMIT;
        let (route_hours_min, route_hours_max) = ROUTE_RELIABILITY_HOURS;
        let (trains_min, trains_max) = ROUTE_RELIABILITY_MIN_TRAINS;

        assert_eq!(clamp_i32(-1, hours_min, hours_max), hours_min);
        assert_eq!(clamp_i32(0, limit_min, limit_max), limit_min);
        assert_eq!(
            clamp_i32(i32::MAX, route_hours_min, route_hours_max),
            route_hours_max
        );
        assert_eq!(clamp_i32(i32::MAX, trains_min, trains_max), trains_max);
    }

    #[test]
    fn train_history_hours_clamp_invalid_inputs() {
        let (min, max) = TRAIN_HISTORY_HOURS;
        assert_eq!(clamp_i32(0, min, max), min);
        assert_eq!(clamp_i32(i32::MAX, min, max), max);
    }
}
