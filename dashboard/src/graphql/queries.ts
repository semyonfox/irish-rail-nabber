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
    $routeId: String
    $stopId: String!
    $includeBoard: Boolean!
    $includeVehicles: Boolean!
    $includeShapes: Boolean!
    $includeDelays: Boolean!
    $boardLimit: Int
    $vehicleLimit: Int
    $shapeLimit: Int
    $hours: Int
    $routeLimit: Int
  ) {
    busRealtimeStatus {
      lastSuccessAt
      vehiclesLastSuccessAt
      tripUpdatesLastSuccessAt
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
    busVehicles(routeId: $routeId, limit: $vehicleLimit) @include(if: $includeVehicles) {
      entityId
      vehicleId
      vehicleLabel
      tripId
      shapeId
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
    busLiveRouteShapes(limit: $shapeLimit) @include(if: $includeShapes) {
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
    busRouteDelays(hours: $hours, limit: $routeLimit) @include(if: $includeDelays) {
      feedVersionId
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

export const BUS_ROUTES = gql`
  query BusRoutes($search: String, $routeId: String, $feedVersionId: Int, $limit: Int) {
    busRoutes(search: $search, routeId: $routeId, feedVersionId: $feedVersionId, limit: $limit) {
      feedVersionId
      routeId
      routeShortName
      routeLongName
      operatorName
      isActive
    }
  }
`;

export const BUS_DELAY_HISTORY = gql`
  query BusDelayHistory(
    $routeId: String
    $feedVersionId: Int
    $hours: Int
    $stopId: String
    $since: String
  ) {
    busDelayHistory(
      routeId: $routeId
      feedVersionId: $feedVersionId
      hours: $hours
      stopId: $stopId
      since: $since
    ) {
      bucket
      avgDelaySeconds
      p95DelaySeconds
      maxDelaySeconds
      onTimePct
      earlyCount
      lateCount
      sampleCount
      lastUpdated
    }
  }
`;

export const BUS_ROUTE_STOP_DELAYS = gql`
  query BusRouteStopDelays($routeId: String!, $feedVersionId: Int!) {
    busRouteStopDelays(routeId: $routeId, feedVersionId: $feedVersionId, limit: 200) {
      tripId
      tripInstanceKey
      stopId
      stopName
      stopSequence
      headsign
      delaySeconds
      expectedTime
      scheduleRelationship
      lastUpdated
    }
  }
`;

export const BUS_STATUS = gql`
  query BusStatus {
    busRealtimeStatus {
      lastSuccessAt
      vehiclesLastSuccessAt
      tripUpdatesLastSuccessAt
      isLive
    }
  }
`;

export const BUS_ROUTE_RANKINGS = gql`
  query BusRouteRankings($hours: Int, $limit: Int) {
    busRouteDelays(hours: $hours, limit: $limit) {
      feedVersionId
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

export const BUS_STOP_STATS = gql`
  query BusStopStats($hours: Int, $search: String, $feedVersionId: Int, $stopId: String) {
    busStopStats(
      hours: $hours
      search: $search
      feedVersionId: $feedVersionId
      stopId: $stopId
      limit: 200
    ) {
      feedVersionId
      stopId
      stopName
      avgDelaySeconds
      p95DelaySeconds
      maxDelaySeconds
      onTimePct
      sampleCount
    }
  }
`;
export const BUS_JOURNEYS = gql`
  query BusJourneys($feedVersionId: Int!, $routeId: String!, $hours: Int) {
    busJourneys(feedVersionId: $feedVersionId, routeId: $routeId, hours: $hours, limit: 200) {
      feedVersionId
      tripInstanceKey
      tripId
      routeId
      headsign
      firstObserved
      lastObserved
      stopCount
    }
  }
`;
export const BUS_JOURNEY = gql`
  query BusJourney($feedVersionId: Int!, $tripInstanceKey: String!, $hours: Int) {
    busJourneys(
      feedVersionId: $feedVersionId
      tripInstanceKey: $tripInstanceKey
      hours: $hours
      limit: 1
    ) {
      feedVersionId
      tripInstanceKey
      tripId
      routeId
      headsign
      firstObserved
      lastObserved
      stopCount
    }
    busJourneyStops(
      feedVersionId: $feedVersionId
      tripInstanceKey: $tripInstanceKey
      hours: $hours
    ) {
      tripId
      tripInstanceKey
      stopId
      stopName
      stopSequence
      headsign
      delaySeconds
      expectedTime
      scheduleRelationship
      lastUpdated
    }
  }
`;

export const BUS_PUBLISHED_DATASET = gql`
  query BusPublishedDataset {
    busPublishedDataset {
      importId
      sourceUrl
      importedAt
      sourceUpdatedAt
      recordCount
      firstYear
      lastYear
      routeCount
      operators
      years
    }
  }
`;
export const BUS_PUBLISHED_PERFORMANCE = gql`
  query BusPublishedPerformance(
    $importId: String!
    $search: String
    $operatorName: String
    $routeShortName: String
    $year: Int
    $limit: Int
    $offset: Int
  ) {
    busPublishedPerformance(
      importId: $importId
      search: $search
      operatorName: $operatorName
      routeShortName: $routeShortName
      year: $year
      limit: $limit
      offset: $offset
    ) {
      totalCount
      rows {
        operatorName
        routeShortName
        reportYear
        reportPeriod
        onTimePct
        earlyPct
        latePct
        actualDepartures
        excessWaitMinutes
        plannedKm
        actualKm
        lostKm
        contractualLostKm
      }
    }
  }
`;

export const BUS_ROUTE_MAP = gql`
  query BusRouteMap($routeId: String!, $feedVersionId: Int) {
    busRouteMap(routeId: $routeId, feedVersionId: $feedVersionId) {
      feedVersionId
      routeId
      shapes {
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
      stops {
        stopId
        stopCode
        stopName
        latitude
        longitude
      }
    }
  }
`;
