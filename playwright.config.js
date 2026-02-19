import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 60000,
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.35, // force-directed layout is non-deterministic; we test rendering, not positions
    },
  },
  use: {
    baseURL: 'http://localhost:3333',
    viewport: { width: 1280, height: 800 },
    // WebGL needs real GPU context — use headed Chromium
    launchOptions: {
      args: ['--use-gl=angle', '--use-angle=swiftshader'],
    },
  },
  webServer: {
    command: 'npm run dev -- --host',
    port: 3333,
    reuseExistingServer: true,
    timeout: 15000,
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
