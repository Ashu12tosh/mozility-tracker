import React, { useState, useEffect } from "react";
import {
  StyleSheet,
  View,
  Button,
  Alert,
  Text,
  Platform,
  FlatList,
  ScrollView,
  RefreshControl,
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
    <View style={styles.tableRow}>
      <View style={styles.tableCell}>
        <Text style={styles.cellText}>{index + 1}</Text>
      </View>
      <View style={styles.tableCell}>
        <Text style={styles.cellText}>
          {formatCoords(item.latitude, item.longitude)}
        </Text>
      </View>
      <View style={styles.tableCell}>
        <Text style={styles.cellText}>{formatDate(item.timestamp)}</Text>
      </View>
      <View style={styles.tableCell}>
        <View
          style={[
            styles.syncBadge,
            item.synced ? styles.syncedBadge : styles.pendingBadge,
          ]}
        >
          <Text style={styles.syncText}>{item.synced ? "✓" : "●"}</Text>
        </View>
      </View>
    </View>
  );

  // Render table header
  const renderTableHeader = () => (
    <View style={styles.tableHeader}>
      <View style={styles.tableCell}>
        <Text style={styles.headerText}>#</Text>
      </View>
      <View style={styles.tableCell}>
        <Text style={styles.headerText}>Coordinates</Text>
      </View>
      <View style={styles.tableCell}>
        <Text style={styles.headerText}>Time</Text>
      </View>
      <View style={styles.tableCell}>
        <Text style={styles.headerText}>Sync</Text>
      </View>
    </View>
  );

  return (
    <ScrollView
      style={styles.container}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
      }
    >
      <Text style={styles.title}>Mozility Tracker</Text>

      {/* Stats Bar */}
      <View style={styles.statsContainer}>
        <View style={styles.statItem}>
          <Text style={styles.statNumber}>{stats.total || 0}</Text>
          <Text style={styles.statLabel}>Total</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.statItem}>
          <Text style={styles.statNumber}>{stats.synced || 0}</Text>
          <Text style={styles.statLabel}>Synced</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.statItem}>
          <Text style={styles.statNumber}>{stats.pending || 0}</Text>
          <Text style={styles.statLabel}>Pending</Text>
        </View>
      </View>

      {/* Status Panel */}
      <View style={styles.statusContainer}>
        <View style={styles.statusRow}>
          <Text style={styles.statusLabel}>Tracking:</Text>
          <View
            style={[
              styles.statusIndicator,
              isTracking ? styles.activeIndicator : styles.inactiveIndicator,
            ]}
          >
            <Text style={styles.statusValue}>
              {isTracking ? "ACTIVE" : "INACTIVE"}
            </Text>
          </View>
        </View>
        <View style={styles.statusRow}>
          <Text style={styles.statusLabel}>Network:</Text>
          <View
            style={[
              styles.statusIndicator,
              isOnline ? styles.onlineIndicator : styles.offlineIndicator,
            ]}
          >
            <Text style={styles.statusValue}>
              {isOnline ? "ONLINE" : "OFFLINE"}
            </Text>
          </View>
        </View>
        <View style={styles.statusRow}>
          <Text style={styles.statusLabel}>Permission:</Text>
          <Text style={styles.statusValue}>
            {locationPermission === "granted" ? "✓ Granted" : "✗ Required"}
          </Text>
        </View>
        {testMode && (
          <View style={styles.statusRow}>
            <Text style={styles.statusLabel}>Test Mode:</Text>
            <Text style={[styles.statusValue, styles.testModeText]}>
              ACTIVE (UI updates every 5s)
            </Text>
          </View>
        )}
      </View>

      {/* Control Buttons */}
      <View style={styles.buttonContainer}>
        <View style={styles.buttonRow}>
          <Button
            title="Start Tracking"
            onPress={startTracking}
            color="#4CAF50"
            disabled={isTracking || locationPermission !== "granted"}
          />
          <Button
            title="Stop Tracking"
            onPress={stopTracking}
            color="#F44336"
            disabled={!isTracking}
          />
        </View>
        <View style={styles.buttonRow}>
          <Button
            title="Sync Now"
            onPress={syncData}
            color="#2196F3"
            disabled={!isOnline}
          />
          <Button
            title="Test Location"
            onPress={testLocation}
            color="#9C27B0"
          />
        </View>
        <View style={styles.buttonRow}>
          <Button title="Clear Data" onPress={clearDatabase} color="#FF9800" />
          <Button title="Refresh" onPress={onRefresh} color="#607D8B" />
        </View>
      </View>

      {/* Location Data Table */}
      <View style={styles.tableContainer}>
        <Text style={styles.tableTitle}>
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
          <View style={styles.emptyTable}>
            <Text style={styles.emptyText}>No location data yet</Text>
            <Text style={styles.emptySubText}>
              Start tracking to capture locations every 40 seconds
            </Text>
          </View>
        )}

        <View style={styles.tableFooter}>
          <Text style={styles.footerText}>
            Locations update every 40 seconds when tracking is active
          </Text>
          <Text style={styles.footerText}>
            Green check = Synced, Red dot = Pending sync
          </Text>
        </View>
      </View>

      {/* Info Panel */}
      <View style={styles.infoContainer}>
        <Text style={styles.infoText}>
          📍 Tracking: Every 40 seconds when active
        </Text>
        <Text style={styles.infoText}>
          💾 Storage: SQLite database (offline capable)
        </Text>
        <Text style={styles.infoText}>
          🔄 Sync: Automatic when online, manual sync available
        </Text>
        <Text style={styles.infoText}>
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f5f5f5",
  },
  title: {
    fontSize: 28,
    fontWeight: "bold",
    textAlign: "center",
    marginTop: 40,
    marginBottom: 20,
    color: "#333",
  },
  statsContainer: {
    flexDirection: "row",
    backgroundColor: "white",
    marginHorizontal: 20,
    marginBottom: 20,
    borderRadius: 10,
    padding: 15,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  statItem: {
    flex: 1,
    alignItems: "center",
  },
  statNumber: {
    fontSize: 28,
    fontWeight: "bold",
    color: "#2196F3",
  },
  statLabel: {
    fontSize: 12,
    color: "#666",
    marginTop: 5,
  },
  statDivider: {
    width: 1,
    backgroundColor: "#e0e0e0",
    marginHorizontal: 10,
  },
  statusContainer: {
    backgroundColor: "white",
    marginHorizontal: 20,
    marginBottom: 20,
    borderRadius: 10,
    padding: 15,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  statusRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  statusLabel: {
    fontSize: 14,
    color: "#666",
  },
  statusValue: {
    fontSize: 14,
    fontWeight: "500",
  },
  statusIndicator: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
  },
  activeIndicator: {
    backgroundColor: "#4CAF50",
  },
  inactiveIndicator: {
    backgroundColor: "#F44336",
  },
  onlineIndicator: {
    backgroundColor: "#4CAF50",
  },
  offlineIndicator: {
    backgroundColor: "#FF9800",
  },
  testModeText: {
    color: "#9C27B0",
    fontWeight: "bold",
  },
  buttonContainer: {
    marginHorizontal: 20,
    marginBottom: 20,
  },
  buttonRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  tableContainer: {
    backgroundColor: "white",
    marginHorizontal: 20,
    marginBottom: 20,
    borderRadius: 10,
    padding: 15,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  tableTitle: {
    fontSize: 16,
    fontWeight: "bold",
    marginBottom: 15,
    color: "#333",
    textAlign: "center",
  },
  tableHeader: {
    flexDirection: "row",
    backgroundColor: "#2196F3",
    borderTopLeftRadius: 5,
    borderTopRightRadius: 5,
    paddingVertical: 10,
  },
  tableRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#e0e0e0",
    paddingVertical: 8,
  },
  tableCell: {
    flex: 1,
    paddingHorizontal: 5,
    justifyContent: "center",
  },
  headerText: {
    color: "white",
    fontWeight: "bold",
    textAlign: "center",
    fontSize: 12,
  },
  cellText: {
    fontSize: 11,
    textAlign: "center",
    color: "#333",
  },
  syncBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignSelf: "center",
    justifyContent: "center",
    alignItems: "center",
  },
  syncedBadge: {
    backgroundColor: "#4CAF50",
  },
  pendingBadge: {
    backgroundColor: "#F44336",
  },
  syncText: {
    color: "white",
    fontWeight: "bold",
    fontSize: 12,
  },
  emptyTable: {
    padding: 30,
    alignItems: "center",
  },
  emptyText: {
    fontSize: 16,
    color: "#666",
    marginBottom: 5,
  },
  emptySubText: {
    fontSize: 12,
    color: "#999",
    textAlign: "center",
  },
  tableFooter: {
    marginTop: 15,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: "#e0e0e0",
  },
  footerText: {
    fontSize: 10,
    color: "#666",
    textAlign: "center",
    marginBottom: 3,
  },
  infoContainer: {
    backgroundColor: "#E3F2FD",
    marginHorizontal: 20,
    marginBottom: 30,
    borderRadius: 10,
    padding: 15,
  },
  infoText: {
    fontSize: 12,
    color: "#1976D2",
    marginBottom: 5,
  },
});
