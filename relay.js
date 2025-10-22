// LibP2P Relay Server with Key-Value Storage

import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { circuitRelayServer } from '@libp2p/circuit-relay-v2'
import { identify } from '@libp2p/identify'
import { webSockets } from '@libp2p/websockets'
import * as filters from '@libp2p/websockets/filters'
import { createLibp2p } from 'libp2p'
import { byteStream } from 'it-byte-stream'
import { fromString, toString } from 'uint8arrays'
import { peerIdFromString } from '@libp2p/peer-id'
import fetch from 'node-fetch'

// Constants
const KV_PROTOCOL = '/libp2p/examples/kv/1.0.0'
const KV_QUERY_PROTOCOL = '/libp2p/examples/kv-query/1.0.0'
const HARDCODED_PEER_ID = '12D3KooWA1bysjrTACSWqf6q172inxvwKHUxAnBtVgaVDKMxpZtx'
const EXTERNAL_PORT = '8080'
const MAX_RESERVATIONS = Infinity

// Error Codes
const STREAM_ABORT_ERROR = 'ERR_STREAM_ABORT'

// Default Key-Value Store
const kvStore = new Map()

// Utility Functions
const logInfo = (message) => console.log(message)
const logError = (message) => console.log(`ERROR: ${message}`)

const createSuccessResponse = (data = {}) => ({
  success: true,
  ...data
})

const createErrorResponse = (error) => ({
  success: false,
  error
})

const writeResponse = async (streamWriter, response) => {
  await streamWriter.write(fromString(JSON.stringify(response)))
}

// Server Configuration
const createDefaultListenAddresses = (port) => [
  `/ip4/0.0.0.0/tcp/${port}/ws`,
  `/ip6/::/tcp/${port}/ws`
]

// Relay Server Creation
export async function createRelayServer(options = {}) {
  const {
    peerIdString = HARDCODED_PEER_ID,
    port = EXTERNAL_PORT,
    listenAddresses = createDefaultListenAddresses(port),
    kvStore: customKvStore = kvStore
  } = options

  const peerId = await peerIdFromString(peerIdString)

  const server = await createLibp2p({
    peerId,
    addresses: {
      listen: listenAddresses,
    },
    transports: [webSockets({ filter: filters.all })],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      relay: circuitRelayServer({
        reservations: { maxReservations: MAX_RESERVATIONS }
      })
    }
  })

  return { server, kvStore: customKvStore }
}

// KV Storage Handler Functions
const processKvStorageRequest = async (kvPair, kvStore) => {
  if (!kvPair.key || kvPair.value === undefined) {
    throw new Error('Invalid format')
  }

  const storageData = {
    value: kvPair.value,
    circuitRelay: kvPair.circuitRelay || null
  }

  kvStore.set(kvPair.key, JSON.stringify(storageData))
  logInfo(`Stored: ${kvPair.key} -> ${kvPair.value} (${kvStore.size} total)`)

  return createSuccessResponse({ message: 'Stored successfully' })
}

const handleKvStorageStream = async (streamReader, streamWriter, kvStore) => {
  while (true) {
    const data = await streamReader.read()
    if (data === null) {
      break // End of stream
    }

    const message = toString(data.subarray())
    let response

    try {
      const kvPair = JSON.parse(message)
      response = await processKvStorageRequest(kvPair, kvStore)
    } catch (parseError) {
      logError(`Invalid JSON: ${message}`)
      response = createErrorResponse('Invalid JSON')
    }

    await writeResponse(streamWriter, response)
  }
}

// KV Storage Protocol Handler
const setupKvStorageHandler = (server, kvStore) => {
  server.handle(KV_PROTOCOL, async ({ stream, connection }) => {
    const streamReader = byteStream(stream)
    const streamWriter = byteStream(stream)

    try {
      await handleKvStorageStream(streamReader, streamWriter, kvStore)
    } catch (error) {
      if (error.code !== STREAM_ABORT_ERROR) {
        logError(`KV stream error: ${error.message}`)
      }
    }
  })
}

// KV Query Handler Functions
const processGetQuery = (query, kvStore) => {
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
    } catch (parseError) {
      // Handle legacy format (direct value storage)
      value = storedData
      found = true
    }
  }

  logInfo(`Query: ${query.key} -> ${value ? 'found' : 'not found'}`)

  return createSuccessResponse({
    key: query.key,
    value,
    circuitRelay,
    found
  })
}

const processListQuery = (kvStore) => {
  const keys = Array.from(kvStore.keys())
  logInfo(`List query: ${keys.length} keys`)

  return createSuccessResponse({
    keys,
    count: keys.length
  })
}

const processDeleteQuery = (query, kvStore) => {
  const deleted = kvStore.delete(query.key)
  logInfo(`Delete: ${query.key} (${deleted ? 'deleted' : 'not found'}) - ${kvStore.size} remaining`)

  return createSuccessResponse({
    key: query.key,
    deleted
  })
}

const processKvQuery = (query, kvStore) => {
  if (query.action === 'get' && query.key) {
    return processGetQuery(query, kvStore)
  } else if (query.action === 'list') {
    return processListQuery(kvStore)
  } else if (query.action === 'delete' && query.key) {
    return processDeleteQuery(query, kvStore)
  } else {
    throw new Error('Invalid format')
  }
}

const handleKvQueryStream = async (streamReader, streamWriter, kvStore) => {
  while (true) {
    const data = await streamReader.read()
    if (data === null) {
      break // End of stream
    }

    const message = toString(data.subarray())
    let response

    try {
      const query = JSON.parse(message)
      response = processKvQuery(query, kvStore)
    } catch (error) {
      if (error instanceof SyntaxError) {
        logError(`Invalid JSON query: ${message}`)
        response = createErrorResponse('Invalid JSON')
      } else {
        logError(`Invalid query: ${message}`)
        response = createErrorResponse(error.message)
      }
    }

    await writeResponse(streamWriter, response)
  }
}

// KV Query Protocol Handler
const setupKvQueryHandler = (server, kvStore) => {
  server.handle(KV_QUERY_PROTOCOL, async ({ stream, connection }) => {
    const streamReader = byteStream(stream)
    const streamWriter = byteStream(stream)

    try {
      await handleKvQueryStream(streamReader, streamWriter, kvStore)
    } catch (error) {
      if (error.code !== STREAM_ABORT_ERROR) {
        logError(`Query stream error: ${error.message}`)
      }
    }
  })
}

// Main Handler Setup Function
export function setupRelayHandlers(server, kvStore) {
  setupKvStorageHandler(server, kvStore)
  setupKvQueryHandler(server, kvStore)
}

// Server Startup and Logging
const logServerInfo = (server) => {
  logInfo('Relay server started:')
  logInfo(`Peer ID: ${server.peerId.toString()}`)
  logInfo(`Listening on: ${server.getMultiaddrs().map(ma => ma.toString()).join(', ')}`)
  logInfo('Protocols: KV storage, KV query ready')
}

// Standalone Server Startup
const startStandaloneServer = async () => {
  const { server, kvStore: serverKvStore } = await createRelayServer()
  setupRelayHandlers(server, serverKvStore)
  logServerInfo(server)
}

// For standalone server usage - only run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  startStandaloneServer()
}
