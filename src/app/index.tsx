import { Text, View, StyleSheet } from "react-native";
import { Map, Camera, UserLocation, type CameraRef } from "@maplibre/maplibre-react-native";
import { useEffect, useState, useRef } from "react";
import * as Location from "expo-location";

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
  const [location, setLocation] = useState<Location.LocationObject>(DEFAULT_LOCATION);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const cameraRef = useRef<CameraRef>(null);

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
            cameraRef.current?.jumpTo({
              center: [location.coords.longitude, location.coords.latitude],
            });
            console.log("jumpTo was called");
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

  let text = "Waiting...";
  if (errorMsg) {
    text = errorMsg;
  } else if (location) {
    text = JSON.stringify(location);
  }

  return (
    <View style={styles.container}>
      <Map style={styles.map} mapStyle="https://tiles.openfreemap.org/styles/liberty">
        <Camera
          ref={cameraRef} initialViewState={INITIAL_VIEW_STATE}
        />
        <UserLocation accuracy/>
      </Map>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  map: {
    flex: 1,
  }
});
