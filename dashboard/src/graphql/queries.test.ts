import { Kind, type DocumentNode } from "graphql";
import { describe, expect, test } from "vite-plus/test";

import { BUS_LIVE_OVERVIEW, LIVE_RAIL_OVERVIEW } from "./queries";

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

describe("live overview operations", () => {
  test("fetches rail map and board data in one operation", () => {
    expect(rootFields(LIVE_RAIL_OVERVIEW)).toEqual(["liveTrains", "countryBoard"]);
  });

  test("fetches bus board, vehicles and route delays in one operation", () => {
    expect(rootFields(BUS_LIVE_OVERVIEW)).toEqual([
      "busStopBoard",
      "busVehicles",
      "busRouteDelays",
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
  });
});
