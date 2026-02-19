import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    server: {
      port: 3333,
      open: true,
      proxy: {
        // Proxy /api → beads daemon (avoids CORS)
        '/api': {
          target: env.VITE_BD_API_URL || 'http://localhost:9080',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ''),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              if (env.VITE_BD_TOKEN) {
                proxyReq.setHeader('Authorization', `Bearer ${env.VITE_BD_TOKEN}`);
              }
            });
          },
        },
      },
    },
  };
});
