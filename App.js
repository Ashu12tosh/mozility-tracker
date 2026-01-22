import "./global.css";
import React, { useState, useEffect } from "react";
import {
  View,
  Button,
  Alert,
  Text,
  Platform,
  FlatList,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
} from "react-native";
import * as SQLite from "expo-sqlite";
import NetInfo from "@react-native-community/netinfo";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import * as BackgroundFetch from "expo-background-fetch";
import AsyncStorage from "@react-native-async-storage/async-storage";

const LOCATION_TASK_NAME = "background-location-task";
const SYNC_TASK_NAME = "background-sync-task";

export default function App() {
  const [isTracking, setIsTracking] = useState(false);
  const [isOnline, setIsOnline] = useState(true);
  const [locationPermission, setLocationPermission] = useState(null);
  const [backgroundPermission, setBackgroundPermission] = useState(null);
  const [database, setDatabase] = useState(null);
  const [locations, setLocations] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [stats, setStats] = useState({ total: 0, synced: 0, pending: 0 });
  const [testMode, setTestMode] = useState(false);
  const [testInterval, setTestInterval] = useState(null);

  // Initialize database
  useEffect(() => {
    initDatabase();
    checkPermissions();
    setupNetworkListener();
    return () => {
      if (testInterval) clearInterval(testInterval);
    };
  }, []);

  // Load locations when database is ready
  useEffect(() => {
    if (database) {
      loadLocations();
      loadStats();
    }
  }, [database]);

  // Initialize SQLite database
  const initDatabase = async () => {
    try {
      const db = await SQLite.openDatabaseAsync("tracker.db");
      setDatabase(db);

      // Create tables if they don't exist
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS locations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          latitude REAL NOT NULL,
          longitude REAL NOT NULL,
          accuracy REAL,
          altitude REAL,
          speed REAL,
          heading REAL,
          timestamp INTEGER NOT NULL,
          synced INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        
        CREATE TABLE IF NOT EXISTS sync_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          table_name TEXT NOT NULL,
          record_id INTEGER NOT NULL,
          operation TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        
        CREATE TABLE IF NOT EXISTS app_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message TEXT NOT NULL,
          level TEXT DEFAULT 'info',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await logToDatabase("Database initialized successfully");
      console.log("Database initialized");
    } catch (error) {
      console.error("Database initialization error:", error);
    }
  };

  // Load locations from database
  const loadLocations = async () => {
    if (!database) return;

    try {
      const locs = await database.getAllAsync(
        "SELECT * FROM locations ORDER BY timestamp DESC LIMIT 20"
      );
      setLocations(locs);
      console.log(`Loaded ${locs.length} locations`);
    } catch (error) {
      console.error("Error loading locations:", error);
    }
  };

  // Load statistics
  const loadStats = async () => {
    if (!database) return;

    try {
      const statsData = await database.getAllAsync(`
        SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN synced = 1 THEN 1 ELSE 0 END) as synced,
          SUM(CASE WHEN synced = 0 THEN 1 ELSE 0 END) as pending
        FROM locations
      `);

      if (statsData && statsData.length > 0) {
        setStats(statsData[0]);
      }
    } catch (error) {
      console.error("Error loading stats:", error);
    }
  };

  // Refresh data
  const onRefresh = async () => {
    setRefreshing(true);
    await loadLocations();
    await loadStats();
    setRefreshing(false);
  };

  // Check and request permissions
  const checkPermissions = async () => {
    try {
      // Check foreground location permission
      let { status } = await Location.requestForegroundPermissionsAsync();
      setLocationPermission(status);

      if (status !== "granted") {
        Alert.alert(
          "Permission Denied",
          "Location permission is required for tracking"
        );
        return;
      }

      // Check background location permission (Android/iOS)
      if (Platform.OS === "android" || Platform.OS === "ios") {
        const bgStatus = await Location.requestBackgroundPermissionsAsync();
        setBackgroundPermission(bgStatus.status);

        if (bgStatus.status !== "granted") {
          Alert.alert(
            "Background Permission",
            "Background location permission is required for tracking when app is closed"
          );
        }
      }
    } catch (error) {
      console.error("Permission error:", error);
    }
  };

  // Setup network listener
  const setupNetworkListener = () => {
    NetInfo.addEventListener((state) => {
      setIsOnline(state.isConnected);

      if (state.isConnected) {
        // Try to sync when coming back online
        syncData();
      }
    });
  };

  // Log to database
  const logToDatabase = async (message, level = "info") => {
    if (!database) return;

    try {
      await database.runAsync(
        "INSERT INTO app_logs (message, level) VALUES (?, ?)",
        [message, level]
      );
      console.log(`[LOG:${level}] ${message}`);
    } catch (error) {
      console.error("Logging error:", error);
    }
  };

  // Start tracking
  const startTracking = async () => {
    if (!database) {
      Alert.alert("Error", "Database not initialized");
      return;
    }

    if (locationPermission !== "granted") {
      Alert.alert("Permission Required", "Location permission is required");
      return;
    }

    try {
      // Start foreground location updates
      await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
        accuracy: Location.Accuracy.Balanced,
        timeInterval: 40000, // 40 seconds
        distanceInterval: 10, // 10 meters
        foregroundService: {
          notificationTitle: "Location Tracking",
          notificationBody: "Tracking your location in background",
          notificationColor: "#FF0000",
        },
        showsBackgroundLocationIndicator: true,
      });

      // Register background fetch task for syncing
      await BackgroundFetch.registerTaskAsync(SYNC_TASK_NAME, {
        minimumInterval: 900, // 15 minutes minimum on iOS, but actual timing may vary
        stopOnTerminate: false,
        startOnBoot: true,
      });

      setIsTracking(true);
      await AsyncStorage.setItem("isTracking", "true");
      await logToDatabase("Tracking started");

      // Start test mode for UI updates
      startTestMode();

      Alert.alert("Success", "Location tracking started");
    } catch (error) {
      console.error("Start tracking error:", error);
      Alert.alert("Error", "Failed to start tracking: " + error.message);
    }
  };

  // Start test mode for UI updates
  const startTestMode = () => {
    setTestMode(true);

    // Clear any existing interval
    if (testInterval) clearInterval(testInterval);

    // Update UI every 5 seconds to show fresh data
    const interval = setInterval(() => {
      loadLocations();
      loadStats();
    }, 5000);

    setTestInterval(interval);
  };

  // Stop tracking
  const stopTracking = async () => {
    try {
      await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
      await BackgroundFetch.unregisterTaskAsync(SYNC_TASK_NAME);

      setIsTracking(false);
      await AsyncStorage.setItem("isTracking", "false");
      await logToDatabase("Tracking stopped");

      // Stop test mode
      setTestMode(false);
      if (testInterval) {
        clearInterval(testInterval);
        setTestInterval(null);
      }

      Alert.alert("Stopped", "Location tracking stopped");
    } catch (error) {
      console.error("Stop tracking error:", error);
    }
  };

  // Manual test location (for debugging)
  const testLocation = async () => {
    if (!database) return;

    try {
      const mockLocation = {
        coords: {
          latitude: 28.6139 + (Math.random() - 0.5) * 0.01,
          longitude: 77.209 + (Math.random() - 0.5) * 0.01,
          accuracy: 10,
          altitude: 200,
          speed: 5,
          heading: 90,
        },
        timestamp: Date.now(),
      };

      await saveLocation(mockLocation);
      await loadLocations();
      await loadStats();

      Alert.alert("Test", "Test location added successfully");
    } catch (error) {
      console.error("Test location error:", error);
    }
  };

  // Save location to database
  const saveLocation = async (location) => {
    if (!database) return;

    try {
      const result = await database.runAsync(
        `INSERT INTO locations 
        (latitude, longitude, accuracy, altitude, speed, heading, timestamp, synced) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          location.coords.latitude,
          location.coords.longitude,
          location.coords.accuracy,
          location.coords.altitude,
          location.coords.speed,
          location.coords.heading,
          location.timestamp,
          0, // not synced yet
        ]
      );

      // Add to sync queue
      await database.runAsync(
        "INSERT INTO sync_queue (table_name, record_id, operation) VALUES (?, ?, ?)",
        ["locations", result.lastInsertRowId, "INSERT"]
      );

      const message = `Location saved: ${location.coords.latitude.toFixed(
        6
      )}, ${location.coords.longitude.toFixed(6)}`;
      await logToDatabase(message);
      console.log(message);
    } catch (error) {
      console.error("Save location error:", error);
      await logToDatabase("Failed to save location: " + error.message, "error");
    }
  };

  // Sync data with server
  const syncData = async () => {
    if (!database || !isOnline) return;

    try {
      // Get unsynced locations
      const unsyncedLocations = await database.getAllAsync(
        "SELECT * FROM locations WHERE synced = 0 ORDER BY timestamp ASC LIMIT 100"
      );

      if (unsyncedLocations.length === 0) {
        await logToDatabase("No data to sync");
        Alert.alert("Sync", "No data to sync");
        return;
      }

      // Here you would send data to your backend
      // For now, we'll simulate successful sync
      const locationIds = unsyncedLocations.map((loc) => loc.id);

      // Mark as synced
      await database.runAsync(
        `UPDATE locations SET synced = 1 WHERE id IN (${locationIds.join(",")})`
      );

      // Remove from sync queue
      await database.runAsync(
        "DELETE FROM sync_queue WHERE table_name = ? AND record_id IN (?)",
        ["locations", locationIds.join(",")]
      );

      const message = `Synced ${unsyncedLocations.length} locations`;
      await logToDatabase(message);
      Alert.alert("Sync Successful", message);

      // Refresh UI
      await loadLocations();
      await loadStats();
    } catch (error) {
      console.error("Sync error:", error);
      await logToDatabase("Sync failed: " + error.message, "error");
      Alert.alert("Sync Failed", error.message);
    }
  };

  // Clear all data
  const clearDatabase = async () => {
    if (!database) return;

    Alert.alert(
      "Clear Database",
      "Are you sure you want to delete all location data?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear",
          style: "destructive",
          onPress: async () => {
            try {
              await database.execAsync(`
                DELETE FROM locations;
                DELETE FROM sync_queue;
                DELETE FROM app_logs;
              `);

              await logToDatabase("Database cleared");
              await loadLocations();
              await loadStats();
              Alert.alert("Success", "Database cleared successfully");
            } catch (error) {
              console.error("Clear database error:", error);
              Alert.alert("Error", "Failed to clear database");
            }
          },
        },
      ]
    );
  };

  // Format date for display
  const formatDate = (timestamp) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString();
  };

  // Format coordinates for display
  const formatCoords = (lat, lng) => {
    return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  };

  // Render location item
  const renderLocationItem = ({ item, index }) => (
    <View className="flex-row border-b border-gray-200 py-2">
      <View className="flex-1 px-1 justify-center">
        <Text className="text-xs text-center text-gray-800">{index + 1}</Text>
      </View>
      <View className="flex-1 px-1 justify-center">
        <Text className="text-xs text-center text-gray-800">
          {formatCoords(item.latitude, item.longitude)}
        </Text>
      </View>
      <View className="flex-1 px-1 justify-center">
        <Text className="text-xs text-center text-gray-800">
          {formatDate(item.timestamp)}
        </Text>
      </View>
      <View className="flex-1 px-1 justify-center">
        <View
          className={`w-6 h-6 rounded-full self-center justify-center items-center ${
            item.synced ? "bg-green-500" : "bg-red-500"
          }`}
        >
          <Text className="text-white font-bold text-xs">
            {item.synced ? "✓" : "●"}
          </Text>
        </View>
      </View>
    </View>
  );

  // Render table header
  const renderTableHeader = () => (
    <View className="flex-row bg-blue-500 rounded-t-lg py-2">
      <View className="flex-1 px-1">
        <Text className="text-white font-bold text-center text-xs">#</Text>
      </View>
      <View className="flex-1 px-1">
        <Text className="text-white font-bold text-center text-xs">
          Coordinates
        </Text>
      </View>
      <View className="flex-1 px-1">
        <Text className="text-white font-bold text-center text-xs">Time</Text>
      </View>
      <View className="flex-1 px-1">
        <Text className="text-white font-bold text-center text-xs">Sync</Text>
      </View>
    </View>
  );

  return (
    <ScrollView
      className="flex-1 bg-gray-50"
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
      }
    >
      {/* Header */}
      <Text className="text-2xl font-bold text-center mt-10 mb-5 text-gray-800">
        Mozility Tracker
      </Text>

      {/* Stats Bar */}
      <View className="flex-row bg-white mx-5 mb-5 rounded-xl p-4 shadow-sm border border-gray-100">
        <View className="flex-1 items-center">
          <Text className="text-2xl font-bold text-blue-500">
            {stats.total || 0}
          </Text>
          <Text className="text-xs text-gray-600 mt-1">Total</Text>
        </View>
        <View className="w-px bg-gray-200 mx-2" />
        <View className="flex-1 items-center">
          <Text className="text-2xl font-bold text-blue-500">
            {stats.synced || 0}
          </Text>
          <Text className="text-xs text-gray-600 mt-1">Synced</Text>
        </View>
        <View className="w-px bg-gray-200 mx-2" />
        <View className="flex-1 items-center">
          <Text className="text-2xl font-bold text-blue-500">
            {stats.pending || 0}
          </Text>
          <Text className="text-xs text-gray-600 mt-1">Pending</Text>
        </View>
      </View>

      {/* Status Panel */}
      <View className="bg-white mx-5 mb-5 rounded-xl p-4 shadow-sm border border-gray-100">
        <View className="flex-row justify-between items-center mb-2">
          <Text className="text-sm text-gray-600">Tracking:</Text>
          <View
            className={`px-3 py-1 rounded-full ${
              isTracking ? "bg-green-500" : "bg-red-500"
            }`}
          >
            <Text className="text-white text-sm font-medium">
              {isTracking ? "ACTIVE" : "INACTIVE"}
            </Text>
          </View>
        </View>
        <View className="flex-row justify-between items-center mb-2">
          <Text className="text-sm text-gray-600">Network:</Text>
          <View
            className={`px-3 py-1 rounded-full ${
              isOnline ? "bg-green-500" : "bg-orange-500"
            }`}
          >
            <Text className="text-white text-sm font-medium">
              {isOnline ? "ONLINE" : "OFFLINE"}
            </Text>
          </View>
        </View>
        <View className="flex-row justify-between items-center mb-2">
          <Text className="text-sm text-gray-600">Permission:</Text>
          <Text className="text-sm font-medium">
            {locationPermission === "granted" ? "✓ Granted" : "✗ Required"}
          </Text>
        </View>
        {testMode && (
          <View className="flex-row justify-between items-center">
            <Text className="text-sm text-gray-600">Test Mode:</Text>
            <Text className="text-sm font-medium text-purple-600 font-bold">
              ACTIVE (UI updates every 5s)
            </Text>
          </View>
        )}
      </View>

      {/* Control Buttons */}
      <View className="mx-5 mb-5">
        <View className="flex-row justify-between mb-2">
          <TouchableOpacity
            className={`flex-1 mr-1 rounded-lg py-3 ${
              isTracking || locationPermission !== "granted"
                ? "bg-gray-300"
                : "bg-green-500"
            }`}
            onPress={startTracking}
            disabled={isTracking || locationPermission !== "granted"}
          >
            <Text className="text-white text-center font-medium">
              Start Tracking
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            className={`flex-1 ml-1 rounded-lg py-3 ${
              !isTracking ? "bg-gray-300" : "bg-red-500"
            }`}
            onPress={stopTracking}
            disabled={!isTracking}
          >
            <Text className="text-white text-center font-medium">
              Stop Tracking
            </Text>
          </TouchableOpacity>
        </View>
        <View className="flex-row justify-between mb-2">
          <TouchableOpacity
            className={`flex-1 mr-1 rounded-lg py-3 ${
              !isOnline ? "bg-gray-300" : "bg-blue-500"
            }`}
            onPress={syncData}
            disabled={!isOnline}
          >
            <Text className="text-white text-center font-medium">Sync Now</Text>
          </TouchableOpacity>
          <TouchableOpacity
            className="flex-1 ml-1 rounded-lg py-3 bg-purple-500"
            onPress={testLocation}
          >
            <Text className="text-white text-center font-medium">
              Test Location
            </Text>
          </TouchableOpacity>
        </View>
        <View className="flex-row justify-between">
          <TouchableOpacity
            className="flex-1 mr-1 rounded-lg py-3 bg-orange-500"
            onPress={clearDatabase}
          >
            <Text className="text-white text-center font-medium">
              Clear Data
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            className="flex-1 ml-1 rounded-lg py-3 bg-gray-600"
            onPress={onRefresh}
          >
            <Text className="text-white text-center font-medium">Refresh</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Location Data Table */}
      <View className="bg-white mx-5 mb-5 rounded-xl p-4 shadow-sm border border-gray-100">
        <Text className="text-base font-bold mb-3 text-gray-800 text-center">
          Recent Locations ({locations.length})
          {testMode && " - Auto-refresh enabled"}
        </Text>

        {renderTableHeader()}

        {locations.length > 0 ? (
          <FlatList
            data={locations}
            renderItem={renderLocationItem}
            keyExtractor={(item) => item.id.toString()}
            scrollEnabled={false}
            initialNumToRender={10}
          />
        ) : (
          <View className="py-8 items-center">
            <Text className="text-base text-gray-600 mb-1">
              No location data yet
            </Text>
            <Text className="text-xs text-gray-500 text-center">
              Start tracking to capture locations every 40 seconds
            </Text>
          </View>
        )}

        <View className="mt-4 pt-3 border-t border-gray-200">
          <Text className="text-xs text-gray-600 text-center mb-1">
            Locations update every 40 seconds when tracking is active
          </Text>
          <Text className="text-xs text-gray-600 text-center">
            Green check = Synced, Red dot = Pending sync
          </Text>
        </View>
      </View>

      {/* Info Panel */}
      <View className="bg-blue-50 mx-5 mb-8 rounded-xl p-4 border border-blue-100">
        <Text className="text-xs text-blue-700 mb-1">
          📍 Tracking: Every 40 seconds when active
        </Text>
        <Text className="text-xs text-blue-700 mb-1">
          💾 Storage: SQLite database (offline capable)
        </Text>
        <Text className="text-xs text-blue-700 mb-1">
          🔄 Sync: Automatic when online, manual sync available
        </Text>
        <Text className="text-xs text-blue-700">
          📱 Background: Works even when app is closed
        </Text>
      </View>
    </ScrollView>
  );
}

// Define background location task
TaskManager.defineTask(
  LOCATION_TASK_NAME,
  async ({ data: { locations }, error }) => {
    if (error) {
      console.error("Location task error:", error);
      return;
    }

    if (locations && locations.length > 0) {
      const location = locations[0];
      console.log(
        `[BACKGROUND] Location captured: ${location.coords.latitude}, ${location.coords.longitude}`
      );

      // Get database instance
      const db = await SQLite.openDatabaseAsync("tracker.db");

      // Save location
      await db.runAsync(
        `INSERT INTO locations 
      (latitude, longitude, accuracy, altitude, speed, heading, timestamp, synced) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          location.coords.latitude,
          location.coords.longitude,
          location.coords.accuracy,
          location.coords.altitude,
          location.coords.speed,
          location.coords.heading,
          location.timestamp,
          0,
        ]
      );

      // Check network and sync if available
      const netInfo = await NetInfo.fetch();
      if (netInfo.isConnected) {
        console.log("[BACKGROUND] Network available, data saved");
      }
    }
  }
);

// Define background sync task
TaskManager.defineTask(SYNC_TASK_NAME, async () => {
  const netInfo = await NetInfo.fetch();

  if (netInfo.isConnected) {
    const db = await SQLite.openDatabaseAsync("tracker.db");
    console.log("[BACKGROUND SYNC] Running sync task");

    // Your sync logic here
    return BackgroundFetch.BackgroundFetchResult.NewData;
  }

  return BackgroundFetch.BackgroundFetchResult.NoData;
});