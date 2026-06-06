import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.spacecanvas.fieldops',
  appName: 'Arlington Turf Live Ops',
  webDir: 'dist',
  backgroundColor: '#dbeafe',
  server: {
    androidScheme: 'https',
  },
  ios: {
    path: 'ios',
  },
  android: {
    path: 'android',
  },
};

export default config;
