// Browser Integration Tests for Decentralized Threshold Signing Service

import { setup, expect } from 'test-ipfs-example/browser'
import { createRelayServer, setupRelayHandlers } from '../relay.js'

const test = setup()

const messageInput = '#message'
const sendBtn = '#send'
const output = '#output'
const ss58AddressInput = '#ss58-address-input'
const storeAddressBtn = '#store-address-input'
const ss58Address = '#ss58-address'
const connectViaAddressBtn = '#connect-via-address'

let url

const TEST_SS58_ADDRESS_A = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY'
const TEST_SS58_ADDRESS_B = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty'

async function spawnRelay() {
  const HARDCODED_PEER_ID = '12D3KooWA1bysjrTACSWqf6q172inxvwKHUxAnBtVgaVDKMxpZtx'
  const testKvStore = new Map()

  const { server: relayNode, kvStore } = await createRelayServer({
    peerIdString: HARDCODED_PEER_ID,
    port: '8080',
    listenAddresses: ['/ip4/127.0.0.1/tcp/8080/ws'],
    kvStore: testKvStore
  })

  setupRelayHandlers(relayNode, kvStore)

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