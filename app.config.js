export default {
  expo: {
    owner: "atulgoswami2019",
    name: "mozility-tracker",
    slug: "mozility-tracker",
    version: "1.0.0",
    orientation: "portrait",
    icon: "./assets/icon.png",
    userInterfaceStyle: "light",
    splash: {
      image: "./assets/splash-icon.png",
      resizeMode: "contain",
      backgroundColor: "#ffffff",
    },
    assetBundlePatterns: ["**/*"],
    ios: {
      supportsTablet: true,
      infoPlist: {
        UIBackgroundModes: ["location", "fetch"],
        NSLocationAlwaysAndWhenInUseUsageDescription:
          "This app uses background location tracking to record your location data even when the app is closed.",
        NSLocationWhenInUseUsageDescription:
          "This app uses location tracking to record your location data.",
      },
    },
    android: {
      adaptiveIcon: {
        foregroundImage: "./assets/adaptive-icon.png",
        backgroundColor: "#ffffff",
      },
      permissions: [
        "ACCESS_COARSE_LOCATION",
        "ACCESS_FINE_LOCATION",
        "ACCESS_BACKGROUND_LOCATION",
        "FOREGROUND_SERVICE",
        "WAKE_LOCK",
      ],
      package: "com.yourcompany.mozilitytracker",
    },
    plugins: [
      "expo-location",
      "expo-background-fetch",
      [
        "expo-sqlite",
        {
          iosDatabaseLocation: "Library/SQLite",
        },
      ],
    ],
    extra: {
      eas: {
        projectId: "f820df0b-452b-4d66-8fd1-946c986a68e0",
      },
    },
  },
};
