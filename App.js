import React, { useState, useEffect } from "react";
import { StyleSheet, View, Button, Alert, Text, Platform } from "react-native";
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

  // Initialize database
  useEffect(() => {
    initDatabase();
    checkPermissions();
    setupNetworkListener();
  }, []);

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
    } catch (error) {
      console.error("Database initialization error:", error);
    }
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
        timeInterval: 5000, // 5 seconds
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

      Alert.alert("Success", "Location tracking started");
    } catch (error) {
      console.error("Start tracking error:", error);
      Alert.alert("Error", "Failed to start tracking: " + error.message);
    }
  };

  // Stop tracking
  const stopTracking = async () => {
    try {
      await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
      await BackgroundFetch.unregisterTaskAsync(SYNC_TASK_NAME);

      setIsTracking(false);
      await AsyncStorage.setItem("isTracking", "false");
      await logToDatabase("Tracking stopped");

      Alert.alert("Stopped", "Location tracking stopped");
    } catch (error) {
      console.error("Stop tracking error:", error);
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

      await logToDatabase(
        `Location saved: ${location.coords.latitude}, ${location.coords.longitude}`
      );
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

      await logToDatabase(`Synced ${unsyncedLocations.length} locations`);
    } catch (error) {
      console.error("Sync error:", error);
      await logToDatabase("Sync failed: " + error.message, "error");
    }
  };

  // Get stats
  const getStats = async () => {
    if (!database) return { total: 0, synced: 0, pending: 0 };

    try {
      const stats = await database.getAllAsync(`
        SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN synced = 1 THEN 1 ELSE 0 END) as synced,
          SUM(CASE WHEN synced = 0 THEN 1 ELSE 0 END) as pending
        FROM locations
      `);

      return stats[0];
    } catch (error) {
      console.error("Get stats error:", error);
      return { total: 0, synced: 0, pending: 0 };
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Mozility Tracker</Text>

      <View style={styles.statusContainer}>
        <Text style={styles.statusText}>
          Tracking: {isTracking ? "ACTIVE" : "INACTIVE"}
        </Text>
        <Text style={styles.statusText}>
          Network: {isOnline ? "ONLINE" : "OFFLINE"}
        </Text>
        <Text style={styles.statusText}>
          Location Permission: {locationPermission || "Not checked"}
        </Text>
      </View>

      <View style={styles.buttonContainer}>
        <Button
          title="Start Tracking"
          onPress={startTracking}
          color="#4CAF50"
          disabled={isTracking || locationPermission !== "granted"}
        />

        <View style={styles.buttonSpacer} />

        <Button
          title="Stop Tracking"
          onPress={stopTracking}
          color="#F44336"
          disabled={!isTracking}
        />

        <View style={styles.buttonSpacer} />

        <Button
          title="Sync Now"
          onPress={syncData}
          color="#2196F3"
          disabled={!isOnline}
        />
      </View>

      <View style={styles.infoContainer}>
        <Text style={styles.infoText}>
          Note: App will track location even when closed or offline. Data will
          sync automatically when network is available.
        </Text>
      </View>
    </View>
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
        // You would implement sync logic here
        console.log("Background: Location saved and network available");
      }
    }
  }
);

// Define background sync task
TaskManager.defineTask(SYNC_TASK_NAME, async () => {
  const netInfo = await NetInfo.fetch();

  if (netInfo.isConnected) {
    const db = await SQLite.openDatabaseAsync("tracker.db");

    // Your sync logic here
    console.log("Background sync task running");

    return BackgroundFetch.BackgroundFetchResult.NewData;
  }

  return BackgroundFetch.BackgroundFetchResult.NoData;
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f5f5f5",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: "bold",
    marginBottom: 30,
    color: "#333",
  },
  statusContainer: {
    backgroundColor: "white",
    padding: 20,
    borderRadius: 10,
    marginBottom: 30,
    width: "100%",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  statusText: {
    fontSize: 16,
    marginBottom: 8,
    color: "#666",
  },
  buttonContainer: {
    width: "100%",
    marginBottom: 30,
  },
  buttonSpacer: {
    height: 15,
  },
  infoContainer: {
    backgroundColor: "#E3F2FD",
    padding: 15,
    borderRadius: 10,
    width: "100%",
  },
  infoText: {
    fontSize: 14,
    color: "#1976D2",
    textAlign: "center",
  },
});
