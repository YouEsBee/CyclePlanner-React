/**
 * Geocoding tests — run with `npm run test:geocoding`.
 *
 * Hits the live Photon / Nominatim services, so it needs a network connection
 * and it is deliberately slow: requests are spaced out to stay inside the
 * community usage policies of both services.
 */

import { searchPlaces, reverseGeocode, isInSingapore } from '../src/services/geocoding.ts';

const NEAR = [103.851959, 1.29027]; // city centre, used as the search bias

let failures = 0;
function check(name, condition, detail = '') {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) failures++;
  console.log(`  [${status}] ${name}${detail ? ` — ${detail}` : ''}`);
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log('== Search ==');
const queries = [
  { q: 'East Coast Park', expect: 'a well-known park' },
  { q: 'Bishan', expect: 'a town name' },
  { q: 'Punggol Waterway', expect: 'a park connector landmark' },
  { q: '018956', expect: 'a postal code' },
  { q: 'Ang Mo Kio Ave 3', expect: 'a road' },
];

for (const { q, expect } of queries) {
  const started = Date.now();
  const results = await searchPlaces(q, { near: NEAR });
  const ms = Date.now() - started;

  console.log(`\n  "${q}" (${expect}) → ${results.length} results in ${ms} ms`);
  for (const place of results.slice(0, 3)) {
    console.log(`    [${place.source}] ${place.name} | ${place.address} | ` +
      `${place.latitude.toFixed(5)}, ${place.longitude.toFixed(5)}`);
  }

  check(`  "${q}" returns something`, results.length > 0);
  check(`  "${q}" results are all in Singapore`,
    results.every((p) => isInSingapore(p.longitude, p.latitude)));
  check(`  "${q}" results are all usable`,
    results.every((p) => p.id && p.name && Number.isFinite(p.latitude) && Number.isFinite(p.longitude)));
  check(`  "${q}" answers in reasonable time`, ms < 8000, `${ms} ms`);

  await pause(1100); // be polite to the free geocoders
}

console.log('\n== Edge cases ==');
const nonsense = await searchPlaces('zzzqqqnotaplace', { near: NEAR });
check('a nonsense query returns an empty list, not an error', Array.isArray(nonsense) && nonsense.length === 0);

const tooShort = await searchPlaces('a', { near: NEAR });
check('a one-character query does not hit the network', tooShort.length === 0);

const controller = new AbortController();
const aborted = searchPlaces('Bedok', { signal: controller.signal })
  .then(() => 'resolved')
  .catch((e) => e.name);
controller.abort();
check('an aborted search rejects with AbortError', (await aborted) === 'AbortError');

console.log('\n== Reverse geocode ==');
await pause(1100);
const place = await reverseGeocode([103.927, 1.301]);
console.log(`  ${place ? `${place.name} | ${place.address}` : 'null'}`);
check('a coordinate on East Coast Park gets a name', place !== null);
check('the reverse result is in Singapore',
  place !== null && isInSingapore(place.longitude, place.latitude));

console.log(failures === 0 ? '\nAll geocoding checks passed.' : `\n${failures} geocoding check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
