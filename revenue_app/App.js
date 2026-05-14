import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createMaterialTopTabNavigator } from '@react-navigation/material-top-tabs';
import { Home, Clock } from 'lucide-react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { View } from 'react-native';

import DashboardScreen from './screens/Dashboard';
import HistoryScreen from './screens/History';

const Tab = createMaterialTopTabNavigator();

function TabNavigator() {
  const insets = useSafeAreaInsets();
  
  return (
    <View style={{ flex: 1, paddingTop: insets.top, backgroundColor: 'white' }}>
      <Tab.Navigator
        screenOptions={({ route }) => ({
          tabBarIcon: ({ color }) => {
            const size = 20;
            if (route.name === 'Dashboard') {
              return <Home size={size} color={color} />;
            } else if (route.name === 'History') {
              return <Clock size={size} color={color} />;
            }
          },
          tabBarActiveTintColor: '#2563eb',
          tabBarInactiveTintColor: '#94a3b8',
          tabBarShowIcon: true,
          tabBarIndicatorStyle: { backgroundColor: '#2563eb' },
          tabBarStyle: {
            backgroundColor: 'white',
            elevation: 0,
            shadowOpacity: 0,
            borderBottomWidth: 1,
            borderBottomColor: '#e2e8f0',
          },
          tabBarLabelStyle: {
            fontSize: 12,
            fontWeight: 'bold',
            textTransform: 'none'
          }
        })}
      >
        <Tab.Screen 
          name="Dashboard" 
          component={DashboardScreen} 
          options={{ title: 'Thống kê' }} 
        />
        <Tab.Screen 
          name="History" 
          component={HistoryScreen} 
          options={{ title: 'Lịch sử' }} 
        />
      </Tab.Navigator>
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <NavigationContainer>
        <TabNavigator />
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
