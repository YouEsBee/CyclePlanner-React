import { Text, View, StyleSheet, TextInput, TouchableOpacity } from "react-native";
import { Map, Camera, UserLocation, GeoJSONSource, Layer, type CameraRef } from "@maplibre/maplibre-react-native";
import { useEffect, useState, useRef } from "react";
import * as Location from "expo-location";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { stylesPlanner } from "@/constants/theme"
import { fetchParkConnectors } from "@/components/planner-func";

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

export default function Index() {
  const insets = useSafeAreaInsets();

  const [location, setLocation] = useState<Location.LocationObject>(DEFAULT_LOCATION);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const cameraRef = useRef<CameraRef>(null);

  const DATASET_ID = "d_a69ef89737379f231d2ae93fd1c5707f";
  const [parkConnectors, setParkConnectors] = useState(null);

  const [startLoc, setStartLoc] = useState("");
  const [destLoc, setDestLoc] = useState("");

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
    fetchParkConnectors(DATASET_ID).then(setParkConnectors).catch(console.warn);
  }, []);

  let text = "Waiting...";
  if (errorMsg) {
    text = errorMsg;
  } else if (location) {
    text = JSON.stringify(location);
  }

  return (
    <View style={stylesPlanner.container}>
      <View style={[stylesPlanner.searchBox, {top: insets.top + 10}]}>
        <TextInput style={stylesPlanner.searchField} onChangeText={(loc) => setStartLoc(loc)} value={startLoc} placeholder="Starting Point"/>
        <Text style={{textAlign:"center"}}>To</Text>
        <TextInput style={stylesPlanner.searchField} onChangeText={(loc) => setDestLoc(loc)} value={destLoc} placeholder="Destination"/>
        <TouchableOpacity style={stylesPlanner.button}>
          <Text style={stylesPlanner.buttontext}>Plan</Text>
        </TouchableOpacity>
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
      </Map>
    </View>
  );
}
