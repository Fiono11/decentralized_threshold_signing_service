#!/usr/bin/env node

/**
 * Cloud deployment startup script
 * Runs both the relay server and Vite dev server concurrently
 */

import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
}

const log = (color, label, message) => {
  const timestamp = new Date().toISOString()
  console.log(`${color}[${timestamp}] [${label}]${colors.reset} ${message}`)
}

// Start relay server
const relayProcess = spawn('node', ['relay.js'], {
  cwd: __dirname,
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'production' }
})

relayProcess.on('error', (error) => {
  log(colors.red, 'RELAY', `Failed to start: ${error.message}`)
  process.exit(1)
})

relayProcess.on('exit', (code) => {
  if (code !== 0 && code !== null) {
    log(colors.red, 'RELAY', `Exited with code ${code}`)
    process.exit(code)
  }
})

// Start Vite dev server
const viteProcess = spawn('npm', ['run', 'start:cloud'], {
  cwd: __dirname,
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'development' }
})

viteProcess.on('error', (error) => {
  log(colors.red, 'VITE', `Failed to start: ${error.message}`)
  relayProcess.kill()
  process.exit(1)
})

viteProcess.on('exit', (code) => {
  if (code !== 0 && code !== null) {
    log(colors.red, 'VITE', `Exited with code ${code}`)
    relayProcess.kill()
    process.exit(code)
  }
})

// Handle process termination
const shutdown = () => {
  log(colors.yellow, 'SHUTDOWN', 'Shutting down services...')
  relayProcess.kill()
  viteProcess.kill()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// Log startup
log(colors.green, 'STARTUP', 'Starting relay server and Vite dev server...')
log(colors.cyan, 'INFO', 'Relay server will run on port 8080')
log(colors.cyan, 'INFO', 'Vite dev server will run on port 5173 (or VITE_PORT if set)')
log(colors.cyan, 'INFO', 'Access the application at http://<your-server-ip>:5173')

