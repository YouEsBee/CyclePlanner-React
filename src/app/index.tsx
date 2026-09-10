import { ActivityIndicator, Dimensions, Keyboard, Pressable, ScrollView, Text, View, TextInput, TouchableOpacity } from "react-native";
import { Map, Camera, UserLocation, GeoJSONSource, Layer, type CameraRef } from "@maplibre/maplibre-react-native";
import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import * as Location from "expo-location";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BottomTabInset, stylesPlanner, stylesRoute, stylesSearch } from "@/constants/theme"
import { usePcnNetwork, usePlaceSearch } from "@/components/planner-func";
import { placeToLngLat, type GeoPlace } from "@/services/geocoding";
import {
  accessLegsToFeatureCollection,
  formatDistance,
  formatDuration,
  planPcnRoute,
  routeBounds,
  routeEndpointsToFeatureCollection,
  routeToFeatureCollection,
  type LngLat,
  type PlannedRoute,
} from "@/services/pcn-routing";

const DEFAULT_LOCATION: Location.LocationObject = {
    coords: {
      latitude: 1.290270,
      longitude: 103.851959,
      altitude: null,
      accuracy: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
    },
    timestamp: Date.now(),
  }

const INITIAL_VIEW_STATE = {
  center:[DEFAULT_LOCATION.coords.longitude, DEFAULT_LOCATION.coords.latitude] as [number, number],
  zoom: 15,
}

const DATASET_ID = "d_a69ef89737379f231d2ae93fd1c5707f";

/** Which search field is currently open, if any. */
type ActiveField = "start" | "destination" | null;

/** Zoom that fits a bounding box in the visible part of the map. */
function zoomForBounds(sw: LngLat, ne: LngLat): number {
  const { width, height } = Dimensions.get("window");
  const TILE_SIZE = 512;

  const latRadians = (lat: number) => {
    const sin = Math.sin((lat * Math.PI) / 180);
    return Math.log((1 + sin) / (1 - sin)) / 2;
  };

  const latFraction = Math.max((latRadians(ne[1]) - latRadians(sw[1])) / (2 * Math.PI), 1e-9);
  const lngDelta = ne[0] - sw[0] < 0 ? ne[0] - sw[0] + 360 : ne[0] - sw[0];
  const lngFraction = Math.max(lngDelta / 360, 1e-9);

  // Leave room for the search card on top and the route card at the bottom.
  const usableWidth = Math.max(120, width - 80);
  const usableHeight = Math.max(160, height - 380);

  const zoom = Math.min(
    Math.log2(usableHeight / TILE_SIZE / latFraction),
    Math.log2(usableWidth / TILE_SIZE / lngFraction),
  );
  return Math.min(16, Math.max(9, zoom));
}

export default function Index() {
  const insets = useSafeAreaInsets();

  const [location, setLocation] = useState<Location.LocationObject>(DEFAULT_LOCATION);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const cameraRef = useRef<CameraRef>(null);

  const { geojson: parkConnectors, graph, loading: networkLoading, error: networkError } =
    usePcnNetwork(DATASET_ID);

  const [startLoc, setStartLoc] = useState("");
  const [destLoc, setDestLoc] = useState("");
  const [startPlace, setStartPlace] = useState<GeoPlace | null>(null);
  const [destPlace, setDestPlace] = useState<GeoPlace | null>(null);
  const [activeField, setActiveField] = useState<ActiveField>(null);

  const [route, setRoute] = useState<PlannedRoute | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const userLngLat = useMemo<LngLat>(
    () => [location.coords.longitude, location.coords.latitude],
    [location.coords.longitude, location.coords.latitude],
  );

  // Only the focused field searches, and only until a suggestion is picked.
  const startSearch = usePlaceSearch(startLoc, {
    near: userLngLat,
    enabled: activeField === "start" && startPlace === null,
  });
  const destSearch = usePlaceSearch(destLoc, {
    near: userLngLat,
    enabled: activeField === "destination" && destPlace === null,
  });

  useEffect(() => {
    async function getCurrentLocation() {
      try {
        let { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== "granted") {
          setErrorMsg("Permission to access location was denied.");
          setLocation(DEFAULT_LOCATION);
          return;
        }

        const location = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.BestForNavigation,
        });
        console.log("Got location: ", location.coords.latitude, location.coords.longitude);
        setLocation(location);

        // Move camera to curr location
        try {
          setTimeout(() => {
            cameraRef.current?.flyTo({
              center: [location.coords.longitude, location.coords.latitude],
              duration: 1000,
            });
            console.log("flyTo was called");
          }, 500)
        } catch (e) {
          console.warn("jumpTo threw: ", e);
        }

      } catch (error) {
        console.warn("Location error: ", error);
        setLocation(DEFAULT_LOCATION);
      }
    }

    getCurrentLocation();
  }, []);

  const fitCameraToRoute = useCallback((planned: PlannedRoute) => {
    const { sw, ne } = routeBounds(planned);
    const center: LngLat = [(sw[0] + ne[0]) / 2, (sw[1] + ne[1]) / 2];
    try {
      cameraRef.current?.flyTo({
        center,
        zoom: zoomForBounds(sw, ne),
        duration: 1200,
      });
    } catch (e) {
      console.warn("flyTo threw: ", e);
    }
  }, []);

  const selectPlace = useCallback((field: Exclude<ActiveField, null>, place: GeoPlace) => {
    if (field === "start") {
      setStartPlace(place);
      setStartLoc(place.name);
    } else {
      setDestPlace(place);
      setDestLoc(place.name);
    }
    setActiveField(null);
    setPlanError(null);
    Keyboard.dismiss();
  }, []);

  const clearRoute = useCallback(() => {
    setRoute(null);
    setPlanError(null);
  }, []);

  const handlePlan = useCallback(async () => {
    Keyboard.dismiss();
    setActiveField(null);
    setPlanError(null);

    if (!graph) {
      setPlanError(networkError ?? "The park connector network is still loading.");
      return;
    }

    // An empty start field means "start from where I am".
    const start: LngLat | null = startPlace
      ? placeToLngLat(startPlace)
      : startLoc.trim().length === 0
        ? userLngLat
        : null;

    if (!start) {
      setPlanError("Pick a starting point from the suggestions, or clear the field to start from your location.");
      return;
    }
    if (!destPlace) {
      setPlanError("Pick a destination from the suggestions.");
      return;
    }

    setPlanning(true);
    setRoute(null);
    // Yield one frame so the spinner paints before the search runs.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const result = planPcnRoute({ graph, start, destination: placeToLngLat(destPlace) });
    setPlanning(false);

    if (!result.ok) {
      setPlanError(result.message);
      return;
    }

    setRoute(result.route);
    fitCameraToRoute(result.route);
  }, [destPlace, fitCameraToRoute, graph, networkError, startLoc, startPlace, userLngLat]);

  const routeLine = useMemo(() => (route ? routeToFeatureCollection(route) : null), [route]);
  const routeAccess = useMemo(() => (route ? accessLegsToFeatureCollection(route) : null), [route]);
  const routeEndpoints = useMemo(
    () => (route ? routeEndpointsToFeatureCollection(route) : null),
    [route],
  );

  const canPlan = !planning && !networkLoading && destPlace !== null;

  const renderSuggestions = (field: Exclude<ActiveField, null>) => {
    const search = field === "start" ? startSearch : destSearch;
    const picked = field === "start" ? startPlace : destPlace;
    if (activeField !== field || picked !== null) return null;

    if (search.loading) {
      return (
        <View style={stylesSearch.suggestions}>
          <View style={stylesSearch.suggestionStatus}>
            <ActivityIndicator size="small" />
            <Text style={stylesSearch.suggestionStatusText}>Searching…</Text>
          </View>
        </View>
      );
    }

    if (search.results.length === 0) {
      if (!search.error) return null;
      return (
        <View style={stylesSearch.suggestions}>
          <View style={stylesSearch.suggestionStatus}>
            <Text style={stylesSearch.suggestionStatusText}>{search.error}</Text>
          </View>
        </View>
      );
    }

    return (
      <ScrollView style={stylesSearch.suggestions} keyboardShouldPersistTaps="handled">
        {search.results.map((place) => (
          <Pressable
            key={place.id}
            onPress={() => selectPlace(field, place)}
            style={({ pressed }) => [
              stylesSearch.suggestion,
              pressed && stylesSearch.suggestionPressed,
            ]}>
            <Text style={stylesSearch.suggestionName} numberOfLines={1}>{place.name}</Text>
            {place.address.length > 0 && (
              <Text style={stylesSearch.suggestionAddress} numberOfLines={1}>{place.address}</Text>
            )}
          </Pressable>
        ))}
      </ScrollView>
    );
  };

  return (
    <View style={stylesPlanner.container}>
      <View style={[stylesPlanner.searchBox, {top: insets.top + 10}]}>
        <View style={stylesSearch.fieldRow}>
          <TextInput
            style={[stylesPlanner.searchField, stylesSearch.fieldInput]}
            onChangeText={(loc) => { setStartLoc(loc); setStartPlace(null); }}
            onFocus={() => setActiveField("start")}
            value={startLoc}
            placeholder="Starting Point (blank = my location)"
            returnKeyType="search"
          />
          {startLoc.length > 0 && (
            <TouchableOpacity
              style={stylesSearch.clearField}
              onPress={() => { setStartLoc(""); setStartPlace(null); }}>
              <Text style={stylesSearch.clearFieldText}>✕</Text>
            </TouchableOpacity>
          )}
        </View>
        {renderSuggestions("start")}

        <Text style={{textAlign:"center"}}>To</Text>

        <View style={stylesSearch.fieldRow}>
          <TextInput
            style={[stylesPlanner.searchField, stylesSearch.fieldInput]}
            onChangeText={(loc) => { setDestLoc(loc); setDestPlace(null); }}
            onFocus={() => setActiveField("destination")}
            value={destLoc}
            placeholder="Destination"
            returnKeyType="search"
          />
          {destLoc.length > 0 && (
            <TouchableOpacity
              style={stylesSearch.clearField}
              onPress={() => { setDestLoc(""); setDestPlace(null); }}>
              <Text style={stylesSearch.clearFieldText}>✕</Text>
            </TouchableOpacity>
          )}
        </View>
        {renderSuggestions("destination")}

        {(planError || errorMsg || networkError) && (
          <Text style={stylesSearch.errorText}>{planError ?? networkError ?? errorMsg}</Text>
        )}

        <View style={stylesSearch.buttonRow}>
          <TouchableOpacity
            style={[stylesPlanner.button, {flex: 1}, !canPlan && stylesSearch.buttonDisabled]}
            disabled={!canPlan}
            onPress={handlePlan}>
            {planning ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Text style={stylesPlanner.buttontext}>
                {networkLoading ? "Loading network…" : "Plan"}
              </Text>
            )}
          </TouchableOpacity>
          {route && (
            <TouchableOpacity style={stylesSearch.secondaryButton} onPress={clearRoute}>
              <Text style={stylesSearch.secondaryButtonText}>Clear</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      <Map style={stylesPlanner.map} mapStyle="https://tiles.openfreemap.org/styles/liberty">
        <Camera
          ref={cameraRef} initialViewState={INITIAL_VIEW_STATE}
        />
        <UserLocation accuracy/>

        {/* Draw park connectors on map */}
        {parkConnectors && (
          <GeoJSONSource id="parkConnectors" data={parkConnectors}>
            <Layer
              id="parkConnectorsLine"
              type="line"
              paint={{
                "line-color": "#006e30",
                "line-width": 5,
                "line-opacity": 0.8,
              }}
            />
          </GeoJSONSource>
        )}

        {/* Dashed legs between the real endpoints and the network */}
        {routeAccess && routeAccess.features.length > 0 && (
          <GeoJSONSource id="routeAccess" data={routeAccess}>
            <Layer
              id="routeAccessLine"
              type="line"
              layout={{ "line-cap": "round" }}
              paint={{
                "line-color": "#5A6470",
                "line-width": 3,
                "line-dasharray": [1, 2],
              }}
            />
          </GeoJSONSource>
        )}

        {/* The planned ride */}
        {routeLine && (
          <GeoJSONSource id="plannedRoute" data={routeLine}>
            <Layer
              id="plannedRouteCasing"
              type="line"
              layout={{ "line-cap": "round", "line-join": "round" }}
              paint={{
                "line-color": "#FFFFFF",
                "line-width": 10,
              }}
            />
            <Layer
              id="plannedRouteLine"
              type="line"
              layout={{ "line-cap": "round", "line-join": "round" }}
              paint={{
                "line-color": "#006BF6",
                "line-width": 6,
              }}
            />
          </GeoJSONSource>
        )}

        {routeEndpoints && (
          <GeoJSONSource id="routeEndpoints" data={routeEndpoints}>
            <Layer
              id="routeEndpointsCircle"
              type="circle"
              paint={{
                "circle-radius": 7,
                "circle-color": ["match", ["get", "role"], "start", "#00A651", "#EF4444"],
                "circle-stroke-width": 2,
                "circle-stroke-color": "#FFFFFF",
              }}
            />
          </GeoJSONSource>
        )}
      </Map>

      {route && (
        <View style={[stylesRoute.card, {bottom: BottomTabInset + insets.bottom + 10}]}>
          <View style={stylesRoute.metrics}>
            <View>
              <Text style={stylesRoute.metricValue}>{formatDistance(route.distanceMeters)}</Text>
              <Text style={stylesRoute.metricLabel}>On park connectors</Text>
            </View>
            <View>
              <Text style={stylesRoute.metricValue}>{formatDuration(route.durationSeconds)}</Text>
              <Text style={stylesRoute.metricLabel}>Estimated at 15 km/h</Text>
            </View>
          </View>

          {route.loops.length > 0 && (
            <Text style={stylesRoute.detail}>Via {route.loops.join(" → ")}</Text>
          )}
          {route.accessDistanceMeters >= 5 && (
            <Text style={stylesRoute.detail}>
              Plus {formatDistance(route.accessDistanceMeters)} off-network to reach and leave the path.
            </Text>
          )}
        </View>
      )}
    </View>
  );
}
