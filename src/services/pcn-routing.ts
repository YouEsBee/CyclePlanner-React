/**
 * Park Connector Network (PCN) routing.
 *
 * The data.gov.sg "Park Connector Loop" dataset is a bag of disconnected
 * LineString / MultiLineString features. To plan a ride on it we:
 *
 *   1. weld every vertex that shares a ~1 m grid cell into a single graph node,
 *   2. stitch dangling ends that sit within a few metres of another path,
 *   3. label connected components so we can snap both ends onto the same one,
 *   4. run A* (haversine heuristic, admissible because edge weights are
 *      great-circle distances) between the snapped nodes.
 *
 * Everything here is pure TypeScript with no dependencies, so it can be unit
 * tested outside React Native.
 */

export type LngLat = [number, number];

export interface PcnEdge {
  /** Index of the node on the other end of this edge. */
  to: number;
  /** Great-circle length of the edge, in metres. */
  weight: number;
  /** Index into {@link PcnGraph.loops}; -1 for a synthetic stitch edge. */
  loop: number;
}

export interface PcnGraph {
  nodes: LngLat[];
  adjacency: PcnEdge[][];
  /** PCN loop names, e.g. "Eastern Coastal Loop". */
  loops: string[];
  /** Connected component id per node. */
  components: Int32Array;
  componentSizes: number[];
  /** Spatial hash used for nearest-node lookups. */
  cells: Map<string, number[]>;
  cellSize: number;
  stats: {
    nodeCount: number;
    edgeCount: number;
    stitchedCount: number;
    bridgedCount: number;
    componentCount: number;
    networkLengthMeters: number;
  };
}

export interface BuildGraphOptions {
  /** Dangling ends closer than this to another node get joined. Default 25 m. */
  stitchToleranceMeters?: number;
  /**
   * Two otherwise separate stretches passing within this distance of each other
   * get one bridge edge at their closest point. Default 60 m — enough to close
   * the crossings the dataset omits, small enough not to invent a link across a
   * canal or an expressway. Set to 0 to disable.
   */
  bridgeToleranceMeters?: number;
  /** Spatial hash cell size in degrees. Default 0.0025 (~275 m). */
  cellSize?: number;
}

export interface NearestNode {
  index: number;
  coordinate: LngLat;
  distanceMeters: number;
}

export interface RouteAccessLeg {
  from: LngLat;
  to: LngLat;
  distanceMeters: number;
}

export interface PlannedRoute {
  /** The on-network polyline, start-node first. */
  coordinates: LngLat[];
  /** Distance ridden on the park connector network. */
  distanceMeters: number;
  /** Straight-line distance of the two off-network access legs. */
  accessDistanceMeters: number;
  totalDistanceMeters: number;
  ridingSeconds: number;
  accessSeconds: number;
  durationSeconds: number;
  /** PCN loop names in the order they are first ridden. */
  loops: string[];
  start: LngLat;
  destination: LngLat;
  startAccess: RouteAccessLeg;
  endAccess: RouteAccessLeg;
}

export type PlanRouteErrorCode =
  | 'EMPTY_NETWORK'
  | 'START_TOO_FAR'
  | 'DESTINATION_TOO_FAR'
  | 'TOO_CLOSE'
  | 'NO_PATH';

export type PlanRouteResult =
  | { ok: true; route: PlannedRoute }
  | { ok: false; code: PlanRouteErrorCode; message: string };

export interface PlanRouteOptions {
  graph: PcnGraph;
  start: LngLat;
  destination: LngLat;
  /** How far a point may sit from the network before we give up. Default 3000 m. */
  maxSnapMeters?: number;
  /** Riding speed used for the ETA. Default 15 km/h. */
  cyclingSpeedKmh?: number;
  /** Speed used for the walk-to-the-path legs. Default 4.5 km/h. */
  accessSpeedKmh?: number;
}

const EARTH_RADIUS_M = 6371008.8;
const DEG_TO_RAD = Math.PI / 180;
const METRES_PER_DEGREE = 111320;
/** 1e5 => vertices within ~1.1 m of each other become the same node. */
const NODE_PRECISION = 1e5;
const DEFAULT_CELL_SIZE = 0.0025;
const DEFAULT_STITCH_TOLERANCE_M = 25;
const DEFAULT_BRIDGE_TOLERANCE_M = 60;

export function haversineMeters(a: LngLat, b: LngLat): number {
  const lat1 = a[1] * DEG_TO_RAD;
  const lat2 = b[1] * DEG_TO_RAD;
  const dLat = lat2 - lat1;
  const dLng = (b[0] - a[0]) * DEG_TO_RAD;
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function cellKey(cx: number, cy: number): string {
  return cx + ':' + cy;
}

function cellIndexOf(value: number, cellSize: number): number {
  return Math.floor(value / cellSize);
}

/** Binary min-heap with lazy deletion (a node may be pushed more than once). */
class MinHeap {
  private items: number[] = [];
  private keys: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: number, key: number): void {
    this.items.push(item);
    this.keys.push(key);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= this.keys[i]) break;
      this.swap(parent, i);
      i = parent;
    }
  }

  pop(): number | undefined {
    if (this.items.length === 0) return undefined;
    const top = this.items[0];
    const lastItem = this.items.pop() as number;
    const lastKey = this.keys.pop() as number;
    if (this.items.length > 0) {
      this.items[0] = lastItem;
      this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < this.keys.length && this.keys[left] < this.keys[smallest]) smallest = left;
        if (right < this.keys.length && this.keys[right] < this.keys[smallest]) smallest = right;
        if (smallest === i) break;
        this.swap(smallest, i);
        i = smallest;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const item = this.items[a];
    this.items[a] = this.items[b];
    this.items[b] = item;
    const key = this.keys[a];
    this.keys[a] = this.keys[b];
    this.keys[b] = key;
  }
}

type LooseGeometry = { type?: string; coordinates?: unknown } | null | undefined;
type LooseFeature = { geometry?: LooseGeometry; properties?: Record<string, unknown> | null };
type LooseFeatureCollection = { features?: LooseFeature[] } | null | undefined;

function linesOf(geometry: LooseGeometry): number[][][] {
  if (!geometry || !Array.isArray(geometry.coordinates)) return [];
  if (geometry.type === 'LineString') return [geometry.coordinates as number[][]];
  if (geometry.type === 'MultiLineString') return geometry.coordinates as number[][][];
  return [];
}

/**
 * Turns the raw PCN FeatureCollection into a routable graph.
 * ~33k vertices for the Singapore dataset; takes well under a second.
 */
export function buildPcnGraph(
  geojson: LooseFeatureCollection,
  options: BuildGraphOptions = {},
): PcnGraph {
  const cellSize = options.cellSize ?? DEFAULT_CELL_SIZE;
  const stitchToleranceMeters = options.stitchToleranceMeters ?? DEFAULT_STITCH_TOLERANCE_M;
  const bridgeToleranceMeters = options.bridgeToleranceMeters ?? DEFAULT_BRIDGE_TOLERANCE_M;

  const nodes: LngLat[] = [];
  const adjacency: PcnEdge[][] = [];
  const nodeIndex = new Map<string, number>();
  const cells = new Map<string, number[]>();
  const loops: string[] = [];
  const loopIndex = new Map<string, number>();
  let networkLengthMeters = 0;

  const nodeIdFor = (coordinate: LngLat): number => {
    const key =
      Math.round(coordinate[0] * NODE_PRECISION) + '/' + Math.round(coordinate[1] * NODE_PRECISION);
    const existing = nodeIndex.get(key);
    if (existing !== undefined) return existing;

    const id = nodes.length;
    nodes.push(coordinate);
    adjacency.push([]);
    nodeIndex.set(key, id);

    const ck = cellKey(cellIndexOf(coordinate[0], cellSize), cellIndexOf(coordinate[1], cellSize));
    const bucket = cells.get(ck);
    if (bucket) bucket.push(id);
    else cells.set(ck, [id]);
    return id;
  };

  const connect = (a: number, b: number, weight: number, loop: number): boolean => {
    if (a === b) return false;
    for (const edge of adjacency[a]) {
      if (edge.to === b) return false;
    }
    adjacency[a].push({ to: b, weight, loop });
    adjacency[b].push({ to: a, weight, loop });
    return true;
  };

  for (const feature of geojson?.features ?? []) {
    const properties = feature?.properties ?? {};
    const loopName =
      (typeof properties.PCN_LOOP === 'string' && properties.PCN_LOOP) ||
      (typeof properties.PARK === 'string' && properties.PARK) ||
      'Park Connector';

    let loop = loopIndex.get(loopName);
    if (loop === undefined) {
      loop = loops.length;
      loops.push(loopName);
      loopIndex.set(loopName, loop);
    }

    for (const line of linesOf(feature?.geometry)) {
      let previous = -1;
      for (const raw of line) {
        if (!Array.isArray(raw) || raw.length < 2) continue;
        const lng = Number(raw[0]);
        const lat = Number(raw[1]);
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;

        const current = nodeIdFor([lng, lat]);
        if (previous >= 0 && previous !== current) {
          const weight = haversineMeters(nodes[previous], nodes[current]);
          if (connect(previous, current, weight, loop)) networkLengthMeters += weight;
        }
        previous = current;
      }
    }
  }

  // Stitch dangling ends onto whatever they nearly touch. Without this the
  // dataset breaks into thousands of unusable fragments.
  let stitchedCount = 0;
  if (stitchToleranceMeters > 0) {
    const danglingEnds: number[] = [];
    for (let i = 0; i < adjacency.length; i++) {
      if (adjacency[i].length === 1) danglingEnds.push(i);
    }

    for (const from of danglingEnds) {
      const point = nodes[from];
      let best = -1;
      let bestDistance = Infinity;

      for (const candidate of candidatesWithin(cells, cellSize, point, stitchToleranceMeters)) {
        if (candidate === from) continue;

        let alreadyLinked = false;
        for (const edge of adjacency[from]) {
          if (edge.to === candidate) {
            alreadyLinked = true;
            break;
          }
        }
        if (alreadyLinked) continue;

        const distance = haversineMeters(point, nodes[candidate]);
        if (distance <= stitchToleranceMeters && distance < bestDistance) {
          bestDistance = distance;
          best = candidate;
        }
      }

      if (best >= 0 && connect(from, best, bestDistance, -1)) {
        stitchedCount++;
        networkLengthMeters += bestDistance;
      }
    }
  }

  // Stitching only fixes gaps that end in a loose end. Where two separate
  // stretches merely run past each other — a crossing the dataset leaves out —
  // add the single shortest bridge between them (Kruskal over the gap edges, so
  // each pair of components is joined once, at its closest point).
  let bridgedCount = 0;
  if (bridgeToleranceMeters > 0) {
    const labels = labelComponents(adjacency).components;
    const gaps: { a: number; b: number; distance: number }[] = [];

    for (let a = 0; a < nodes.length; a++) {
      const point = nodes[a];
      for (const b of candidatesWithin(cells, cellSize, point, bridgeToleranceMeters)) {
        if (b <= a || labels[a] === labels[b]) continue;
        const distance = haversineMeters(point, nodes[b]);
        if (distance <= bridgeToleranceMeters) gaps.push({ a, b, distance });
      }
    }
    gaps.sort((x, y) => x.distance - y.distance);

    const parent = new Int32Array(labels.length ? Math.max(...labels) + 1 : 0);
    for (let i = 0; i < parent.length; i++) parent[i] = i;
    const find = (x: number): number => {
      let root = x;
      while (parent[root] !== root) root = parent[root];
      while (parent[x] !== root) {
        const next = parent[x];
        parent[x] = root;
        x = next;
      }
      return root;
    };

    for (const gap of gaps) {
      const rootA = find(labels[gap.a]);
      const rootB = find(labels[gap.b]);
      if (rootA === rootB) continue;
      if (!connect(gap.a, gap.b, gap.distance, -1)) continue;
      parent[rootB] = rootA;
      bridgedCount++;
      networkLengthMeters += gap.distance;
    }
  }

  const { components, componentSizes } = labelComponents(adjacency);

  let edgeCount = 0;
  for (const edges of adjacency) edgeCount += edges.length;

  return {
    nodes,
    adjacency,
    loops,
    components,
    componentSizes,
    cells,
    cellSize,
    stats: {
      nodeCount: nodes.length,
      edgeCount: edgeCount / 2,
      stitchedCount,
      bridgedCount,
      componentCount: componentSizes.length,
      networkLengthMeters,
    },
  };
}

function labelComponents(adjacency: PcnEdge[][]): {
  components: Int32Array;
  componentSizes: number[];
} {
  const components = new Int32Array(adjacency.length).fill(-1);
  const componentSizes: number[] = [];
  const queue: number[] = [];

  for (let start = 0; start < adjacency.length; start++) {
    if (components[start] !== -1) continue;

    const id = componentSizes.length;
    let size = 0;
    components[start] = id;
    queue.length = 0;
    queue.push(start);

    while (queue.length > 0) {
      const node = queue.pop() as number;
      size++;
      for (const edge of adjacency[node]) {
        if (components[edge.to] === -1) {
          components[edge.to] = id;
          queue.push(edge.to);
        }
      }
    }
    componentSizes.push(size);
  }

  return { components, componentSizes };
}

function candidatesWithin(
  cells: Map<string, number[]>,
  cellSize: number,
  point: LngLat,
  radiusMeters: number,
): number[] {
  const latSpan = radiusMeters / METRES_PER_DEGREE;
  const lngSpan = latSpan / Math.max(0.01, Math.cos(point[1] * DEG_TO_RAD));

  const minCx = cellIndexOf(point[0] - lngSpan, cellSize);
  const maxCx = cellIndexOf(point[0] + lngSpan, cellSize);
  const minCy = cellIndexOf(point[1] - latSpan, cellSize);
  const maxCy = cellIndexOf(point[1] + latSpan, cellSize);

  const found: number[] = [];
  for (let cx = minCx; cx <= maxCx; cx++) {
    for (let cy = minCy; cy <= maxCy; cy++) {
      const bucket = cells.get(cellKey(cx, cy));
      if (bucket) found.push(...bucket);
    }
  }
  return found;
}

/**
 * Nearest graph node to an arbitrary point, searched ring by ring so we stop
 * as soon as the result is provably the closest.
 *
 * @param component when given, only nodes in that connected component match.
 */
export function findNearestNode(
  graph: PcnGraph,
  point: LngLat,
  maxRadiusMeters = 3000,
  component?: number,
): NearestNode | null {
  if (graph.nodes.length === 0) return null;

  const cellMeters = graph.cellSize * METRES_PER_DEGREE;
  const maxRings = Math.max(1, Math.ceil(maxRadiusMeters / cellMeters) + 1);
  const cx = cellIndexOf(point[0], graph.cellSize);
  const cy = cellIndexOf(point[1], graph.cellSize);

  let bestIndex = -1;
  let bestDistance = Infinity;

  for (let ring = 0; ring <= maxRings; ring++) {
    for (let x = cx - ring; x <= cx + ring; x++) {
      for (let y = cy - ring; y <= cy + ring; y++) {
        // Only walk the shell of the ring; inner cells were scanned already.
        if (ring > 0 && Math.abs(x - cx) !== ring && Math.abs(y - cy) !== ring) continue;

        const bucket = graph.cells.get(cellKey(x, y));
        if (!bucket) continue;

        for (const id of bucket) {
          if (component !== undefined && graph.components[id] !== component) continue;
          const distance = haversineMeters(point, graph.nodes[id]);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = id;
          }
        }
      }
    }
    // A hit inside the already-scanned radius cannot be beaten further out.
    if (bestIndex >= 0 && bestDistance <= ring * cellMeters) break;
  }

  if (bestIndex < 0 || bestDistance > maxRadiusMeters) return null;
  return {
    index: bestIndex,
    coordinate: graph.nodes[bestIndex],
    distanceMeters: bestDistance,
  };
}

/** A* over the network. Returns node indices from start to goal. */
export function findShortestPath(
  graph: PcnGraph,
  startIndex: number,
  goalIndex: number,
): { path: number[]; distanceMeters: number } | null {
  const count = graph.nodes.length;
  if (startIndex < 0 || goalIndex < 0 || startIndex >= count || goalIndex >= count) return null;
  if (startIndex === goalIndex) return { path: [startIndex], distanceMeters: 0 };
  if (graph.components[startIndex] !== graph.components[goalIndex]) return null;

  const goal = graph.nodes[goalIndex];
  const gScore = new Float64Array(count).fill(Infinity);
  const cameFrom = new Int32Array(count).fill(-1);
  const closed = new Uint8Array(count);
  const open = new MinHeap();

  gScore[startIndex] = 0;
  open.push(startIndex, haversineMeters(graph.nodes[startIndex], goal));

  while (open.size > 0) {
    const current = open.pop() as number;
    if (closed[current]) continue;
    closed[current] = 1;

    if (current === goalIndex) {
      const path: number[] = [];
      for (let node = goalIndex; node !== -1; node = cameFrom[node]) path.push(node);
      path.reverse();
      return { path, distanceMeters: gScore[goalIndex] };
    }

    const currentScore = gScore[current];
    for (const edge of graph.adjacency[current]) {
      if (closed[edge.to]) continue;
      const tentative = currentScore + edge.weight;
      if (tentative < gScore[edge.to]) {
        gScore[edge.to] = tentative;
        cameFrom[edge.to] = current;
        open.push(edge.to, tentative + haversineMeters(graph.nodes[edge.to], goal));
      }
    }
  }

  return null;
}

function edgeBetween(graph: PcnGraph, a: number, b: number): PcnEdge | null {
  for (const edge of graph.adjacency[a]) {
    if (edge.to === b) return edge;
  }
  return null;
}

/**
 * Snaps both ends onto the park connector network and plans the ride between
 * them. Never throws: failures come back as `{ ok: false, code, message }` so
 * the UI can show them directly.
 */
export function planPcnRoute(options: PlanRouteOptions): PlanRouteResult {
  const {
    graph,
    start,
    destination,
    maxSnapMeters = 3000,
    cyclingSpeedKmh = 15,
    accessSpeedKmh = 4.5,
  } = options;

  if (!graph || graph.nodes.length === 0) {
    return {
      ok: false,
      code: 'EMPTY_NETWORK',
      message: 'The park connector network has not loaded yet. Try again in a moment.',
    };
  }

  const startNode = findNearestNode(graph, start, maxSnapMeters);
  if (!startNode) {
    return {
      ok: false,
      code: 'START_TOO_FAR',
      message: `No park connector within ${formatDistance(maxSnapMeters)} of the starting point.`,
    };
  }

  const destinationNode = findNearestNode(graph, destination, maxSnapMeters);
  if (!destinationNode) {
    return {
      ok: false,
      code: 'DESTINATION_TOO_FAR',
      message: `No park connector within ${formatDistance(maxSnapMeters)} of the destination.`,
    };
  }

  // The loop dataset is not one connected network. If the two nearest nodes sit
  // on different components, re-snap onto a shared one and keep the cheaper of
  // the two re-snaps.
  let from = startNode;
  let to = destinationNode;
  if (graph.components[from.index] !== graph.components[to.index]) {
    const destinationOnStartComponent = findNearestNode(
      graph,
      destination,
      maxSnapMeters,
      graph.components[from.index],
    );
    const startOnDestinationComponent = findNearestNode(
      graph,
      start,
      maxSnapMeters,
      graph.components[to.index],
    );

    const optionA = destinationOnStartComponent
      ? startNode.distanceMeters + destinationOnStartComponent.distanceMeters
      : Infinity;
    const optionB = startOnDestinationComponent
      ? startOnDestinationComponent.distanceMeters + destinationNode.distanceMeters
      : Infinity;

    if (optionA === Infinity && optionB === Infinity) {
      return {
        ok: false,
        code: 'NO_PATH',
        message:
          'These two points sit on park connector stretches that are not linked to each other.',
      };
    }
    if (optionA <= optionB && destinationOnStartComponent) {
      to = destinationOnStartComponent;
    } else if (startOnDestinationComponent) {
      from = startOnDestinationComponent;
    }
  }

  const result = findShortestPath(graph, from.index, to.index);
  if (!result || result.path.length < 2) {
    return {
      ok: false,
      code: result ? 'TOO_CLOSE' : 'NO_PATH',
      message: result
        ? 'Start and destination snap to the same point on the network — pick places further apart.'
        : 'No park connector route links these two points.',
    };
  }

  const coordinates = result.path.map((index) => graph.nodes[index]);

  const loopsRidden: string[] = [];
  for (let i = 1; i < result.path.length; i++) {
    const edge = edgeBetween(graph, result.path[i - 1], result.path[i]);
    if (!edge || edge.loop < 0) continue;
    const name = graph.loops[edge.loop];
    if (name && !loopsRidden.includes(name)) loopsRidden.push(name);
  }

  const startAccess: RouteAccessLeg = {
    from: start,
    to: from.coordinate,
    distanceMeters: from.distanceMeters,
  };
  const endAccess: RouteAccessLeg = {
    from: to.coordinate,
    to: destination,
    distanceMeters: to.distanceMeters,
  };

  const accessDistanceMeters = startAccess.distanceMeters + endAccess.distanceMeters;
  const ridingSeconds = result.distanceMeters / ((cyclingSpeedKmh * 1000) / 3600);
  const accessSeconds = accessDistanceMeters / ((accessSpeedKmh * 1000) / 3600);

  return {
    ok: true,
    route: {
      coordinates,
      distanceMeters: result.distanceMeters,
      accessDistanceMeters,
      totalDistanceMeters: result.distanceMeters + accessDistanceMeters,
      ridingSeconds,
      accessSeconds,
      durationSeconds: ridingSeconds + accessSeconds,
      loops: loopsRidden,
      start,
      destination,
      startAccess,
      endAccess,
    },
  };
}

/* ---------------------------------------------------------------- GeoJSON -- */

export interface RouteLineFeature {
  type: 'Feature';
  properties: { role: 'route' | 'access' };
  geometry: { type: 'LineString'; coordinates: LngLat[] };
}

export interface RoutePointFeature {
  type: 'Feature';
  properties: { role: 'start' | 'destination' };
  geometry: { type: 'Point'; coordinates: LngLat };
}

export interface FeatureCollectionOf<T> {
  type: 'FeatureCollection';
  features: T[];
}

export function routeToFeatureCollection(
  route: PlannedRoute,
): FeatureCollectionOf<RouteLineFeature> {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { role: 'route' },
        geometry: { type: 'LineString', coordinates: route.coordinates },
      },
    ],
  };
}

/** The dashed "get to the path" / "leave the path" legs, when worth drawing. */
export function accessLegsToFeatureCollection(
  route: PlannedRoute,
): FeatureCollectionOf<RouteLineFeature> {
  const features: RouteLineFeature[] = [];
  for (const leg of [route.startAccess, route.endAccess]) {
    if (leg.distanceMeters < 5) continue;
    features.push({
      type: 'Feature',
      properties: { role: 'access' },
      geometry: { type: 'LineString', coordinates: [leg.from, leg.to] },
    });
  }
  return { type: 'FeatureCollection', features };
}

export function routeEndpointsToFeatureCollection(
  route: PlannedRoute,
): FeatureCollectionOf<RoutePointFeature> {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { role: 'start' },
        geometry: { type: 'Point', coordinates: route.start },
      },
      {
        type: 'Feature',
        properties: { role: 'destination' },
        geometry: { type: 'Point', coordinates: route.destination },
      },
    ],
  };
}

export function routeBounds(route: PlannedRoute): { sw: LngLat; ne: LngLat } {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;

  for (const [lng, lat] of [...route.coordinates, route.start, route.destination]) {
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
  }

  return { sw: [minLng, minLat], ne: [maxLng, maxLat] };
}

/* -------------------------------------------------------------- formatting -- */

export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters)) return '—';
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = meters / 1000;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—';
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return '<1 min';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}
