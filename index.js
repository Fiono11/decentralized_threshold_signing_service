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
import { cryptoWaitReady, sr25519Sign, sr25519PairFromSeed } from '@polkadot/util-crypto'
import { hexToU8a } from '@polkadot/util'

// Constants
const WEBRTC_CODE = WebRTC.code
const CHAT_PROTOCOL = '/libp2p/examples/chat/1.0.0'
const KV_PROTOCOL = '/libp2p/examples/kv/1.0.0'
const KV_QUERY_PROTOCOL = '/libp2p/examples/kv-query/1.0.0'
const PROOF_OF_POSSESSION_PROTOCOL = '/libp2p/examples/proof-of-possession/1.0.0'
const CONNECTION_TIMEOUT = 10000
const STREAM_TIMEOUT = 5000
const CHAT_STREAM_TIMEOUT = 5000

// DOM Elements
const output = document.getElementById('output')
const sendSection = document.getElementById('send-section')

// Global State
let peerMultiaddr
let chatStream
let mySS58Address = null
let mySecretKey = null
let cryptoReady = false

// Utility Functions
const appendOutput = (message) => {
  const div = document.createElement('div')
  div.appendChild(document.createTextNode(message))
  output.append(div)
}

const isWebrtc = (multiaddr) => WebRTC.matches(multiaddr)

const getRelayConnection = () => {
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

// LibP2P Node Configuration
const node = await createLibp2p({
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

// Relay Configuration
const HARDCODED_RELAY_ADDRESS = '/ip4/127.0.0.1/tcp/8080/ws/p2p/12D3KooWA1bysjrTACSWqf6q172inxvwKHUxAnBtVgaVDKMxpZtx'

// Connection Management
const connectToRelay = async () => {
  try {
    appendOutput('Connecting to relay...')
    const relayMultiaddr = multiaddr(HARDCODED_RELAY_ADDRESS)
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

// Initialize connection to relay
connectToRelay()

// UI Update Functions
const updateConnList = () => {
  const connectionElements = node.getConnections().map((connection) => {
    if (WebRTC.matches(connection.remoteAddr)) {
      peerMultiaddr = connection.remoteAddr
      sendSection.style.display = 'block'
    }
    const element = document.createElement('li')
    element.textContent = connection.remoteAddr.toString()
    return element
  })
  document.getElementById('connections').replaceChildren(...connectionElements)
}

const updateMultiaddrs = () => {
  const webrtcMultiaddrs = node.getMultiaddrs()
    .filter(multiaddr => isWebrtc(multiaddr))
    .map((multiaddr) => {
      const element = document.createElement('li')
      element.textContent = multiaddr.toString()
      return element
    })
  document.getElementById('multiaddrs').replaceChildren(...webrtcMultiaddrs)
}

// Event Listeners
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

// Chat Protocol Handler
node.handle(CHAT_PROTOCOL, async ({ stream }) => {
  chatStream = byteStream(stream)
  while (true) {
    const buffer = await chatStream.read()
    if (buffer === null) {
      break // End of stream
    }
    appendOutput(`Received: '${toString(buffer.subarray())}'`)
  }
})

// Chat Stream Management
const handleChatStream = async () => {
  if (chatStream == null) {
    appendOutput('Opening chat stream')
    const signal = AbortSignal.timeout(CHAT_STREAM_TIMEOUT)
    try {
      const stream = await node.dialProtocol(peerMultiaddr, CHAT_PROTOCOL, { signal })
      chatStream = byteStream(stream)

      // Handle incoming messages
      Promise.resolve().then(async () => {
        while (true) {
          const buffer = await chatStream.read()
          if (buffer === null) {
            break // End of stream
          }
          appendOutput(`Received: '${toString(buffer.subarray())}'`)
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
    await chatStream.write(fromString(message))
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
const requestChallenge = async (ss58Address) => {
  const relayConnection = getRelayConnection()
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

const submitProof = async (ss58Address, challenge, signature, webrtcMultiaddr) => {
  const relayConnection = getRelayConnection()
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
const getWebrtcMultiaddr = () => {
  const multiaddrs = node.getMultiaddrs()
  return multiaddrs.find(multiaddr => WebRTC.matches(multiaddr))
}

const storeAddressInRelay = async (polkadotAddress, webrtcMultiaddr, secretKey) => {
  if (!secretKey) {
    throw new Error('Secret key is required for proof of possession')
  }

  try {
    // Step 1: Request challenge from relay
    const challenge = await requestChallenge(polkadotAddress)

    // Step 2: Sign the challenge with the secret key
    appendOutput('Signing challenge...')
    const signature = await signMessage(challenge, secretKey)

    // Step 3: Submit proof to relay
    await submitProof(polkadotAddress, challenge, signature, webrtcMultiaddr)

    mySS58Address = polkadotAddress
    mySecretKey = secretKey
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

    const webrtcMultiaddr = getWebrtcMultiaddr()
    if (!webrtcMultiaddr) {
      const availableMultiaddrs = node.getMultiaddrs().map(ma => ma.toString()).join(', ')
      appendOutput(`No WebRTC address found. Available: ${availableMultiaddrs}`)
      return
    }

    await storeAddressInRelay(polkadotAddress, webrtcMultiaddr, secretKey)
  } catch (error) {
    appendOutput(`Error: ${error.message}`)
  }
}

// Address Lookup Functions
const queryRelayForAddress = async (polkadotAddress) => {
  const relayConnection = getRelayConnection()
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

const connectToPeer = async (peerMultiaddrString) => {
  appendOutput('Connecting to peer...')
  try {
    const dialSignal = AbortSignal.timeout(CONNECTION_TIMEOUT)
    const peerMultiaddr = multiaddr(peerMultiaddrString)
    await node.dial(peerMultiaddr, { signal: dialSignal })
    appendOutput('Connected to peer!')
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Connection timeout')
    } else {
      throw new Error(`Connection failed: ${error.message}`)
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
    appendOutput(`Looking up: ${polkadotAddress}`)
    const peerMultiaddrString = await queryRelayForAddress(polkadotAddress)
    appendOutput(`Found: ${peerMultiaddrString}`)
    await connectToPeer(peerMultiaddrString)
  } catch (error) {
    appendOutput(`Error: ${error.message}`)
  }
}

