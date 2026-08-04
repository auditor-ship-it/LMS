import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Own port, own backend (see src/shared/auth/client.js's VITE_API_URL) —
    // genuinely independent of the other apps' dev servers/ports/processes.
    port: 3001
  }
});
