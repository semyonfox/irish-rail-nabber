import { gql } from "urql";

export const LIVE_RAIL_OVERVIEW = gql`
  query LiveRailOverview($boardLimit: Int, $boardMinutes: Int) {
    liveTrains {
      trainCode
      trainDate
      latitude
      longitude
      trainStatus
      direction
      trainType
      fetchedAt
    }
    countryBoard(limit: $boardLimit, minutes: $boardMinutes) {
      lateMinutes
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

export const COUNTRY_BOARD = gql`
  query CountryBoard($limit: Int, $minutes: Int) {
    countryBoard(limit: $limit, minutes: $minutes) {
      trainCode
      stationCode
      stationDesc
      trainDate
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
      lastLocation
      dueIn
      fetchedAt
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

export const DELAY_HISTORY = gql`
  query DelayHistory($stationCode: String, $hours: Int, $bucket: String, $since: String) {
    delayHistory(stationCode: $stationCode, hours: $hours, bucket: $bucket, since: $since) {
      bucket
      avgLateMinutes
      p95LateMinutes
      maxLateMinutes
      onTimePct
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

export const ROUTE_SEGMENTS = gql`
  query RouteSegments($hours: Int, $limit: Int) {
    routeSegments(hours: $hours, limit: $limit) {
      fromStationCode
      fromStationName
      fromLatitude
      fromLongitude
      toStationCode
      toStationName
      toLatitude
      toLongitude
      trainCount
      lastSeen
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

export const BUS_STOPS = gql`
  query BusStops($search: String, $limit: Int) {
    busStops(search: $search, limit: $limit) {
      stopId
      stopCode
      stopName
      latitude
      longitude
    }
  }
`;

export const BUS_SCHEDULED_ROUTE_SHAPES = gql`
  query BusScheduledRouteShapes($stopId: String, $limit: Int) {
    busScheduledRouteShapes(stopId: $stopId, limit: $limit) {
      routeId
      routeShortName
      shapeId
      routeColor
      points {
        latitude
        longitude
        sequence
      }
    }
  }
`;

export const BUS_LIVE_OVERVIEW = gql`
  query BusLiveOverview(
    $stopId: String!
    $includeBoard: Boolean!
    $boardLimit: Int
    $vehicleLimit: Int
    $shapeLimit: Int
    $hours: Int
    $routeLimit: Int
  ) {
    busRealtimeStatus {
      lastSuccessAt
      isLive
    }
    busStopBoard(stopId: $stopId, limit: $boardLimit) @include(if: $includeBoard) {
      entityId
      tripId
      routeId
      routeShortName
      routeLongName
      operatorName
      headsign
      serviceDate
      scheduledTime
      expectedTime
      delaySeconds
      scheduleRelationship
      fetchedAt
    }
    busVehicles(limit: $vehicleLimit) {
      entityId
      vehicleId
      vehicleLabel
      tripId
      routeId
      routeShortName
      routeLongName
      operatorName
      headsign
      latitude
      longitude
      bearing
      speedMetersPerSecond
      currentStopSequence
      stopId
      currentStatus
      occupancyStatus
      sourceTimestamp
      fetchedAt
    }
    busLiveRouteShapes(limit: $shapeLimit) {
      routeId
      routeShortName
      shapeId
      routeColor
      points {
        latitude
        longitude
        sequence
      }
    }
    busRouteDelays(hours: $hours, limit: $routeLimit) {
      routeId
      routeShortName
      routeLongName
      operatorName
      avgDelaySeconds
      onTimePct
      sampleCount
      lastUpdated
    }
  }
`;
