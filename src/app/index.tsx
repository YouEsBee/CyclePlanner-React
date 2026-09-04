import { Text, View, StyleSheet, TextInput, TouchableOpacity } from "react-native";
import { Map, Camera, UserLocation, type CameraRef } from "@maplibre/maplibre-react-native";
import { useEffect, useState, useRef } from "react";
import * as Location from "expo-location";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "expo-router/build/react-navigation";

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

  let text = "Waiting...";
  if (errorMsg) {
    text = errorMsg;
  } else if (location) {
    text = JSON.stringify(location);
  }

  return (
    <>
    <View style={styles.container}>
      <View style={[styles.searchBox, {top: insets.top + 10}]}>
        <TextInput style={styles.searchField} placeholder="Starting Point"/>
        <Text style={{textAlign:"center"}}>To</Text>
        <TextInput style={styles.searchField} placeholder="Destination"/>
        <TouchableOpacity style={styles.button}><Text style={styles.buttontext}>Plan</Text></TouchableOpacity>
      </View>
      <Map style={styles.map} mapStyle="https://tiles.openfreemap.org/styles/liberty">
        <Camera
          ref={cameraRef} initialViewState={INITIAL_VIEW_STATE}
        />
        <UserLocation accuracy/>
      </Map>
    </View>
    </>
    
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  map: {
    flex: 1,
  },
  searchBox: {
    position: "absolute",
    left: 10,
    right: 10,
    backgroundColor: "white",
    padding: 12,
    borderRadius: 20,
    elevation: 10, // Android
    zIndex: 10,
    shadowColor: "#000", // iOS
    shadowOffset: {width:0, height:2},
    shadowOpacity: 0.15,
    shadowRadius: 4
  },
  searchField: {
    borderRadius: 10,
    backgroundColor: "#EEEEEE",
    margin: 5,
    padding: 10
  },
  button: {
    borderRadius: 10,
    backgroundColor: "#006BF6",
    padding: 10,
    marginTop: 15,
    marginLeft: 5,
    marginRight: 5,
    marginBottom: 5
  },
  buttontext: {
    color: "#FFFFFF",
    textAlign: "center"
  }
});
