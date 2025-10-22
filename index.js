// LibP2P Browser Client for Decentralized Threshold Signing Service

import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { identify, identifyPush } from '@libp2p/identify'
import { ping } from '@libp2p/ping'
import { webRTC } from '@libp2p/webrtc'
import { webSockets } from '@libp2p/websockets'
import * as filters from '@libp2p/websockets/filters'
import { multiaddr } from '@multiformats/multiaddr'
import { WebRTC } from '@multiformats/multiaddr-matcher'
import { byteStream } from 'it-byte-stream'
import { createLibp2p } from 'libp2p'
import { fromString, toString } from 'uint8arrays'
import { decodeAddress, encodeAddress } from '@polkadot/keyring'
import initOlaf, { wasm_simplpedpop_contribute_all, wasm_keypair_from_secret, wasm_secret_key_to_ss58_address } from './olaf/pkg/olaf.js';

// Initialize the WASM module once at startup
await initOlaf();

// Expose WASM functions globally for testing
window.wasm_simplpedpop_contribute_all = wasm_simplpedpop_contribute_all;
window.wasm_keypair_from_secret = wasm_keypair_from_secret;
window.wasm_secret_key_to_ss58_address = wasm_secret_key_to_ss58_address;
window.wasmReady = true;

// Expose helper functions for testing
window.ss58ToPublicKeyBytes = function (ss58Address) {
  try {
    const decoded = decodeAddress(ss58Address);
    return new Uint8Array(decoded);
  } catch (error) {
    throw new Error(`Failed to decode SS58 address ${ss58Address}: ${error.message}`);
  }
};

window.hexToUint8Array = function (hexString) {
  const cleanHex = hexString.startsWith('0x') ? hexString.slice(2) : hexString;
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes[i / 2] = parseInt(cleanHex.substring(i, i + 2), 16);
  }
  return bytes;
};

window.createKeypairBytes = function (secretKeyHex) {
  const secretKeyBytes = window.hexToUint8Array(secretKeyHex);

  // Use the WASM function to generate a proper keypair from the secret key
  return window.wasm_keypair_from_secret(secretKeyBytes);
};

window.secretKeyToSS58Address = function (secretKeyHex) {
  const secretKeyBytes = window.hexToUint8Array(secretKeyHex);
  // Use the WASM function to convert secret key to SS58 address
  return window.wasm_secret_key_to_ss58_address(secretKeyBytes);
};

const WEBRTC_CODE = WebRTC.code

const output = document.getElementById('output')
const sendSection = document.getElementById('send-section')

const appendOutput = (line) => {
  const div = document.createElement('div')
  div.appendChild(document.createTextNode(line))
  output.append(div)
}

const CHAT_PROTOCOL = '/libp2p/examples/chat/1.0.0'
const KV_PROTOCOL = '/libp2p/examples/kv/1.0.0'
const KV_QUERY_PROTOCOL = '/libp2p/examples/kv-query/1.0.0'

let ma
let chatStream
let connectedPeerSS58Address = null
let generatedAllMessage = null

const node = await createLibp2p({
  addresses: {
    listen: ['/p2p-circuit', '/webrtc']
  },
  transports: [
    webSockets({ filter: filters.all }),
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

const HARDCODED_RELAY_ADDRESS = '/ip4/127.0.0.1/tcp/8080/ws/p2p/12D3KooWA1bysjrTACSWqf6q172inxvwKHUxAnBtVgaVDKMxpZtx'

async function connectToRelay() {
  try {
    appendOutput(`Connecting to relay...`)
    const relayMa = multiaddr(HARDCODED_RELAY_ADDRESS)
    const signal = AbortSignal.timeout(10000)
    await node.dial(relayMa, { signal })
    appendOutput('Connected to relay')
  } catch (err) {
    if (err.name === 'AbortError') {
      appendOutput('Connection timeout')
    } else {
      appendOutput(`Connection failed: ${err.message}`)
    }
  }
}

connectToRelay()

function updateConnList() {
  const connListEls = node.getConnections().map((connection) => {
    if (WebRTC.matches(connection.remoteAddr)) {
      ma = connection.remoteAddr
      sendSection.style.display = 'block'
    }
    const el = document.createElement('li')
    el.textContent = connection.remoteAddr.toString()
    return el
  })
  document.getElementById('connections').replaceChildren(...connListEls)
}

node.addEventListener('connection:open', updateConnList)
node.addEventListener('connection:close', updateConnList)

node.addEventListener('self:peer:update', (event) => {
  const multiaddrs = node.getMultiaddrs()
    .filter(ma => isWebrtc(ma))
    .map((ma) => {
      const el = document.createElement('li')
      el.textContent = ma.toString()
      return el
    })
  document.getElementById('multiaddrs').replaceChildren(...multiaddrs)
})

node.handle(CHAT_PROTOCOL, async ({ stream }) => {
  chatStream = byteStream(stream)
  while (true) {
    const buf = await chatStream.read()
    appendOutput(`Received: '${toString(buf.subarray())}'`)
  }
})

const isWebrtc = (ma) => WebRTC.matches(ma)

window.send.onclick = async () => {
  if (chatStream == null) {
    appendOutput('Opening chat stream')
    const signal = AbortSignal.timeout(5000)
    try {
      const stream = await node.dialProtocol(ma, CHAT_PROTOCOL, { signal })
      chatStream = byteStream(stream)
      Promise.resolve().then(async () => {
        while (true) {
          const buf = await chatStream.read()
          appendOutput(`Received: '${toString(buf.subarray())}'`)
        }
      })
    } catch (err) {
      if (signal.aborted) {
        appendOutput('Chat stream timeout')
      } else {
        appendOutput(`Chat stream failed: ${err.message}`)
      }
      return
    }
  }

  const message = window.message.value.toString().trim()
  appendOutput(`Sending: '${message}'`)
  chatStream.write(fromString(message))
    .catch(err => {
      appendOutput(`Send error: ${err.message}`)
    })
}

const getRelayConnection = () => {
  const connections = node.getConnections()
  return connections.find(conn => !conn.remoteAddr.protoCodes().includes(WEBRTC_CODE))
}

function validatePolkadotAddress(address) {
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

window['store-address-input'].onclick = async () => {
  const polkadotAddress = window['ss58-address-input'].value.toString().trim()

  if (!polkadotAddress) {
    appendOutput('Please enter a SS58 address')
    return
  }

  try {
    appendOutput('Validating SS58 address...')
    validatePolkadotAddress(polkadotAddress)
    appendOutput(`Valid address: ${polkadotAddress}`)

    const relayConnection = getRelayConnection()
    if (!relayConnection) {
      appendOutput('No relay connection found')
      return
    }

    appendOutput('Storing address in relay...')
    const stream = await node.dialProtocol(relayConnection.remoteAddr, KV_PROTOCOL, {
      signal: AbortSignal.timeout(5000)
    })
    const streamWriter = byteStream(stream)
    const streamReader = byteStream(stream)

    const multiaddrs = node.getMultiaddrs()
    let webrtcMultiaddr = multiaddrs.find(ma => WebRTC.matches(ma))

    if (!webrtcMultiaddr) {
      appendOutput('No WebRTC address found. Available: ' + multiaddrs.map(ma => ma.toString()).join(', '))
      await stream.close()
      return
    }

    const kvPair = { key: polkadotAddress, value: webrtcMultiaddr.toString() }
    const message = JSON.stringify(kvPair)
    appendOutput(`Storing: ${polkadotAddress} -> ${webrtcMultiaddr.toString()}`)

    await streamWriter.write(fromString(message))
    const response = await streamReader.read()

    if (response === null) {
      appendOutput('No response from relay')
      return
    }

    const responseText = toString(response.subarray())
    try {
      const parsed = JSON.parse(responseText)
      if (parsed.success) {
        appendOutput('Address stored successfully')
      } else {
        appendOutput(`Store failed: ${parsed.error}`)
      }
    } catch (e) {
      appendOutput(`Response parse error: ${e.message}`)
    }

    await stream.close()
  } catch (err) {
    appendOutput(`Error: ${err.message}`)
  }
}

window['connect-via-address'].onclick = async () => {
  const polkadotAddress = window['ss58-address'].value.toString().trim()

  if (!polkadotAddress) {
    appendOutput('Please enter a SS58 address')
    return
  }

  try {
    appendOutput(`Looking up: ${polkadotAddress}`)
    const relayConnection = getRelayConnection()
    if (!relayConnection) {
      appendOutput('No relay connection found')
      return
    }

    const stream = await node.dialProtocol(relayConnection.remoteAddr, KV_QUERY_PROTOCOL, {
      signal: AbortSignal.timeout(5000)
    })
    const streamWriter = byteStream(stream)
    const streamReader = byteStream(stream)

    const query = { action: 'get', key: polkadotAddress }
    const message = JSON.stringify(query)
    appendOutput(`Querying relay...`)

    await streamWriter.write(fromString(message))
    const response = await streamReader.read()

    if (response === null) {
      appendOutput('No response from relay')
      await stream.close()
      return
    }

    const responseText = toString(response.subarray())
    try {
      const parsed = JSON.parse(responseText)
      if (parsed.success && parsed.found) {
        const peerMultiaddr = parsed.value
        appendOutput(`Found: ${peerMultiaddr}`)
        appendOutput('Connecting to peer...')
        await stream.close()

        try {
          const dialSignal = AbortSignal.timeout(10000)
          const ma = multiaddr(peerMultiaddr)
          await node.dial(ma, { signal: dialSignal })
          connectedPeerSS58Address = polkadotAddress
          appendOutput('Connected to peer!')
          appendOutput(`Peer SS58 address stored: ${polkadotAddress}`)
        } catch (dialError) {
          if (dialError.name === 'AbortError') {
            appendOutput('Connection timeout')
          } else {
            appendOutput(`Connection failed: ${dialError.message}`)
            appendOutput(`Multiaddress: ${peerMultiaddr}`)
          }
        }
      } else if (parsed.success && !parsed.found) {
        appendOutput(`No peer found for: ${polkadotAddress}`)
      } else {
        appendOutput(`Query failed: ${parsed.error}`)
      }
    } catch (e) {
      appendOutput(`Response parse error: ${e.message}`)
    }

    await stream.close()
  } catch (err) {
    appendOutput(`Error: ${err.message}`)
  }
}

window['generate-all-message'].onclick = async () => {
  const secretKeyHex = window['secret-key-input'].value.toString().trim()

  if (!secretKeyHex) {
    appendOutput('Please enter a secret key')
    return
  }

  if (!connectedPeerSS58Address) {
    appendOutput('Error: No connected peer. Please connect to a peer first using "Find Peer & Connect"')
    return
  }

  try {
    appendOutput('Generating AllMessage...')

    // Step 1: Generate keypair from secret key
    const keypairBytes = window.createKeypairBytes(secretKeyHex)
    appendOutput(`Generated keypair: ${keypairBytes.length} bytes`)
    appendOutput(`Keypair first 16 bytes: ${Array.from(keypairBytes.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`)

    // Step 2: Derive SS58 address from secret key using WASM function
    // This calls wasm_secret_key_to_ss58_address internally
    const ownSS58Address = window.secretKeyToSS58Address(secretKeyHex)
    appendOutput(`Own SS58 address (derived from secret): ${ownSS58Address}`)
    appendOutput(`Peer SS58 address (connected peer): ${connectedPeerSS58Address}`)

    // Step 3: Convert both SS58 addresses to public key bytes
    const ownPublicKeyBytes = window.ss58ToPublicKeyBytes(ownSS58Address)
    const peerPublicKeyBytes = window.ss58ToPublicKeyBytes(connectedPeerSS58Address)

    appendOutput(`Own public key: ${ownPublicKeyBytes.length} bytes - ${Array.from(ownPublicKeyBytes.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`)
    appendOutput(`Peer public key: ${peerPublicKeyBytes.length} bytes - ${Array.from(peerPublicKeyBytes.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`)

    // Step 4: Concatenate the public keys (own + peer)
    // Recipients: [own public key, peer public key]
    const recipientsConcat = new Uint8Array(ownPublicKeyBytes.length + peerPublicKeyBytes.length)
    recipientsConcat.set(ownPublicKeyBytes, 0)
    recipientsConcat.set(peerPublicKeyBytes, ownPublicKeyBytes.length)

    appendOutput(`Recipients concatenated: ${recipientsConcat.length} bytes`)
    appendOutput(`Recipients first 16 bytes: ${Array.from(recipientsConcat.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`)

    // Step 5: Call WASM function
    const threshold = 2
    appendOutput(`Calling WASM function with:`)
    appendOutput(`  - keypairBytes: ${keypairBytes.length} bytes, type: ${keypairBytes.constructor.name}`)
    appendOutput(`  - threshold: ${threshold}, type: ${typeof threshold}`)
    appendOutput(`  - recipientsConcat: ${recipientsConcat.length} bytes, type: ${recipientsConcat.constructor.name}`)
    appendOutput(`  - WASM function available: ${typeof window.wasm_simplpedpop_contribute_all}`)

    let result
    try {
      result = window.wasm_simplpedpop_contribute_all(keypairBytes, threshold, recipientsConcat)
    } catch (wasmError) {
      appendOutput(`WASM function threw an exception:`)
      appendOutput(`  - Error type: ${wasmError.constructor.name}`)
      appendOutput(`  - Error as string: ${String(wasmError)}`)
      appendOutput(`  - Error message: ${wasmError.message}`)
      appendOutput(`  - Error stack: ${wasmError.stack}`)
      appendOutput(`  - Error valueOf: ${wasmError.valueOf()}`)
      appendOutput(`  - Error toString: ${wasmError.toString()}`)
      throw new Error(`WASM error: ${String(wasmError)}`)
    }

    appendOutput(`Result type: ${typeof result}`)
    appendOutput(`Result constructor: ${result ? result.constructor.name : 'null/undefined'}`)
    appendOutput(`Result value: ${result}`)

    if (!result) {
      throw new Error('WASM function returned null or undefined')
    }

    // Step 6: Store the result and display it
    generatedAllMessage = result
    appendOutput(`✓ AllMessage generated successfully: ${result.length} bytes`)

    // Convert to hex for display
    const hexResult = Array.from(result)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')

    const outputDiv = document.getElementById('all-message-output')
    outputDiv.innerHTML = `
      <div style="background-color: #e8f5e9; padding: 10px; border-radius: 3px; margin-top: 5px;">
        <strong>Result (${result.length} bytes):</strong><br/>
        <div style="margin-top: 5px; font-size: 12px;">0x${hexResult}</div>
      </div>
    `

    // Show the action buttons
    const actionsDiv = document.getElementById('all-message-actions')
    actionsDiv.style.display = 'block'

    appendOutput(`First 16 bytes: ${Array.from(result.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`)
  } catch (err) {
    appendOutput(`Error generating AllMessage: ${err.message}`)
    const outputDiv = document.getElementById('all-message-output')
    outputDiv.innerHTML = `
      <div style="background-color: #ffebee; padding: 10px; border-radius: 3px; margin-top: 5px;">
        <strong>Error:</strong> ${err.message}
      </div>
    `
  }
}

// Send AllMessage to connected peer
window['send-all-message'].onclick = async () => {
  if (!generatedAllMessage) {
    appendOutput('Error: No AllMessage generated. Please generate an AllMessage first.')
    return
  }

  if (!connectedPeerSS58Address) {
    appendOutput('Error: No connected peer. Please connect to a peer first using "Find Peer & Connect"')
    return
  }

  try {
    appendOutput('Sending AllMessage to connected peer...')

    // Ensure chat stream is open
    if (chatStream == null) {
      appendOutput('Opening chat stream to peer...')
      const signal = AbortSignal.timeout(5000)
      try {
        const stream = await node.dialProtocol(ma, CHAT_PROTOCOL, { signal })
        chatStream = byteStream(stream)
        Promise.resolve().then(async () => {
          while (true) {
            const buf = await chatStream.read()
            appendOutput(`Received: '${toString(buf.subarray())}'`)
          }
        })
      } catch (err) {
        if (signal.aborted) {
          appendOutput('Chat stream timeout')
        } else {
          appendOutput(`Chat stream failed: ${err.message}`)
        }
        return
      }
    }

    // Convert AllMessage to hex string for transmission
    const hexMessage = Array.from(generatedAllMessage)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')

    const messageToSend = `ALL_MESSAGE:${hexMessage}`
    appendOutput(`Sending AllMessage (${generatedAllMessage.length} bytes) to peer: ${connectedPeerSS58Address}`)

    await chatStream.write(fromString(messageToSend))
    appendOutput('✓ AllMessage sent successfully to connected peer!')

  } catch (err) {
    appendOutput(`Error sending AllMessage: ${err.message}`)
  }
}

// Store AllMessage in relay server
window['store-all-message'].onclick = async () => {
  if (!generatedAllMessage) {
    appendOutput('Error: No AllMessage generated. Please generate an AllMessage first.')
    return
  }

  if (!connectedPeerSS58Address) {
    appendOutput('Error: No connected peer. Please connect to a peer first using "Find Peer & Connect"')
    return
  }

  try {
    appendOutput('Storing AllMessage in relay server...')

    const relayConnection = getRelayConnection()
    if (!relayConnection) {
      appendOutput('No relay connection found')
      return
    }

    const stream = await node.dialProtocol(relayConnection.remoteAddr, KV_PROTOCOL, {
      signal: AbortSignal.timeout(5000)
    })
    const streamWriter = byteStream(stream)
    const streamReader = byteStream(stream)

    // Create a unique key for the AllMessage using both peer addresses
    const ownSS58Address = window.secretKeyToSS58Address(window['secret-key-input'].value.toString().trim())
    const allMessageKey = `all_message_${ownSS58Address}_${connectedPeerSS58Address}`

    // Convert AllMessage to hex string for storage
    const hexMessage = Array.from(generatedAllMessage)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')

    const kvPair = { key: allMessageKey, value: hexMessage }
    const message = JSON.stringify(kvPair)
    appendOutput(`Storing AllMessage with key: ${allMessageKey}`)

    await streamWriter.write(fromString(message))
    const response = await streamReader.read()

    if (response === null) {
      appendOutput('No response from relay')
      return
    }

    const responseText = toString(response.subarray())
    try {
      const parsed = JSON.parse(responseText)
      if (parsed.success) {
        appendOutput('✓ AllMessage stored successfully in relay server!')
        appendOutput(`Key: ${allMessageKey}`)
        appendOutput(`Size: ${generatedAllMessage.length} bytes`)
      } else {
        appendOutput(`Store failed: ${parsed.error}`)
      }
    } catch (e) {
      appendOutput(`Response parse error: ${e.message}`)
    }

    await stream.close()
  } catch (err) {
    appendOutput(`Error storing AllMessage: ${err.message}`)
  }
}

