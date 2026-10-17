import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        auth: 'auth/index.html',
        dashboard: 'dashboard/index.html',
        admin: 'admin/index.html',
        leadMagnet: 'lead-magnet/index.html'
      }
    }
  }
});
