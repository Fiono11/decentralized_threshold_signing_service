// Browser Integration Tests for Decentralized Threshold Signing Service

import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { circuitRelayServer } from '@libp2p/circuit-relay-v2'
import { identify } from '@libp2p/identify'
import { webSockets } from '@libp2p/websockets'
import * as filters from '@libp2p/websockets/filters'
import { createLibp2p } from 'libp2p'
import { setup, expect } from 'test-ipfs-example/browser'
import { byteStream } from 'it-byte-stream'
import { fromString, toString } from 'uint8arrays'
import { peerIdFromString } from '@libp2p/peer-id'

const test = setup()

const messageInput = '#message'
const sendBtn = '#send'
const output = '#output'
const ss58AddressInput = '#ss58-address-input'
const storeAddressBtn = '#store-address-input'
const ss58Address = '#ss58-address'
const connectViaAddressBtn = '#connect-via-address'

let url

const KV_PROTOCOL = '/libp2p/examples/kv/1.0.0'
const KV_QUERY_PROTOCOL = '/libp2p/examples/kv-query/1.0.0'

const TEST_SS58_ADDRESS_A = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY'
const TEST_SS58_ADDRESS_B = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty'

// Test data for WASM integration tests
const TEST_RECIPIENTS = [
  "5CXkZyy4S5b3w16wvKA2hUwzp5q2y7UtRPkXnW97QGvDN8Jw",
  "5Gma8SNsn6rkQf9reAWFQ9WKq8bwwHtSzwMYtLTdhYsGPKiy"
]

const TEST_SECRET_KEY_1 = "0x473a77675b8e77d90c1b6dc2dbe6ac533b0853790ea8bcadf0ee8b5da4cfbbce"
const TEST_SECRET_KEY_2 = "0xdb9ddbb3d6671c4de8248a4fba95f3d873dc21a0434b52951bb33730c1ac93d7"

async function spawnRelay() {
  const HARDCODED_PEER_ID = '12D3KooWA1bysjrTACSWqf6q172inxvwKHUxAnBtVgaVDKMxpZtx'
  const peerId = await peerIdFromString(HARDCODED_PEER_ID)

  const relayNode = await createLibp2p({
    peerId,
    addresses: {
      listen: ['/ip4/127.0.0.1/tcp/8080/ws']
    },
    transports: [webSockets({ filter: filters.all })],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      relay: circuitRelayServer({
        reservations: { maxReservations: Infinity }
      })
    }
  })

  const kvStore = new Map()

  relayNode.handle(KV_PROTOCOL, async ({ stream, connection }) => {
    const streamReader = byteStream(stream)
    const streamWriter = byteStream(stream)

    try {
      while (true) {
        const data = await streamReader.read()
        const message = toString(data.subarray())

        try {
          const kvPair = JSON.parse(message)
          if (kvPair.key && kvPair.value !== undefined) {
            const storageData = {
              value: kvPair.value,
              circuitRelay: kvPair.circuitRelay || null
            }
            kvStore.set(kvPair.key, JSON.stringify(storageData))
            const response = { success: true, message: 'Stored successfully' }
            await streamWriter.write(fromString(JSON.stringify(response)))
          } else {
            const response = { success: false, error: 'Invalid format' }
            await streamWriter.write(fromString(JSON.stringify(response)))
          }
        } catch (parseError) {
          const response = { success: false, error: 'Invalid JSON' }
          await streamWriter.write(fromString(JSON.stringify(response)))
        }
      }
    } catch (error) { }
  })

  relayNode.handle(KV_QUERY_PROTOCOL, async ({ stream, connection }) => {
    const streamReader = byteStream(stream)
    const streamWriter = byteStream(stream)

    try {
      while (true) {
        const data = await streamReader.read()
        const message = toString(data.subarray())

        try {
          const query = JSON.parse(message)

          if (query.action === 'get' && query.key) {
            const storedData = kvStore.get(query.key)
            let value = null
            let circuitRelay = null
            let found = false

            if (storedData !== undefined) {
              try {
                const parsed = JSON.parse(storedData)
                value = parsed.value
                circuitRelay = parsed.circuitRelay
                found = true
              } catch (e) {
                value = storedData
                found = true
              }
            }

            const response = {
              success: true,
              key: query.key,
              value: value,
              circuitRelay: circuitRelay,
              found: found
            }
            await streamWriter.write(fromString(JSON.stringify(response)))
          } else {
            const response = { success: false, error: 'Invalid format' }
            await streamWriter.write(fromString(JSON.stringify(response)))
          }
        } catch (parseError) {
          const response = { success: false, error: 'Invalid JSON' }
          await streamWriter.write(fromString(JSON.stringify(response)))
        }
      }
    } catch (error) { }
  })

  const relayNodeAddr = relayNode.getMultiaddrs()[0].toString()
  console.log(`Test relay listening on: ${relayNodeAddr}`)

  return { relayNode, relayNodeAddr }
}

test.describe('browser to browser example:', () => {
  let relayNode
  let relayNodeAddr

  // eslint-disable-next-line no-empty-pattern
  test.beforeAll(async ({ servers }, testInfo) => {
    testInfo.setTimeout(5 * 60_000)
    const r = await spawnRelay()
    relayNode = r.relayNode
    relayNodeAddr = r.relayNodeAddr
    url = servers[0].url
  }, {})

  test.afterAll(async () => {
    if (relayNode) {
      await relayNode.stop()
    }
  })

  test.beforeEach(async ({ page }) => {
    await page.goto(url)
  })

  test('should connect to another browser peer and send a message via SS58 addresses', async ({ page: pageA, context }) => {
    test.setTimeout(120000)

    const pageB = await context.newPage()
    await pageB.goto(url)

    await waitForRelayConnection(pageA)
    await waitForRelayConnection(pageB)

    await storeSS58Address(pageA, TEST_SS58_ADDRESS_A)
    await storeSS58Address(pageB, TEST_SS58_ADDRESS_B)

    await connectViaSS58Address(pageB, TEST_SS58_ADDRESS_A)

    await sendMessage(pageA, pageB, 'hello B from A')
    await sendMessage(pageB, pageA, 'hello A from B')
  })
})

async function sendMessage(senderPage, recipientPage, message) {
  await senderPage.waitForSelector(messageInput, { state: 'visible' })
  await senderPage.fill(messageInput, message)
  await senderPage.click(sendBtn)
  await expect(senderPage.locator(output)).toContainText(`Sending: '${message}'`)
  await expect(recipientPage.locator(output)).toContainText(`Received: '${message}'`)
}

async function waitForRelayConnection(page) {
  const outputLocator = page.locator(output)
  await expect(outputLocator).toContainText('Connected to relay')
}

async function storeSS58Address(page, addressToStore) {
  await page.fill(ss58AddressInput, addressToStore)
  await page.click(storeAddressBtn)
  const outputLocator = page.locator(output)
  await expect(outputLocator).toContainText(`Valid address: ${addressToStore}`)
  await expect(outputLocator).toContainText('Address stored successfully')
}

async function connectViaSS58Address(page, addressToConnect) {
  await page.fill(ss58Address, addressToConnect)
  await page.click(connectViaAddressBtn)
  const outputLocator = page.locator(output)
  await expect(outputLocator).toContainText(`Looking up: ${addressToConnect}`)
  await expect(outputLocator).toContainText('Found:')
  await expect(outputLocator).toContainText('Connected to peer!', { timeout: 60000 })
}

// WASM Integration Tests
test.describe('WASM Integration Tests for Olaf Threshold Public Key Generation:', () => {
  test.beforeAll(async ({ servers }, testInfo) => {
    testInfo.setTimeout(5 * 60_000)
    url = servers[0].url
  }, {})

  test.beforeEach(async ({ page }) => {
    // Navigate to the main page which initializes WASM
    await page.goto(url)

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
    await pageB.goto(url)

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