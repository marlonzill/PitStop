import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'br.com.pitstopsports.app',
  appName: 'PitStop-Sports',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  android: {
    backgroundColor: '#070B12',
    allowMixedContent: false,
  },
};

export default config;
