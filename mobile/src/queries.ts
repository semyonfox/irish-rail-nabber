export const STATIONS = `
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

export const STATION_BOARD = `
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

export const BUS_STOPS = `
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

export const LIVE_TRAINS = `
  query LiveTrains {
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
  }
`;

export const BUS_VEHICLES = `
  query BusVehicles($limit: Int) {
    busRealtimeStatus {
      vehiclesLastSuccessAt
    }
    busVehicles(limit: $limit) {
      entityId
      vehicleId
      routeId
      routeShortName
      headsign
      operatorName
      latitude
      longitude
    }
  }
`;

export const BUS_STOP_BOARD = `
  query BusStopBoard($stopId: String!, $limit: Int) {
    busStopBoard(stopId: $stopId, limit: $limit) {
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
  }
`;
