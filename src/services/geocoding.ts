/**
 * Place search for the start / destination fields.
 *
 * Photon (photon.komoot.io) is the primary provider: it is built for
 * as-you-type search and has no API key. If it is unreachable or returns
 * nothing we fall back to Nominatim, which is slower but has better coverage of
 * Singapore addresses and postal codes.
 *
 * Both are free community services — keep requests debounced (see
 * `usePlaceSearch` in `@/components/planner-func`) and never fire one per
 * keystroke.
 */

import type { LngLat } from '@/services/pcn-routing';

export type { LngLat };

export interface GeoPlace {
  id: string;
  /** Short label, e.g. "East Coast Park". */
  name: string;
  /** Secondary line, e.g. "Marine Parade, Singapore 449876". */
  address: string;
  latitude: number;
  longitude: number;
  source: 'photon' | 'nominatim';
}

export interface SearchPlacesOptions {
  limit?: number;
  /** Biases results towards this point (usually the rider's location). */
  near?: LngLat;
  signal?: AbortSignal;
}

export const SINGAPORE_BBOX = {
  minLng: 103.59,
  minLat: 1.14,
  maxLng: 104.13,
  maxLat: 1.49,
} as const;

export const SINGAPORE_CENTER: LngLat = [103.851959, 1.29027];

const PHOTON_URL = 'https://photon.komoot.io/api/';
const PHOTON_REVERSE_URL = 'https://photon.komoot.io/reverse';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
/** Nominatim's usage policy requires an identifiable client. */
const USER_AGENT = 'CyclePlanner/1.0 (https://github.com/youesbee/CyclePlanner-React)';
const REQUEST_TIMEOUT_MS = 8000;

export function isInSingapore(longitude: number, latitude: number): boolean {
  return (
    longitude >= SINGAPORE_BBOX.minLng &&
    longitude <= SINGAPORE_BBOX.maxLng &&
    latitude >= SINGAPORE_BBOX.minLat &&
    latitude <= SINGAPORE_BBOX.maxLat
  );
}

/**
 * True when a rejection means "this request was cancelled" rather than "this
 * provider failed".
 *
 * The global `fetch` here is Expo's WinterCG implementation, not whatwg-fetch,
 * and it reports cancellation in three different shapes:
 *   - `DOMException('The operation was aborted.', 'AbortError')` — the web
 *     standard, raised when the response body stream is aborted;
 *   - `FetchError: fetch failed: Fetch request has been canceled` — the native
 *     Android/iOS cancellation, wrapped by `expo/winter`'s `FetchError`, whose
 *     `name` is a plain `'Error'`;
 *   - `FetchError: fetch failed: The operation was aborted.` — thrown when the
 *     signal was already aborted before the request started.
 *
 * Only the first has `name === 'AbortError'`. Testing that alone made every
 * superseded keystroke look like a Photon outage, which logged a warning and
 * fired a pointless Nominatim request against a 1 req/s rate limit.
 */
function isAbortError(error: unknown, depth = 0): boolean {
  if (depth > 3 || typeof error !== 'object' || error === null) return false;

  const { name, message, cause } = error as {
    name?: string;
    message?: string;
    cause?: unknown;
  };

  if (name === 'AbortError') return true;
  if (typeof message === 'string' && /\b(aborted|cancell?ed)\b/i.test(message)) return true;

  return isAbortError(cause, depth + 1);
}

function abortError(): Error {
  return Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
}

/**
 * fetch() with a timeout, chained to the caller's abort signal so a new
 * keystroke cancels the request in flight.
 */
async function fetchJson(
  url: string,
  signal: AbortSignal | undefined,
  headers?: Record<string, string>,
): Promise<any> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  const forwardAbort = () => controller.abort();
  signal?.addEventListener('abort', forwardAbort);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', ...headers },
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return await response.json();
  } catch (error) {
    // A timeout cancels the request exactly the way a new keystroke does, so
    // relabel it — otherwise `isAbortError` swallows it and a genuinely slow
    // provider never fails over to the other one.
    if (timedOut && !signal?.aborted) {
      throw new Error(`timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', forwardAbort);
  }
}

function joinParts(parts: (string | undefined | null)[]): string {
  return parts.filter((part): part is string => Boolean(part && part.trim())).join(', ');
}

/* ------------------------------------------------------------------ Photon -- */

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: Record<string, string | number | undefined>;
}

function photonToPlace(feature: PhotonFeature, index: number): GeoPlace | null {
  const coordinates = feature.geometry?.coordinates;
  if (!coordinates || coordinates.length < 2) return null;

  const longitude = Number(coordinates[0]);
  const latitude = Number(coordinates[1]);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;

  const properties = feature.properties ?? {};
  const street = properties.street ? String(properties.street) : undefined;
  const houseNumber = properties.housenumber ? String(properties.housenumber) : undefined;
  const streetLine = joinParts([houseNumber ? `${houseNumber} ${street ?? ''}`.trim() : street]);

  const name = String(properties.name ?? streetLine ?? properties.city ?? 'Unnamed place');
  const address = joinParts([
    name === streetLine ? undefined : streetLine,
    properties.district ? String(properties.district) : undefined,
    properties.city ? String(properties.city) : undefined,
    properties.postcode ? String(properties.postcode) : undefined,
    properties.country ? String(properties.country) : undefined,
  ]);

  return {
    id: `photon:${properties.osm_type ?? 'x'}${properties.osm_id ?? index}`,
    name,
    address,
    latitude,
    longitude,
    source: 'photon',
  };
}

async function searchPhoton(
  query: string,
  limit: number,
  near: LngLat | undefined,
  signal: AbortSignal | undefined,
): Promise<GeoPlace[]> {
  const params = new URLSearchParams({
    q: query,
    limit: String(Math.max(limit * 2, limit)),
    lang: 'en',
    bbox: `${SINGAPORE_BBOX.minLng},${SINGAPORE_BBOX.minLat},${SINGAPORE_BBOX.maxLng},${SINGAPORE_BBOX.maxLat}`,
  });
  const bias = near ?? SINGAPORE_CENTER;
  params.set('lon', String(bias[0]));
  params.set('lat', String(bias[1]));

  const json = await fetchJson(`${PHOTON_URL}?${params.toString()}`, signal);
  const features: PhotonFeature[] = Array.isArray(json?.features) ? json.features : [];

  return features
    .map(photonToPlace)
    .filter((place): place is GeoPlace => place !== null)
    .filter((place) => isInSingapore(place.longitude, place.latitude))
    .slice(0, limit);
}

/* --------------------------------------------------------------- Nominatim -- */

interface NominatimResult {
  place_id?: number | string;
  lat?: string;
  lon?: string;
  name?: string;
  display_name?: string;
}

function nominatimToPlace(result: NominatimResult, index: number): GeoPlace | null {
  const latitude = Number(result.lat);
  const longitude = Number(result.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const display = result.display_name ?? '';
  const parts = display.split(',').map((part) => part.trim());
  const name = result.name?.trim() || parts[0] || 'Unnamed place';
  const address = parts.slice(name === parts[0] ? 1 : 0).join(', ');

  return {
    id: `nominatim:${result.place_id ?? index}`,
    name,
    address,
    latitude,
    longitude,
    source: 'nominatim',
  };
}

async function searchNominatim(
  query: string,
  limit: number,
  signal: AbortSignal | undefined,
): Promise<GeoPlace[]> {
  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    limit: String(limit),
    countrycodes: 'sg',
    addressdetails: '1',
    'accept-language': 'en',
  });

  const json = await fetchJson(`${NOMINATIM_URL}?${params.toString()}`, signal, {
    'User-Agent': USER_AGENT,
  });
  const results: NominatimResult[] = Array.isArray(json) ? json : [];

  return results
    .map(nominatimToPlace)
    .filter((place): place is GeoPlace => place !== null)
    .filter((place) => isInSingapore(place.longitude, place.latitude))
    .slice(0, limit);
}

/* -------------------------------------------------------------- public API -- */

/**
 * Searches Photon first, then Nominatim. Aborts propagate to the caller;
 * every other provider failure is swallowed so one dead service does not break
 * search.
 */
export async function searchPlaces(
  query: string,
  options: SearchPlacesOptions = {},
): Promise<GeoPlace[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const { limit = 6, near, signal } = options;

  try {
    const photonResults = await searchPhoton(trimmed, limit, near, signal);
    if (photonResults.length > 0) return photonResults;
  } catch (error) {
    // `signal.aborted` is the reliable test; the error's shape is not.
    if (signal?.aborted || isAbortError(error)) throw error;
    console.warn('Photon search failed, falling back to Nominatim:', error);
  }

  // Photon came back empty rather than failing — don't spend the caller's
  // Nominatim budget on a query they have already moved on from.
  if (signal?.aborted) throw abortError();

  try {
    return await searchNominatim(trimmed, limit, signal);
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw error;
    console.warn('Nominatim search failed:', error);
    return [];
  }
}

/** Names a coordinate — used to label "Current location" once GPS lands. */
export async function reverseGeocode(
  point: LngLat,
  signal?: AbortSignal,
): Promise<GeoPlace | null> {
  const params = new URLSearchParams({
    lon: String(point[0]),
    lat: String(point[1]),
    lang: 'en',
    limit: '1',
  });

  try {
    const json = await fetchJson(`${PHOTON_REVERSE_URL}?${params.toString()}`, signal);
    const feature = Array.isArray(json?.features) ? json.features[0] : undefined;
    return feature ? photonToPlace(feature, 0) : null;
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw error;
    console.warn('Reverse geocode failed:', error);
    return null;
  }
}

/** Wraps a raw coordinate as a GeoPlace so the UI can treat both alike. */
export function placeFromCoordinate(point: LngLat, name = 'Current location'): GeoPlace {
  return {
    id: `coordinate:${point[0].toFixed(5)},${point[1].toFixed(5)}`,
    name,
    address: `${point[1].toFixed(5)}, ${point[0].toFixed(5)}`,
    latitude: point[1],
    longitude: point[0],
    source: 'photon',
  };
}

export function placeToLngLat(place: GeoPlace): LngLat {
  return [place.longitude, place.latitude];
}
