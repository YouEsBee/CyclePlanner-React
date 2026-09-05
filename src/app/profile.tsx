import {Text, View} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { stylesProfile } from "@/constants/theme";

export default function Profile() {
    return (
        <SafeAreaView>
            <View style={stylesProfile.main}>
                <Text style={stylesProfile.header}>Profile</Text>
                <View style={stylesProfile.panes}>
                    <Text style={stylesProfile.settingHeader}>Saved Routes</Text>
                    <View style={stylesProfile.line}/>
                    <Text style={stylesProfile.routePanel}>Placeholder Route</Text>
                    <Text style={stylesProfile.routePanel}>Placeholder Route 2</Text>
                </View>
            </View>
        </SafeAreaView>
    )
}