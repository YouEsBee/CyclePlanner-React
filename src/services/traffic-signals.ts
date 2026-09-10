import type { LngLat } from "@/services/pcn-routing";
import * as turf from "@turf/turf";
import type { Feature, FeatureCollection, Point } from "geojson";

type SignalProperties = {
  OBJECTID_1?: number;
  BEARG_NUM?: number;
  TYP_NAM?: string;
  UNIQUE_ID?: number;
  INC_CRC?: string;
  FMEL_UPD_D?: string;
};

type CrossingProperties = {
  signalCount: number;
  signalTypes: string[];
};

export type RouteTrafficLights = {
  count: number;
  crossings: FeatureCollection<Point, CrossingProperties>;
};

const ROUTE_DISTANCE_METERS = 15;
const CROSSING_RADIUS_KM = 0.03;

const CYCLIST_SIGNAL_TYPES = new Set([
  "Pedestrian Signal",
  "Pedestrian Signal with Intergrated Count Down Timer",
]);

export function getRouteTrafficLights(
  routeCoordinates: LngLat[],
  trafficSignals: FeatureCollection<Point, SignalProperties>,
): RouteTrafficLights {
  if (routeCoordinates.length < 2) {
    return {
      count: 0,
      crossings: turf.featureCollection([]),
    };
  }

  const routeLine = turf.lineString(routeCoordinates);

  const nearbySignals = trafficSignals.features.filter((feature) => {
    if (
      feature.geometry?.type !== "Point" ||
      !CYCLIST_SIGNAL_TYPES.has(feature.properties?.TYP_NAM ?? "")
    ) {
      return false;
    }

    const distanceKm = turf.pointToLineDistance(feature, routeLine, {
      units: "kilometers",
    });

    return distanceKm * 1000 <= ROUTE_DISTANCE_METERS;
  }) as Feature<Point, SignalProperties>[];

  if (nearbySignals.length === 0) {
    return {
      count: 0,
      crossings: turf.featureCollection([]),
    };
  }

  const clustered = turf.clustersDbscan(
    turf.featureCollection(nearbySignals),
    CROSSING_RADIUS_KM,
    {
      units: "kilometers",
      minPoints: 1,
    },
  );

  const clusters = new Map<number, Feature<Point, SignalProperties>[]>();

  for (const signal of clustered.features) {
    const clusterId = signal.properties.cluster;

    if (typeof clusterId !== "number") {
      continue;
    }

    const signalsInCluster = clusters.get(clusterId) ?? [];
    signalsInCluster.push(signal as Feature<Point, SignalProperties>);
    clusters.set(clusterId, signalsInCluster);
  }

  const crossingMarkers = [...clusters.values()].map((signals) => {
    const center = turf.centroid(turf.featureCollection(signals));

    return turf.point(center.geometry.coordinates, {
      signalCount: signals.length,
      signalTypes: [
        ...new Set(
          signals
            .map((signal) => signal.properties.TYP_NAM)
            .filter((type): type is string => Boolean(type)),
        ),
      ],
    });
  });

  return {
    count: crossingMarkers.length,
    crossings: turf.featureCollection(crossingMarkers),
  };
}