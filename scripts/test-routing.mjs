/**
 * Routing tests — run with `npm run test:routing`.
 *
 * Imports src/services/pcn-routing.ts directly (Node >= 22.18 strips the types),
 * so there is no build step and no copy of the logic to keep in sync.
 *
 * The dataset is cached in the OS temp dir; pass --fresh to re-download it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildPcnGraph,
  findNearestNode,
  haversineMeters,
  planPcnRoute,
  routeBounds,
  formatDistance,
  formatDuration,
} from '../src/services/pcn-routing.ts';

const DATASET_ID = 'd_a69ef89737379f231d2ae93fd1c5707f';
const CACHE = path.join(os.tmpdir(), `${DATASET_ID}.geojson`);

let failures = 0;
function check(name, condition, detail = '') {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) failures++;
  console.log(`  [${status}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function loadDataset() {
  if (fs.existsSync(CACHE) && !process.argv.includes('--fresh')) {
    console.log(`Using cached dataset (${CACHE})`);
    return JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  }

  console.log('Downloading park connector dataset from data.gov.sg…');
  const pollRes = await fetch(
    `https://api-open.data.gov.sg/v1/public/api/datasets/${DATASET_ID}/poll-download`,
  );
  const pollJson = await pollRes.json();
  if (pollJson.code !== 0) throw new Error(pollJson.errMsg);

  const geojson = await (await fetch(pollJson.data.url)).json();
  fs.writeFileSync(CACHE, JSON.stringify(geojson));
  return geojson;
}

/** Landmarks near the network, with the leg we expect to be plannable. */
const PLACES = {
  'East Coast Park': [103.927, 1.301],
  'Bedok Reservoir': [103.923, 1.34],
  'Punggol Waterway': [103.907, 1.403],
  'Marina Barrage': [103.871, 1.2805],
  'Bishan-AMK Park': [103.843, 1.362],
  'Changi Beach': [103.988, 1.39],
};

const geojson = await loadDataset();

console.log('\n== Graph build ==');
const buildStart = Date.now();
const graph = buildPcnGraph(geojson);
const buildMs = Date.now() - buildStart;
const biggestComponent = Math.max(...graph.componentSizes);

console.log(`  ${JSON.stringify(graph.stats)}`);
console.log(`  built in ${buildMs} ms, largest component ${biggestComponent} nodes ` +
  `(${((100 * biggestComponent) / graph.stats.nodeCount).toFixed(1)}%)`);

check('graph has nodes', graph.stats.nodeCount > 20000, `${graph.stats.nodeCount} nodes`);
check('network length is plausible', graph.stats.networkLengthMeters > 250_000, formatDistance(graph.stats.networkLengthMeters));
check('loose ends were stitched', graph.stats.stitchedCount > 0, `${graph.stats.stitchedCount}`);
check('components were bridged', graph.stats.bridgedCount > 0, `${graph.stats.bridgedCount}`);
check('largest component covers >50% of the network', biggestComponent / graph.stats.nodeCount > 0.5);
check('build is fast enough', buildMs < 3000, `${buildMs} ms`);
check('loop names were read', graph.loops.includes('Eastern Coastal Loop'), graph.loops.length + ' loops');

console.log('\n== Snapping ==');
for (const [name, point] of Object.entries(PLACES)) {
  const near = findNearestNode(graph, point);
  check(`${name} snaps to the network`, near !== null && near.distanceMeters < 1000,
    near ? formatDistance(near.distanceMeters) : 'no node found');
}
const middleOfTheSea = findNearestNode(graph, [104.05, 1.18]);
check('a point far offshore snaps to nothing', middleOfTheSea === null);

console.log('\n== Planning ==');
const legs = [
  ['East Coast Park', 'Marina Barrage'],
  ['East Coast Park', 'Changi Beach'],
  ['Punggol Waterway', 'Bishan-AMK Park'],
  ['Bedok Reservoir', 'Marina Barrage'],
];

for (const [a, b] of legs) {
  const started = Date.now();
  const result = planPcnRoute({ graph, start: PLACES[a], destination: PLACES[b] });
  const ms = Date.now() - started;

  if (!result.ok) {
    check(`${a} → ${b}`, false, `${result.code}: ${result.message}`);
    continue;
  }

  const route = result.route;
  const crowFlies = haversineMeters(PLACES[a], PLACES[b]);
  const detour = route.distanceMeters / crowFlies;
  const bounds = routeBounds(route);

  console.log(`  ${a} → ${b}: ${formatDistance(route.distanceMeters)} / ` +
    `${formatDuration(route.durationSeconds)}, detour x${detour.toFixed(2)}, ` +
    `${route.coordinates.length} points, via ${route.loops.join(' → ')} (${ms} ms)`);

  check(`  ${a} → ${b} is longer than the crow flight`, route.distanceMeters >= crowFlies);
  check(`  ${a} → ${b} does not wander absurdly`, detour < 8, `x${detour.toFixed(2)}`);
  check(`  ${a} → ${b} starts and ends where asked`,
    haversineMeters(route.coordinates[0], PLACES[a]) < 3000 &&
    haversineMeters(route.coordinates[route.coordinates.length - 1], PLACES[b]) < 3000);
  check(`  ${a} → ${b} stays inside Singapore`,
    bounds.sw[0] > 103.5 && bounds.ne[0] < 104.2 && bounds.sw[1] > 1.1 && bounds.ne[1] < 1.5);
  check(`  ${a} → ${b} names the loops it uses`, route.loops.length > 0);
  check(`  ${a} → ${b} is fast`, ms < 500, `${ms} ms`);
}

console.log('\n== Failure cases ==');
const offNetwork = planPcnRoute({ graph, start: PLACES['East Coast Park'], destination: [103.83, 1.2494] });
check('a destination off the network is rejected, not crashed',
  !offNetwork.ok && offNetwork.code === 'DESTINATION_TOO_FAR', offNetwork.ok ? 'planned anyway' : offNetwork.code);

const samePoint = planPcnRoute({ graph, start: PLACES['Marina Barrage'], destination: PLACES['Marina Barrage'] });
check('start == destination is rejected', !samePoint.ok, samePoint.ok ? 'planned anyway' : samePoint.code);

const emptyGraph = planPcnRoute({ graph: buildPcnGraph({ features: [] }), start: [103.85, 1.29], destination: [103.9, 1.3] });
check('an empty network is rejected', !emptyGraph.ok && emptyGraph.code === 'EMPTY_NETWORK');

console.log(failures === 0 ? '\nAll routing checks passed.' : `\n${failures} routing check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
