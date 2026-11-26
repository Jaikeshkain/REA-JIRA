import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// The API port comes from the server's .env (API_PORT), so both sides agree.
export default defineConfig(({ mode }) => {
  const server = loadEnv(mode, '../server', '');
  const apiPort = process.env.API_PORT || server.API_PORT || '4000';
  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: { '/api': `http://127.0.0.1:${apiPort}` },
    },
  };
});
