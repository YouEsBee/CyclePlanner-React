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

const EARTH_RADIUS_METERS = 6371008.8;
const DEG_TO_RAD = Math.PI / 180;
/**
 * Grid cell edge in metres. Must be >= ROUTE_DISTANCE_METERS so that a
 * signal's own cell plus its eight neighbours always contains every segment
 * within tolerance.
 */
const GRID_CELL_METERS = 100;

/**
 * Finds the signals within ROUTE_DISTANCE_METERS of the route.
 *
 * The obvious `turf.pointToLineDistance(signal, routeLine)` per signal is
 * signals × segments geodesic evaluations — 12k cyclist signals against a
 * 1,500-point route was measured at ~85 s on desktop V8, and several times
 * that in dev-mode Hermes on an emulator. Instead the route's segments are
 * bucketed into a metre-based grid and each signal is tested only against
 * the segments in its neighbourhood, which is ~15 ms for the same input with
 * identical results.
 *
 * Distances use an equirectangular projection centred on the route. At
 * Singapore's latitude and a 15 m tolerance that is accurate to well under a
 * metre, and it keeps the inner loop to plain arithmetic.
 */
function signalsNearRoute(
  routeCoordinates: LngLat[],
  trafficSignals: FeatureCollection<Point, SignalProperties>,
  maxMeters: number,
): Feature<Point, SignalProperties>[] {
  const cosLat = Math.cos(routeCoordinates[0][1] * DEG_TO_RAD);
  const toX = (lng: number) => lng * DEG_TO_RAD * EARTH_RADIUS_METERS * cosLat;
  const toY = (lat: number) => lat * DEG_TO_RAD * EARTH_RADIUS_METERS;

  const xs = routeCoordinates.map((point) => toX(point[0]));
  const ys = routeCoordinates.map((point) => toY(point[1]));

  // Each segment is registered in every cell its bounding box touches.
  const cells = new Map<string, number[]>();
  for (let i = 0; i < routeCoordinates.length - 1; i++) {
    const x0 = Math.min(xs[i], xs[i + 1]);
    const x1 = Math.max(xs[i], xs[i + 1]);
    const y0 = Math.min(ys[i], ys[i + 1]);
    const y1 = Math.max(ys[i], ys[i + 1]);
    for (let cx = Math.floor(x0 / GRID_CELL_METERS); cx <= Math.floor(x1 / GRID_CELL_METERS); cx++) {
      for (let cy = Math.floor(y0 / GRID_CELL_METERS); cy <= Math.floor(y1 / GRID_CELL_METERS); cy++) {
        const key = `${cx},${cy}`;
        const bucket = cells.get(key);
        if (bucket) bucket.push(i);
        else cells.set(key, [i]);
      }
    }
  }

  const squaredDistanceToSegment = (px: number, py: number, i: number): number => {
    const ax = xs[i];
    const ay = ys[i];
    const dx = xs[i + 1] - ax;
    const dy = ys[i + 1] - ay;
    const lengthSquared = dx * dx + dy * dy;
    let t = lengthSquared === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lengthSquared;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = ax + t * dx - px;
    const qy = ay + t * dy - py;
    return qx * qx + qy * qy;
  };

  const maxSquared = maxMeters * maxMeters;

  return trafficSignals.features.filter((feature) => {
    if (
      feature.geometry?.type !== "Point" ||
      !CYCLIST_SIGNAL_TYPES.has(feature.properties?.TYP_NAM ?? "")
    ) {
      return false;
    }

    const [lng, lat] = feature.geometry.coordinates;
    const px = toX(lng);
    const py = toY(lat);
    const cx = Math.floor(px / GRID_CELL_METERS);
    const cy = Math.floor(py / GRID_CELL_METERS);

    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const segments = cells.get(`${cx + ox},${cy + oy}`);
        if (!segments) continue;
        for (const i of segments) {
          if (squaredDistanceToSegment(px, py, i) <= maxSquared) return true;
        }
      }
    }
    return false;
  }) as Feature<Point, SignalProperties>[];
}

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

  const nearbySignals = signalsNearRoute(
    routeCoordinates,
    trafficSignals,
    ROUTE_DISTANCE_METERS,
  );

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