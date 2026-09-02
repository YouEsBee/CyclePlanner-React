import { Text, View, StyleSheet, ScrollView } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

export default function Index() {
  return (
    <SafeAreaProvider>
      <ScrollView>
        <View style={styles.container}>
          <Text>Cycling Planner</Text>
        </View>
        <Text>Hello World</Text>
      </ScrollView>
      
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
