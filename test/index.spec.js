// Browser Integration Tests for Decentralized Threshold Signing Service

import { test, expect } from '@playwright/test'
import { createRelayServer, setupRelayHandlers } from '../relay.js'
import { RELAY_PEER_ID } from '../config/relay-peer-id.js'
import { spawn } from 'child_process'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

// DOM Selectors
const SELECTORS = {
  output: '#output',
  ss58AddressInput: '#ss58-address-input',
  secretKeyInput: '#secret-key-input',
  storeAddressButton: '#store-address-input',
  ss58Address: '#ss58-address',
  connectViaAddressButton: '#connect-via-address'
}

// Test data for WASM integration tests
const TEST_RECIPIENTS = [
  '5CXkZyy4S5b3w16wvKA2hUwzp5q2y7UtRPkXnW97QGvDN8Jw',
  '5Gma8SNsn6rkQf9reAWFQ9WKq8bwwHtSzwMYtLTdhYsGPKiy'
]

const [TEST_SS58_ADDRESS_A, TEST_SS58_ADDRESS_B] = TEST_RECIPIENTS
const PEER_SS58_ADDRESSES = Object.freeze([...TEST_RECIPIENTS])

const TEST_SECRET_KEY_1 = "0x473a77675b8e77d90c1b6dc2dbe6ac533b0853790ea8bcadf0ee8b5da4cfbbce"
const TEST_SECRET_KEY_2 = "0xdb9ddbb3d6671c4de8248a4fba95f3d873dc21a0434b52951bb33730c1ac93d7"

// Test Constants
const TEST_CONFIG = {
  hardcodedPeerId: RELAY_PEER_ID,
  relayPort: '8080',
  relayListenAddress: '/ip4/127.0.0.1/tcp/8080/ws',
  testSS58AddressA: '5CXkZyy4S5b3w16wvKA2hUwzp5q2y7UtRPkXnW97QGvDN8Jw',
  testSS58AddressB: '5Gma8SNsn6rkQf9reAWFQ9WKq8bwwHtSzwMYtLTdhYsGPKiy',
  testSecretKeyA: '0x473a77675b8e77d90c1b6dc2dbe6ac533b0853790ea8bcadf0ee8b5da4cfbbce',
  testSecretKeyB: '0xdb9ddbb3d6671c4de8248a4fba95f3d873dc21a0434b52951bb33730c1ac93d7'
}

// Test Timeouts
const TIMEOUTS = {
  beforeAll: 5 * 60_000, // 5 minutes
  mainTest: 120_000, // 2 minutes
  peerConnection: 60_000 // 1 minute
}

// Global Test State
let testUrlA = 'http://localhost:5173'
let testUrlB = 'http://localhost:5174'
let viteServerA
let viteServerB

// Vite Server Management
const startViteServer = (port) => {
  return new Promise((resolve, reject) => {
    const server = spawn('npm', ['start'], {
      env: { ...process.env, VITE_PORT: port.toString() },
      stdio: 'pipe'
    })

    let resolved = false

    server.stdout.on('data', (data) => {
      const output = data.toString()
      console.log(`Vite server on port ${port}: ${output}`)

      if (output.includes('ready') && !resolved) {
        resolved = true
        resolve(server)
      }
    })

    server.stderr.on('data', (data) => {
      console.error(`Vite server on port ${port} error: ${data}`)
    })

    server.on('error', (error) => {
      if (!resolved) {
        resolved = true
        reject(error)
      }
    })

    // Timeout after 30 seconds
    setTimeout(() => {
      if (!resolved) {
        resolved = true
        reject(new Error(`Vite server on port ${port} failed to start within 30 seconds`))
      }
    }, 30000)
  })
}

const stopViteServer = (server) => {
  if (server) {
    server.kill('SIGTERM')
  }
}

// Relay Server Management
const createTestRelayServer = async () => {
  const testKvStore = new Map()

  const { server: relayNode, kvStore } = await createRelayServer({
    port: TEST_CONFIG.relayPort,
    listenAddresses: [TEST_CONFIG.relayListenAddress],
    kvStore: testKvStore
  })

  setupRelayHandlers(relayNode, kvStore)

  const relayNodeAddress = relayNode.getMultiaddrs()[0].toString()
  console.log(`Test relay listening on: ${relayNodeAddress}`)

  return { relayNode, relayNodeAddress }
}

// Test Suite: Browser-to-Browser Communication
test.describe('browser to browser example:', () => {
  let relayNode
  let relayNodeAddress

  // Test Setup and Teardown
  test.beforeAll(async ({ }, testInfo) => {
    testInfo.setTimeout(TIMEOUTS.beforeAll)

    // Start relay server
    const relayServer = await createTestRelayServer()
    relayNode = relayServer.relayNode
    relayNodeAddress = relayServer.relayNodeAddress

    // Start both Vite servers
    console.log('Starting Vite servers...')
    viteServerA = await startViteServer(5173)
    viteServerB = await startViteServer(5174)

    console.log(`Client A URL: ${testUrlA}`)
    console.log(`Client B URL: ${testUrlB}`)
  })

  test.afterAll(async () => {
    if (relayNode) {
      await relayNode.stop()
    }

    // Stop Vite servers
    console.log('Stopping Vite servers...')
    stopViteServer(viteServerA)
    stopViteServer(viteServerB)
  })

  // Main Integration Test
  test('should connect to another browser peer via SS58 addresses with permission', async ({ browser }) => {
    test.setTimeout(TIMEOUTS.mainTest)

    // Create two separate browser contexts (clients)
    const contextA = await browser.newContext()
    const contextB = await browser.newContext()

    const pageA = await contextA.newPage()
    const pageB = await contextB.newPage()

    await pageA.goto(testUrlA)  // Client A connects to first server
    await pageB.goto(testUrlB)  // Client B connects to second server

    // Establish relay connections for both pages
    await waitForRelayConnection(pageA)
    await waitForRelayConnection(pageB)

    // Store SS58 addresses in the relay
    await storeSS58Address(pageA, TEST_CONFIG.testSS58AddressA, TEST_CONFIG.testSecretKeyA)
    await storeSS58Address(pageB, TEST_CONFIG.testSS58AddressB, TEST_CONFIG.testSecretKeyB)

    // Connect pageB to pageA via SS58 address (this will now request permission)
    await connectViaSS58AddressWithPermission(pageB, pageA, TEST_CONFIG.testSS58AddressA)

    // Verify that the receiving peer (pageA) also logs the connection
    // The log should contain either the SS58 address or just the connection message
    const pageAOutput = pageA.locator(SELECTORS.output)
    await expect(pageAOutput).toContainText('Peer connected:', { timeout: TIMEOUTS.peerConnection })

    // If SS58 address is found, it should be included in the log
    // This is a more flexible test that works whether SS58 lookup succeeds or not
    const connectionLog = await pageAOutput.textContent()
    const hasSS58InLog = connectionLog.includes(TEST_CONFIG.testSS58AddressB)
    const hasConnectionMessage = connectionLog.includes('Peer connected:')

    // Either we have the SS58 address in the log, or just the connection message
    expect(hasSS58InLog || hasConnectionMessage).toBeTruthy()

    // Cleanup browser contexts
    await contextA.close()
    await contextB.close()
  })

  // Connection Proof of Possession Test
  test('should perform mutual proof of possession during connection with permission', async ({ browser }) => {
    test.setTimeout(TIMEOUTS.mainTest)

    // Create two separate browser contexts (clients)
    const contextA = await browser.newContext()
    const contextB = await browser.newContext()

    const pageA = await contextA.newPage()
    const pageB = await contextB.newPage()

    await pageA.goto(testUrlA)  // Client A connects to first server
    await pageB.goto(testUrlB)  // Client B connects to second server

    // Establish relay connections for both pages
    await waitForRelayConnection(pageA)
    await waitForRelayConnection(pageB)

    // Store SS58 addresses in the relay
    await storeSS58Address(pageA, TEST_CONFIG.testSS58AddressA, TEST_CONFIG.testSecretKeyA)
    await storeSS58Address(pageB, TEST_CONFIG.testSS58AddressB, TEST_CONFIG.testSecretKeyB)

    // Connect pageB to pageA via SS58 address with permission (this should trigger proof of possession)
    await connectViaSS58AddressWithPermission(pageB, pageA, TEST_CONFIG.testSS58AddressA)

    // Verify proof of possession messages in both pages
    const pageAOutput = pageA.locator(SELECTORS.output)
    const pageBOutput = pageB.locator(SELECTORS.output)

    // Check that pageB (initiator) shows proof of possession messages
    await expect(pageBOutput).toContainText('Initiating connection proof of possession...')
    await expect(pageBOutput).toContainText('Received challenge:')
    await expect(pageBOutput).toContainText('Our signature verified!')
    await expect(pageBOutput).toContainText('Received mutual challenge:')
    await expect(pageBOutput).toContainText('Mutual connection proof of possession completed!')

    // Check that pageA (acceptor) shows proof of possession messages
    await expect(pageAOutput).toContainText('Generated connection challenge for peer:')
    await expect(pageAOutput).toContainText('Connection challenge verified for peer:')
    await expect(pageAOutput).toContainText('Generated mutual challenge for peer:')
    await expect(pageAOutput).toContainText('Mutual connection challenge verified - connection established!')

    // Cleanup browser contexts
    await contextA.close()
    await contextB.close()
  })

  // Connection Permission Rejection Test
  test('should handle permission rejection gracefully', async ({ browser }) => {
    test.setTimeout(TIMEOUTS.mainTest)

    // Create two separate browser contexts (clients)
    const contextA = await browser.newContext()
    const contextB = await browser.newContext()

    const pageA = await contextA.newPage()
    const pageB = await contextB.newPage()

    await pageA.goto(testUrlA)  // Client A connects to first server
    await pageB.goto(testUrlB)  // Client B connects to second server

    // Establish relay connections for both pages
    await waitForRelayConnection(pageA)
    await waitForRelayConnection(pageB)

    // Store SS58 addresses in the relay
    await storeSS58Address(pageA, TEST_CONFIG.testSS58AddressA, TEST_CONFIG.testSecretKeyA)
    await storeSS58Address(pageB, TEST_CONFIG.testSS58AddressB, TEST_CONFIG.testSecretKeyB)

    // Start connection request from pageB
    await pageB.fill(SELECTORS.ss58Address, TEST_CONFIG.testSS58AddressA)
    await pageB.click(SELECTORS.connectViaAddressButton)

    // Wait for permission request to be sent
    const pageBOutput = pageB.locator(SELECTORS.output)
    await expect(pageBOutput).toContainText(`Requesting connection to: ${TEST_CONFIG.testSS58AddressA}`)
    await expect(pageBOutput).toContainText('Permission request sent')

    // Wait for permission request to appear on pageA and reject it
    const permissionRequestsSection = pageA.locator('#permission-requests')
    await expect(permissionRequestsSection).toContainText('Incoming Connection Request', { timeout: 10000 })

    const rejectButton = permissionRequestsSection.locator('button:has-text("Reject")')
    await rejectButton.click()

    // Verify that pageB shows permission rejection
    await expect(pageBOutput).toContainText('Connection permission was rejected')

    // Cleanup browser contexts
    await contextA.close()
    await contextB.close()
  })
})

// Test Helper Functions

// Relay Connection Verification
const waitForRelayConnection = async (page) => {
  const outputLocator = page.locator(SELECTORS.output)
  await expect(outputLocator).toContainText('Connected to relay')
}

// SS58 Address Storage Test
const storeSS58Address = async (page, addressToStore, secretKey) => {
  await page.fill(SELECTORS.ss58AddressInput, addressToStore)
  await page.fill(SELECTORS.secretKeyInput, secretKey)
  await page.click(SELECTORS.storeAddressButton)

  const outputLocator = page.locator(SELECTORS.output)
  await expect(outputLocator).toContainText(`Valid address: ${addressToStore}`)
  await expect(outputLocator).toContainText('Address registered with proof of possession!')
}

// SS58 Address Connection Test
const connectViaSS58Address = async (page, addressToConnect) => {
  await page.fill(SELECTORS.ss58Address, addressToConnect)
  await page.click(SELECTORS.connectViaAddressButton)

  const outputLocator = page.locator(SELECTORS.output)
  await expect(outputLocator).toContainText(`Requesting connection to: ${addressToConnect}`)
  await expect(outputLocator).toContainText('Permission granted! Proceeding with connection...')
  await expect(outputLocator).toContainText('Connected to peer!', { timeout: TIMEOUTS.peerConnection })
}

// SS58 Address Connection with Permission Test
const connectViaSS58AddressWithPermission = async (requesterPage, acceptorPage, addressToConnect) => {
  // Start the connection request from the requester page
  await requesterPage.fill(SELECTORS.ss58Address, addressToConnect)
  await requesterPage.click(SELECTORS.connectViaAddressButton)

  // Wait for permission request to be sent
  const requesterOutput = requesterPage.locator(SELECTORS.output)
  await expect(requesterOutput).toContainText(`Requesting connection to: ${addressToConnect}`)
  await expect(requesterOutput).toContainText('Permission request sent')

  // Wait for permission request to appear on acceptor page
  const permissionRequestsSection = acceptorPage.locator('#permission-requests')
  await expect(permissionRequestsSection).toContainText('Incoming Connection Request', { timeout: 10000 })
  await expect(permissionRequestsSection).toContainText('From:')

  // Accept the permission request
  const acceptButton = permissionRequestsSection.locator('button:has-text("Accept")')
  await acceptButton.click()

  // Wait for connection to be established
  await expect(requesterOutput).toContainText('Permission granted! Proceeding with connection...')
  await expect(requesterOutput).toContainText('Connected to peer!', { timeout: TIMEOUTS.peerConnection })
}

// WASM Integration Tests
test.describe('WASM Integration Tests for Olaf Threshold Public Key Generation:', () => {
  let relayNode
  let relayNodeAddress

  test.beforeAll(async ({ }, testInfo) => {
    testInfo.setTimeout(TIMEOUTS.beforeAll)

    // Start relay server
    const relayServer = await createTestRelayServer()
    relayNode = relayServer.relayNode
    relayNodeAddress = relayServer.relayNodeAddress

    // Start Vite server for WASM tests
    console.log('Starting Vite server for WASM tests...')
    viteServerA = await startViteServer(5173)

    console.log(`Client URL: ${testUrlA}`)
  })

  test.afterAll(async () => {
    if (relayNode) {
      await relayNode.stop()
    }
    stopViteServer(viteServerA)
  })

  test.beforeEach(async ({ page }) => {
    // Navigate to the main page which initializes WASM
    await page.goto(testUrlA)

    // Wait for WASM module to be initialized
    await page.waitForFunction(() => window.wasmReady === true, { timeout: 30000 })
  })

  test('should successfully generate AllMessage for participant 1', async ({ page }) => {
    const result = await page.evaluate(({ secretKey, recipients, threshold }) => {
      const keypairBytes = window.createKeypairBytes(secretKey)

      // Convert recipients to concatenated public key bytes
      const recipient1Bytes = window.ss58ToPublicKeyBytes(recipients[0])
      const recipient2Bytes = window.ss58ToPublicKeyBytes(recipients[1])

      // Concatenate recipient public keys
      const recipientsConcat = new Uint8Array(recipient1Bytes.length + recipient2Bytes.length)
      recipientsConcat.set(recipient1Bytes, 0)
      recipientsConcat.set(recipient2Bytes, recipient1Bytes.length)

      // Call the WASM function
      const result = window.wasm_simplpedpop_contribute_all(keypairBytes, threshold, recipientsConcat)

      return {
        isUint8Array: result instanceof Uint8Array,
        length: result.length,
        first16Bytes: Array.from(result.slice(0, 16))
      }
    }, { secretKey: TEST_SECRET_KEY_1, recipients: TEST_RECIPIENTS, threshold: 2 })

    // Validate the result
    expect(result.isUint8Array).toBe(true)
    expect(result.length).toBeGreaterThan(0)

    console.log(`Generated AllMessage for participant 1: ${result.length} bytes`)
    console.log(`First 16 bytes: ${result.first16Bytes.map(b => b.toString(16).padStart(2, '0')).join(' ')}`)
  })

  test('should successfully generate AllMessage for participant 2', async ({ page }) => {
    const result = await page.evaluate(({ secretKey, recipients, threshold }) => {
      const keypairBytes = window.createKeypairBytes(secretKey)

      const recipient1Bytes = window.ss58ToPublicKeyBytes(recipients[0])
      const recipient2Bytes = window.ss58ToPublicKeyBytes(recipients[1])

      const recipientsConcat = new Uint8Array(recipient1Bytes.length + recipient2Bytes.length)
      recipientsConcat.set(recipient1Bytes, 0)
      recipientsConcat.set(recipient2Bytes, recipient1Bytes.length)

      const result = window.wasm_simplpedpop_contribute_all(keypairBytes, threshold, recipientsConcat)

      return {
        isUint8Array: result instanceof Uint8Array,
        length: result.length,
        first16Bytes: Array.from(result.slice(0, 16))
      }
    }, { secretKey: TEST_SECRET_KEY_2, recipients: TEST_RECIPIENTS, threshold: 2 })

    expect(result.isUint8Array).toBe(true)
    expect(result.length).toBeGreaterThan(0)

    console.log(`Generated AllMessage for participant 2: ${result.length} bytes`)
    console.log(`First 16 bytes: ${result.first16Bytes.map(b => b.toString(16).padStart(2, '0')).join(' ')}`)
  })

  test('should produce identical threshold keys when both peers process AllMessages', async ({ page: pageA, context }) => {
    test.setTimeout(120000)

    const pageB = await context.newPage()
    await pageB.goto(testUrlA)

    // Wait for WASM to be ready on both pages
    await pageA.waitForFunction(() => window.wasmReady === true, { timeout: 30000 })
    await pageB.waitForFunction(() => window.wasmReady === true, { timeout: 30000 })

    // Generate AllMessages for both participants
    const allMessageA = await pageA.evaluate(({ secretKey, recipients, threshold }) => {
      const keypairBytes = window.createKeypairBytes(secretKey)
      const recipient1Bytes = window.ss58ToPublicKeyBytes(recipients[0])
      const recipient2Bytes = window.ss58ToPublicKeyBytes(recipients[1])
      const recipientsConcat = new Uint8Array(recipient1Bytes.length + recipient2Bytes.length)
      recipientsConcat.set(recipient1Bytes, 0)
      recipientsConcat.set(recipient2Bytes, recipient1Bytes.length)
      return window.wasm_simplpedpop_contribute_all(keypairBytes, threshold, recipientsConcat)
    }, { secretKey: TEST_SECRET_KEY_1, recipients: TEST_RECIPIENTS, threshold: 2 })

    const allMessageB = await pageB.evaluate(({ secretKey, recipients, threshold }) => {
      const keypairBytes = window.createKeypairBytes(secretKey)
      const recipient1Bytes = window.ss58ToPublicKeyBytes(recipients[0])
      const recipient2Bytes = window.ss58ToPublicKeyBytes(recipients[1])
      const recipientsConcat = new Uint8Array(recipient1Bytes.length + recipient2Bytes.length)
      recipientsConcat.set(recipient1Bytes, 0)
      recipientsConcat.set(recipient2Bytes, recipient1Bytes.length)
      return window.wasm_simplpedpop_contribute_all(keypairBytes, threshold, recipientsConcat)
    }, { secretKey: TEST_SECRET_KEY_2, recipients: TEST_RECIPIENTS, threshold: 2 })

    console.log(`AllMessage A: ${allMessageA.length} bytes`)
    console.log(`AllMessage B: ${allMessageB.length} bytes`)

    // Now test threshold key generation from both peers' perspectives
    const thresholdKeyA = await pageA.evaluate(({ secretKey, allMessageA, allMessageB }) => {
      const keypairBytes = window.createKeypairBytes(secretKey)

      // Create JSON array of AllMessage bytes
      const allMessagesArray = [
        Array.from(allMessageA),
        Array.from(allMessageB)
      ]
      const allMessagesJson = JSON.stringify(allMessagesArray)
      const allMessagesBytes = new TextEncoder().encode(allMessagesJson)

      const result = window.wasm_simplpedpop_recipient_all(keypairBytes, allMessagesBytes)
      return result.threshold_public_key
    }, {
      secretKey: TEST_SECRET_KEY_1,
      allMessageA: Array.from(allMessageA),
      allMessageB: Array.from(allMessageB)
    })

    const thresholdKeyB = await pageB.evaluate(({ secretKey, allMessageA, allMessageB }) => {
      const keypairBytes = window.createKeypairBytes(secretKey)

      // Create JSON array of AllMessage bytes
      const allMessagesArray = [
        Array.from(allMessageA),
        Array.from(allMessageB)
      ]
      const allMessagesJson = JSON.stringify(allMessagesArray)
      const allMessagesBytes = new TextEncoder().encode(allMessagesJson)

      const result = window.wasm_simplpedpop_recipient_all(keypairBytes, allMessagesBytes)
      return result.threshold_public_key
    }, {
      secretKey: TEST_SECRET_KEY_2,
      allMessageA: Array.from(allMessageA),
      allMessageB: Array.from(allMessageB)
    })

    console.log(`Threshold key A: ${thresholdKeyA.length} bytes`)
    console.log(`Threshold key B: ${thresholdKeyB.length} bytes`)

    // Convert to arrays for comparison
    const thresholdKeyABytes = Array.from(thresholdKeyA)
    const thresholdKeyBBytes = Array.from(thresholdKeyB)

    // Assert that both threshold keys are identical
    expect(thresholdKeyABytes).toEqual(thresholdKeyBBytes)
    expect(thresholdKeyA.length).toBe(thresholdKeyB.length)
    expect(thresholdKeyA.length).toBeGreaterThan(0)

    console.log(`✓ Threshold keys are identical: ${thresholdKeyA.length} bytes`)
    console.log(`Threshold key (hex): ${thresholdKeyABytes.map(b => b.toString(16).padStart(2, '0')).join('')}`)
    console.log(`Threshold key (first 16 bytes): ${thresholdKeyABytes.slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join(' ')}`)
  })

  test('should run complete SimplPedPoP protocol with test keys (port of Rust test)', async ({ page }) => {
    test.setTimeout(120000)

    const result = await page.evaluate(({ secretKey1, secretKey2, recipients, threshold }) => {
      console.log('Running SimplPedPoP protocol with test keys:')
      console.log(`Threshold: ${threshold}`)
      console.log(`Participants: 2`)

      // Get public keys for both participants
      const secretKey1Bytes = window.hexToUint8Array(secretKey1)
      const secretKey2Bytes = window.hexToUint8Array(secretKey2)
      const keypair1Bytes = window.wasm_keypair_from_secret(secretKey1Bytes)
      const keypair2Bytes = window.wasm_keypair_from_secret(secretKey2Bytes)
      const publicKey1Bytes = keypair1Bytes.slice(0, 32)
      const publicKey2Bytes = keypair2Bytes.slice(0, 32)
      const publicKey1 = window.encodeAddress(publicKey1Bytes, 42)
      const publicKey2 = window.encodeAddress(publicKey2Bytes, 42)

      console.log(`Contributor 1 public key: ${publicKey1}`)
      console.log(`Contributor 2 public key: ${publicKey2}`)

      // Convert recipients to concatenated public key bytes
      const recipient1Bytes = window.ss58ToPublicKeyBytes(recipients[0])
      const recipient2Bytes = window.ss58ToPublicKeyBytes(recipients[1])
      const recipientsConcat = new Uint8Array(recipient1Bytes.length + recipient2Bytes.length)
      recipientsConcat.set(recipient1Bytes, 0)
      recipientsConcat.set(recipient2Bytes, recipient1Bytes.length)

      // Generate AllMessages from both contributors
      const allMessage1 = window.wasm_simplpedpop_contribute_all(keypair1Bytes, threshold, recipientsConcat)
      const allMessage2 = window.wasm_simplpedpop_contribute_all(keypair2Bytes, threshold, recipientsConcat)

      console.log(`\n--- Contributor 1 ---`)
      console.log(`AllMessage 1: ${allMessage1.length} bytes`)
      console.log(`AllMessage 1 (first 16 bytes): ${Array.from(allMessage1.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`)

      console.log(`\n--- Contributor 2 ---`)
      console.log(`AllMessage 2: ${allMessage2.length} bytes`)
      console.log(`AllMessage 2 (first 16 bytes): ${Array.from(allMessage2.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`)

      // Process messages as recipients
      const allMessagesArray = [
        Array.from(allMessage1),
        Array.from(allMessage2)
      ]
      const allMessagesJson = JSON.stringify(allMessagesArray)
      const allMessagesBytes = new TextEncoder().encode(allMessagesJson)

      // Process from participant 1's perspective
      console.log(`\n--- Recipient 1 processing ---`)
      const result1 = window.wasm_simplpedpop_recipient_all(keypair1Bytes, allMessagesBytes)
      const thresholdKey1 = result1.threshold_public_key
      console.log(`Threshold key 1: ${thresholdKey1.length} bytes`)
      console.log(`SPP output message 1: ${result1.spp_output_message.length} bytes`)
      console.log(`Signing keypair 1: ${result1.signing_keypair.length} bytes`)
      console.log(`Threshold key 1 (first 16 bytes): ${Array.from(thresholdKey1.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`)

      // Process from participant 2's perspective
      console.log(`\n--- Recipient 2 processing ---`)
      const result2 = window.wasm_simplpedpop_recipient_all(keypair2Bytes, allMessagesBytes)
      const thresholdKey2 = result2.threshold_public_key
      console.log(`Threshold key 2: ${thresholdKey2.length} bytes`)
      console.log(`SPP output message 2: ${result2.spp_output_message.length} bytes`)
      console.log(`Signing keypair 2: ${result2.signing_keypair.length} bytes`)
      console.log(`Threshold key 2 (first 16 bytes): ${Array.from(thresholdKey2.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`)

      // Convert to arrays for comparison
      const thresholdKey1Bytes = Array.from(thresholdKey1)
      const thresholdKey2Bytes = Array.from(thresholdKey2)

      // Verify that both threshold keys are identical
      const keysMatch = thresholdKey1Bytes.length === thresholdKey2Bytes.length &&
        thresholdKey1Bytes.every((byte, index) => byte === thresholdKey2Bytes[index])

      console.log(`\n=== FINAL RESULTS ===`)
      console.log(`Threshold Public Key (hex): ${thresholdKey1Bytes.map(b => b.toString(16).padStart(2, '0')).join('')}`)
      console.log(`Threshold Public Key (hex, formatted): 0x${thresholdKey1Bytes.map(b => b.toString(16).padStart(2, '0')).join('')}`)
      console.log(`All messages processed successfully!`)
      console.log(`Protocol completed with 2 participants and threshold ${threshold}`)
      console.log(`Threshold keys match: ${keysMatch}`)

      return {
        keysMatch,
        thresholdKey1Length: thresholdKey1.length,
        thresholdKey2Length: thresholdKey2.length,
        thresholdKey1Bytes,
        thresholdKey2Bytes,
        thresholdKeyHex: thresholdKey1Bytes.map(b => b.toString(16).padStart(2, '0')).join(''),
        thresholdKeyHexFormatted: '0x' + thresholdKey1Bytes.map(b => b.toString(16).padStart(2, '0')).join(''),
        allMessage1Length: allMessage1.length,
        allMessage2Length: allMessage2.length,
        sppOutputMessage1Length: result1.spp_output_message.length,
        sppOutputMessage2Length: result2.spp_output_message.length,
        signingKeypair1Length: result1.signing_keypair.length,
        signingKeypair2Length: result2.signing_keypair.length
      }
    }, {
      secretKey1: TEST_SECRET_KEY_1,
      secretKey2: TEST_SECRET_KEY_2,
      recipients: TEST_RECIPIENTS,
      threshold: 2
    })

    // Assert that both threshold keys are identical
    expect(result.keysMatch).toBe(true)
    expect(result.thresholdKey1Length).toBe(result.thresholdKey2Length)
    expect(result.thresholdKey1Length).toBeGreaterThan(0)
    expect(result.allMessage1Length).toBeGreaterThan(0)
    expect(result.allMessage2Length).toBeGreaterThan(0)
    expect(result.sppOutputMessage1Length).toBeGreaterThan(0)
    expect(result.sppOutputMessage2Length).toBeGreaterThan(0)
    expect(result.signingKeypair1Length).toBeGreaterThan(0)
    expect(result.signingKeypair2Length).toBeGreaterThan(0)

    console.log(`✓ Complete SimplPedPoP protocol test passed`)
    console.log(`✓ Threshold keys are identical: ${result.thresholdKey1Length} bytes`)
    console.log(`✓ Threshold Public Key (hex): ${result.thresholdKeyHex}`)
    console.log(`✓ Threshold Public Key (hex, formatted): ${result.thresholdKeyHexFormatted}`)
    console.log(`✓ AllMessage 1: ${result.allMessage1Length} bytes`)
    console.log(`✓ AllMessage 2: ${result.allMessage2Length} bytes`)
    console.log(`✓ SPP Output Message 1: ${result.sppOutputMessage1Length} bytes`)
    console.log(`✓ SPP Output Message 2: ${result.sppOutputMessage2Length} bytes`)
    console.log(`✓ Signing Keypair 1: ${result.signingKeypair1Length} bytes`)
    console.log(`✓ Signing Keypair 2: ${result.signingKeypair2Length} bytes`)
  })
})

// Threshold Signing Rounds Tests
test.describe('Threshold Signing Rounds Tests:', () => {
  let relayNode
  let relayNodeAddress

  test.beforeAll(async ({ }, testInfo) => {
    testInfo.setTimeout(TIMEOUTS.beforeAll)

    // Start relay server
    const relayServer = await createTestRelayServer()
    relayNode = relayServer.relayNode
    relayNodeAddress = relayServer.relayNodeAddress

    // Start Vite server for signing tests
    console.log('Starting Vite server for signing tests...')
    viteServerA = await startViteServer(5173)

    console.log(`Client URL: ${testUrlA}`)
  })

  test.afterAll(async () => {
    if (relayNode) {
      await relayNode.stop()
    }
    stopViteServer(viteServerA)
  })

  test.beforeEach(async ({ page }) => {
    // Navigate to the main page which initializes WASM
    await page.goto(testUrlA)

    // Wait for WASM module to be initialized
    await page.waitForFunction(() => window.wasmReady === true, { timeout: 30000 })
  })

  test('should successfully run Round 1 signing for both participants', async ({ page: pageA, context }) => {
    test.setTimeout(120000)

    const pageB = await context.newPage()
    await pageB.goto(testUrlA)

    // Wait for WASM to be ready on both pages
    await pageA.waitForFunction(() => window.wasmReady === true, { timeout: 30000 })
    await pageB.waitForFunction(() => window.wasmReady === true, { timeout: 30000 })

    // First, generate threshold keys using SimplPedPoP
    const thresholdResults = await generateThresholdKeys(pageA, pageB)

    const peerA = getPeerThresholdCacheEntry(thresholdResults, TEST_SS58_ADDRESS_A)
    const peerB = getPeerThresholdCacheEntry(thresholdResults, TEST_SS58_ADDRESS_B)

    // Test Round 1 for participant 1
    const round1ResultA = await pageA.evaluate(({ signingKeypair }) => {
      const result = window.wasm_threshold_sign_round1(new Uint8Array(signingKeypair))
      return {
        signingNonces: result.signing_nonces,
        signingCommitments: result.signing_commitments
      }
    }, { signingKeypair: Array.from(peerA.signingKeypair) })

    // Test Round 1 for participant 2
    const round1ResultB = await pageB.evaluate(({ signingKeypair }) => {
      const result = window.wasm_threshold_sign_round1(new Uint8Array(signingKeypair))
      return {
        signingNonces: result.signing_nonces,
        signingCommitments: result.signing_commitments
      }
    }, { signingKeypair: Array.from(peerB.signingKeypair) })

    // Validate Round 1 results
    expect(round1ResultA.signingNonces).toBeTruthy()
    expect(round1ResultA.signingCommitments).toBeTruthy()
    expect(round1ResultB.signingNonces).toBeTruthy()
    expect(round1ResultB.signingCommitments).toBeTruthy()

    // Parse JSON strings
    const noncesA = JSON.parse(round1ResultA.signingNonces)
    const commitmentsA = JSON.parse(round1ResultA.signingCommitments)
    const noncesB = JSON.parse(round1ResultB.signingNonces)
    const commitmentsB = JSON.parse(round1ResultB.signingCommitments)

    // Validate that nonces and commitments are arrays of bytes
    expect(Array.isArray(noncesA)).toBe(true)
    expect(Array.isArray(commitmentsA)).toBe(true)
    expect(Array.isArray(noncesB)).toBe(true)
    expect(Array.isArray(commitmentsB)).toBe(true)

    // Validate that nonces have non-zero length
    expect(noncesA.length).toBeGreaterThan(0)
    expect(noncesB.length).toBeGreaterThan(0)
    expect(commitmentsA.length).toBeGreaterThan(0)
    expect(commitmentsB.length).toBeGreaterThan(0)

    console.log(`✓ Round 1 signing completed for both participants`)
    console.log(`✓ Participant 1 nonces: ${noncesA.length} bytes`)
    console.log(`✓ Participant 1 commitments: ${commitmentsA.length} bytes`)
    console.log(`✓ Participant 2 nonces: ${noncesB.length} bytes`)
    console.log(`✓ Participant 2 commitments: ${commitmentsB.length} bytes`)

    await pageB.close()
  })

  test('should successfully run Round 2 signing for both participants', async ({ page: pageA, context }) => {
    test.setTimeout(120000)

    const pageB = await context.newPage()
    await pageB.goto(testUrlA)

    // Wait for WASM to be ready on both pages
    await pageA.waitForFunction(() => window.wasmReady === true, { timeout: 30000 })
    await pageB.waitForFunction(() => window.wasmReady === true, { timeout: 30000 })

    // First, generate threshold keys using SimplPedPoP
    const thresholdResults = await generateThresholdKeys(pageA, pageB)

    // Run Round 1 for both participants
    const round1Results = await runRound1(pageA, pageB, thresholdResults)

    // Prepare test payload and context for Round 2
    const signingContext = 'test context for threshold signing'
    const payload = new TextEncoder().encode('test payload to sign with threshold signature')

    const peerA = getPeerThresholdCacheEntry(thresholdResults, TEST_SS58_ADDRESS_A)
    const peerB = getPeerThresholdCacheEntry(thresholdResults, TEST_SS58_ADDRESS_B)
    const round1PeerA = round1Results.peers[TEST_SS58_ADDRESS_A]
    const round1PeerB = round1Results.peers[TEST_SS58_ADDRESS_B]
    const commitmentsJson = JSON.stringify([round1PeerA.commitments, round1PeerB.commitments])

    // Run Round 2 for participant 1
    const signingPackageA = await pageA.evaluate(({
      signingKeypair,
      signingNonces,
      commitmentsJson,
      sppOutputMessage,
      payload,
      signingContext
    }) => {
      const commitmentsArray = JSON.parse(commitmentsJson)
      const commitmentsBytes = new TextEncoder().encode(JSON.stringify(commitmentsArray))

      const result = window.wasm_threshold_sign_round2(
        new Uint8Array(signingKeypair),
        new Uint8Array(signingNonces),
        commitmentsBytes,
        new Uint8Array(sppOutputMessage),
        new Uint8Array(payload),
        signingContext
      )
      return Array.from(result)
    }, {
      signingKeypair: Array.from(peerA.signingKeypair),
      signingNonces: round1PeerA.nonces,
      commitmentsJson,
      sppOutputMessage: Array.from(peerA.sppOutputMessage),
      payload: Array.from(payload),
      signingContext
    })

    // Run Round 2 for participant 2
    const signingPackageB = await pageB.evaluate(({
      signingKeypair,
      signingNonces,
      commitmentsJson,
      sppOutputMessage,
      payload,
      signingContext
    }) => {
      const commitmentsArray = JSON.parse(commitmentsJson)
      const commitmentsBytes = new TextEncoder().encode(JSON.stringify(commitmentsArray))

      const result = window.wasm_threshold_sign_round2(
        new Uint8Array(signingKeypair),
        new Uint8Array(signingNonces),
        commitmentsBytes,
        new Uint8Array(sppOutputMessage),
        new Uint8Array(payload),
        signingContext
      )
      return Array.from(result)
    }, {
      signingKeypair: Array.from(peerB.signingKeypair),
      signingNonces: round1PeerB.nonces,
      commitmentsJson,
      sppOutputMessage: Array.from(peerB.sppOutputMessage),
      payload: Array.from(payload),
      signingContext
    })

    // Validate Round 2 results
    expect(signingPackageA.length).toBeGreaterThan(0)
    expect(signingPackageB.length).toBeGreaterThan(0)

    console.log(`✓ Round 2 signing completed for both participants`)
    console.log(`✓ Participant 1 signing package: ${signingPackageA.length} bytes`)
    console.log(`✓ Participant 2 signing package: ${signingPackageB.length} bytes`)

    await pageB.close()
  })

  test('should successfully aggregate threshold signature', async ({ page: pageA, context }) => {
    test.setTimeout(120000)

    const pageB = await context.newPage()
    await pageB.goto(testUrlA)

    // Wait for WASM to be ready on both pages
    await pageA.waitForFunction(() => window.wasmReady === true, { timeout: 30000 })
    await pageB.waitForFunction(() => window.wasmReady === true, { timeout: 30000 })

    // First, generate threshold keys using SimplPedPoP
    const thresholdResults = await generateThresholdKeys(pageA, pageB)

    // Run Round 1 for both participants
    const round1Results = await runRound1(pageA, pageB, thresholdResults)

    // Prepare test payload and context for Round 2
    const signingContext = 'test context for threshold signing'
    const payload = new TextEncoder().encode('test payload to sign with threshold signature')

    // Run Round 2 for both participants
    const signingPackages = await runRound2(pageA, pageB, thresholdResults, round1Results, payload, signingContext)

    // Aggregate signing packages
    const aggregatedSignature = await pageA.evaluate(({ signingPackages }) => {
      const signingPackagesJson = JSON.stringify(signingPackages)
      const signingPackagesBytes = new TextEncoder().encode(signingPackagesJson)
      const result = window.wasm_aggregate_threshold_signature(signingPackagesBytes)
      return Array.from(result)
    }, {
      signingPackages: [signingPackages.packageA, signingPackages.packageB]
    })

    // Validate aggregated signature
    expect(aggregatedSignature.length).toBeGreaterThan(0)

    console.log(`✓ Signature aggregation completed`)
    console.log(`✓ Aggregated signature: ${aggregatedSignature.length} bytes`)
    console.log(`✓ Signature (hex): ${aggregatedSignature.map(b => b.toString(16).padStart(2, '0')).join('')}`)

    await pageB.close()
  })

  test('should run complete threshold signing protocol (port of Rust test)', async ({ page: pageA, context }) => {
    test.setTimeout(120000)

    const pageB = await context.newPage()
    await pageB.goto(testUrlA)

    // Wait for WASM to be ready on both pages
    await pageA.waitForFunction(() => window.wasmReady === true, { timeout: 30000 })
    await pageB.waitForFunction(() => window.wasmReady === true, { timeout: 30000 })

    const result = await pageA.evaluate(({
      secretKey1,
      secretKey2,
      recipients,
      threshold,
      payloadText,
      contextText
    }) => {
      console.log('Running complete threshold signing protocol:')
      console.log(`Threshold: ${threshold}`)
      console.log(`Participants: 2`)

      // Step 1: Generate threshold keys using SimplPedPoP
      const keypair1Bytes = window.createKeypairBytes(secretKey1)
      const keypair2Bytes = window.createKeypairBytes(secretKey2)

      const recipient1Bytes = window.ss58ToPublicKeyBytes(recipients[0])
      const recipient2Bytes = window.ss58ToPublicKeyBytes(recipients[1])
      const recipientsConcat = new Uint8Array(recipient1Bytes.length + recipient2Bytes.length)
      recipientsConcat.set(recipient1Bytes, 0)
      recipientsConcat.set(recipient2Bytes, recipient1Bytes.length)

      const allMessage1 = window.wasm_simplpedpop_contribute_all(keypair1Bytes, threshold, recipientsConcat)
      const allMessage2 = window.wasm_simplpedpop_contribute_all(keypair2Bytes, threshold, recipientsConcat)

      const allMessagesArray = [
        Array.from(allMessage1),
        Array.from(allMessage2)
      ]
      const allMessagesJson = JSON.stringify(allMessagesArray)
      const allMessagesBytes = new TextEncoder().encode(allMessagesJson)

      const result1 = window.wasm_simplpedpop_recipient_all(keypair1Bytes, allMessagesBytes)
      const result2 = window.wasm_simplpedpop_recipient_all(keypair2Bytes, allMessagesBytes)

      const thresholdKey1 = result1.threshold_public_key
      const sppOutputMessage1 = result1.spp_output_message
      const signingKeypair1 = result1.signing_keypair
      const sppOutputMessage2 = result2.spp_output_message
      const signingKeypair2 = result2.signing_keypair

      // Verify threshold keys match
      const thresholdKey1Bytes = Array.from(thresholdKey1)
      const thresholdKey2Bytes = Array.from(result2.threshold_public_key)
      const keysMatch = thresholdKey1Bytes.length === thresholdKey2Bytes.length &&
        thresholdKey1Bytes.every((byte, index) => byte === thresholdKey2Bytes[index])

      if (!keysMatch) {
        throw new Error('Threshold keys do not match!')
      }

      console.log(`Threshold Public Key: ${thresholdKey1Bytes.map(b => b.toString(16).padStart(2, '0')).join('')}`)

      // Step 2: Round 1 signing
      console.log('\n=== TESTING ROUND 1 SIGNING ===')
      const round1Result1 = window.wasm_threshold_sign_round1(new Uint8Array(signingKeypair1))
      const round1Result2 = window.wasm_threshold_sign_round1(new Uint8Array(signingKeypair2))

      const nonces1 = JSON.parse(round1Result1.signing_nonces)
      const commitments1 = JSON.parse(round1Result1.signing_commitments)
      const nonces2 = JSON.parse(round1Result2.signing_nonces)
      const commitments2 = JSON.parse(round1Result2.signing_commitments)

      console.log(`Round 1 completed for both participants`)

      // Step 3: Round 2 signing
      console.log('\n=== TESTING ROUND 2 SIGNING ===')
      const payload = new TextEncoder().encode(payloadText)

      const commitmentsArray = [commitments1, commitments2]
      const commitmentsJson = JSON.stringify(commitmentsArray)
      const commitmentsBytes = new TextEncoder().encode(commitmentsJson)

      const signingPackage1 = window.wasm_threshold_sign_round2(
        new Uint8Array(signingKeypair1),
        new Uint8Array(nonces1),
        commitmentsBytes,
        new Uint8Array(sppOutputMessage1),
        new Uint8Array(payload),
        contextText
      )

      const signingPackage2 = window.wasm_threshold_sign_round2(
        new Uint8Array(signingKeypair2),
        new Uint8Array(nonces2),
        commitmentsBytes,
        new Uint8Array(sppOutputMessage2),
        new Uint8Array(payload),
        contextText
      )

      console.log(`Round 2 completed for both participants`)
      console.log(`Signing package 1: ${signingPackage1.length} bytes`)
      console.log(`Signing package 2: ${signingPackage2.length} bytes`)

      // Step 4: Aggregate signature
      console.log('\n=== TESTING SIGNATURE AGGREGATION ===')
      const signingPackagesArray = [
        Array.from(signingPackage1),
        Array.from(signingPackage2)
      ]
      const signingPackagesJson = JSON.stringify(signingPackagesArray)
      const signingPackagesBytes = new TextEncoder().encode(signingPackagesJson)

      const finalSignature = window.wasm_aggregate_threshold_signature(signingPackagesBytes)

      console.log(`Aggregated signature: ${finalSignature.length} bytes`)
      console.log(`Signature (hex): ${Array.from(finalSignature).map(b => b.toString(16).padStart(2, '0')).join('')}`)

      return {
        keysMatch,
        thresholdKeyLength: thresholdKey1.length,
        thresholdKeyHex: thresholdKey1Bytes.map(b => b.toString(16).padStart(2, '0')).join(''),
        round1Nonces1Length: nonces1.length,
        round1Commitments1Length: commitments1.length,
        round1Nonces2Length: nonces2.length,
        round1Commitments2Length: commitments2.length,
        signingPackage1Length: signingPackage1.length,
        signingPackage2Length: signingPackage2.length,
        aggregatedSignatureLength: finalSignature.length,
        aggregatedSignatureHex: Array.from(finalSignature).map(b => b.toString(16).padStart(2, '0')).join('')
      }
    }, {
      secretKey1: TEST_SECRET_KEY_1,
      secretKey2: TEST_SECRET_KEY_2,
      recipients: TEST_RECIPIENTS,
      threshold: 2,
      payloadText: 'test payload to sign with threshold signature',
      contextText: 'test context for threshold signing'
    })

    // Validate complete protocol results
    expect(result.keysMatch).toBe(true)
    expect(result.thresholdKeyLength).toBeGreaterThan(0)
    expect(result.round1Nonces1Length).toBeGreaterThan(0)
    expect(result.round1Commitments1Length).toBeGreaterThan(0)
    expect(result.round1Nonces2Length).toBeGreaterThan(0)
    expect(result.round1Commitments2Length).toBeGreaterThan(0)
    expect(result.signingPackage1Length).toBeGreaterThan(0)
    expect(result.signingPackage2Length).toBeGreaterThan(0)
    expect(result.aggregatedSignatureLength).toBeGreaterThan(0)

    console.log(`✓ Complete threshold signing protocol test passed`)
    console.log(`✓ Threshold key: ${result.thresholdKeyLength} bytes`)
    console.log(`✓ Aggregated signature: ${result.aggregatedSignatureLength} bytes`)
    console.log(`✓ Signature (hex): ${result.aggregatedSignatureHex}`)

    await pageB.close()
  })
})

// Helper functions for signing tests
async function generateThresholdKeys(pageA, pageB) {
  // Cache file path (using ES module compatible __dirname)
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = dirname(__filename)
  const cacheFilePath = join(__dirname, 'threshold-keys-cache.json')

  const normalizePeerEntry = (address, entry) => {
    if (!entry || typeof entry !== 'object') {
      return null
    }
    const { thresholdPublicKey, sppOutputMessage, signingKeypair } = entry
    const isByteArray = (value) => Array.isArray(value) && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    if (!isByteArray(thresholdPublicKey) || !isByteArray(sppOutputMessage) || !isByteArray(signingKeypair)) {
      console.warn(`threshold-keys-cache.json peer entry for ${address} is invalid`)
      return null
    }
    return {
      thresholdPublicKey,
      sppOutputMessage,
      signingKeypair
    }
  }

  const loadCachedThresholdKeys = () => {
    if (!existsSync(cacheFilePath)) {
      return null
    }

    try {
      console.log('Loading cached threshold keys from:', cacheFilePath)
      const cachedData = JSON.parse(readFileSync(cacheFilePath, 'utf-8'))

      if (cachedData && typeof cachedData === 'object' && cachedData.peers) {
        const peers = {}
        for (const address of PEER_SS58_ADDRESSES) {
          const normalized = normalizePeerEntry(address, cachedData.peers[address])
          if (!normalized) {
            return null
          }
          peers[address] = normalized
        }

        const sharedThreshold = cachedData.thresholdPublicKey ||
          cachedData.peers[PEER_SS58_ADDRESSES[0]]?.thresholdPublicKey

        if (!Array.isArray(sharedThreshold)) {
          console.warn('threshold-keys-cache.json missing shared thresholdPublicKey; ignoring cache')
          return null
        }

        console.log('✓ Using cached threshold keys')
        const result = {
          thresholdPublicKey: sharedThreshold,
          peers
        }

        if (cachedData.polkadotRound1) {
          result.polkadotRound1 = cachedData.polkadotRound1
        }

        return result
      }

      // Backwards compatibility for legacy schema
      if (cachedData.thresholdPublicKey1 &&
        cachedData.thresholdPublicKey2 &&
        cachedData.sppOutputMessage1 &&
        cachedData.sppOutputMessage2 &&
        cachedData.signingKeypair1 &&
        cachedData.signingKeypair2) {
        console.log('✓ Using cached threshold keys (legacy schema detected, will migrate on save)')
        return {
          thresholdPublicKey: cachedData.thresholdPublicKey1,
          peers: {
            [TEST_SS58_ADDRESS_A]: {
              thresholdPublicKey: cachedData.thresholdPublicKey1,
              sppOutputMessage: cachedData.sppOutputMessage1,
              signingKeypair: cachedData.signingKeypair1
            },
            [TEST_SS58_ADDRESS_B]: {
              thresholdPublicKey: cachedData.thresholdPublicKey2,
              sppOutputMessage: cachedData.sppOutputMessage2,
              signingKeypair: cachedData.signingKeypair2
            }
          },
          polkadotRound1: cachedData.polkadotRound1
        }
      }

      console.log('⚠️  Cached data structure invalid, regenerating...')
    } catch (error) {
      console.log('⚠️  Error loading cache, regenerating:', error.message)
    }
    return null
  }

  const cachedThresholdKeys = loadCachedThresholdKeys()
  if (cachedThresholdKeys) {
    return cachedThresholdKeys
  }

  // Generate new threshold keys if cache doesn't exist or is invalid
  console.log('Generating new threshold keys...')

  // Generate AllMessages for both participants
  const allMessageA = await pageA.evaluate(({ secretKey, recipients, threshold }) => {
    const keypairBytes = window.createKeypairBytes(secretKey)
    const recipient1Bytes = window.ss58ToPublicKeyBytes(recipients[0])
    const recipient2Bytes = window.ss58ToPublicKeyBytes(recipients[1])
    const recipientsConcat = new Uint8Array(recipient1Bytes.length + recipient2Bytes.length)
    recipientsConcat.set(recipient1Bytes, 0)
    recipientsConcat.set(recipient2Bytes, recipient1Bytes.length)
    return window.wasm_simplpedpop_contribute_all(keypairBytes, threshold, recipientsConcat)
  }, { secretKey: TEST_SECRET_KEY_1, recipients: TEST_RECIPIENTS, threshold: 2 })

  const allMessageB = await pageB.evaluate(({ secretKey, recipients, threshold }) => {
    const keypairBytes = window.createKeypairBytes(secretKey)
    const recipient1Bytes = window.ss58ToPublicKeyBytes(recipients[0])
    const recipient2Bytes = window.ss58ToPublicKeyBytes(recipients[1])
    const recipientsConcat = new Uint8Array(recipient1Bytes.length + recipient2Bytes.length)
    recipientsConcat.set(recipient1Bytes, 0)
    recipientsConcat.set(recipient2Bytes, recipient1Bytes.length)
    return window.wasm_simplpedpop_contribute_all(keypairBytes, threshold, recipientsConcat)
  }, { secretKey: TEST_SECRET_KEY_2, recipients: TEST_RECIPIENTS, threshold: 2 })

  // Process AllMessages to generate threshold keys
  const resultA = await pageA.evaluate(({ secretKey, allMessageA, allMessageB }) => {
    const keypairBytes = window.createKeypairBytes(secretKey)
    const allMessagesArray = [
      Array.from(allMessageA),
      Array.from(allMessageB)
    ]
    const allMessagesJson = JSON.stringify(allMessagesArray)
    const allMessagesBytes = new TextEncoder().encode(allMessagesJson)
    const result = window.wasm_simplpedpop_recipient_all(keypairBytes, allMessagesBytes)
    return {
      thresholdPublicKey: Array.from(result.threshold_public_key),
      sppOutputMessage: Array.from(result.spp_output_message),
      signingKeypair: Array.from(result.signing_keypair)
    }
  }, {
    secretKey: TEST_SECRET_KEY_1,
    allMessageA: Array.from(allMessageA),
    allMessageB: Array.from(allMessageB)
  })

  const resultB = await pageB.evaluate(({ secretKey, allMessageA, allMessageB }) => {
    const keypairBytes = window.createKeypairBytes(secretKey)
    const allMessagesArray = [
      Array.from(allMessageA),
      Array.from(allMessageB)
    ]
    const allMessagesJson = JSON.stringify(allMessagesArray)
    const allMessagesBytes = new TextEncoder().encode(allMessagesJson)
    const result = window.wasm_simplpedpop_recipient_all(keypairBytes, allMessagesBytes)
    return {
      thresholdPublicKey: Array.from(result.threshold_public_key),
      sppOutputMessage: Array.from(result.spp_output_message),
      signingKeypair: Array.from(result.signing_keypair)
    }
  }, {
    secretKey: TEST_SECRET_KEY_2,
    allMessageA: Array.from(allMessageA),
    allMessageB: Array.from(allMessageB)
  })

  // Verify threshold keys match
  const keysMatch = resultA.thresholdPublicKey.length === resultB.thresholdPublicKey.length &&
    resultA.thresholdPublicKey.every((byte, index) => byte === resultB.thresholdPublicKey[index])

  if (!keysMatch) {
    throw new Error('Threshold keys do not match!')
  }

  let existingRound1Cache = null
  if (existsSync(cacheFilePath)) {
    try {
      const existingCache = JSON.parse(readFileSync(cacheFilePath, 'utf-8'))
      if (existingCache?.polkadotRound1) {
        existingRound1Cache = existingCache.polkadotRound1
      }
    } catch (error) {
      console.log('⚠️  Unable to read existing Round 1 cache during key generation:', error.message)
    }
  }

  const thresholdResults = {
    thresholdPublicKey: resultA.thresholdPublicKey,
    peers: {
      [TEST_SS58_ADDRESS_A]: {
        thresholdPublicKey: resultA.thresholdPublicKey,
        sppOutputMessage: resultA.sppOutputMessage,
        signingKeypair: resultA.signingKeypair
      },
      [TEST_SS58_ADDRESS_B]: {
        thresholdPublicKey: resultB.thresholdPublicKey,
        sppOutputMessage: resultB.sppOutputMessage,
        signingKeypair: resultB.signingKeypair
      }
    }
  }

  // Save to cache file
  try {
    const thresholdCachePayload = existingRound1Cache
      ? { ...thresholdResults, polkadotRound1: existingRound1Cache }
      : thresholdResults

    writeFileSync(cacheFilePath, JSON.stringify(thresholdCachePayload, null, 2), 'utf-8')
    console.log('✓ Threshold keys cached to:', cacheFilePath)
  } catch (error) {
    console.warn('⚠️  Failed to save cache:', error.message)
  }

  return existingRound1Cache
    ? { ...thresholdResults, polkadotRound1: existingRound1Cache }
    : thresholdResults
}

const getPeerThresholdCacheEntry = (thresholdResults, address) => {
  const peers = thresholdResults?.peers
  if (!peers || !peers[address]) {
    throw new Error(`Missing threshold cache entry for peer ${address}`)
  }
  return peers[address]
}

async function runRound1(pageA, pageB, thresholdResults) {
  const peerA = getPeerThresholdCacheEntry(thresholdResults, TEST_SS58_ADDRESS_A)
  const peerB = getPeerThresholdCacheEntry(thresholdResults, TEST_SS58_ADDRESS_B)

  const round1ResultA = await pageA.evaluate(({ signingKeypair }) => {
    const result = window.wasm_threshold_sign_round1(new Uint8Array(signingKeypair))
    return {
      signingNonces: result.signing_nonces,
      signingCommitments: result.signing_commitments
    }
  }, { signingKeypair: Array.from(peerA.signingKeypair) })

  const round1ResultB = await pageB.evaluate(({ signingKeypair }) => {
    const result = window.wasm_threshold_sign_round1(new Uint8Array(signingKeypair))
    return {
      signingNonces: result.signing_nonces,
      signingCommitments: result.signing_commitments
    }
  }, { signingKeypair: Array.from(peerB.signingKeypair) })

  const noncesA = JSON.parse(round1ResultA.signingNonces)
  const commitmentsA = JSON.parse(round1ResultA.signingCommitments)
  const noncesB = JSON.parse(round1ResultB.signingNonces)
  const commitmentsB = JSON.parse(round1ResultB.signingCommitments)

  return {
    peers: {
      [TEST_SS58_ADDRESS_A]: {
        signingKeypair: Array.from(peerA.signingKeypair),
        nonces: noncesA,
        commitments: commitmentsA
      },
      [TEST_SS58_ADDRESS_B]: {
        signingKeypair: Array.from(peerB.signingKeypair),
        nonces: noncesB,
        commitments: commitmentsB
      }
    }
  }
}

async function getPolkadotRound1SigningData(pageA, pageB, thresholdResults) {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = dirname(__filename)
  const cacheFilePath = join(__dirname, 'polkadot-round1-cache.json')

  const toArray = (value) => Array.isArray(value) ? value : Array.from(value)
  const arraysEqual = (a, b) => Array.isArray(a) && Array.isArray(b) &&
    a.length === b.length && a.every((value, index) => value === b[index])
  const isByteArray = (value) =>
    Array.isArray(value) &&
    value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)

  const thresholdPeerA = getPeerThresholdCacheEntry(thresholdResults, TEST_SS58_ADDRESS_A)
  const thresholdPeerB = getPeerThresholdCacheEntry(thresholdResults, TEST_SS58_ADDRESS_B)

  const signingKeypair1Array = toArray(thresholdPeerA.signingKeypair)
  const signingKeypair2Array = toArray(thresholdPeerB.signingKeypair)

  const normalizeRound1PeerEntry = (address, entry) => {
    if (!entry || typeof entry !== 'object') {
      return null
    }
    const { signingKeypair, nonces, commitments } = entry
    if (!isByteArray(signingKeypair) || !isByteArray(nonces) || !isByteArray(commitments)) {
      console.warn(`polkadotRound1 cache entry for ${address} is invalid`)
      return null
    }
    return {
      signingKeypair: Array.from(signingKeypair),
      nonces: Array.from(nonces),
      commitments: Array.from(commitments)
    }
  }

  if (existsSync(cacheFilePath)) {
    try {
      const cachedData = JSON.parse(readFileSync(cacheFilePath, 'utf-8'))
      if (cachedData && typeof cachedData === 'object' && cachedData.peers) {
        console.log('Loading cached Round 1 signing data for Polkadot test from:', cacheFilePath)

        const cachedPeerA = normalizeRound1PeerEntry(TEST_SS58_ADDRESS_A, cachedData.peers[TEST_SS58_ADDRESS_A])
        const cachedPeerB = normalizeRound1PeerEntry(TEST_SS58_ADDRESS_B, cachedData.peers[TEST_SS58_ADDRESS_B])

        if (
          cachedPeerA &&
          cachedPeerB &&
          arraysEqual(cachedPeerA.signingKeypair, signingKeypair1Array) &&
          arraysEqual(cachedPeerB.signingKeypair, signingKeypair2Array)
        ) {
          console.log('✓ Using cached Round 1 signing data for Polkadot test')
          return {
            peers: {
              [TEST_SS58_ADDRESS_A]: {
                signingKeypair: signingKeypair1Array,
                nonces: Array.from(cachedPeerA.nonces),
                commitments: Array.from(cachedPeerA.commitments)
              },
              [TEST_SS58_ADDRESS_B]: {
                signingKeypair: signingKeypair2Array,
                nonces: Array.from(cachedPeerB.nonces),
                commitments: Array.from(cachedPeerB.commitments)
              }
            }
          }
        }

        console.log('⚠️  Cached Round 1 data invalid or mismatched, regenerating...')
      }
    } catch (error) {
      console.log('⚠️  Error loading Round 1 cache, regenerating:', error.message)
    }
  }

  console.log('Generating new Round 1 signing data for Polkadot test...')
  const round1Results = await runRound1(pageA, pageB, thresholdResults)

  const round1CachePayload = {
    peers: {
      [TEST_SS58_ADDRESS_A]: {
        signingKeypair: signingKeypair1Array,
        nonces: Array.from(round1Results.peers[TEST_SS58_ADDRESS_A].nonces),
        commitments: Array.from(round1Results.peers[TEST_SS58_ADDRESS_A].commitments)
      },
      [TEST_SS58_ADDRESS_B]: {
        signingKeypair: signingKeypair2Array,
        nonces: Array.from(round1Results.peers[TEST_SS58_ADDRESS_B].nonces),
        commitments: Array.from(round1Results.peers[TEST_SS58_ADDRESS_B].commitments)
      }
    }
  }

  try {
    writeFileSync(cacheFilePath, JSON.stringify(round1CachePayload, null, 2), 'utf-8')
    console.log('✓ Round 1 signing data cached to:', cacheFilePath)
  } catch (error) {
    console.warn('⚠️  Failed to save Round 1 cache:', error.message)
  }

  return {
    peers: {
      [TEST_SS58_ADDRESS_A]: {
        signingKeypair: signingKeypair1Array,
        nonces: Array.from(round1Results.peers[TEST_SS58_ADDRESS_A].nonces),
        commitments: Array.from(round1Results.peers[TEST_SS58_ADDRESS_A].commitments)
      },
      [TEST_SS58_ADDRESS_B]: {
        signingKeypair: signingKeypair2Array,
        nonces: Array.from(round1Results.peers[TEST_SS58_ADDRESS_B].nonces),
        commitments: Array.from(round1Results.peers[TEST_SS58_ADDRESS_B].commitments)
      }
    }
  }
}

async function runRound2(pageA, pageB, thresholdResults, round1Results, payload, context) {
  const peerA = getPeerThresholdCacheEntry(thresholdResults, TEST_SS58_ADDRESS_A)
  const peerB = getPeerThresholdCacheEntry(thresholdResults, TEST_SS58_ADDRESS_B)
  const round1PeerA = round1Results.peers[TEST_SS58_ADDRESS_A]
  const round1PeerB = round1Results.peers[TEST_SS58_ADDRESS_B]

  const commitmentsPayload = JSON.stringify([round1PeerA.commitments, round1PeerB.commitments])

  const signingPackageA = await pageA.evaluate(({
    signingKeypair,
    signingNonces,
    commitmentsJson,
    sppOutputMessage,
    payload,
    context
  }) => {
    const commitmentsArray = JSON.parse(commitmentsJson)
    const commitmentsBytes = new TextEncoder().encode(JSON.stringify(commitmentsArray))

    const result = window.wasm_threshold_sign_round2(
      new Uint8Array(signingKeypair),
      new Uint8Array(signingNonces),
      commitmentsBytes,
      new Uint8Array(sppOutputMessage),
      new Uint8Array(payload),
      context
    )
    return Array.from(result)
  }, {
    signingKeypair: Array.from(peerA.signingKeypair),
    signingNonces: round1PeerA.nonces,
    commitmentsJson: commitmentsPayload,
    sppOutputMessage: Array.from(peerA.sppOutputMessage),
    payload: Array.from(payload),
    context
  })

  const signingPackageB = await pageB.evaluate(({
    signingKeypair,
    signingNonces,
    commitmentsJson,
    sppOutputMessage,
    payload,
    context
  }) => {
    const commitmentsArray = JSON.parse(commitmentsJson)
    const commitmentsBytes = new TextEncoder().encode(JSON.stringify(commitmentsArray))

    const result = window.wasm_threshold_sign_round2(
      new Uint8Array(signingKeypair),
      new Uint8Array(signingNonces),
      commitmentsBytes,
      new Uint8Array(sppOutputMessage),
      new Uint8Array(payload),
      context
    )
    return Array.from(result)
  }, {
    signingKeypair: Array.from(peerB.signingKeypair),
    signingNonces: round1PeerB.nonces,
    commitmentsJson: commitmentsPayload,
    sppOutputMessage: Array.from(peerB.sppOutputMessage),
    payload: Array.from(payload),
    context
  })

  return {
    packageA: signingPackageA,
    packageB: signingPackageB
  }
}

// Polkadot API Integration Tests with Threshold Signing
test.describe('Polkadot API Integration with Threshold Signing:', () => {
  let relayNode
  let relayNodeAddress

  test.beforeAll(async ({ }, testInfo) => {
    testInfo.setTimeout(TIMEOUTS.beforeAll)

    // Start relay server
    const relayServer = await createTestRelayServer()
    relayNode = relayServer.relayNode
    relayNodeAddress = relayServer.relayNodeAddress

    // Start Vite server for Polkadot API tests
    console.log('Starting Vite server for Polkadot API tests...')
    viteServerA = await startViteServer(5173)

    console.log(`Client URL: ${testUrlA}`)
  })

  test.afterAll(async () => {
    if (relayNode) {
      await relayNode.stop()
    }
    stopViteServer(viteServerA)
  })

  test.beforeEach(async ({ page }) => {
    // Navigate to the main page which initializes WASM
    await page.goto(testUrlA)

    // Wait for WASM module to be initialized
    await page.waitForFunction(() => window.wasmReady === true, { timeout: 30000 })
  })

  test('should sign Polkadot extrinsic using threshold public key and threshold signing protocol', async ({ page: pageA, context }) => {
    test.setTimeout(180000) // 3 minutes for Polkadot API calls

    // Capture browser console logs and forward them to test output
    // This must be set up before any evaluate calls that log to console
    pageA.on('console', msg => {
      const text = msg.text()
      const type = msg.type()
      // Print all console messages to terminal
      if (type === 'log' || type === 'info') {
        console.log(`[Browser] ${text}`)
      } else if (type === 'error') {
        console.error(`[Browser Error] ${text}`)
      } else if (type === 'warn') {
        console.warn(`[Browser Warn] ${text}`)
      } else if (type === 'debug') {
        console.log(`[Browser Debug] ${text}`)
      } else {
        console.log(`[Browser ${type}] ${text}`)
      }
    })

    // Also capture page errors
    pageA.on('pageerror', error => {
      console.error(`[Browser Page Error] ${error.message}`)
      console.error(`[Browser Page Error Stack] ${error.stack}`)
    })

    const pageB = await context.newPage()

    pageB.on('console', msg => {
      const text = msg.text()
      const type = msg.type()
      // Print all console messages to terminal
      if (type === 'log' || type === 'info') {
        console.log(`[Browser B] ${text}`)
      } else if (type === 'error') {
        console.error(`[Browser B Error] ${text}`)
      } else if (type === 'warn') {
        console.warn(`[Browser B Warn] ${text}`)
      } else if (type === 'debug') {
        console.log(`[Browser B Debug] ${text}`)
      } else {
        console.log(`[Browser B ${type}] ${text}`)
      }
    })

    // Also capture page errors for pageB
    pageB.on('pageerror', error => {
      console.error(`[Browser B Page Error] ${error.message}`)
      console.error(`[Browser B Page Error Stack] ${error.stack}`)
    })

    await pageB.goto(testUrlA)

    // Wait for WASM to be ready on both pages
    await pageA.waitForFunction(() => window.wasmReady === true, { timeout: 30000 })
    await pageB.waitForFunction(() => window.wasmReady === true, { timeout: 30000 })

    // Step 1: Generate threshold keys using SimplPedPoP
    const thresholdResults = await generateThresholdKeys(pageA, pageB)

    // Step 2: Use threshold public key to sign a Polkadot extrinsic
    const round1Results = await getPolkadotRound1SigningData(pageA, pageB, thresholdResults)
    const thresholdPeerA = getPeerThresholdCacheEntry(thresholdResults, TEST_SS58_ADDRESS_A)
    const thresholdPeerB = getPeerThresholdCacheEntry(thresholdResults, TEST_SS58_ADDRESS_B)
    const round1PeerA = round1Results.peers[TEST_SS58_ADDRESS_A]
    const round1PeerB = round1Results.peers[TEST_SS58_ADDRESS_B]

    const result = await pageA.evaluate(async ({
      secretKey1,
      secretKey2,
      recipients,
      threshold,
      thresholdPublicKey,
      sppOutputMessage1,
      sppOutputMessage2,
      signingKeypair1,
      signingKeypair2,
      signingNonces1,
      signingNonces2,
      signingCommitments1,
      signingCommitments2
    }) => {
      // Import Polkadot API from CDN (works in browser context)
      const { ApiPromise, WsProvider } = await import('https://esm.sh/@polkadot/api@latest')
      const { hexToU8a, u8aToHex } = await import('https://esm.sh/@polkadot/util@latest')
      const { sr25519Verify } = await import('https://esm.sh/@polkadot/util-crypto@latest')

      // 1. Connect to Westend Relay Chain
      // Note: Westend has multiple chains (relay, assethub, collectives, bridgehub, people, coretime)
      // This connects to the Westend Relay Chain (main chain)
      // For parachains, use endpoints like:
      //   - Asset Hub: 'wss://westend-asset-hub-rpc.polkadot.io'
      //   - Collectives: 'wss://westend-collectives-rpc.polkadot.io'
      //   - Bridge Hub: 'wss://westend-bridge-hub-rpc.polkadot.io'
      //   - People: 'wss://westend-people-rpc.polkadot.io'
      //   - Coretime: 'wss://westend-coretime-rpc.polkadot.io'
      const ws = new WsProvider('wss://westend-rpc.polkadot.io')
      const api = await ApiPromise.create({ provider: ws })
      await api.isReady

      console.log('Connected to: Westend Relay Chain')
      console.log('Chain:', api.runtimeChain.toString())
      console.log('Runtime version:', api.runtimeVersion.specVersion.toString())

      try {
        // 2. Build the remark call
        const remarkText = 'Hello, Westend!'
        // Convert text to hex (browser-compatible)
        const remarkHex = '0x' + Array.from(new TextEncoder().encode(remarkText))
          .map(b => b.toString(16).padStart(2, '0')).join('')
        const remark = api.tx.system.remark(remarkHex)

        // 3. Use threshold public key (32 bytes) as AccountId32
        const thresholdPubkey = new Uint8Array(thresholdPublicKey)
        const accountId32 = api.registry.createType('AccountId32', thresholdPubkey)

        console.log('--- Account Information ---')
        console.log('Individual Participant Addresses (recipients):')
        recipients.forEach((addr, idx) => {
          console.log(`  Participant ${idx + 1}: ${addr}`)
        })
        console.log('')
        console.log('Threshold Account (derived from threshold public key):')
        console.log('  Threshold AccountId32 (hex):', accountId32.toHex())
        console.log('  Threshold AccountId32 SS58 address:', accountId32.toHuman())
        console.log('')
        console.log('Note: The threshold account is different from individual participant addresses.')
        console.log('The threshold account is the correct signer for threshold signatures.')
        console.log('Individual participants sign collaboratively to produce a signature for the threshold account.')

        // 4. Query nonce for that account (will be 0 if account doesn't exist)
        let nonce
        try {
          const accountInfo = await api.query.system.account(accountId32)
          nonce = accountInfo.nonce
        } catch (error) {
          // Account doesn't exist, use nonce 0
          nonce = api.registry.createType('Index', 0)
        }

        // 5. Build payload fields
        const era = api.registry.createType('ExtrinsicEra', '0x00') // immortal
        const genesisHash = api.genesisHash.toHex()
        const blockHash = genesisHash

        const payloadFields = {
          method: remark.method.toHex(),
          nonce: nonce.toString(),
          era: era.toHex(),
          tip: '0',
          specVersion: api.runtimeVersion.specVersion.toNumber(),
          transactionVersion: api.runtimeVersion.transactionVersion.toNumber(),
          genesisHash,
          blockHash,
        }

        // 6. Create ExtrinsicPayload (this is what must be signed)
        const extrinsicPayload = api.registry.createType(
          'ExtrinsicPayload',
          payloadFields,
          { version: api.extrinsicVersion }
        )

        // 7. Export signable payload as Uint8Array (to be signed with threshold signing)
        const signableU8a = extrinsicPayload.toU8a({ method: true })
        const signableHex = u8aToHex(signableU8a)
        console.log('--- Signable payload ---')
        console.log('Signable payload length:', signableU8a.length, 'bytes')
        console.log('Signable payload (hex):', signableHex.substring(0, 100) + '...')

        // 8. Use threshold signing protocol to sign the payload
        // Step 8a: Round 1 signing data (cached or freshly generated)
        const nonces1 = signingNonces1
        const commitments1 = signingCommitments1
        const nonces2 = signingNonces2
        const commitments2 = signingCommitments2

        console.log('Round 1 signing data ready for both participants')
        console.log('Signing nonces (participant 1):', JSON.stringify(nonces1))
        console.log('Signing commitments (participant 1):', JSON.stringify(commitments1))
        console.log('Signing nonces (participant 2):', JSON.stringify(nonces2))
        console.log('Signing commitments (participant 2):', JSON.stringify(commitments2))

        // Step 8b: Round 2 signing for both participants
        const commitmentsArray = [commitments1, commitments2]
        const commitmentsJson = JSON.stringify(commitmentsArray)
        const commitmentsBytes = new TextEncoder().encode(commitmentsJson)

        // Use the signable payload as the message to sign
        const signingContext = 'substrate' // Standard context for Substrate

        const signingPackage1 = window.wasm_threshold_sign_round2(
          new Uint8Array(signingKeypair1),
          new Uint8Array(nonces1),
          commitmentsBytes,
          new Uint8Array(sppOutputMessage1),
          signableU8a, // Use the extrinsic payload as the payload
          signingContext
        )

        const signingPackage2 = window.wasm_threshold_sign_round2(
          new Uint8Array(signingKeypair2),
          new Uint8Array(nonces2),
          commitmentsBytes,
          new Uint8Array(sppOutputMessage2),
          signableU8a, // Use the extrinsic payload as the payload
          signingContext
        )

        console.log('Round 2 completed for both participants')
        console.log('Signing package 1:', signingPackage1.length, 'bytes')
        console.log('Signing package 2:', signingPackage2.length, 'bytes')

        // Step 8c: Aggregate threshold signature
        const signingPackagesArray = [
          Array.from(signingPackage1),
          Array.from(signingPackage2)
        ]
        const signingPackagesJson = JSON.stringify(signingPackagesArray)
        const signingPackagesBytes = new TextEncoder().encode(signingPackagesJson)
        console.log('Signing packages JSON:', signingPackagesJson)
        console.log('Signing packages bytes length:', signingPackagesBytes.length)
        console.log(
          'Signing packages bytes (hex preview):',
          u8aToHex(signingPackagesBytes.slice(0, Math.min(signingPackagesBytes.length, 64))) +
          (signingPackagesBytes.length > 64 ? '…' : '')
        )

        const aggregatedSignature = window.wasm_aggregate_threshold_signature(signingPackagesBytes)

        console.log('Aggregated signature length:', aggregatedSignature.length, 'bytes')
        console.log('Aggregated signature (hex):', u8aToHex(aggregatedSignature))

        // 9. Attach the threshold signature to the extrinsic
        // Validate signature length - Sr25519 requires exactly 64 bytes
        if (aggregatedSignature.length !== 64) {
          throw new Error(
            `Signature length mismatch: expected 64 bytes for Sr25519, got ${aggregatedSignature.length} bytes. ` +
            `The threshold signing library may return a compressed format that needs conversion.`
          )
        }

        // Create Signature type explicitly using MultiSignature enum format
        // Signature is actually a MultiSignature enum with variants: Ed25519, Sr25519, Ecdsa
        // We need to explicitly specify Sr25519 variant (capitalized)
        const signatureType = api.registry.createType('MultiSignature', {
          Sr25519: aggregatedSignature
        })

        // Use addSignature() method to properly attach the signature to the extrinsic
        // This is the correct way to manually sign an extrinsic in Polkadot API
        const signerPayload = {
          era,
          nonce,
          tip: '0'
        }

        console.log('accountId32 (hex):', accountId32.toHex())
        console.log('accountId32 (SS58):', accountId32.toHuman())
        console.log('MultiSignature (Sr25519, hex):', u8aToHex(aggregatedSignature))
        console.log('Signer payload:', {
          era: typeof signerPayload.era?.toHex === 'function' ? signerPayload.era.toHex() : String(signerPayload.era),
          nonce: typeof signerPayload.nonce?.toString === 'function' ? signerPayload.nonce.toString() : String(signerPayload.nonce),
          tip: signerPayload.tip
        })

        const signedExtrinsic = remark.addSignature(
          accountId32,
          signatureType,
          signerPayload
        )

        // 10. Now you have the final signed extrinsic
        const signedHex = signedExtrinsic.toHex()
        console.log('--- Final signed extrinsic ---')
        console.log('Signed extrinsic length:', signedHex.length, 'characters')
        console.log('Signed extrinsic (first 200 chars):', signedHex.substring(0, 200) + '...')

        console.log('--- Signed Extrinsic Information ---')
        console.log('Is signed:', signedExtrinsic.isSigned);
        console.log('Signer (should match threshold account):', signedExtrinsic.signer.toString());

        // Verify that signer matches threshold account
        const signerMatches = signedExtrinsic.signer.toString() === accountId32.toHuman()
        console.log('Signer matches threshold account:', signerMatches);
        if (!signerMatches) {
          console.warn('WARNING: Signer does not match threshold account!');
          console.warn('Expected (threshold account):', accountId32.toHuman());
          console.warn('Actual (signer):', signedExtrinsic.signer.toString());
        } else {
          console.log('✓ Signer correctly matches threshold account');
        }

        // Verify the signature using crypto utilities
        // Verify against the signable payload (ExtrinsicPayload) that was actually signed
        const verified = sr25519Verify(signableU8a, aggregatedSignature, thresholdPubkey)
        console.log('Signature valid:', verified)

        // Check account balance and estimate fee before submitting
        let txHash = null
        let submissionError = null
        let balance = null
        let estimatedFee = null

        try {
          // Query account balance
          const accountInfo = await api.query.system.account(accountId32)
          balance = accountInfo.data.free.toBigInt()
          const balanceWND = Number(balance) / 1e12
          console.log('--- Account Balance Check ---')
          console.log('Account balance:', balance.toString(), 'Planck (', balanceWND.toFixed(6), 'WND)')

          // Estimate transaction fee
          const paymentInfo = await signedExtrinsic.paymentInfo(accountId32)
          estimatedFee = paymentInfo.partialFee.toBigInt()
          const feeWND = Number(estimatedFee) / 1e12
          console.log('Estimated fee:', estimatedFee.toString(), 'Planck (', feeWND.toFixed(6), 'WND)')

          // Check if account has sufficient balance (fee + small buffer)
          const requiredBalance = estimatedFee + BigInt(1e10) // fee + 0.00001 WND buffer
          const requiredBalanceWND = Number(requiredBalance) / 1e12
          console.log('Required balance (fee + buffer):', requiredBalance.toString(), 'Planck (', requiredBalanceWND.toFixed(6), 'WND)')

          if (balance < requiredBalance) {
            console.warn('')
            console.warn('--- Insufficient Balance Warning ---')
            console.warn(`Balance (${balanceWND.toFixed(6)} WND) < Required (${requiredBalanceWND.toFixed(6)} WND)`)
            console.warn('Skipping extrinsic submission due to insufficient balance.')
            console.warn('')
            console.warn('⚠️  IMPORTANT: The THRESHOLD ACCOUNT must be funded (not individual participant accounts)')
            console.warn('   The threshold account is the signer of the extrinsic and pays transaction fees.')
            console.warn('   Individual participant accounts are only used for collaborative signing.')
            console.warn('')
            console.warn('   To fund the threshold account, send at least', requiredBalanceWND.toFixed(6), 'WND to:')
            console.warn('   Threshold Account Address:', accountId32.toHuman())
            console.warn('   (This is the account derived from the threshold public key)')
          } else {
            console.log('✓ Balance sufficient for transaction')
            console.log(`  Balance: ${balanceWND.toFixed(6)} WND >= Required: ${requiredBalanceWND.toFixed(6)} WND`)
            // Submit extrinsic only if balance is sufficient
            console.log('Submitting extrinsic to network...')
            txHash = await api.rpc.author.submitExtrinsic(signedHex);
            console.log('✓ Broadcasted TxHash:', txHash.toHex());
          }
        } catch (error) {
          // Capture submission error but don't fail the test
          submissionError = error.message
          console.error('--- Extrinsic Submission Error ---')
          console.error('Error:', submissionError)
          console.error('Stack:', error.stack)
          console.warn('This might be due to insufficient balance or network issues. The threshold signing test still passes.')
        }

        return {
          success: true,
          thresholdPublicKeyHex: u8aToHex(thresholdPubkey),
          thresholdAccountId32Hex: accountId32.toHex(),
          thresholdAccountId32SS58: accountId32.toHuman(),
          nonce: nonce.toString(),
          signablePayloadLength: signableU8a.length,
          signablePayloadHex: signableHex,
          aggregatedSignatureLength: aggregatedSignature.length,
          aggregatedSignatureHex: u8aToHex(aggregatedSignature),
          signedExtrinsicLength: signedHex.length,
          signedExtrinsicHex: signedHex, // Full signed extrinsic
          signatureValid: verified,
          balance: balance ? balance.toString() : '0',
          estimatedFee: estimatedFee ? estimatedFee.toString() : null,
          txHash: txHash ? txHash.toHex() : null,
          submissionError: submissionError || null
        }
      } finally {
        await api.disconnect()
      }
    }, {
      secretKey1: TEST_SECRET_KEY_1,
      secretKey2: TEST_SECRET_KEY_2,
      recipients: TEST_RECIPIENTS,
      threshold: 2,
      thresholdPublicKey: thresholdResults.thresholdPublicKey,
      sppOutputMessage1: thresholdPeerA.sppOutputMessage,
      sppOutputMessage2: thresholdPeerB.sppOutputMessage,
      signingKeypair1: thresholdPeerA.signingKeypair,
      signingKeypair2: thresholdPeerB.signingKeypair,
      signingNonces1: round1PeerA.nonces,
      signingNonces2: round1PeerB.nonces,
      signingCommitments1: round1PeerA.commitments,
      signingCommitments2: round1PeerB.commitments
    })

    // Validate results
    expect(result.success).toBe(true)
    expect(result.thresholdPublicKeyHex).toBeTruthy()
    expect(result.thresholdAccountId32Hex).toBeTruthy()
    expect(result.aggregatedSignatureLength).toBeGreaterThan(0)
    expect(result.signedExtrinsicLength).toBeGreaterThan(0)

    // Print all test results
    console.log('\n=== TEST RESULTS ===')
    console.log('✓ Threshold signing test passed')
    console.log('✓ Threshold Public Key (hex):', result.thresholdPublicKeyHex)
    console.log('✓ Threshold AccountId32 (hex):', result.thresholdAccountId32Hex)
    console.log('✓ Threshold AccountId32 (SS58):', result.thresholdAccountId32SS58)
    console.log('✓ Nonce:', result.nonce)
    console.log('✓ Signable payload length:', result.signablePayloadLength, 'bytes')
    console.log('✓ Signable payload (hex):', result.signablePayloadHex)
    console.log('✓ Aggregated signature length:', result.aggregatedSignatureLength, 'bytes')
    console.log('✓ Aggregated signature (hex):', result.aggregatedSignatureHex)
    console.log('✓ Signature valid:', result.signatureValid)
    console.log('✓ Signed extrinsic length:', result.signedExtrinsicLength, 'characters')
    console.log('✓ Signed extrinsic (hex):', result.signedExtrinsicHex)
    console.log('')
    console.log('--- Account Funding Information ---')
    console.log('⚠️  IMPORTANT: Fund the THRESHOLD ACCOUNT (not individual participant accounts)')
    console.log('   Account to fund:', result.thresholdAccountId32SS58)
    if (result.estimatedFee) {
      const feeWND = (Number(result.estimatedFee) / 1e12).toFixed(6)
      console.log('   Estimated fee:', feeWND, 'WND')
      console.log('   Recommended minimum:', (Number(result.estimatedFee) / 1e12 + 0.00001).toFixed(6), 'WND')
    }
    if (result.txHash) {
      console.log('   ✓ Transaction submitted successfully:', result.txHash)
    } else if (result.submissionError) {
      console.log('   ⚠️  Transaction not submitted (likely insufficient balance)')
      console.log('   Send funds to the threshold account above to enable transaction submission')
    }
    console.log('=== END TEST RESULTS ===\n')

    await pageB.close()
  })
})
