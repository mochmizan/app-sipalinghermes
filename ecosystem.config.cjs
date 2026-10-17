module.exports = {
  apps: [
    {
      name: 'sipalinghermes-app',
      script: 'server.mjs',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT: 5173,
        POSTHOG_API_KEY: 'phs_REPLACE_VIA_ENVIRONMENT'
      }
    }
  ]
};
