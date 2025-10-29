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
import { cryptoWaitReady, sr25519Verify, sr25519PairFromSeed } from '@polkadot/util-crypto'
import { decodeAddress, encodeAddress } from '@polkadot/keyring'
import { hexToU8a } from '@polkadot/util'

// Constants
const KV_PROTOCOL = '/libp2p/examples/kv/1.0.0'
const KV_QUERY_PROTOCOL = '/libp2p/examples/kv-query/1.0.0'
const PROOF_OF_POSSESSION_PROTOCOL = '/libp2p/examples/proof-of-possession/1.0.0'
const CONNECTION_CHALLENGE_PROTOCOL = '/libp2p/examples/connection-challenge/1.0.0'
const CONNECTION_PERMISSION_PROTOCOL = '/libp2p/examples/connection-permission/1.0.0'
const HARDCODED_PEER_ID = '12D3KooWA1bysjrTACSWqf6q172inxvwKHUxAnBtVgaVDKMxpZtx'
const EXTERNAL_PORT = '8080'
const MAX_RESERVATIONS = Infinity

// Error Codes
const STREAM_ABORT_ERROR = 'ERR_STREAM_ABORT'

// Default Key-Value Store
const kvStore = new Map()

// Challenge store for proof of possession
const challengeStore = new Map()

// Permission request store for connection permissions
const permissionRequests = new Map()

// Utility Functions
const logInfo = (message) => console.log(message)
const logError = (message) => console.log(`ERROR: ${message}`)

// Initialize crypto
let cryptoReady = false
const initializeCrypto = async () => {
  if (!cryptoReady) {
    await cryptoWaitReady()
    cryptoReady = true
  }
}

// Generate a random challenge
const generateChallenge = () => {
  const challenge = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(challenge).map(b => b.toString(16).padStart(2, '0')).join('')
}

// Verify SS58 address format
const validateSS58Address = (address) => {
  if (!address || typeof address !== 'string') {
    throw new Error('Invalid address: must be a non-empty string')
  }

  try {
    const decoded = decodeAddress(address)
    const reEncoded = encodeAddress(decoded)
    if (address !== reEncoded) {
      throw new Error('Address format is not canonical. Expected: ' + reEncoded)
    }
    return true
  } catch (error) {
    throw new Error(`Invalid SS58 address: ${error.message}`)
  }
}

// Verify signature for proof of possession
const verifyProofOfPossession = async (ss58Address, challenge, signature) => {
  try {
    await initializeCrypto()

    // Validate SS58 address
    validateSS58Address(ss58Address)

    // Convert challenge to bytes (challenge is already a hex string without 0x prefix)
    const challengeBytes = hexToU8a('0x' + challenge)

    // Convert signature to Uint8Array
    const signatureBytes = typeof signature === 'string'
      ? hexToU8a(signature.startsWith('0x') ? signature : '0x' + signature)
      : new Uint8Array(signature)

    // Decode the SS58 address to get the public key
    const publicKey = decodeAddress(ss58Address)

    // Verify the signature
    const isValid = sr25519Verify(challengeBytes, signatureBytes, publicKey)

    return isValid
  } catch (error) {
    logError(`Proof of possession verification failed: ${error.message}`)
    return false
  }
}

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

// Proof of Possession Handler Functions
const processChallengeRequest = (request) => {
  if (!request.ss58Address) {
    throw new Error('SS58 address is required')
  }

  // Validate SS58 address format
  validateSS58Address(request.ss58Address)

  // Generate challenge
  const challenge = generateChallenge()

  // Store challenge with timestamp (expires in 5 minutes)
  const expiresAt = Date.now() + (5 * 60 * 1000)
  challengeStore.set(request.ss58Address, {
    challenge,
    expiresAt
  })

  logInfo(`Generated challenge for ${request.ss58Address}: ${challenge}`)

  return createSuccessResponse({
    challenge,
    message: 'Challenge generated successfully'
  })
}

const processProofRequest = async (request, kvStore) => {
  if (!request.ss58Address || !request.challenge || !request.signature) {
    throw new Error('SS58 address, challenge, and signature are required')
  }

  // Validate SS58 address format
  validateSS58Address(request.ss58Address)

  // Check if challenge exists and is not expired
  const storedChallenge = challengeStore.get(request.ss58Address)
  if (!storedChallenge) {
    throw new Error('No challenge found for this address')
  }

  if (Date.now() > storedChallenge.expiresAt) {
    challengeStore.delete(request.ss58Address)
    throw new Error('Challenge has expired')
  }

  if (storedChallenge.challenge !== request.challenge) {
    throw new Error('Invalid challenge')
  }

  // Verify the signature
  const isValid = await verifyProofOfPossession(request.ss58Address, request.challenge, request.signature)

  if (!isValid) {
    throw new Error('Invalid signature')
  }

  // Clean up the challenge
  challengeStore.delete(request.ss58Address)

  // Store the address with proof of possession
  const storageData = {
    value: request.webrtcMultiaddr,
    circuitRelay: request.circuitRelay || null,
    proofOfPossession: {
      verified: true,
      verifiedAt: Date.now()
    }
  }

  kvStore.set(request.ss58Address, JSON.stringify(storageData))
  logInfo(`Stored with proof of possession: ${request.ss58Address} -> ${request.webrtcMultiaddr} (${kvStore.size} total)`)

  return createSuccessResponse({
    message: 'Address registered with proof of possession',
    verified: true
  })
}

const processProofOfPossessionRequest = async (request, kvStore) => {
  if (request.action === 'challenge') {
    return processChallengeRequest(request)
  } else if (request.action === 'proof') {
    return processProofRequest(request, kvStore)
  } else {
    throw new Error('Invalid action. Must be "challenge" or "proof"')
  }
}

const handleProofOfPossessionStream = async (streamReader, streamWriter, kvStore) => {
  while (true) {
    const data = await streamReader.read()
    if (data === null) {
      break // End of stream
    }

    const message = toString(data.subarray())
    let response

    try {
      const request = JSON.parse(message)
      response = await processProofOfPossessionRequest(request, kvStore)
    } catch (error) {
      if (error instanceof SyntaxError) {
        logError(`Invalid JSON: ${message}`)
        response = createErrorResponse('Invalid JSON')
      } else {
        logError(`Proof of possession error: ${error.message}`)
        response = createErrorResponse(error.message)
      }
    }

    await writeResponse(streamWriter, response)
  }
}

// Proof of Possession Protocol Handler
const setupProofOfPossessionHandler = (server, kvStore) => {
  server.handle(PROOF_OF_POSSESSION_PROTOCOL, async ({ stream, connection }) => {
    const streamReader = byteStream(stream)
    const streamWriter = byteStream(stream)

    try {
      await handleProofOfPossessionStream(streamReader, streamWriter, kvStore)
    } catch (error) {
      if (error.code !== STREAM_ABORT_ERROR) {
        logError(`Proof of possession stream error: ${error.message}`)
      }
    }
  })
}

// Connection Permission Handler Functions
const processPermissionRequest = async (request, kvStore) => {
  if (request.action === 'request') {
    // Peer A wants to connect to Peer B - forward the request
    const { targetSS58Address, requesterSS58Address, requesterPeerId } = request

    // Validate that the target address exists in the store
    const targetData = kvStore.get(targetSS58Address)
    if (!targetData) {
      return createErrorResponse('Target peer not found')
    }

    // Store the permission request
    const requestId = crypto.randomUUID()
    const expiresAt = Date.now() + (10 * 60 * 1000) // 10 minutes
    permissionRequests.set(requestId, {
      targetSS58Address,
      requesterSS58Address,
      requesterPeerId,
      status: 'pending',
      expiresAt,
      createdAt: Date.now()
    })

    logInfo(`Permission request ${requestId}: ${requesterSS58Address} wants to connect to ${targetSS58Address}`)

    return createSuccessResponse({
      requestId,
      message: 'Permission request forwarded'
    })

  } else if (request.action === 'respond') {
    // Target peer is responding to a permission request
    const { requestId, accepted } = request

    const permissionRequest = permissionRequests.get(requestId)
    if (!permissionRequest) {
      return createErrorResponse('Permission request not found')
    }

    if (Date.now() > permissionRequest.expiresAt) {
      permissionRequests.delete(requestId)
      return createErrorResponse('Permission request has expired')
    }

    // Update the request status
    permissionRequest.status = accepted ? 'accepted' : 'rejected'
    permissionRequest.respondedAt = Date.now()

    logInfo(`Permission request ${requestId}: ${accepted ? 'accepted' : 'rejected'}`)

    return createSuccessResponse({
      message: `Permission request ${accepted ? 'accepted' : 'rejected'}`,
      accepted
    })

  } else if (request.action === 'check') {
    // Check if a permission request exists for a specific target
    const { targetSS58Address } = request

    // Find pending requests for this target
    const pendingRequests = Array.from(permissionRequests.values())
      .filter(req => req.targetSS58Address === targetSS58Address && req.status === 'pending')
      .map(req => ({
        requestId: Array.from(permissionRequests.entries()).find(([id, r]) => r === req)?.[0],
        requesterSS58Address: req.requesterSS58Address,
        requesterPeerId: req.requesterPeerId,
        createdAt: req.createdAt
      }))

    return createSuccessResponse({
      pendingRequests,
      count: pendingRequests.length
    })

  } else if (request.action === 'get_status') {
    // Get the status of a specific permission request
    const { requestId } = request

    const permissionRequest = permissionRequests.get(requestId)
    if (!permissionRequest) {
      return createErrorResponse('Permission request not found')
    }

    return createSuccessResponse({
      requestId,
      status: permissionRequest.status,
      accepted: permissionRequest.status === 'accepted',
      respondedAt: permissionRequest.respondedAt
    })

  } else {
    throw new Error('Invalid action. Must be "request", "respond", "check", or "get_status"')
  }
}

// Connection Challenge Handler Functions
const processConnectionChallengeRequest = async (request, kvStore) => {
  // Connection challenges are handled peer-to-peer, not through the relay
  // The relay only facilitates the initial connection discovery
  // This handler is a placeholder for future relay-based connection challenges if needed
  return createErrorResponse('Connection challenges are handled peer-to-peer')
}

const handlePermissionRequestStream = async (streamReader, streamWriter, kvStore) => {
  while (true) {
    const data = await streamReader.read()
    if (data === null) {
      break // End of stream
    }

    const message = toString(data.subarray())
    let response

    try {
      const request = JSON.parse(message)
      response = await processPermissionRequest(request, kvStore)
    } catch (error) {
      if (error instanceof SyntaxError) {
        logError(`Invalid JSON: ${message}`)
        response = createErrorResponse('Invalid JSON')
      } else {
        logError(`Permission request error: ${error.message}`)
        response = createErrorResponse(error.message)
      }
    }

    await writeResponse(streamWriter, response)
  }
}

const handleConnectionChallengeStream = async (streamReader, streamWriter, kvStore) => {
  while (true) {
    const data = await streamReader.read()
    if (data === null) {
      break // End of stream
    }

    const message = toString(data.subarray())
    let response

    try {
      const request = JSON.parse(message)
      response = await processConnectionChallengeRequest(request, kvStore)
    } catch (error) {
      if (error instanceof SyntaxError) {
        logError(`Invalid JSON: ${message}`)
        response = createErrorResponse('Invalid JSON')
      } else {
        logError(`Connection challenge error: ${error.message}`)
        response = createErrorResponse(error.message)
      }
    }

    await writeResponse(streamWriter, response)
  }
}

// Connection Permission Protocol Handler
const setupConnectionPermissionHandler = (server, kvStore) => {
  server.handle(CONNECTION_PERMISSION_PROTOCOL, async ({ stream, connection }) => {
    const streamReader = byteStream(stream)
    const streamWriter = byteStream(stream)

    try {
      await handlePermissionRequestStream(streamReader, streamWriter, kvStore)
    } catch (error) {
      if (error.code !== STREAM_ABORT_ERROR) {
        logError(`Permission request stream error: ${error.message}`)
      }
    }
  })
}

// Connection Challenge Protocol Handler
const setupConnectionChallengeHandler = (server, kvStore) => {
  server.handle(CONNECTION_CHALLENGE_PROTOCOL, async ({ stream, connection }) => {
    const streamReader = byteStream(stream)
    const streamWriter = byteStream(stream)

    try {
      await handleConnectionChallengeStream(streamReader, streamWriter, kvStore)
    } catch (error) {
      if (error.code !== STREAM_ABORT_ERROR) {
        logError(`Connection challenge stream error: ${error.message}`)
      }
    }
  })
}

// Main Handler Setup Function
export function setupRelayHandlers(server, kvStore) {
  setupKvStorageHandler(server, kvStore)
  setupKvQueryHandler(server, kvStore)
  setupProofOfPossessionHandler(server, kvStore)
  setupConnectionChallengeHandler(server, kvStore)
  setupConnectionPermissionHandler(server, kvStore)
}

// Server Startup and Logging
const logServerInfo = (server) => {
  logInfo('Relay server started:')
  logInfo(`Peer ID: ${server.peerId.toString()}`)
  logInfo(`Listening on: ${server.getMultiaddrs().map(ma => ma.toString()).join(', ')}`)
  logInfo('Protocols: KV storage, KV query, Proof of Possession, Connection Challenge, Connection Permission ready')
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
