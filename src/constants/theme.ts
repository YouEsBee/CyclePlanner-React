/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 */

import '@/global.css';

import { Platform, StyleSheet } from 'react-native';

export const Colors = {
  light: {
    text: '#000000',
    background: '#ffffff',
    backgroundElement: '#F0F0F3',
    backgroundSelected: '#E0E1E6',
    textSecondary: '#60646C',
  },
  dark: {
    text: '#ffffff',
    background: '#000000',
    backgroundElement: '#212225',
    backgroundSelected: '#2E3135',
    textSecondary: '#B0B4BA',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;


export const stylesPlanner = StyleSheet.create({
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
    textAlign: "center",
    fontWeight: "bold"
  }
});

export const stylesProfile = StyleSheet.create({
  main: {
    margin: 20,
  },
  panes: {
    borderRadius: 10,
    backgroundColor: "#FFF",
    marginTop: 20,
    padding: 20
  },
  header: {
    fontSize: 40
  },
  settingHeader: {
    fontSize: 18
  },
  line: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: "#bbb",
    marginTop: 10,
    marginBottom: 20,
    width: "100%"
  },
  routePanel: {
    paddingVertical: 20
  }
});