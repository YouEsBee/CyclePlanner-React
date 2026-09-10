import { searchPlaces, type GeoPlace, type LngLat, } from "@/services/geocoding";
import { buildPcnGraph, type PcnGraph } from "@/services/pcn-routing";
import { useEffect, useState } from "react";

export async function fetchParkConnectors(DATASET_ID:string) {
    const pollRes = await fetch(
        `https://api-open.data.gov.sg/v1/public/api/datasets/${DATASET_ID}/poll-download`
    );
    const pollJson = await pollRes.json();

    if (pollJson.code !== 0) {
        throw new Error(pollJson.errMsg);
    }

    const fileRes = await fetch(pollJson.data.url);
    const geojson = await fileRes.json();
    return geojson;
}

export interface PcnNetwork {
    /** Raw FeatureCollection, drawn as the green PCN overlay. */
    geojson: any;
    /** Routable graph built from that FeatureCollection. */
    graph: PcnGraph | null;
    loading: boolean;
    error: string | null;
}

/**
 * Downloads the park connector dataset once and builds the routing graph from
 * it. Graph construction is synchronous (~33k vertices, well under a second)
 * and runs after the first paint, so the map is interactive while it happens.
 */
// export function usePcnNetwork(datasetId: string): PcnNetwork {
//     const [geojson, setGeojson] = useState<any>(null);
//     const [graph, setGraph] = useState<PcnGraph | null>(null);
//     const [loading, setLoading] = useState(true);
//     const [error, setError] = useState<string | null>(null);

//     useEffect(() => {
//         let cancelled = false;

//         (async () => {
//             try {
//                 const data = await fetchParkConnectors(datasetId);
//                 if (cancelled) return;
//                 setGeojson(data);

//                 const built = buildPcnGraph(data);
//                 if (cancelled) return;
//                 console.log("PCN graph:", built.stats);
//                 setGraph(built);
//                 setError(null);
//             } catch (e) {
//                 console.warn("Failed to load park connectors:", e);
//                 if (!cancelled) setError("Could not load the park connector network.");
//             } finally {
//                 if (!cancelled) setLoading(false);
//             }
//         })();

//         return () => {
//             cancelled = true;
//         };
//     }, [datasetId]);

//     return { geojson, graph, loading, error };
// }

// export interface PlaceSearchOptions {
//     /** Bias results towards this point. */
//     near?: LngLat;
//     /** Set false to pause searching (e.g. the field is not focused). */
//     enabled?: boolean;
//     /** Debounce before hitting the geocoder. Default 350 ms. */
//     delayMs?: number;
//     limit?: number;
// }

// export interface PlaceSearchState {
//     results: GeoPlace[];
//     loading: boolean;
//     error: string | null;
// }

// /**
//  * Debounced as-you-type place search. Each keystroke cancels the request still
//  * in flight, so only the latest query reaches the geocoder.
//  */
export interface PlaceSearchOptions {
  near?: LngLat;
  enabled?: boolean;
  delayMs?: number;
  limit?: number;
}

export interface PlaceSearchState {
  results: GeoPlace[];
  loading: boolean;
  error: string | null;
}
export function usePlaceSearch(query: string, options: PlaceSearchOptions = {}): PlaceSearchState {
    const { near, enabled = true, delayMs = 350, limit = 6 } = options;

    const [results, setResults] = useState<GeoPlace[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Bias point as a primitive so a jittery GPS fix does not restart the search.
    const nearKey = near ? `${near[0].toFixed(3)},${near[1].toFixed(3)}` : "";

    useEffect(() => {
        const trimmed = query.trim();
        if (!enabled || trimmed.length < 2) {
            setResults([]);
            setLoading(false);
            setError(null);
            return;
        }

        const controller = new AbortController();
        setLoading(true);

        const timer = setTimeout(async () => {
            try {
                const bias = nearKey
                    ? (nearKey.split(",").map(Number) as LngLat)
                    : undefined;
                const found = await searchPlaces(trimmed, {
                    limit,
                    near: bias,
                    signal: controller.signal,
                });
                if (controller.signal.aborted) return;
                setResults(found);
                setError(found.length === 0 ? "No matching places in Singapore." : null);
            } catch (e) {
                if (controller.signal.aborted) return;
                console.warn("Place search failed:", e);
                setResults([]);
                setError("Search is unavailable right now.");
            } finally {
                if (!controller.signal.aborted) setLoading(false);
            }
        }, delayMs);

        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [query, enabled, delayMs, limit, nearKey]);

    return { results, loading, error };
}
// return { geojson, graph, loading, error };

// // Paste useTrafficSignals here:
// export interface TrafficSignalNetwork {
//   geojson: any;
//   loading: boolean;
//   error: string | null;
// }

export function usePcnNetwork(datasetId: string): PcnNetwork {
  const [geojson, setGeojson] = useState<any>(null);
  const [graph, setGraph] = useState<PcnGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const data = await fetchParkConnectors(datasetId);
        if (cancelled) return;

        setGeojson(data);

        const built = buildPcnGraph(data);
        if (cancelled) return;

        console.log("PCN graph:", built.stats);
        setGraph(built);
        setError(null);
      } catch (e) {
        console.warn("Failed to load park connectors:", e);

        if (!cancelled) {
          setError("Could not load the park connector network.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [datasetId]);

  return { geojson, graph, loading, error };
}

export interface TrafficSignalNetwork {
  geojson: any;
  loading: boolean;
  error: string | null;
}

export function useTrafficSignal(): TrafficSignalNetwork {
  const [geojson, setGeojson] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const response = await fetch("/data/traffic-signals.geojson");

        if (!response.ok) {
          throw new Error(`Traffic signals failed to load: ${response.status}`);
        }

        const data = await response.json();

        if (cancelled) return;

        setGeojson(data);
        setError(null);
        console.log("Traffic signal aspects:", data.features?.length ?? 0);
      } catch (e) {
        console.warn("Failed to load traffic signals:", e);

        if (!cancelled) {
          setError("Could not load traffic-signal data.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return { geojson, loading, error };
}
