import { gql } from "urql";

export const LIVE_TRAINS = gql`
  query LiveTrains($trainType: String) {
    liveTrains(trainType: $trainType) {
      trainCode
      latitude
      longitude
      trainStatus
      direction
      fetchedAt
    }
  }
`;

export const NETWORK_SUMMARY = gql`
  query NetworkSummary {
    networkSummary {
      activeTrains
      totalStations
      avgDelayMinutes
      onTimePct
      lastUpdated
    }
  }
`;

export const STATIONS = gql`
  query Stations($stationType: String, $isDart: Boolean) {
    stations(stationType: $stationType, isDart: $isDart) {
      stationCode
      stationDesc
      stationType
      isDart
      latitude
      longitude
    }
  }
`;

export const STATION_BOARD = gql`
  query StationBoard($stationCode: String!, $limit: Int) {
    stationBoard(stationCode: $stationCode, limit: $limit) {
      trainCode
      origin
      destination
      trainType
      direction
      status
      scheduledArrival
      scheduledDeparture
      expectedArrival
      expectedDeparture
      lateMinutes
      dueIn
      lastLocation
    }
  }
`;

export const STATION_DELAY_STATS = gql`
  query StationDelayStats($hours: Int, $limit: Int) {
    stationDelayStats(hours: $hours, limit: $limit) {
      stationCode
      stationDesc
      avgLateMinutes
      maxLateMinutes
      onTimePct
      totalEvents
    }
  }
`;

export const HOURLY_DELAYS = gql`
  query HourlyDelays($stationCode: String, $hours: Int) {
    hourlyDelays(stationCode: $stationCode, hours: $hours) {
      hour
      stationCode
      avgLateMinutes
      maxLateMinutes
      eventCount
    }
  }
`;

export const ROUTE_RELIABILITY = gql`
  query RouteReliability($hours: Int, $minTrains: Int) {
    routeReliability(hours: $hours, minTrains: $minTrains) {
      origin
      destination
      avgLateMinutes
      onTimePct
      trainCount
    }
  }
`;

export const TRAIN_JOURNEY = gql`
  query TrainJourney($trainCode: String!, $trainDate: String) {
    trainJourney(trainCode: $trainCode, trainDate: $trainDate) {
      trainCode
      trainDate
      locationCode
      locationFullName
      locationOrder
      trainOrigin
      trainDestination
      scheduledArrival
      scheduledDeparture
      expectedArrival
      expectedDeparture
      actualArrival
      actualDeparture
      stopType
    }
  }
`;

export const FETCH_STATUS = gql`
  query FetchStatus {
    fetchStatus {
      endpoint
      lastStatus
      lastRecordCount
      lastDurationMs
      lastFetched
    }
  }
`;
