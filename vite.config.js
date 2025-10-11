export default {
  build: {
    target: 'es2022'
  },
  optimizeDeps: {
    esbuildOptions: { target: 'es2022', supported: { bigint: true } }
  },
  server: {
    host: '0.0.0.0', // Allow external connections
    port: 5173, // Default Vite port
    open: false, // Don't automatically open browser
    cors: true // Enable CORS for cross-origin requests
  }
}
