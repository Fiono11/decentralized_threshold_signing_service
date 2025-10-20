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

  test.afterAll(() => {
    if (relayNode) {
      relayNode.stop()
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