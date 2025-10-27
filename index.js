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
import initOlaf, { wasm_simplpedpop_contribute_all, wasm_keypair_from_secret, wasm_simplpedpop_recipient_all } from './olaf/pkg/olaf.js';

// Initialize the WASM module once at startup
await initOlaf();

// Expose WASM functions globally for testing
window.wasm_simplpedpop_contribute_all = wasm_simplpedpop_contribute_all;
window.wasm_keypair_from_secret = wasm_keypair_from_secret;
window.wasm_simplpedpop_recipient_all = wasm_simplpedpop_recipient_all;
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

window.encodeAddress = encodeAddress;

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
let receivedAllMessage = null

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
    const message = toString(buf.subarray())
    appendOutput(`Received: '${message}'`)

    // Check if this is an AllMessage
    if (message.startsWith('ALL_MESSAGE:')) {
      const hexMessage = message.substring('ALL_MESSAGE:'.length)
      try {
        receivedAllMessage = window.hexToUint8Array(hexMessage)
        appendOutput(`✓ AllMessage received and stored: ${receivedAllMessage.length} bytes`)
      } catch (err) {
        appendOutput(`Error parsing received AllMessage: ${err.message}`)
      }
    }
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
          const message = toString(buf.subarray())
          appendOutput(`Received: '${message}'`)

          // Check if this is an AllMessage
          if (message.startsWith('ALL_MESSAGE:')) {
            const hexMessage = message.substring('ALL_MESSAGE:'.length)
            try {
              receivedAllMessage = window.hexToUint8Array(hexMessage)
              appendOutput(`✓ AllMessage received and stored: ${receivedAllMessage.length} bytes`)
            } catch (err) {
              appendOutput(`Error parsing received AllMessage: ${err.message}`)
            }
          }
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
  try {
    const secretKeyInput = window['secret-key-input'].value.toString().trim()
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
    if (!ma) {
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
    if (chatStream == null) {
      appendOutput('Opening chat stream...')
      const signal = AbortSignal.timeout(5000)
      try {
        const stream = await node.dialProtocol(ma, CHAT_PROTOCOL, { signal })
        chatStream = byteStream(stream)

        // Set up message listener
        Promise.resolve().then(async () => {
          while (true) {
            const buf = await chatStream.read()
            const message = toString(buf.subarray())
            appendOutput(`Received: '${message}'`)

            // Check if this is an AllMessage
            if (message.startsWith('ALL_MESSAGE:')) {
              const hexMessage = message.substring('ALL_MESSAGE:'.length)
              try {
                receivedAllMessage = window.hexToUint8Array(hexMessage)
                appendOutput(`✓ AllMessage received and stored: ${receivedAllMessage.length} bytes`)
              } catch (err) {
                appendOutput(`Error parsing received AllMessage: ${err.message}`)
              }
            }
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

    // Send the AllMessage
    await chatStream.write(fromString(messageToSend))
    appendOutput('✓ AllMessage sent successfully to connected peer')
    appendOutput(`Recipient: ${connectedPeerSS58Address || 'Unknown peer'}`)

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
    const secretKeyInput = window['secret-key-input'].value.toString().trim()
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
    const thresholdKey = window.wasm_simplpedpop_recipient_all(keypairBytes, allMessagesBytes)

    appendOutput(`✓ Threshold key generated successfully: ${thresholdKey.length} bytes`)
    appendOutput(`First 16 bytes: ${Array.from(thresholdKey.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`)

    // Convert to hex for display
    const thresholdKeyHex = Array.from(thresholdKey).map(b => b.toString(16).padStart(2, '0')).join('')
    appendOutput(`Threshold Public Key (hex): ${thresholdKeyHex}`)

    // Store the threshold key globally for potential future use
    window.generatedThresholdKey = thresholdKey

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
      <p><strong>Size:</strong> ${thresholdKey.length} bytes</p>
      <p><strong>Hex:</strong> ${thresholdKeyHex}</p>
      <p><strong>First 16 bytes:</strong> ${Array.from(thresholdKey.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ')}</p>
    `

    // Find the threshold signing section and append the result
    const thresholdSection = document.querySelector('.ss58-section')
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
    appendOutput('The threshold public key is now available for use in threshold signing operations.')

  } catch (err) {
    appendOutput(`Error processing AllMessages: ${err.message}`)
    console.error('Process AllMessages error:', err)
  }
}




