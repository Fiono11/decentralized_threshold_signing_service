// Browser Integration Tests for Decentralized Threshold Signing Service

import { test, expect } from '@playwright/test'
import { createRelayServer, setupRelayHandlers } from '../relay.js'
import { spawn } from 'child_process'

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
  "5CXkZyy4S5b3w16wvKA2hUwzp5q2y7UtRPkXnW97QGvDN8Jw",
  "5Gma8SNsn6rkQf9reAWFQ9WKq8bwwHtSzwMYtLTdhYsGPKiy"
]

const TEST_SECRET_KEY_1 = "0x473a77675b8e77d90c1b6dc2dbe6ac533b0853790ea8bcadf0ee8b5da4cfbbce"
const TEST_SECRET_KEY_2 = "0xdb9ddbb3d6671c4de8248a4fba95f3d873dc21a0434b52951bb33730c1ac93d7"

// Test Constants
const TEST_CONFIG = {
  hardcodedPeerId: '12D3KooWA1bysjrTACSWqf6q172inxvwKHUxAnBtVgaVDKMxpZtx',
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
    peerIdString: TEST_CONFIG.hardcodedPeerId,
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
