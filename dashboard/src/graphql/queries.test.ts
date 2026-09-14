import { Kind, type DocumentNode } from "graphql";
import { describe, expect, test } from "vite-plus/test";

import { BUS_LIVE_OVERVIEW, BUS_SCHEDULED_ROUTE_SHAPES, LIVE_RAIL_OVERVIEW } from "./queries";

function rootFields(document: DocumentNode) {
  const operation = document.definitions.find(
    (definition) => definition.kind === Kind.OPERATION_DEFINITION,
  );
  if (!operation || operation.kind !== Kind.OPERATION_DEFINITION) return [];

  return operation.selectionSet.selections
    .filter((selection) => selection.kind === Kind.FIELD)
    .map((selection) => selection.name.value);
}

function childFields(document: DocumentNode, rootName: string) {
  const operation = document.definitions.find(
    (definition) => definition.kind === Kind.OPERATION_DEFINITION,
  );
  if (!operation || operation.kind !== Kind.OPERATION_DEFINITION) return [];

  const root = operation.selectionSet.selections.find(
    (selection) => selection.kind === Kind.FIELD && selection.name.value === rootName,
  );
  if (!root || root.kind !== Kind.FIELD) return [];

  return (
    root.selectionSet?.selections
      .filter((selection) => selection.kind === Kind.FIELD)
      .map((selection) => selection.name.value) ?? []
  );
}

function nestedChildFields(document: DocumentNode, rootName: string, childName: string) {
  const operation = document.definitions.find(
    (definition) => definition.kind === Kind.OPERATION_DEFINITION,
  );
  if (!operation || operation.kind !== Kind.OPERATION_DEFINITION) return [];

  const root = operation.selectionSet.selections.find(
    (selection) => selection.kind === Kind.FIELD && selection.name.value === rootName,
  );
  if (!root || root.kind !== Kind.FIELD) return [];
  const child = root.selectionSet?.selections.find(
    (selection) => selection.kind === Kind.FIELD && selection.name.value === childName,
  );
  if (!child || child.kind !== Kind.FIELD) return [];

  return (
    child.selectionSet?.selections
      .filter((selection) => selection.kind === Kind.FIELD)
      .map((selection) => selection.name.value) ?? []
  );
}

describe("live overview operations", () => {
  test("fetches rail map and board data in one operation", () => {
    expect(rootFields(LIVE_RAIL_OVERVIEW)).toEqual(["liveTrains", "countryBoard"]);
    expect(childFields(LIVE_RAIL_OVERVIEW, "liveTrains")).toContain("trainDate");
  });

  test("fetches bus board, vehicles, live shapes and route delays in one operation", () => {
    expect(rootFields(BUS_LIVE_OVERVIEW)).toEqual([
      "busRealtimeStatus",
      "busStopBoard",
      "busVehicles",
      "busLiveRouteShapes",
      "busRouteDelays",
    ]);

    expect(childFields(BUS_LIVE_OVERVIEW, "busRealtimeStatus")).toEqual([
      "lastSuccessAt",
      "vehiclesLastSuccessAt",
      "tripUpdatesLastSuccessAt",
      "isLive",
    ]);

    const operation = BUS_LIVE_OVERVIEW.definitions.find(
      (definition) => definition.kind === Kind.OPERATION_DEFINITION,
    );
    const board =
      operation?.kind === Kind.OPERATION_DEFINITION
        ? operation.selectionSet.selections.find(
            (selection) => selection.kind === Kind.FIELD && selection.name.value === "busStopBoard",
          )
        : undefined;

    expect(board?.kind).toBe(Kind.FIELD);
    if (board?.kind === Kind.FIELD) {
      expect(board.directives?.map((directive) => directive.name.value)).toContain("include");
    }

    expect(childFields(BUS_LIVE_OVERVIEW, "busVehicles")).toEqual([
      "entityId",
      "vehicleId",
      "vehicleLabel",
      "tripId",
      "shapeId",
      "routeId",
      "routeShortName",
      "routeLongName",
      "operatorName",
      "headsign",
      "latitude",
      "longitude",
      "bearing",
      "speedMetersPerSecond",
      "currentStopSequence",
      "stopId",
      "currentStatus",
      "occupancyStatus",
      "sourceTimestamp",
      "fetchedAt",
    ]);
    expect(childFields(BUS_LIVE_OVERVIEW, "busLiveRouteShapes")).toEqual([
      "routeId",
      "routeShortName",
      "shapeId",
      "routeColor",
      "points",
    ]);
    expect(nestedChildFields(BUS_LIVE_OVERVIEW, "busLiveRouteShapes", "points")).toEqual([
      "latitude",
      "longitude",
      "sequence",
    ]);
  });

  test("fetches a bounded scheduled route-map operation separately from live polling", () => {
    expect(rootFields(BUS_SCHEDULED_ROUTE_SHAPES)).toEqual(["busScheduledRouteShapes"]);
    expect(childFields(BUS_SCHEDULED_ROUTE_SHAPES, "busScheduledRouteShapes")).toEqual([
      "routeId",
      "routeShortName",
      "shapeId",
      "routeColor",
      "points",
    ]);
    expect(
      nestedChildFields(BUS_SCHEDULED_ROUTE_SHAPES, "busScheduledRouteShapes", "points"),
    ).toEqual(["latitude", "longitude", "sequence"]);
  });
});
