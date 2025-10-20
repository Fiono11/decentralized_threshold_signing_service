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

const KV_PROTOCOL = '/libp2p/examples/kv/1.0.0'
const KV_QUERY_PROTOCOL = '/libp2p/examples/kv-query/1.0.0'
const HARDCODED_PEER_ID = '12D3KooWA1bysjrTACSWqf6q172inxvwKHUxAnBtVgaVDKMxpZtx'
const EXTERNAL_PORT = '8080'

// SS58 address to multiaddress mapping
const kvStore = new Map()

const peerId = peerIdFromString(HARDCODED_PEER_ID)

const server = await createLibp2p({
  peerId,
  addresses: {
    listen: [
      `/ip4/0.0.0.0/tcp/${EXTERNAL_PORT}/ws`,
      `/ip6/::/tcp/${EXTERNAL_PORT}/ws`
    ],
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

server.handle(KV_PROTOCOL, async ({ stream, connection }) => {
  const streamReader = byteStream(stream)
  const streamWriter = byteStream(stream)

  try {
    while (true) {
      const data = await streamReader.read()
      const message = toString(data.subarray())

      try {
        const kvPair = JSON.parse(message)
        if (kvPair.key && kvPair.value !== undefined) {
          kvStore.set(kvPair.key, kvPair.value)
          console.log(`Stored: ${kvPair.key} -> ${kvPair.value} (${kvStore.size} total)`)
          await streamWriter.write(fromString(JSON.stringify({ success: true, message: 'Stored successfully' })))
        } else {
          console.log(`Invalid KV format: ${message}`)
          await streamWriter.write(fromString(JSON.stringify({ success: false, error: 'Invalid format' })))
        }
      } catch (parseError) {
        console.log(`Invalid JSON: ${message}`)
        await streamWriter.write(fromString(JSON.stringify({ success: false, error: 'Invalid JSON' })))
      }
    }
  } catch (error) {
    if (error.code !== 'ERR_STREAM_ABORT') {
      console.log(`KV stream error: ${error.message}`)
    }
  }
})

server.handle(KV_QUERY_PROTOCOL, async ({ stream, connection }) => {
  const streamReader = byteStream(stream)
  const streamWriter = byteStream(stream)

  try {
    while (true) {
      const data = await streamReader.read()
      const message = toString(data.subarray())

      try {
        const query = JSON.parse(message)

        if (query.action === 'get' && query.key) {
          const value = kvStore.get(query.key)
          await streamWriter.write(fromString(JSON.stringify({
            success: true,
            key: query.key,
            value: value,
            found: value !== undefined
          })))
          console.log(`Query: ${query.key} -> ${value ? 'found' : 'not found'}`)

        } else if (query.action === 'list') {
          const keys = Array.from(kvStore.keys())
          await streamWriter.write(fromString(JSON.stringify({
            success: true,
            keys: keys,
            count: keys.length
          })))
          console.log(`List query: ${keys.length} keys`)

        } else if (query.action === 'delete' && query.key) {
          const deleted = kvStore.delete(query.key)
          await streamWriter.write(fromString(JSON.stringify({
            success: true,
            key: query.key,
            deleted: deleted
          })))
          console.log(`Delete: ${query.key} (${deleted ? 'deleted' : 'not found'}) - ${kvStore.size} remaining`)

        } else {
          console.log(`Invalid query: ${message}`)
          await streamWriter.write(fromString(JSON.stringify({ success: false, error: 'Invalid format' })))
        }
      } catch (parseError) {
        console.log(`Invalid JSON query: ${message}`)
        await streamWriter.write(fromString(JSON.stringify({ success: false, error: 'Invalid JSON' })))
      }
    }
  } catch (error) {
    if (error.code !== 'ERR_STREAM_ABORT') {
      console.log(`Query stream error: ${error.message}`)
    }
  }
})

console.log('Relay server started:')
console.log(`Peer ID: ${server.peerId.toString()}`)
console.log(`Listening on: ${server.getMultiaddrs().map(ma => ma.toString()).join(', ')}`)
console.log('Protocols: KV storage, KV query ready')
