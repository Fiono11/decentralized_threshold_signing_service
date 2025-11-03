export default {
  build: {
    target: 'es2022'
  },
  optimizeDeps: {
    esbuildOptions: { target: 'es2022', supported: { bigint: true } }
  },
  server: {
    host: '0.0.0.0', // Allow external connections
    port: process.env.VITE_PORT ? parseInt(process.env.VITE_PORT) : 5173, // Use VITE_PORT env var or default to 5173
    open: false, // Don't automatically open browser
    cors: true // Enable CORS for cross-origin requests
  }
}
