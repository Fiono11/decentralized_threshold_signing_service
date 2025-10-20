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
import initOlaf, { wasm_simplpedpop_contribute_all } from './olaf/pkg/olaf.js';

// Initialize the WASM module once at startup
await initOlaf();

// Example usage:
function contributeAllExample() {
  // KEYPAIR_LENGTH must match schnorrkel’s size (e.g., 64 bytes)
  const keypairBytes = new Uint8Array(/* your keypair bytes here */);

  // threshold is a JS number; it’s converted to u16 in Rust
  const threshold = 2;

  // recipients_concat is the concatenation of N schnorrkel public keys, each PUBLIC_KEY_LENGTH bytes (e.g., 32)
  const recipientsConcat = new Uint8Array(/* pk1||pk2||... */);

  const result = wasm_simplpedpop_contribute_all(keypairBytes, threshold, recipientsConcat);
  // result is a Uint8Array
  console.log('contribute_all result bytes:', result);
}

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

// Test call for WASM function on startup
try {
  appendOutput('Calling contributeAllExample()...')
  contributeAllExample()
  appendOutput('contributeAllExample() returned successfully')
} catch (e) {
  appendOutput('contributeAllExample() threw: ' + (e?.message || String(e)))
}

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
          appendOutput('Connected to peer!')
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

