// @ts-check
import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for browser integration tests
 * 
 * This configuration is optimized for running in Docker containers,
 * particularly Ubuntu/Debian environments with proper browser support.
 */
export default defineConfig({
    // Test directory
    testDir: './test',

    // Global test configuration
    fullyParallel: false, // Run tests serially for better resource management
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: process.env.CI ? 1 : undefined,

    // Reporter configuration
    reporter: 'html',

    // Global test timeout
    timeout: 120 * 1000, // 2 minutes

    // Global expect timeout
    expect: {
        timeout: 30 * 1000, // 30 seconds
    },

    // Browser configuration
    use: {
        // Base URL for tests
        baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5173',

        // Browser context options
        headless: true,
        viewport: { width: 1280, height: 720 },
        ignoreHTTPSErrors: true,

        // Trace for debugging
        trace: 'on-first-retry',
    },

    // Browser projects
    projects: [
        {
            name: 'chromium',
            use: {
                ...devices['Desktop Chrome'],
                // Use Playwright's Chromium in Docker Ubuntu
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-web-security',
                    '--disable-features=VizDisplayCompositor',
                    '--disable-background-timer-throttling',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-renderer-backgrounding',
                    '--disable-gpu',
                    '--disable-software-rasterizer',
                ],
            },
        },
    ],

    // Web server configuration for serving the test application
    webServer: {
        command: 'npm run build && npm run start:cloud',
        url: 'http://localhost:5173',
        reuseExistingServer: !process.env.CI,
        timeout: 120 * 1000, // 2 minutes
    },
});
