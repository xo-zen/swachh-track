import type { ExpoConfig } from 'expo/config';

const config: ExpoConfig = {
  name: 'Swachh-Track Collector',
  slug: 'swachh-track-collector',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'light',
  newArchEnabled: true,
  android: {
    package: 'in.swachhtrack.collector',
    versionCode: 1,
    allowBackup: false,
    permissions: ['CAMERA', 'ACCESS_COARSE_LOCATION', 'ACCESS_FINE_LOCATION'],
    blockedPermissions: ['android.permission.RECORD_AUDIO'],
  },
  plugins: [
    ['expo-camera', { cameraPermission: 'Photograph pickup evidence and scan property QR codes.', recordAudioAndroid: false }],
    ['expo-location', { locationWhenInUsePermission: 'Record the pickup location, accuracy and time.' }],
    'expo-sqlite',
    ['expo-secure-store', { configureAndroidBackup: true }],
  ],
};

export default config;
