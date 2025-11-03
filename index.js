// LibP2P Browser Client for Decentralized Threshold Signing Service

import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { identify, identifyPush } from '@libp2p/identify'
import { ping } from '@libp2p/ping'
import { webRTC } from '@libp2p/webrtc'
import { webSockets } from '@libp2p/websockets'
import { multiaddr } from '@multiformats/multiaddr'
import { WebRTC } from '@multiformats/multiaddr-matcher'
import { byteStream } from 'it-byte-stream'
import { createLibp2p } from 'libp2p'
import { fromString, toString } from 'uint8arrays'
import { decodeAddress, encodeAddress } from '@polkadot/keyring'
import { cryptoWaitReady, sr25519Sign, sr25519Verify, sr25519PairFromSeed } from '@polkadot/util-crypto'
import { hexToU8a } from '@polkadot/util'
import { createEd25519PeerId } from '@libp2p/peer-id-factory'
import initOlaf, { wasm_simplpedpop_contribute_all, wasm_keypair_from_secret, wasm_simplpedpop_recipient_all, wasm_aggregate_threshold_signature, wasm_threshold_sign_round1, wasm_threshold_sign_round2 } from './olaf/pkg/olaf.js'

// Constants
const WEBRTC_CODE = WebRTC.code
const CHAT_PROTOCOL = '/libp2p/examples/chat/1.0.0'
const KV_PROTOCOL = '/libp2p/examples/kv/1.0.0'
const KV_QUERY_PROTOCOL = '/libp2p/examples/kv-query/1.0.0'
const PROOF_OF_POSSESSION_PROTOCOL = '/libp2p/examples/proof-of-possession/1.0.0'
const CONNECTION_CHALLENGE_PROTOCOL = '/libp2p/examples/connection-challenge/1.0.0'
const CONNECTION_PERMISSION_PROTOCOL = '/libp2p/examples/connection-permission/1.0.0'
const CONNECTION_TIMEOUT = 10000
const STREAM_TIMEOUT = 5000
const CHAT_STREAM_TIMEOUT = 5000

// DOM Elements
const output = document.getElementById('output')
const sendSection = document.getElementById('send-section')

// WASM Threshold Signing State
let generatedAllMessage = null
let receivedAllMessage = null
let round1Nonces = null
let round1Commitments = null
let receivedRound1Commitments = [] // Array to store commitments from other participants
let round2SigningPackage = null
let receivedSigningPackages = [] // Array to store signing packages from other participants

// Session State Class
class SessionState {
  constructor() {
    this.peerMultiaddr = null
    this.chatStream = null
    this.mySS58Address = null
    this.mySecretKey = null
    this.connectionChallenges = new Map() // Store pending connection challenges
    this.pendingPermissionRequests = new Map() // Store incoming permission requests
    this.outgoingPermissionRequests = new Map() // Store outgoing permission requests
  }

  reset() {
    this.peerMultiaddr = null
    this.chatStream = null
    this.mySS58Address = null
    this.mySecretKey = null
    this.connectionChallenges.clear()
    this.pendingPermissionRequests.clear()
    this.outgoingPermissionRequests.clear()
  }
}

// Global State
let sessionState = new SessionState()
let cryptoReady = false

// Utility Functions
const appendOutput = (message) => {
  const div = document.createElement('div')
  div.appendChild(document.createTextNode(message))
  output.append(div)
}

const isWebrtc = (multiaddr) => WebRTC.matches(multiaddr)

const getRelayConnection = (node) => {
  const connections = node.getConnections()
  return connections.find(conn => !conn.remoteAddr.protoCodes().includes(WEBRTC_CODE))
}

const validatePolkadotAddress = (address) => {
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

// Initialize crypto
const initializeCrypto = async () => {
  if (!cryptoReady) {
    await cryptoWaitReady()
    cryptoReady = true
  }
}

// Sign a message with the secret key
const signMessage = async (message, secretKey) => {
  await initializeCrypto()

  // Convert message to Uint8Array
  // If message is a hex string, convert it to bytes, otherwise encode as text
  let messageBytes
  if (typeof message === 'string' && /^[0-9a-fA-F]+$/.test(message)) {
    // It's a hex string, convert to bytes
    messageBytes = hexToU8a('0x' + message)
  } else {
    // It's a text message, encode as text
    messageBytes = new TextEncoder().encode(message)
  }

  // Convert secret key to Uint8Array
  const secretKeyBytes = typeof secretKey === 'string'
    ? hexToU8a(secretKey.startsWith('0x') ? secretKey : '0x' + secretKey)
    : new Uint8Array(secretKey)

  // Create key pair from secret key
  const pair = sr25519PairFromSeed(secretKeyBytes)

  // Sign the message
  const signature = sr25519Sign(messageBytes, pair)

  return signature
}

// Convert signature to hex string
const signatureToHex = (signature) => {
  return '0x' + Array.from(signature).map(b => b.toString(16).padStart(2, '0')).join('')
}

// Generate a random challenge for connection proof of possession
const generateConnectionChallenge = () => {
  const challenge = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(challenge).map(b => b.toString(16).padStart(2, '0')).join('')
}

// Handle connection challenge requests
const handleConnectionChallengeRequest = async (request, connection, sessionState) => {
  if (!sessionState.mySS58Address || !sessionState.mySecretKey) {
    return { success: false, error: 'No SS58 address or secret key available' }
  }

  if (request.action === 'initiate') {
    // Peer A wants to connect - generate challenge for them
    const challenge = generateConnectionChallenge()
    const peerId = connection.remotePeer.toString()

    // Store challenge with expiration (5 minutes)
    const expiresAt = Date.now() + (5 * 60 * 1000)
    sessionState.connectionChallenges.set(peerId, {
      challenge,
      expiresAt,
      status: 'pending'
    })

    appendOutput(`Generated connection challenge for peer: ${peerId}`)
    return { success: true, challenge }

  } else if (request.action === 'respond') {
    // Peer A is responding with their signature
    const { challenge, signature } = request
    const peerId = connection.remotePeer.toString()

    // Verify the challenge exists and is not expired
    const storedChallenge = sessionState.connectionChallenges.get(peerId)
    if (!storedChallenge || Date.now() > storedChallenge.expiresAt) {
      sessionState.connectionChallenges.delete(peerId)
      return { success: false, error: 'Challenge expired or not found' }
    }

    if (storedChallenge.challenge !== challenge) {
      return { success: false, error: 'Invalid challenge' }
    }

    // Verify the signature
    const isValid = await verifyConnectionSignature(request.ss58Address, challenge, signature)
    if (!isValid) {
      return { success: false, error: 'Invalid signature' }
    }

    // Update challenge status
    storedChallenge.status = 'verified'
    storedChallenge.remoteSS58Address = request.ss58Address

    appendOutput(`Connection challenge verified for peer: ${peerId}`)
    return { success: true, message: 'Challenge verified' }

  } else if (request.action === 'challenge') {
    // Peer B wants to challenge Peer A back
    const peerId = connection.remotePeer.toString()
    const storedChallenge = sessionState.connectionChallenges.get(peerId)

    if (!storedChallenge || storedChallenge.status !== 'verified') {
      return { success: false, error: 'No verified connection found' }
    }

    // Generate our challenge for them
    const ourChallenge = generateConnectionChallenge()
    storedChallenge.ourChallenge = ourChallenge
    storedChallenge.ourChallengeExpires = Date.now() + (5 * 60 * 1000)

    appendOutput(`Generated mutual challenge for peer: ${peerId}`)
    return { success: true, challenge: ourChallenge }

  } else if (request.action === 'verify') {
    // Peer A is responding to our challenge
    const { challenge, signature } = request
    const peerId = connection.remotePeer.toString()
    const storedChallenge = sessionState.connectionChallenges.get(peerId)

    if (!storedChallenge || !storedChallenge.ourChallenge) {
      return { success: false, error: 'No pending challenge found' }
    }

    if (Date.now() > storedChallenge.ourChallengeExpires) {
      sessionState.connectionChallenges.delete(peerId)
      return { success: false, error: 'Challenge expired' }
    }

    if (storedChallenge.ourChallenge !== challenge) {
      return { success: false, error: 'Invalid challenge' }
    }

    // Verify the signature
    const isValid = await verifyConnectionSignature(request.ss58Address, challenge, signature)
    if (!isValid) {
      return { success: false, error: 'Invalid signature' }
    }

    // Both challenges verified - connection established
    storedChallenge.status = 'established'
    sessionState.connectionChallenges.delete(peerId) // Clean up

    appendOutput(`Mutual connection challenge verified - connection established!`)
    return { success: true, message: 'Connection established' }

  } else {
    return { success: false, error: 'Invalid action' }
  }
}

// Verify connection signature
const verifyConnectionSignature = async (ss58Address, challenge, signature) => {
  try {
    await initializeCrypto()

    // Convert challenge to bytes
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
    appendOutput(`Connection signature verification failed: ${error.message}`)
    return false
  }
}

// Permission Request Functions
const requestConnectionPermission = async (targetSS58Address, node, sessionState) => {
  const relayConnection = getRelayConnection(node)
  if (!relayConnection) {
    throw new Error('No relay connection found')
  }

  if (!sessionState.mySS58Address) {
    throw new Error('No SS58 address available')
  }

  appendOutput(`Requesting connection permission from: ${targetSS58Address}`)
  const stream = await node.dialProtocol(relayConnection.remoteAddr, CONNECTION_PERMISSION_PROTOCOL, {
    signal: AbortSignal.timeout(STREAM_TIMEOUT)
  })

  try {
    const streamWriter = byteStream(stream)
    const streamReader = byteStream(stream)

    const request = {
      action: 'request',
      targetSS58Address,
      requesterSS58Address: sessionState.mySS58Address,
      requesterPeerId: node.peerId.toString()
    }
    const message = JSON.stringify(request)

    await streamWriter.write(fromString(message))
    const response = await streamReader.read()

    if (response === null) {
      throw new Error('No response from relay')
    }

    const responseText = toString(response.subarray())
    const parsed = JSON.parse(responseText)

    if (parsed.success) {
      const requestId = parsed.requestId
      sessionState.outgoingPermissionRequests.set(requestId, {
        targetSS58Address,
        status: 'pending',
        createdAt: Date.now()
      })
      appendOutput(`Permission request sent. Request ID: ${requestId}`)
      return requestId
    } else {
      throw new Error(`Permission request failed: ${parsed.error}`)
    }
  } finally {
    await stream.close()
  }
}

const checkPermissionRequestStatus = async (requestId, node) => {
  const relayConnection = getRelayConnection(node)
  if (!relayConnection) {
    throw new Error('No relay connection found')
  }

  const stream = await node.dialProtocol(relayConnection.remoteAddr, CONNECTION_PERMISSION_PROTOCOL, {
    signal: AbortSignal.timeout(STREAM_TIMEOUT)
  })

  try {
    const streamWriter = byteStream(stream)
    const streamReader = byteStream(stream)

    const request = { action: 'get_status', requestId }
    const message = JSON.stringify(request)

    await streamWriter.write(fromString(message))
    const response = await streamReader.read()

    if (response === null) {
      throw new Error('No response from relay')
    }

    const responseText = toString(response.subarray())
    const parsed = JSON.parse(responseText)

    if (parsed.success) {
      return parsed
    } else {
      throw new Error(`Status check failed: ${parsed.error}`)
    }
  } finally {
    await stream.close()
  }
}

const respondToPermissionRequest = async (requestId, accepted, node, sessionState) => {
  const relayConnection = getRelayConnection(node)
  if (!relayConnection) {
    throw new Error('No relay connection found')
  }

  appendOutput(`${accepted ? 'Accepting' : 'Rejecting'} permission request: ${requestId}`)
  const stream = await node.dialProtocol(relayConnection.remoteAddr, CONNECTION_PERMISSION_PROTOCOL, {
    signal: AbortSignal.timeout(STREAM_TIMEOUT)
  })

  try {
    const streamWriter = byteStream(stream)
    const streamReader = byteStream(stream)

    const request = { action: 'respond', requestId, accepted }
    const message = JSON.stringify(request)

    await streamWriter.write(fromString(message))
    const response = await streamReader.read()

    if (response === null) {
      throw new Error('No response from relay')
    }

    const responseText = toString(response.subarray())
    const parsed = JSON.parse(responseText)

    if (parsed.success) {
      // Remove from pending requests
      sessionState.pendingPermissionRequests.delete(requestId)
      appendOutput(`Permission request ${accepted ? 'accepted' : 'rejected'}`)
      return true
    } else {
      throw new Error(`Response failed: ${parsed.error}`)
    }
  } finally {
    await stream.close()
  }
}

const checkForIncomingPermissionRequests = async (node, sessionState) => {
  if (!sessionState.mySS58Address) return

  const relayConnection = getRelayConnection(node)
  if (!relayConnection) return

  const stream = await node.dialProtocol(relayConnection.remoteAddr, CONNECTION_PERMISSION_PROTOCOL, {
    signal: AbortSignal.timeout(STREAM_TIMEOUT)
  })

  try {
    const streamWriter = byteStream(stream)
    const streamReader = byteStream(stream)

    const request = { action: 'check', targetSS58Address: sessionState.mySS58Address }
    const message = JSON.stringify(request)

    await streamWriter.write(fromString(message))
    const response = await streamReader.read()

    if (response === null) {
      return
    }

    const responseText = toString(response.subarray())
    const parsed = JSON.parse(responseText)

    if (parsed.success && parsed.pendingRequests.length > 0) {
      for (const req of parsed.pendingRequests) {
        if (!sessionState.pendingPermissionRequests.has(req.requestId)) {
          sessionState.pendingPermissionRequests.set(req.requestId, {
            requesterSS58Address: req.requesterSS58Address,
            requesterPeerId: req.requesterPeerId,
            createdAt: req.createdAt
          })
          displayPermissionRequest(req.requestId, req.requesterSS58Address)
        }
      }
    }
  } finally {
    await stream.close()
  }
}

const displayPermissionRequest = (requestId, requesterSS58Address) => {
  const permissionRequestsContainer = document.getElementById('permission-requests')

  // Clear the placeholder text if it exists
  const placeholder = permissionRequestsContainer.querySelector('p')
  if (placeholder) {
    placeholder.remove()
  }

  const div = document.createElement('div')
  div.className = 'permission-request'
  div.id = `permission-request-${requestId}`
  div.innerHTML = `
    <div style="border: 2px solid #007bff; padding: 15px; margin: 10px 0; border-radius: 8px; background-color: #f8f9fa; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
        <strong style="color: #007bff; font-size: 16px;">🔗 Incoming Connection Request</strong>
        <span style="font-size: 12px; color: #666; background-color: #e9ecef; padding: 2px 8px; border-radius: 4px;">${requestId.substring(0, 8)}...</span>
      </div>
      <div style="margin-bottom: 15px;">
        <strong>From:</strong> <span style="font-family: monospace; font-size: 14px;">${requesterSS58Address}</span><br>
        <strong>Time:</strong> <span style="color: #666;">${new Date().toLocaleTimeString()}</span>
      </div>
      <div style="display: flex; gap: 10px;">
        <button onclick="acceptPermissionRequest('${requestId}')" style="background-color: #28a745; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-weight: bold; transition: background-color 0.2s;">✓ Accept</button>
        <button onclick="rejectPermissionRequest('${requestId}')" style="background-color: #dc3545; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-weight: bold; transition: background-color 0.2s;">✗ Reject</button>
      </div>
    </div>
  `
  permissionRequestsContainer.appendChild(div)

  // Also log to output
  appendOutput(`New connection request from ${requesterSS58Address} (ID: ${requestId})`)
}

// Global functions for permission request buttons
window.acceptPermissionRequest = async (requestId) => {
  try {
    await respondToPermissionRequest(requestId, true, node, sessionState)
    // Remove the specific permission request UI
    const permissionDiv = document.getElementById(`permission-request-${requestId}`)
    if (permissionDiv) {
      permissionDiv.remove()
    }

    // If no more permission requests, show placeholder
    const permissionRequestsContainer = document.getElementById('permission-requests')
    const remainingRequests = permissionRequestsContainer.querySelectorAll('.permission-request')
    if (remainingRequests.length === 0) {
      const placeholder = document.createElement('p')
      placeholder.textContent = 'Incoming connection requests will appear here. You can accept or reject them.'
      permissionRequestsContainer.appendChild(placeholder)
    }
  } catch (error) {
    appendOutput(`Error accepting permission request: ${error.message}`)
  }
}

window.rejectPermissionRequest = async (requestId) => {
  try {
    await respondToPermissionRequest(requestId, false, node, sessionState)
    // Remove the specific permission request UI
    const permissionDiv = document.getElementById(`permission-request-${requestId}`)
    if (permissionDiv) {
      permissionDiv.remove()
    }

    // If no more permission requests, show placeholder
    const permissionRequestsContainer = document.getElementById('permission-requests')
    const remainingRequests = permissionRequestsContainer.querySelectorAll('.permission-request')
    if (remainingRequests.length === 0) {
      const placeholder = document.createElement('p')
      placeholder.textContent = 'Incoming connection requests will appear here. You can accept or reject them.'
      permissionRequestsContainer.appendChild(placeholder)
    }
  } catch (error) {
    appendOutput(`Error rejecting permission request: ${error.message}`)
  }
}

// Session Management
let node = null
let sessionId = null
let permissionRequestInterval = null

// Initialize a new session with unique Peer ID
const initializeSession = async () => {
  try {
    // Generate a unique Peer ID for this session
    const peerId = await createEd25519PeerId()
    sessionId = peerId.toString()

    appendOutput(`Starting new session with Peer ID: ${sessionId}`)

    // Reset session state
    sessionState.reset()

    // Create LibP2P node with unique Peer ID
    node = await createLibp2p({
      peerId,
      addresses: {
        listen: ['/p2p-circuit', '/webrtc']
      },
      transports: [
        webSockets(),
        webRTC(),
        circuitRelayTransport()
      ],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      connectionGater: {
        denyDialMultiaddr: () => false
      },
      services: {
        identify: identify(),
        identifyPush: identifyPush(),
        ping: ping()
      }
    })

    await node.start()

    // Set up event listeners
    setupEventListeners()

    // Connect to relay
    await connectToRelay()

    // Start periodic checking for incoming permission requests
    startPermissionRequestPolling()

    appendOutput(`Session initialized successfully`)

  } catch (error) {
    appendOutput(`Session initialization failed: ${error.message}`)
    throw error
  }
}

// Relay Configuration
const RELAY_HOST = '127.0.0.1'
const RELAY_PORT = '8080'
const RELAY_PEER_ID = '12D3KooWA1bysjrTACSWqf6q172inxvwKHUxAnBtVgaVDKMxpZtx'
const RELAY_ADDRESS = `/ip4/${RELAY_HOST}/tcp/${RELAY_PORT}/ws/p2p/${RELAY_PEER_ID}`

// Connection Management
const connectToRelay = async () => {
  try {
    appendOutput('Connecting to relay...')
    const relayMultiaddr = multiaddr(RELAY_ADDRESS)
    const signal = AbortSignal.timeout(CONNECTION_TIMEOUT)
    await node.dial(relayMultiaddr, { signal })
    appendOutput('Connected to relay')
  } catch (error) {
    if (error.name === 'AbortError') {
      appendOutput('Connection timeout')
    } else {
      appendOutput(`Connection failed: ${error.message}`)
    }
  }
}

// Set up event listeners
const setupEventListeners = () => {
  node.addEventListener('connection:open', async (event) => {
    const remoteAddr = event.detail.remoteAddr.toString()
    const logMessage = `Peer connected: ${remoteAddr}`
    appendOutput(logMessage)
    updateConnList()
  })

  node.addEventListener('connection:close', async (event) => {
    const remoteAddr = event.detail.remoteAddr.toString()
    const logMessage = `Peer disconnected: ${remoteAddr}`
    appendOutput(logMessage)
    updateConnList()
  })

  node.addEventListener('self:peer:update', updateMultiaddrs)

  // Set up protocol handlers
  setupProtocolHandlers()
}

// Set up protocol handlers
const setupProtocolHandlers = () => {
  // Chat Protocol Handler
  node.handle(CHAT_PROTOCOL, async ({ stream }) => {
    sessionState.chatStream = byteStream(stream)
    while (true) {
      const buffer = await sessionState.chatStream.read()
      if (buffer === null) {
        break // End of stream
      }
      const message = toString(buffer.subarray())
      appendOutput(`Received: '${message.substring(0, 50)}${message.length > 50 ? '...' : ''}'`)

      // Check if this is an AllMessage
      if (message.startsWith('ALL_MESSAGE:')) {
        const hexMessage = message.substring('ALL_MESSAGE:'.length)
        try {
          receivedAllMessage = hexToUint8Array('0x' + hexMessage)
          appendOutput(`✓ AllMessage received and stored: ${receivedAllMessage.length} bytes`)
        } catch (err) {
          appendOutput(`Error parsing received AllMessage: ${err.message}`)
        }
      }
      // Check if this is Round 1 commitments
      else if (message.startsWith('ROUND1_COMMITMENTS:')) {
        const hexCommitments = message.substring('ROUND1_COMMITMENTS:'.length)
        try {
          const commitmentsBytes = hexToUint8Array('0x' + hexCommitments)
          const commitmentsArray = Array.from(commitmentsBytes)
          receivedRound1Commitments.push(commitmentsArray)
          appendOutput(`✓ Round 1 commitments received and stored: ${commitmentsArray.length} bytes`)
          appendOutput(`✓ Total received commitments: ${receivedRound1Commitments.length}`)
        } catch (err) {
          appendOutput(`Error parsing received commitments: ${err.message}`)
        }
      }
      // Check if this is a signing package
      else if (message.startsWith('SIGNING_PACKAGE:')) {
        const hexPackage = message.substring('SIGNING_PACKAGE:'.length)
        try {
          const packageBytes = hexToUint8Array('0x' + hexPackage)
          const packageArray = Array.from(packageBytes)
          receivedSigningPackages.push(packageArray)
          appendOutput(`✓ Signing package received and stored: ${packageArray.length} bytes`)
          appendOutput(`✓ Total received signing packages: ${receivedSigningPackages.length}`)
        } catch (err) {
          appendOutput(`Error parsing received signing package: ${err.message}`)
        }
      }
    }
  })

  // Connection Challenge Protocol Handler
  node.handle(CONNECTION_CHALLENGE_PROTOCOL, async ({ stream, connection }) => {
    const streamReader = byteStream(stream)
    const streamWriter = byteStream(stream)

    try {
      while (true) {
        const data = await streamReader.read()
        if (data === null) {
          break // End of stream
        }

        const message = toString(data.subarray())
        let response

        try {
          const request = JSON.parse(message)
          response = await handleConnectionChallengeRequest(request, connection, sessionState)
        } catch (error) {
          appendOutput(`Connection challenge error: ${error.message}`)
          response = { success: false, error: error.message }
        }

        await streamWriter.write(fromString(JSON.stringify(response)))
      }
    } catch (error) {
      appendOutput(`Connection challenge stream error: ${error.message}`)
    }
  })
}

// Start periodic checking for incoming permission requests
const startPermissionRequestPolling = () => {
  permissionRequestInterval = setInterval(async () => {
    try {
      await checkForIncomingPermissionRequests(node, sessionState)
    } catch (error) {
      // Silently handle errors to avoid spamming the console
      // The error might be due to no relay connection or no SS58 address
    }
  }, 10000) // Check every 10 seconds
}

// Clean up session resources
const cleanupSession = async () => {
  try {
    // Clear permission request polling
    if (permissionRequestInterval) {
      clearInterval(permissionRequestInterval)
      permissionRequestInterval = null
    }

    // Close chat stream
    if (sessionState.chatStream) {
      try {
        await sessionState.chatStream.close()
      } catch (error) {
        // Stream might already be closed
      }
      sessionState.chatStream = null
    }

    // Stop the LibP2P node
    if (node) {
      try {
        await node.stop()
      } catch (error) {
        appendOutput(`Error stopping node: ${error.message}`)
      }
      node = null
    }

    // Reset session state
    sessionState.reset()
    sessionId = null

    appendOutput('Session cleaned up successfully')
  } catch (error) {
    appendOutput(`Error during session cleanup: ${error.message}`)
  }
}

// UI Update Functions
const updateConnList = () => {
  if (!node) return

  const connectionElements = node.getConnections().map((connection) => {
    if (WebRTC.matches(connection.remoteAddr)) {
      sessionState.peerMultiaddr = connection.remoteAddr
      sendSection.style.display = 'block'
    }
    const element = document.createElement('li')
    element.textContent = connection.remoteAddr.toString()
    return element
  })
  document.getElementById('connections').replaceChildren(...connectionElements)
}

const updateMultiaddrs = () => {
  if (!node) return

  const webrtcMultiaddrs = node.getMultiaddrs()
    .filter(multiaddr => isWebrtc(multiaddr))
    .map((multiaddr) => {
      const element = document.createElement('li')
      element.textContent = multiaddr.toString()
      return element
    })
  document.getElementById('multiaddrs').replaceChildren(...webrtcMultiaddrs)
}


// Chat Stream Management
const handleChatStream = async () => {
  if (sessionState.chatStream == null) {
    appendOutput('Opening chat stream')
    const signal = AbortSignal.timeout(CHAT_STREAM_TIMEOUT)
    try {
      const stream = await node.dialProtocol(sessionState.peerMultiaddr, CHAT_PROTOCOL, { signal })
      sessionState.chatStream = byteStream(stream)

      // Handle incoming messages
      Promise.resolve().then(async () => {
        while (true) {
          const buffer = await sessionState.chatStream.read()
          if (buffer === null) {
            break // End of stream
          }
          const message = toString(buffer.subarray())
          appendOutput(`Received: '${message.substring(0, 50)}${message.length > 50 ? '...' : ''}'`)

          // Check if this is an AllMessage
          if (message.startsWith('ALL_MESSAGE:')) {
            const hexMessage = message.substring('ALL_MESSAGE:'.length)
            try {
              receivedAllMessage = hexToU8a('0x' + hexMessage)
              appendOutput(`✓ AllMessage received and stored: ${receivedAllMessage.length} bytes`)
            } catch (err) {
              appendOutput(`Error parsing received AllMessage: ${err.message}`)
            }
          }
          // Check if this is Round 1 commitments
          else if (message.startsWith('ROUND1_COMMITMENTS:')) {
            const hexCommitments = message.substring('ROUND1_COMMITMENTS:'.length)
            try {
              const commitmentsBytes = hexToU8a('0x' + hexCommitments)
              const commitmentsArray = Array.from(commitmentsBytes)
              receivedRound1Commitments.push(commitmentsArray)
              appendOutput(`✓ Round 1 commitments received and stored: ${commitmentsArray.length} bytes`)
              appendOutput(`✓ Total received commitments: ${receivedRound1Commitments.length}`)
            } catch (err) {
              appendOutput(`Error parsing received commitments: ${err.message}`)
            }
          }
          // Check if this is a signing package
          else if (message.startsWith('SIGNING_PACKAGE:')) {
            const hexPackage = message.substring('SIGNING_PACKAGE:'.length)
            try {
              const packageBytes = hexToU8a('0x' + hexPackage)
              const packageArray = Array.from(packageBytes)
              receivedSigningPackages.push(packageArray)
              appendOutput(`✓ Signing package received and stored: ${packageArray.length} bytes`)
              appendOutput(`✓ Total received signing packages: ${receivedSigningPackages.length}`)
            } catch (err) {
              appendOutput(`Error parsing received signing package: ${err.message}`)
            }
          }
        }
      })
    } catch (error) {
      if (signal.aborted) {
        appendOutput('Chat stream timeout')
      } else {
        appendOutput(`Chat stream failed: ${error.message}`)
      }
      return false
    }
  }
  return true
}

const sendMessage = async (message) => {
  appendOutput(`Sending: '${message}'`)
  try {
    await sessionState.chatStream.write(fromString(message))
  } catch (error) {
    appendOutput(`Send error: ${error.message}`)
  }
}

// Send Button Handler
window.send.onclick = async () => {
  const streamReady = await handleChatStream()
  if (!streamReady) return

  const message = window.message.value.toString().trim()
  await sendMessage(message)
}

// Proof of Possession Functions
const requestChallenge = async (ss58Address, node) => {
  const relayConnection = getRelayConnection(node)
  if (!relayConnection) {
    throw new Error('No relay connection found')
  }

  appendOutput('Requesting challenge from relay...')
  const stream = await node.dialProtocol(relayConnection.remoteAddr, PROOF_OF_POSSESSION_PROTOCOL, {
    signal: AbortSignal.timeout(STREAM_TIMEOUT)
  })

  try {
    const streamWriter = byteStream(stream)
    const streamReader = byteStream(stream)

    const request = { action: 'challenge', ss58Address }
    const message = JSON.stringify(request)
    appendOutput(`Requesting challenge for: ${ss58Address}`)

    await streamWriter.write(fromString(message))
    const response = await streamReader.read()

    if (response === null) {
      throw new Error('No response from relay')
    }

    const responseText = toString(response.subarray())
    const parsed = JSON.parse(responseText)

    if (parsed.success) {
      appendOutput(`Challenge received: ${parsed.challenge}`)
      return parsed.challenge
    } else {
      throw new Error(`Challenge request failed: ${parsed.error}`)
    }
  } finally {
    await stream.close()
  }
}

const submitProof = async (ss58Address, challenge, signature, webrtcMultiaddr, node) => {
  const relayConnection = getRelayConnection(node)
  if (!relayConnection) {
    throw new Error('No relay connection found')
  }

  appendOutput('Submitting proof to relay...')
  const stream = await node.dialProtocol(relayConnection.remoteAddr, PROOF_OF_POSSESSION_PROTOCOL, {
    signal: AbortSignal.timeout(STREAM_TIMEOUT)
  })

  try {
    const streamWriter = byteStream(stream)
    const streamReader = byteStream(stream)

    const request = {
      action: 'proof',
      ss58Address,
      challenge,
      signature: signatureToHex(signature),
      webrtcMultiaddr: webrtcMultiaddr.toString()
    }
    const message = JSON.stringify(request)
    appendOutput(`Submitting proof for: ${ss58Address}`)

    await streamWriter.write(fromString(message))
    const response = await streamReader.read()

    if (response === null) {
      throw new Error('No response from relay')
    }

    const responseText = toString(response.subarray())
    const parsed = JSON.parse(responseText)

    if (parsed.success) {
      appendOutput('Proof of possession verified successfully!')
      return true
    } else {
      throw new Error(`Proof submission failed: ${parsed.error}`)
    }
  } finally {
    await stream.close()
  }
}

// Address Storage Functions
const getWebrtcMultiaddr = (node) => {
  const multiaddrs = node.getMultiaddrs()
  return multiaddrs.find(multiaddr => WebRTC.matches(multiaddr))
}

const storeAddressInRelay = async (polkadotAddress, webrtcMultiaddr, secretKey, node, sessionState) => {
  if (!secretKey) {
    throw new Error('Secret key is required for proof of possession')
  }

  try {
    // Step 1: Request challenge from relay
    const challenge = await requestChallenge(polkadotAddress, node)

    // Step 2: Sign the challenge with the secret key
    appendOutput('Signing challenge...')
    const signature = await signMessage(challenge, secretKey)

    // Step 3: Submit proof to relay
    await submitProof(polkadotAddress, challenge, signature, webrtcMultiaddr, node)

    sessionState.mySS58Address = polkadotAddress
    sessionState.mySecretKey = secretKey
    appendOutput('Address registered with proof of possession!')
  } catch (error) {
    throw new Error(`Proof of possession failed: ${error.message}`)
  }
}

// Store Address Button Handler
window['store-address-input'].onclick = async () => {
  const polkadotAddress = window['ss58-address-input'].value.toString().trim()
  const secretKey = window['secret-key-input'].value.toString().trim()

  if (!polkadotAddress) {
    appendOutput('Please enter a SS58 address')
    return
  }

  if (!secretKey) {
    appendOutput('Please enter a secret key')
    return
  }

  try {
    appendOutput('Validating SS58 address...')
    validatePolkadotAddress(polkadotAddress)
    appendOutput(`Valid address: ${polkadotAddress}`)

    appendOutput('Validating secret key...')
    // Validate secret key format (should be 32 bytes = 64 hex chars + 0x prefix)
    if (!secretKey.startsWith('0x') || secretKey.length !== 66) {
      throw new Error('Secret key must be 32 bytes (64 hex characters) with 0x prefix')
    }
    appendOutput(`Valid secret key: ${secretKey.substring(0, 10)}...`)

    const webrtcMultiaddr = getWebrtcMultiaddr(node)
    if (!webrtcMultiaddr) {
      const availableMultiaddrs = node.getMultiaddrs().map(ma => ma.toString()).join(', ')
      appendOutput(`No WebRTC address found. Available: ${availableMultiaddrs}`)
      return
    }

    await storeAddressInRelay(polkadotAddress, webrtcMultiaddr, secretKey, node, sessionState)
  } catch (error) {
    appendOutput(`Error: ${error.message}`)
  }
}

// Address Lookup Functions
const queryRelayForAddress = async (polkadotAddress, node) => {
  const relayConnection = getRelayConnection(node)
  if (!relayConnection) {
    throw new Error('No relay connection found')
  }

  const stream = await node.dialProtocol(relayConnection.remoteAddr, KV_QUERY_PROTOCOL, {
    signal: AbortSignal.timeout(STREAM_TIMEOUT)
  })

  try {
    const streamWriter = byteStream(stream)
    const streamReader = byteStream(stream)

    const query = { action: 'get', key: polkadotAddress }
    const message = JSON.stringify(query)
    appendOutput('Querying relay...')

    await streamWriter.write(fromString(message))
    const response = await streamReader.read()

    if (response === null) {
      throw new Error('No response from relay')
    }

    const responseText = toString(response.subarray())
    const parsed = JSON.parse(responseText)

    if (parsed.success && parsed.found) {
      return parsed.value
    } else if (parsed.success && !parsed.found) {
      throw new Error(`No peer found for: ${polkadotAddress}`)
    } else {
      throw new Error(`Query failed: ${parsed.error}`)
    }
  } finally {
    await stream.close()
  }
}

const connectToPeer = async (peerMultiaddrString, node, sessionState) => {
  appendOutput('Connecting to peer...')
  try {
    const dialSignal = AbortSignal.timeout(CONNECTION_TIMEOUT)
    const peerMultiaddr = multiaddr(peerMultiaddrString)
    await node.dial(peerMultiaddr, { signal: dialSignal })
    appendOutput('Connected to peer!')

    // Perform connection proof of possession
    await performConnectionProofOfPossession(peerMultiaddr, node, sessionState)
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Connection timeout')
    } else {
      throw new Error(`Connection failed: ${error.message}`)
    }
  }
}

const connectToPeerWithPermission = async (targetSS58Address, node, sessionState) => {
  if (!sessionState.mySS58Address) {
    throw new Error('No SS58 address available for permission request')
  }

  try {
    // Step 1: Request permission
    const requestId = await requestConnectionPermission(targetSS58Address, node, sessionState)
    appendOutput(`Waiting for permission from ${targetSS58Address}...`)

    // Step 2: Poll for permission status
    let permissionGranted = false
    let attempts = 0
    const maxAttempts = 60 // 5 minutes with 5-second intervals

    while (!permissionGranted && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 5000)) // Wait 5 seconds

      try {
        const status = await checkPermissionRequestStatus(requestId, node)
        if (status.accepted) {
          permissionGranted = true
          appendOutput(`Permission granted! Proceeding with connection...`)
        } else if (status.status === 'rejected') {
          throw new Error('Connection permission was rejected')
        }
        // If still pending, continue waiting
      } catch (error) {
        if (error.message.includes('Permission request not found')) {
          throw new Error('Permission request expired or was cancelled')
        }
        throw error
      }

      attempts++
    }

    if (!permissionGranted) {
      throw new Error('Permission request timed out')
    }

    // Step 3: Get the target peer's multiaddr and connect
    const peerMultiaddrString = await queryRelayForAddress(targetSS58Address, node)
    appendOutput(`Found peer address: ${peerMultiaddrString}`)

    // Step 4: Connect to the peer
    await connectToPeer(peerMultiaddrString, node, sessionState)

    // Clean up the outgoing request
    sessionState.outgoingPermissionRequests.delete(requestId)

  } catch (error) {
    appendOutput(`Permission-based connection failed: ${error.message}`)
    throw error
  }
}

// Perform connection proof of possession
const performConnectionProofOfPossession = async (peerMultiaddr, node, sessionState) => {
  if (!sessionState.mySS58Address || !sessionState.mySecretKey) {
    throw new Error('No SS58 address or secret key available for connection proof of possession')
  }

  let stream
  try {
    // Step 1: Initiate connection challenge
    appendOutput('Initiating connection proof of possession...')
    stream = await node.dialProtocol(peerMultiaddr, CONNECTION_CHALLENGE_PROTOCOL, {
      signal: AbortSignal.timeout(STREAM_TIMEOUT)
    })

    const streamWriter = byteStream(stream)
    const streamReader = byteStream(stream)

    // Step 2: Request challenge from peer
    const initiateRequest = { action: 'initiate' }
    await streamWriter.write(fromString(JSON.stringify(initiateRequest)))

    const challengeResponse = await streamReader.read()
    if (challengeResponse === null) {
      throw new Error('No challenge response from peer')
    }

    const challengeData = JSON.parse(toString(challengeResponse.subarray()))
    if (!challengeData.success) {
      throw new Error(`Challenge request failed: ${challengeData.error}`)
    }

    const challenge = challengeData.challenge
    appendOutput(`Received challenge: ${challenge}`)

    // Step 3: Sign the challenge and respond
    const signature = await signMessage(challenge, sessionState.mySecretKey)
    const respondRequest = {
      action: 'respond',
      ss58Address: sessionState.mySS58Address,
      challenge,
      signature: signatureToHex(signature)
    }

    await streamWriter.write(fromString(JSON.stringify(respondRequest)))
    const respondResponse = await streamReader.read()

    if (respondResponse === null) {
      throw new Error('No response to our signature')
    }

    const respondData = JSON.parse(toString(respondResponse.subarray()))
    if (!respondData.success) {
      throw new Error(`Signature verification failed: ${respondData.error}`)
    }

    appendOutput('Our signature verified!')

    // Step 4: Request mutual challenge from peer
    const challengeRequest = { action: 'challenge' }
    await streamWriter.write(fromString(JSON.stringify(challengeRequest)))

    const mutualChallengeResponse = await streamReader.read()
    if (mutualChallengeResponse === null) {
      throw new Error('No mutual challenge response from peer')
    }

    const mutualChallengeData = JSON.parse(toString(mutualChallengeResponse.subarray()))
    if (!mutualChallengeData.success) {
      throw new Error(`Mutual challenge request failed: ${mutualChallengeData.error}`)
    }

    const mutualChallenge = mutualChallengeData.challenge
    appendOutput(`Received mutual challenge: ${mutualChallenge}`)

    // Step 5: Sign the mutual challenge and verify
    const mutualSignature = await signMessage(mutualChallenge, sessionState.mySecretKey)
    const verifyRequest = {
      action: 'verify',
      ss58Address: sessionState.mySS58Address,
      challenge: mutualChallenge,
      signature: signatureToHex(mutualSignature)
    }

    await streamWriter.write(fromString(JSON.stringify(verifyRequest)))
    const verifyResponse = await streamReader.read()

    if (verifyResponse === null) {
      throw new Error('No response to our mutual signature')
    }

    const verifyData = JSON.parse(toString(verifyResponse.subarray()))
    if (!verifyData.success) {
      throw new Error(`Mutual signature verification failed: ${verifyData.error}`)
    }

    appendOutput('Mutual connection proof of possession completed!')

  } finally {
    if (stream) {
      await stream.close()
    }
  }
}

// Connect via Address Button Handler
window['connect-via-address'].onclick = async () => {
  const polkadotAddress = window['ss58-address'].value.toString().trim()

  if (!polkadotAddress) {
    appendOutput('Please enter a SS58 address')
    return
  }

  try {
    appendOutput(`Requesting connection to: ${polkadotAddress}`)
    await connectToPeerWithPermission(polkadotAddress, node, sessionState)
  } catch (error) {
    appendOutput(`Error: ${error.message}`)
  }
}

// Initialize WASM and helper functions
const initializeWasm = async () => {
  try {
    await initOlaf()

    // Expose WASM functions globally for testing
    window.wasm_simplpedpop_contribute_all = wasm_simplpedpop_contribute_all
    window.wasm_keypair_from_secret = wasm_keypair_from_secret
    window.wasm_simplpedpop_recipient_all = wasm_simplpedpop_recipient_all
    window.wasm_aggregate_threshold_signature = wasm_aggregate_threshold_signature
    window.wasm_threshold_sign_round1 = wasm_threshold_sign_round1
    window.wasm_threshold_sign_round2 = wasm_threshold_sign_round2
    window.wasmReady = true

    // Expose helper functions for testing
    window.ss58ToPublicKeyBytes = function (ss58Address) {
      try {
        const decoded = decodeAddress(ss58Address)
        return new Uint8Array(decoded)
      } catch (error) {
        throw new Error(`Failed to decode SS58 address ${ss58Address}: ${error.message}`)
      }
    }

    window.encodeAddress = encodeAddress

    window.hexToUint8Array = function (hexString) {
      const cleanHex = hexString.startsWith('0x') ? hexString.slice(2) : hexString
      const bytes = new Uint8Array(cleanHex.length / 2)
      for (let i = 0; i < cleanHex.length; i += 2) {
        bytes[i / 2] = parseInt(cleanHex.substring(i, i + 2), 16)
      }
      return bytes
    }

    window.createKeypairBytes = function (secretKeyHex) {
      const secretKeyBytes = window.hexToUint8Array(secretKeyHex)
      // Use the WASM function to generate a proper keypair from the secret key
      return window.wasm_keypair_from_secret(secretKeyBytes)
    }

    appendOutput('WASM module initialized successfully')
  } catch (error) {
    appendOutput(`Failed to initialize WASM: ${error.message}`)
    throw error
  }
}

// Initialize the session when the page loads
document.addEventListener('DOMContentLoaded', async () => {
  try {
    // Initialize WASM first
    await initializeWasm()
    // Then initialize the LibP2P session
    await initializeSession()
  } catch (error) {
    appendOutput(`Failed to initialize: ${error.message}`)
  }
})

// Clean up session when the page is unloaded
window.addEventListener('beforeunload', async () => {
  await cleanupSession()
})

// Add a function to restart the session (useful for debugging)
window.restartSession = async () => {
  try {
    appendOutput('Restarting session...')
    await cleanupSession()
    await initializeSession()
    appendOutput('Session restarted successfully')
  } catch (error) {
    appendOutput(`Failed to restart session: ${error.message}`)
  }
}

window['generate-all-message'].onclick = async () => {
  try {
    const secretKeyInput = document.getElementById('threshold-secret-key-input').value.toString().trim()
    const recipientsInput = window['recipients-input'].value.toString().trim()
    const thresholdInput = window['threshold-input'].value.toString().trim()

    // Validate inputs
    if (!secretKeyInput) {
      appendOutput('Please enter a secret key')
      return
    }

    if (!recipientsInput) {
      appendOutput('Please enter recipient addresses')
      return
    }

    if (!thresholdInput || isNaN(parseInt(thresholdInput)) || parseInt(thresholdInput) < 1) {
      appendOutput('Please enter a valid threshold (must be >= 1)')
      return
    }

    const threshold = parseInt(thresholdInput)
    const recipients = recipientsInput.split(',').map(addr => addr.trim()).filter(addr => addr.length > 0)

    if (recipients.length === 0) {
      appendOutput('Please enter at least one recipient address')
      return
    }

    appendOutput('Generating AllMessage...')
    appendOutput(`Secret key: ${secretKeyInput}`)
    appendOutput(`Recipients: ${recipients.join(', ')}`)
    appendOutput(`Threshold: ${threshold}`)

    // Validate secret key format
    let secretKeyBytes
    try {
      secretKeyBytes = window.hexToUint8Array(secretKeyInput)
    } catch (err) {
      appendOutput(`Invalid secret key format: ${err.message}`)
      return
    }

    // Validate recipient addresses
    for (const recipient of recipients) {
      try {
        validatePolkadotAddress(recipient)
      } catch (err) {
        appendOutput(`Invalid recipient address ${recipient}: ${err.message}`)
        return
      }
    }

    // Create keypair from secret key
    const keypairBytes = window.createKeypairBytes(secretKeyInput)
    appendOutput(`Generated keypair: ${keypairBytes.length} bytes`)

    // Convert recipients to concatenated public key bytes
    const recipientBytes = recipients.map(recipient => {
      return window.ss58ToPublicKeyBytes(recipient)
    })

    // Concatenate all recipient public keys
    const totalLength = recipientBytes.reduce((sum, bytes) => sum + bytes.length, 0)
    const recipientsConcat = new Uint8Array(totalLength)
    let offset = 0
    for (const bytes of recipientBytes) {
      recipientsConcat.set(bytes, offset)
      offset += bytes.length
    }

    appendOutput(`Concatenated recipients: ${recipientsConcat.length} bytes`)

    // Call the WASM function to generate AllMessage
    const allMessage = window.wasm_simplpedpop_contribute_all(keypairBytes, threshold, recipientsConcat)

    appendOutput(`✓ AllMessage generated successfully: ${allMessage.length} bytes`)
    appendOutput(`First 16 bytes: ${Array.from(allMessage.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`)

    // Store the generated AllMessage globally
    generatedAllMessage = allMessage

    // Display the AllMessage in hex format
    const allMessageHex = Array.from(allMessage).map(b => b.toString(16).padStart(2, '0')).join('')
    const outputDiv = document.getElementById('all-message-output')
    outputDiv.textContent = `AllMessage (${allMessage.length} bytes): ${allMessageHex}`

    // Show action buttons
    const actionsDiv = document.getElementById('all-message-actions')
    actionsDiv.style.display = 'block'

    appendOutput('AllMessage ready for sending or storage')

  } catch (err) {
    appendOutput(`Error generating AllMessage: ${err.message}`)
    console.error('Generate AllMessage error:', err)
  }
}

// Send AllMessage to connected peer
window['send-all-message'].onclick = async () => {
  try {
    // Check if we have a generated AllMessage
    if (!generatedAllMessage) {
      appendOutput('No AllMessage generated. Please generate an AllMessage first.')
      return
    }

    // Check if we have a connected peer
    if (!sessionState.peerMultiaddr) {
      appendOutput('No peer connected. Please connect to a peer first.')
      return
    }

    appendOutput('Sending AllMessage to connected peer...')
    appendOutput(`AllMessage size: ${generatedAllMessage.length} bytes`)

    // Convert AllMessage to hex string
    const allMessageHex = Array.from(generatedAllMessage).map(b => b.toString(16).padStart(2, '0')).join('')
    const messageToSend = `ALL_MESSAGE:${allMessageHex}`

    appendOutput(`Sending: ${messageToSend.substring(0, 50)}...`)

    // Ensure we have a chat stream
    const streamReady = await handleChatStream()
    if (!streamReady) {
      return
    }

    // Send the AllMessage
    await sendMessage(messageToSend)
    appendOutput('✓ AllMessage sent successfully to connected peer')

  } catch (err) {
    appendOutput(`Error sending AllMessage: ${err.message}`)
    console.error('Send AllMessage error:', err)
  }

}

// Store AllMessage in relay server
window['store-all-message'].onclick = async () => {

}

// Process AllMessages to generate threshold key
window['process-all-messages'].onclick = async () => {
  try {
    // Check if we have a generated AllMessage
    if (!generatedAllMessage) {
      appendOutput('No generated AllMessage found. Please generate an AllMessage first.')
      return
    }

    // Check if we have a received AllMessage
    if (!receivedAllMessage) {
      appendOutput('No received AllMessage found. Please receive an AllMessage from another peer first.')
      return
    }

    // Get the current secret key for keypair generation
    const secretKeyInput = document.getElementById('threshold-secret-key-input').value.toString().trim()
    if (!secretKeyInput) {
      appendOutput('No secret key found. Please enter your secret key.')
      return
    }

    appendOutput('Processing AllMessages to generate threshold key...')
    appendOutput(`Generated AllMessage: ${generatedAllMessage.length} bytes`)
    appendOutput(`Received AllMessage: ${receivedAllMessage.length} bytes`)

    // Create keypair from secret key
    const keypairBytes = window.createKeypairBytes(secretKeyInput)
    appendOutput(`Generated keypair: ${keypairBytes.length} bytes`)

    // Create JSON array of AllMessage bytes (following test pattern)
    const allMessagesArray = [
      Array.from(generatedAllMessage),
      Array.from(receivedAllMessage)
    ]
    const allMessagesJson = JSON.stringify(allMessagesArray)
    const allMessagesBytes = new TextEncoder().encode(allMessagesJson)

    appendOutput(`AllMessages JSON: ${allMessagesJson.length} characters`)
    appendOutput(`AllMessages bytes: ${allMessagesBytes.length} bytes`)

    // Call the WASM function to generate threshold key
    appendOutput('Calling wasm_simplpedpop_recipient_all...')
    const result = window.wasm_simplpedpop_recipient_all(keypairBytes, allMessagesBytes)

    // Extract the components from the result object
    const thresholdKey = result.threshold_public_key
    const sppOutputMessage = result.spp_output_message
    const signingKeypair = result.signing_keypair

    appendOutput(`✓ Threshold key generated successfully: ${thresholdKey.length} bytes`)
    appendOutput(`✓ SPP Output Message: ${sppOutputMessage.length} bytes`)
    appendOutput(`✓ Signing Keypair: ${signingKeypair.length} bytes`)
    appendOutput(`First 16 bytes: ${Array.from(thresholdKey.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`)

    // Convert to hex for display
    const thresholdKeyHex = Array.from(thresholdKey).map(b => b.toString(16).padStart(2, '0')).join('')
    appendOutput(`Threshold Public Key (hex): ${thresholdKeyHex}`)

    // Store the full result globally for potential future use
    window.generatedThresholdKey = thresholdKey
    window.generatedSppOutputMessage = sppOutputMessage
    window.generatedSigningKeypair = signingKeypair
    window.generatedThresholdResult = result

    // Display the threshold key in a dedicated area
    const thresholdKeyOutput = document.createElement('div')
    thresholdKeyOutput.style.marginTop = '10px'
    thresholdKeyOutput.style.padding = '10px'
    thresholdKeyOutput.style.backgroundColor = '#e8f5e8'
    thresholdKeyOutput.style.border = '1px solid #4caf50'
    thresholdKeyOutput.style.borderRadius = '5px'
    thresholdKeyOutput.style.fontFamily = 'monospace'
    thresholdKeyOutput.style.wordBreak = 'break-all'
    thresholdKeyOutput.innerHTML = `
      <h4>🔐 Generated Threshold Public Key</h4>
      <p><strong>Threshold Key Size:</strong> ${thresholdKey.length} bytes</p>
      <p><strong>SPP Output Message Size:</strong> ${sppOutputMessage.length} bytes</p>
      <p><strong>Signing Keypair Size:</strong> ${signingKeypair.length} bytes</p>
      <p><strong>Threshold Key Hex:</strong> ${thresholdKeyHex}</p>
      <p><strong>First 16 bytes:</strong> ${Array.from(thresholdKey.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ')}</p>
    `

    // Find the threshold signing section and append the result
    const thresholdSection = document.querySelector('section[aria-label="Threshold signing with SimplPedPoP"]')
    if (thresholdSection) {
      // Remove any existing threshold key display
      const existingDisplay = thresholdSection.querySelector('.threshold-key-display')
      if (existingDisplay) {
        existingDisplay.remove()
      }

      thresholdKeyOutput.className = 'threshold-key-display'
      thresholdSection.appendChild(thresholdKeyOutput)
    }

    appendOutput('✓ Threshold key processing completed successfully!')
    appendOutput('The threshold public key, SPP output message, and signing keypair are now available for use in threshold signing operations.')

    // Show Round 1 signing button
    const round1Actions = document.getElementById('round1-signing-actions')
    if (round1Actions) {
      round1Actions.style.display = 'block'
    }

  } catch (err) {
    appendOutput(`Error processing AllMessages: ${err.message}`)
    console.error('Process AllMessages error:', err)
  }
}

// Round 1 Signing Handler
window['run-round1-signing'].onclick = async () => {
  try {
    if (!window.generatedSigningKeypair) {
      appendOutput('No signing keypair available. Please process AllMessages first.')
      return
    }

    appendOutput('Running Round 1 signing...')
    const result = wasm_threshold_sign_round1(window.generatedSigningKeypair)

    // Parse JSON strings
    round1Nonces = JSON.parse(result.signing_nonces)
    round1Commitments = JSON.parse(result.signing_commitments)

    appendOutput(`✓ Round 1 signing completed`)
    appendOutput(`✓ Nonces: ${round1Nonces.length} bytes`)
    appendOutput(`✓ Commitments: ${round1Commitments.length} bytes`)

    // Display Round 1 results
    const round1Output = document.getElementById('round1-output')
    if (round1Output) {
      const noncesHex = round1Nonces.map(b => b.toString(16).padStart(2, '0')).join('')
      const commitmentsHex = round1Commitments.map(b => b.toString(16).padStart(2, '0')).join('')
      round1Output.innerHTML = `
        <p><strong>Nonces (${round1Nonces.length} bytes):</strong> ${noncesHex.substring(0, 64)}...</p>
        <p><strong>Commitments (${round1Commitments.length} bytes):</strong> ${commitmentsHex.substring(0, 64)}...</p>
      `
    }

    // Show send commitments button and Round 2 button
    const sendCommitmentsButton = document.getElementById('send-round1-commitments')
    if (sendCommitmentsButton) {
      sendCommitmentsButton.style.display = 'block'
    }

    const round2Actions = document.getElementById('round2-signing-actions')
    if (round2Actions) {
      round2Actions.style.display = 'block'
    }

  } catch (err) {
    appendOutput(`Error in Round 1 signing: ${err.message}`)
    console.error('Round 1 signing error:', err)
  }
}

// Send Round 1 Commitments Handler
window['send-round1-commitments'].onclick = async () => {
  try {
    if (!round1Commitments) {
      appendOutput('No commitments available. Please run Round 1 signing first.')
      return
    }

    if (!sessionState.peerMultiaddr) {
      appendOutput('No peer connected. Please connect to a peer first.')
      return
    }

    appendOutput('Sending Round 1 commitments to connected peer...')
    appendOutput(`Commitments size: ${round1Commitments.length} bytes`)

    // Convert commitments to hex string
    const commitmentsHex = round1Commitments.map(b => b.toString(16).padStart(2, '0')).join('')
    const messageToSend = `ROUND1_COMMITMENTS:${commitmentsHex}`

    // Ensure we have a chat stream
    const streamReady = await handleChatStream()
    if (!streamReady) {
      return
    }

    // Send the commitments
    await sendMessage(messageToSend)
    appendOutput('✓ Round 1 commitments sent successfully to connected peer')

  } catch (err) {
    appendOutput(`Error sending commitments: ${err.message}`)
    console.error('Send commitments error:', err)
  }
}

// Round 2 Signing Handler
window['run-round2-signing'].onclick = async () => {
  try {
    if (!window.generatedSigningKeypair) {
      appendOutput('No signing keypair available. Please process AllMessages first.')
      return
    }

    if (!round1Nonces || !round1Commitments) {
      appendOutput('Round 1 signing not completed. Please run Round 1 signing first.')
      return
    }

    // Get payload and context from inputs
    const payloadInput = document.getElementById('round2-payload-input')
    const contextInput = document.getElementById('round2-context-input')
    const payloadText = payloadInput ? payloadInput.value : 'test payload to sign with threshold signature'
    const contextText = contextInput ? contextInput.value : 'test context for threshold signing'

    // Check if we have received commitments from other participants
    // IMPORTANT: All participants must use the same commitment order
    // We'll collect all commitments (ours + received) and sort them by their byte representation
    // to ensure consistent ordering across all participants
    const allCommitments = [round1Commitments]
    if (receivedRound1Commitments.length > 0) {
      allCommitments.push(...receivedRound1Commitments)
      appendOutput(`Total commitments before sorting: ${allCommitments.length} (${receivedRound1Commitments.length} received from peers)`)
    } else {
      appendOutput('Warning: No commitments received from other participants. You need at least threshold participants.')
    }

    // Sort commitments by their byte representation to ensure consistent ordering
    // This ensures all participants use the same commitment order, which is required
    // for the common data to match during aggregation
    allCommitments.sort((a, b) => {
      // Compare byte arrays lexicographically
      const minLen = Math.min(a.length, b.length)
      for (let i = 0; i < minLen; i++) {
        if (a[i] < b[i]) return -1
        if (a[i] > b[i]) return 1
      }
      return a.length - b.length
    })

    appendOutput(`Using ${allCommitments.length} commitments in sorted order`)

    appendOutput('Running Round 2 signing...')
    appendOutput(`Payload: ${payloadText}`)
    appendOutput(`Context: ${contextText}`)

    const payload = new TextEncoder().encode(payloadText)

    // Prepare commitments for WASM (JSON encode)
    const commitmentsJson = JSON.stringify(allCommitments)
    const commitmentsBytes = new TextEncoder().encode(commitmentsJson)

    appendOutput(`Commitments JSON length: ${commitmentsJson.length} characters`)

    const result = wasm_threshold_sign_round2(
      window.generatedSigningKeypair,
      new Uint8Array(round1Nonces),
      commitmentsBytes,
      window.generatedSppOutputMessage,
      payload,
      contextText
    )

    round2SigningPackage = Array.from(result)

    appendOutput(`✓ Round 2 signing completed`)
    appendOutput(`✓ Signing package: ${round2SigningPackage.length} bytes`)

    // Display Round 2 results
    const round2Output = document.getElementById('round2-output')
    if (round2Output) {
      const packageHex = round2SigningPackage.map(b => b.toString(16).padStart(2, '0')).join('')
      round2Output.innerHTML = `
        <p><strong>Signing Package (${round2SigningPackage.length} bytes):</strong> ${packageHex.substring(0, 128)}...</p>
      `
    }

    // Show signing package actions
    const signingPackageActions = document.getElementById('signing-package-actions')
    if (signingPackageActions) {
      signingPackageActions.style.display = 'block'
    }

  } catch (err) {
    appendOutput(`Error in Round 2 signing: ${err.message}`)
    console.error('Round 2 signing error:', err)
  }
}

// Send Signing Package Handler
window['send-signing-package'].onclick = async () => {
  try {
    if (!round2SigningPackage) {
      appendOutput('No signing package available. Please run Round 2 signing first.')
      return
    }

    if (!sessionState.peerMultiaddr) {
      appendOutput('No peer connected. Please connect to a peer first.')
      return
    }

    appendOutput('Sending signing package to connected peer...')
    appendOutput(`Signing package size: ${round2SigningPackage.length} bytes`)

    // Convert signing package to hex string
    const packageHex = round2SigningPackage.map(b => b.toString(16).padStart(2, '0')).join('')
    const messageToSend = `SIGNING_PACKAGE:${packageHex}`

    // Ensure we have a chat stream
    const streamReady = await handleChatStream()
    if (!streamReady) {
      return
    }

    // Send the signing package
    await sendMessage(messageToSend)
    appendOutput('✓ Signing package sent successfully to connected peer')

  } catch (err) {
    appendOutput(`Error sending signing package: ${err.message}`)
    console.error('Send signing package error:', err)
  }
}

// Aggregate Signatures Handler
window['aggregate-signatures'].onclick = async () => {
  try {
    if (!round2SigningPackage) {
      appendOutput('No signing package available. Please run Round 2 signing first.')
      return
    }

    // Collect all signing packages
    const allSigningPackages = [round2SigningPackage]
    if (receivedSigningPackages.length > 0) {
      allSigningPackages.push(...receivedSigningPackages)
      appendOutput(`Aggregating ${allSigningPackages.length} signing packages...`)
    } else {
      appendOutput('Warning: No signing packages received from other participants.')
      appendOutput('You need at least threshold signing packages to aggregate.')
      return
    }

    appendOutput('Aggregating threshold signature...')
    appendOutput(`Our signing package: ${round2SigningPackage.length} bytes`)
    appendOutput(`Received signing packages: ${receivedSigningPackages.length}`)
    receivedSigningPackages.forEach((pkg, idx) => {
      appendOutput(`  Package ${idx + 1}: ${pkg.length} bytes`)
    })

    // Validate that we have enough signing packages
    const thresholdInput = document.getElementById('threshold-input')
    const threshold = thresholdInput ? parseInt(thresholdInput.value) : 2
    if (allSigningPackages.length < threshold) {
      appendOutput(`Error: Need at least ${threshold} signing packages for threshold ${threshold}, but only have ${allSigningPackages.length}`)
      return
    }

    appendOutput(`Aggregating with ${allSigningPackages.length} packages (threshold: ${threshold})`)

    // Prepare signing packages for WASM (JSON encode)
    // The format should be an array of byte arrays: [[bytes...], [bytes...]]
    const signingPackagesJson = JSON.stringify(allSigningPackages)
    const signingPackagesBytes = new TextEncoder().encode(signingPackagesJson)

    appendOutput(`JSON length: ${signingPackagesJson.length} characters`)
    appendOutput(`Bytes length: ${signingPackagesBytes.length} bytes`)

    try {
      // Use the globally exposed WASM function
      const aggregatedSignature = window.wasm_aggregate_threshold_signature(signingPackagesBytes)

      if (!aggregatedSignature) {
        throw new Error('WASM function returned null/undefined')
      }

      if (!(aggregatedSignature instanceof Uint8Array)) {
        throw new Error(`WASM function returned unexpected type: ${typeof aggregatedSignature}, constructor: ${aggregatedSignature?.constructor?.name}`)
      }

      const signatureBytes = Array.from(aggregatedSignature)

      appendOutput(`✓ Signature aggregation completed`)
      appendOutput(`✓ Aggregated signature: ${signatureBytes.length} bytes`)

      const signatureHex = signatureBytes.map(b => b.toString(16).padStart(2, '0')).join('')
      appendOutput(`✓ Signature (hex): ${signatureHex}`)

      // Display aggregated signature
      const signingPackageOutput = document.getElementById('signing-package-output')
      if (signingPackageOutput) {
        signingPackageOutput.innerHTML = `
          <p><strong>Aggregated Signature (${signatureBytes.length} bytes):</strong></p>
          <p style="word-break: break-all;">${signatureHex}</p>
        `
      }

      // Store globally
      window.aggregatedSignature = signatureBytes
    } catch (wasmErr) {
      // Handle WASM-specific errors
      let errorMessage = 'Unknown error'
      if (wasmErr && typeof wasmErr === 'object') {
        if (wasmErr.message) {
          errorMessage = wasmErr.message
        } else if (wasmErr.toString && wasmErr.toString() !== '[object Object]') {
          errorMessage = wasmErr.toString()
        } else {
          errorMessage = JSON.stringify(wasmErr)
        }
      } else if (wasmErr) {
        errorMessage = String(wasmErr)
      }

      appendOutput(`Error in WASM aggregation: ${errorMessage}`)
      console.error('WASM aggregation error details:', wasmErr)
      console.error('Signing packages being sent:', allSigningPackages.map(p => p.length))
      throw wasmErr
    }

  } catch (err) {
    const errorMessage = err?.message || err?.toString() || String(err) || 'Unknown error'
    appendOutput(`Error aggregating signatures: ${errorMessage}`)
    console.error('Aggregate signatures error:', err)
    console.error('Error stack:', err?.stack)
  }
}




