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
import { ApiPromise, WsProvider } from '@polkadot/api'
import { decodeAddress, encodeAddress } from '@polkadot/keyring'
import { cryptoWaitReady, sr25519Sign, sr25519Verify, sr25519PairFromSeed } from '@polkadot/util-crypto'
import { hexToU8a, u8aToHex } from '@polkadot/util'
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

// WASM Threshold Signing State
let generatedAllMessage = null
let receivedAllMessage = null
let round1Nonces = null
let round1Commitments = null
let receivedRound1Commitments = [] // Array to store commitments from other participants
let round2SigningPackage = null
let receivedSigningPackages = [] // Array to store signing packages from other participants
let receivedSigningPackagesMetadata = [] // Metadata for received signing packages

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

// General Helpers
const HEX_PATTERN = /^0x[0-9a-fA-F]+$/
const HEX_NO_PREFIX_PATTERN = /^[0-9a-fA-F]+$/

const toHexString = (value, { withPrefix = false } = {}) => {
  const uint8 = value instanceof Uint8Array ? value : Uint8Array.from(value)
  const hex = Array.from(uint8).map((b) => b.toString(16).padStart(2, '0')).join('')
  return withPrefix ? `0x${hex}` : hex
}

const normalizeHexString = (value) => {
  if (typeof value !== 'string') {
    return null
  }
  if (HEX_PATTERN.test(value)) {
    return value
  }
  if (HEX_NO_PREFIX_PATTERN.test(value)) {
    return `0x${value}`
  }
  return null
}

const toUint8ArrayNormalized = (value, label = 'value') => {
  if (value instanceof Uint8Array) {
    return value
  }

  if (Array.isArray(value)) {
    return Uint8Array.from(value)
  }

  if (typeof value === 'string') {
    const normalizedHex = normalizeHexString(value)
    if (normalizedHex) {
      return hexToU8a(normalizedHex)
    }
  }

  throw new Error(`Unsupported ${label} type: ${typeof value}`)
}

const toPayloadUint8Array = (value, label = 'payload') => {
  if (value instanceof Uint8Array) {
    return value
  }

  if (Array.isArray(value)) {
    return Uint8Array.from(value)
  }

  if (typeof value === 'string') {
    const normalizedHex = normalizeHexString(value)
    if (normalizedHex) {
      return hexToU8a(normalizedHex)
    }
    return new TextEncoder().encode(value)
  }

  throw new Error(`Unsupported ${label} type: ${typeof value}`)
}

const serializeByteArrays = (value, label = 'value') => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`)
  }

  const normalized = value.map((entry, index) => Array.from(toUint8ArrayNormalized(entry, `${label}[${index}]`)))
  const json = JSON.stringify(normalized)
  return {
    normalized,
    json,
    bytes: new TextEncoder().encode(json)
  }
}

const ensureThreshold = (threshold) => {
  const parsed = typeof threshold === 'number' ? threshold : parseInt(threshold, 10)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Threshold must be a positive integer. Received: ${threshold}`)
  }
  return parsed
}

const normalizeSs58Recipients = (recipients) => {
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new Error('Recipients must be a non-empty array of SS58 addresses')
  }
  return recipients.map((recipient, index) => {
    if (typeof recipient !== 'string') {
      throw new Error(`Recipient at index ${index} must be a string`)
    }
    validatePolkadotAddress(recipient)
    return recipient
  })
}

const concatRecipientPublicKeys = (recipients) => {
  const publicKeyBytes = recipients.map((recipient) => window.ss58ToPublicKeyBytes(recipient))
  const totalLength = publicKeyBytes.reduce((sum, bytes) => sum + bytes.length, 0)
  const concatenated = new Uint8Array(totalLength)
  let offset = 0
  for (const bytes of publicKeyBytes) {
    concatenated.set(bytes, offset)
    offset += bytes.length
  }
  return { concatenated, publicKeyBytes }
}

// Persistence Helpers
const STORAGE_KEY_PREFIX = 'thresholdSigning:user'
const STORAGE_VERSION = 1
const STORAGE_FALLBACK_ADDRESS = 'anonymous'

const getStorageKeyForAddress = (address) => {
  const suffix = typeof address === 'string' && address.trim().length > 0 ? address.trim() : STORAGE_FALLBACK_ADDRESS
  return `${STORAGE_KEY_PREFIX}:${suffix}`
}

const loadPersistedUserState = (address) => {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }

  const key = getStorageKeyForAddress(address)
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) {
      return null
    }

    const parsed = JSON.parse(raw)
    if (!parsed || parsed.version !== STORAGE_VERSION || typeof parsed.data !== 'object' || parsed.data === null) {
      return null
    }

    return parsed.data
  } catch (error) {
    console.warn('Failed to load persisted threshold signing state:', error)
    return null
  }
}

const writePersistedUserState = (address, data) => {
  if (typeof window === 'undefined' || !window.localStorage) {
    return false
  }

  const key = getStorageKeyForAddress(address)
  try {
    const payload = JSON.stringify({
      version: STORAGE_VERSION,
      updatedAt: Date.now(),
      data
    })
    window.localStorage.setItem(key, payload)
    return true
  } catch (error) {
    console.warn('Failed to persist threshold signing state:', error)
    return false
  }
}

const mergePersistedUserState = (address, updates) => {
  if (!updates || typeof updates !== 'object') {
    return null
  }

  const current = loadPersistedUserState(address) || {}
  const next = { ...current, ...updates }
  writePersistedUserState(address, next)
  return next
}

const encodeBytesForStorage = (value) => {
  if (!value) {
    return null
  }
  if (value instanceof Uint8Array) {
    return toHexString(value, { withPrefix: true })
  }
  if (Array.isArray(value)) {
    return toHexString(Uint8Array.from(value), { withPrefix: true })
  }
  if (typeof value === 'string') {
    const normalized = normalizeHexString(value)
    return normalized
  }
  return null
}

const decodeStoredHexToBytes = (value) => {
  if (typeof value !== 'string') {
    return null
  }
  const normalized = normalizeHexString(value)
  if (!normalized) {
    return null
  }
  try {
    return hexToU8a(normalized)
  } catch (error) {
    console.warn('Failed to decode stored hex value:', error)
    return null
  }
}

const updateGeneratedAllMessageUi = (bytes, hexString) => {
  const outputDiv = document.getElementById('all-message-output')
  if (outputDiv && bytes instanceof Uint8Array) {
    const hex = typeof hexString === 'string' && hexString.length > 0 ? hexString : toHexString(bytes)
    const displayHex = hex.startsWith('0x') ? hex.slice(2) : hex
    outputDiv.textContent = `AllMessage (${bytes.length} bytes): ${displayHex}`
  }
  const actionsDiv = document.getElementById('all-message-actions')
  if (actionsDiv) {
    actionsDiv.style.display = 'block'
  }
}

const persistGeneratedAllMessage = (generation) => {
  if (!generation || !(generation.allMessage instanceof Uint8Array)) {
    return
  }

  const address = sessionState?.mySS58Address
  const storedHex = encodeBytesForStorage(generation.allMessage)
  if (!storedHex) {
    return
  }

  const metadata = {
    hex: storedHex,
    threshold: typeof generation.threshold === 'number' ? generation.threshold : null,
    recipients: Array.isArray(generation.recipients) ? generation.recipients.slice() : null,
    storedAt: Date.now()
  }

  mergePersistedUserState(address, { generatedAllMessage: metadata })
  appendOutput('Saved generated AllMessage to browser storage.')
}

const persistReceivedAllMessage = (messageBytes) => {
  if (!(messageBytes instanceof Uint8Array)) {
    return
  }

  const address = sessionState?.mySS58Address
  const storedHex = encodeBytesForStorage(messageBytes)
  if (!storedHex) {
    return
  }

  const metadata = {
    hex: storedHex,
    storedAt: Date.now()
  }

  mergePersistedUserState(address, { receivedAllMessage: metadata })
  appendOutput('Saved received AllMessage to browser storage.')
}

const setThresholdProcessingState = (processing) => {
  if (!processing) {
    return null
  }

  const ensureUint8Array = (value) => {
    if (!value) {
      return null
    }
    if (value instanceof Uint8Array) {
      return new Uint8Array(value)
    }
    if (Array.isArray(value)) {
      return Uint8Array.from(value)
    }
    return null
  }

  const thresholdPublicKeyBytes =
    ensureUint8Array(processing.thresholdPublicKey) || ensureUint8Array(processing.thresholdPublicKeyArray)
  if (!thresholdPublicKeyBytes) {
    return null
  }

  const signingKeypairBytes =
    ensureUint8Array(processing.signingKeypair) || ensureUint8Array(processing.signingKeypairArray)
  const sppOutputMessageBytes =
    ensureUint8Array(processing.sppOutputMessage) || ensureUint8Array(processing.sppOutputMessageArray)

  const thresholdPublicKeyHex = processing.thresholdPublicKeyHex || toHexString(thresholdPublicKeyBytes)
  const signingKeypairHex = processing.signingKeypairHex || (signingKeypairBytes && toHexString(signingKeypairBytes))
  const sppOutputMessageHex = processing.sppOutputMessageHex || (sppOutputMessageBytes && toHexString(sppOutputMessageBytes))

  const thresholdPublicKeySS58 =
    processing.thresholdPublicKeySS58 || encodeAddress(thresholdPublicKeyBytes, 42)

  const normalizedProcessing = {
    ...processing,
    thresholdPublicKey: thresholdPublicKeyBytes,
    thresholdPublicKeyArray: Array.from(thresholdPublicKeyBytes),
    thresholdPublicKeyHex,
    thresholdPublicKeySS58,
    signingKeypair: signingKeypairBytes,
    signingKeypairArray: signingKeypairBytes ? Array.from(signingKeypairBytes) : [],
    signingKeypairHex,
    sppOutputMessage: sppOutputMessageBytes,
    sppOutputMessageArray: sppOutputMessageBytes ? Array.from(sppOutputMessageBytes) : [],
    sppOutputMessageHex,
    updatedAt: Date.now()
  }

  window.generatedThresholdKey = thresholdPublicKeyBytes
  if (sppOutputMessageBytes) {
    window.generatedSppOutputMessage = sppOutputMessageBytes
  }
  if (signingKeypairBytes) {
    window.generatedSigningKeypair = signingKeypairBytes
  }
  window.generatedThresholdResult = normalizedProcessing
  window.thresholdSigningState = window.thresholdSigningState || {}
  window.thresholdSigningState.lastProcessedThreshold = normalizedProcessing

  const thresholdSection = document.querySelector('section[aria-label="Threshold signing with SimplPedPoP"]')
  if (thresholdSection) {
    const existingDisplay = thresholdSection.querySelector('.threshold-key-display')
    if (existingDisplay) {
      existingDisplay.remove()
    }

    const thresholdKeyOutput = document.createElement('div')
    thresholdKeyOutput.style.marginTop = '10px'
    thresholdKeyOutput.style.padding = '10px'
    thresholdKeyOutput.style.backgroundColor = '#e8f5e8'
    thresholdKeyOutput.style.border = '1px solid #4caf50'
    thresholdKeyOutput.style.borderRadius = '5px'
    thresholdKeyOutput.style.fontFamily = 'monospace'
    thresholdKeyOutput.style.wordBreak = 'break-all'
    thresholdKeyOutput.className = 'threshold-key-display'
    thresholdKeyOutput.innerHTML = `
      <h4>🔐 Generated Threshold Public Key</h4>
      <p><strong>Threshold Key:</strong> ${thresholdPublicKeySS58}</p>
    `

    thresholdSection.appendChild(thresholdKeyOutput)
  }

  return normalizedProcessing
}

const persistThresholdArtifacts = (processing) => {
  if (!processing) {
    return
  }

  const thresholdHex = encodeBytesForStorage(processing.thresholdPublicKey || processing.thresholdPublicKeyArray)
  const signingHex = encodeBytesForStorage(processing.signingKeypair || processing.signingKeypairArray)
  if (!thresholdHex || !signingHex) {
    return
  }

  const metadata = {
    thresholdPublicKeyHex: thresholdHex,
    thresholdPublicKeySS58: processing.thresholdPublicKeySS58 || null,
    signingKeypairHex: signingHex,
    sppOutputMessageHex: encodeBytesForStorage(processing.sppOutputMessage || processing.sppOutputMessageArray),
    storedAt: Date.now()
  }

  const address = sessionState?.mySS58Address
  mergePersistedUserState(address, { thresholdArtifacts: metadata })
  appendOutput('Saved threshold public key and signing key to browser storage.')
}

const restorePersistedAllMessages = (address) => {
  const persisted = loadPersistedUserState(address)
  if (!persisted) {
    return
  }

  const generatedMetadata = persisted.generatedAllMessage
  if (generatedMetadata && typeof generatedMetadata.hex === 'string') {
    const bytes = decodeStoredHexToBytes(generatedMetadata.hex)
    if (bytes) {
      generatedAllMessage = bytes
      window.thresholdSigningState = window.thresholdSigningState || {}
      window.thresholdSigningState.lastGeneratedAllMessage = {
        allMessage: bytes,
        allMessageArray: Array.from(bytes),
        allMessageHex: toHexString(bytes),
        recipients: Array.isArray(generatedMetadata.recipients) ? generatedMetadata.recipients.slice() : [],
        threshold: generatedMetadata.threshold ?? null,
        restoredFromStorage: true
      }
      updateGeneratedAllMessageUi(bytes, generatedMetadata.hex)
      appendOutput('Loaded generated AllMessage from browser storage.')
    }
  }

  const receivedMetadata = persisted.receivedAllMessage
  if (receivedMetadata && typeof receivedMetadata.hex === 'string') {
    const bytes = decodeStoredHexToBytes(receivedMetadata.hex)
    if (bytes) {
      receivedAllMessage = bytes
      appendOutput('Loaded received AllMessage from browser storage.')
    }
  }

  const thresholdMetadata = persisted.thresholdArtifacts
  if (thresholdMetadata && typeof thresholdMetadata.thresholdPublicKeyHex === 'string') {
    const thresholdBytes = decodeStoredHexToBytes(thresholdMetadata.thresholdPublicKeyHex)
    const signingBytes =
      typeof thresholdMetadata.signingKeypairHex === 'string'
        ? decodeStoredHexToBytes(thresholdMetadata.signingKeypairHex)
        : null
    const sppBytes =
      typeof thresholdMetadata.sppOutputMessageHex === 'string'
        ? decodeStoredHexToBytes(thresholdMetadata.sppOutputMessageHex)
        : null

    if (thresholdBytes && signingBytes) {
      const processingState = setThresholdProcessingState({
        thresholdPublicKey: thresholdBytes,
        thresholdPublicKeyHex: toHexString(thresholdBytes),
        thresholdPublicKeySS58: thresholdMetadata.thresholdPublicKeySS58 || encodeAddress(thresholdBytes, 42),
        signingKeypair: signingBytes,
        signingKeypairHex: toHexString(signingBytes),
        sppOutputMessage: sppBytes || undefined,
        sppOutputMessageHex: sppBytes ? toHexString(sppBytes) : undefined,
        restoredFromStorage: true
      })

      if (processingState) {
        appendOutput('Loaded threshold public key and signing key from browser storage.')
      }
    }
  }
}

const parseSigningJson = (jsonString, label) => {
  const parsed = JSON.parse(jsonString)
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} response must be an array`)
  }

  const isNested = parsed.length > 0 && parsed.every((item) => Array.isArray(item))

  if (isNested) {
    const byteArrays = parsed.map((item, index) => {
      if (!Array.isArray(item) || !item.every((value) => typeof value === 'number')) {
        throw new Error(`${label}[${index}] must be an array of numbers`)
      }
      return {
        array: item,
        bytes: Uint8Array.from(item),
        hex: toHexString(item)
      }
    })
    return {
      isNested: true,
      arrays: parsed,
      byteArrays,
      bytes: byteArrays.map((entry) => entry.bytes),
      hex: byteArrays.map((entry) => entry.hex)
    }
  }

  if (!parsed.every((value) => typeof value === 'number')) {
    throw new Error(`${label} must contain numeric byte values`)
  }

  const bytes = Uint8Array.from(parsed)
  return {
    isNested: false,
    arrays: parsed,
    bytes,
    hex: toHexString(bytes)
  }
}

const DEFAULT_PEER_SS58_ADDRESSES = Object.freeze([
  '5CXkZyy4S5b3w16wvKA2hUwzp5q2y7UtRPkXnW97QGvDN8Jw',
  '5Gma8SNsn6rkQf9reAWFQ9WKq8bwwHtSzwMYtLTdhYsGPKiy'
])

const areUint8ArraysEqual = (a, b) => {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) {
    return false
  }
  if (a.length !== b.length) {
    return false
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false
    }
  }
  return true
}

const ensureCachedThresholdSigningForAddress = (ss58Address) => {
  // Cache functionality removed - always return null
  return { artifacts: null, updated: false }
}

const EXTRINSIC_TEST_CONFIG = Object.freeze({
  recipients: [...DEFAULT_PEER_SS58_ADDRESSES],
  secretKeys: [
    '0x473a77675b8e77d90c1b6dc2dbe6ac533b0853790ea8bcadf0ee8b5da4cfbbce',
    '0xdb9ddbb3d6671c4de8248a4fba95f3d873dc21a0434b52951bb33730c1ac93d7'
  ],
  threshold: 2,
  remarkText: 'Hello Westend (threshold signing example)',
  wsEndpoint: 'wss://westend-rpc.polkadot.io',
  signingContext: 'substrate'
})

const createThresholdSigningApi = () => {
  const textEncoder = new TextEncoder()

  const ensureSecretKeyHex = (secretKey) => {
    if (secretKey instanceof Uint8Array || Array.isArray(secretKey)) {
      return toHexString(secretKey, { withPrefix: true })
    }

    if (typeof secretKey === 'string') {
      const normalized = normalizeHexString(secretKey)
      if (!normalized) {
        throw new Error('Secret key must be a hex string (with or without 0x prefix) or Uint8Array')
      }
      return normalized
    }

    throw new Error('Unsupported secret key format')
  }

  const generateAllMessage = ({ secretKey, recipients, threshold }) => {
    const normalizedSecretKeyHex = ensureSecretKeyHex(secretKey)
    const keypairBytes = window.createKeypairBytes(normalizedSecretKeyHex)
    const normalizedRecipients = normalizeSs58Recipients(recipients)
    const { concatenated, publicKeyBytes } = concatRecipientPublicKeys(normalizedRecipients)
    const normalizedThreshold = ensureThreshold(threshold)

    const allMessage = window.wasm_simplpedpop_contribute_all(
      keypairBytes,
      normalizedThreshold,
      concatenated
    )

    return {
      allMessage,
      allMessageArray: Array.from(allMessage),
      allMessageHex: toHexString(allMessage),
      keypairBytes,
      secretKeyHex: normalizedSecretKeyHex,
      recipients: normalizedRecipients,
      recipientsPublicKeyBytes: publicKeyBytes,
      recipientsConcat: concatenated,
      threshold: normalizedThreshold
    }
  }

  const processAllMessages = ({ secretKey, allMessages }) => {
    const normalizedSecretKeyHex = ensureSecretKeyHex(secretKey)
    const keypairBytes = window.createKeypairBytes(normalizedSecretKeyHex)

    const { normalized, json, bytes } = serializeByteArrays(allMessages, 'allMessages')

    const result = window.wasm_simplpedpop_recipient_all(keypairBytes, bytes)

    const thresholdPublicKey = result.threshold_public_key
    const sppOutputMessage = result.spp_output_message
    const signingKeypair = result.signing_keypair

    console.info('processAllMessages signing keypair', {
      signingKeypair,
      signingKeypairHex: toHexString(signingKeypair)
    })

    return {
      thresholdPublicKey,
      thresholdPublicKeyArray: Array.from(thresholdPublicKey),
      thresholdPublicKeyHex: toHexString(thresholdPublicKey),
      thresholdPublicKeySS58: encodeAddress(thresholdPublicKey),
      sppOutputMessage,
      sppOutputMessageArray: Array.from(sppOutputMessage),
      sppOutputMessageHex: toHexString(sppOutputMessage),
      signingKeypair,
      signingKeypairArray: Array.from(signingKeypair),
      signingKeypairHex: toHexString(signingKeypair),
      secretKeyHex: normalizedSecretKeyHex,
      allMessagesJson: json,
      allMessagesNormalized: normalized
    }
  }

  const runRound1 = ({ signingKeypair }) => {
    const signingKeypairBytes = toUint8ArrayNormalized(signingKeypair, 'signingKeypair')
    const round1Result = window.wasm_threshold_sign_round1(signingKeypairBytes)

    const nonces = parseSigningJson(round1Result.signing_nonces, 'signing_nonces')
    const commitments = parseSigningJson(round1Result.signing_commitments, 'signing_commitments')

    return {
      signingNoncesJson: round1Result.signing_nonces,
      signingCommitmentsJson: round1Result.signing_commitments,
      signingNoncesArray: nonces.arrays,
      signingCommitmentsArray: commitments.arrays,
      signingNoncesBytes: nonces.bytes,
      signingCommitmentsBytes: commitments.bytes,
      signingNoncesHex: nonces.hex,
      signingCommitmentsHex: commitments.hex,
      signingNoncesIsNested: nonces.isNested,
      signingCommitmentsIsNested: commitments.isNested
    }
  }

  const normalizeCommitments = (commitments) => {
    if (typeof commitments === 'string') {
      return {
        json: commitments,
        bytes: textEncoder.encode(commitments),
        normalized: JSON.parse(commitments)
      }
    }

    const { json, bytes, normalized } = serializeByteArrays(commitments, 'commitments')
    return { json, bytes, normalized }
  }

  const runRound2 = ({
    signingKeypair,
    signingNonces,
    commitments,
    sppOutputMessage,
    payload,
    context = 'substrate'
  }) => {
    const signingKeypairBytes = toUint8ArrayNormalized(signingKeypair, 'signingKeypair')
    const noncesBytes = toUint8ArrayNormalized(signingNonces, 'signingNonces')
    const { bytes: commitmentsBytes, json: commitmentsJson, normalized: normalizedCommitments } = normalizeCommitments(commitments)
    const sppOutputMessageBytes = toUint8ArrayNormalized(sppOutputMessage, 'sppOutputMessage')
    const payloadBytes = toPayloadUint8Array(payload)

    const signingPackage = window.wasm_threshold_sign_round2(
      signingKeypairBytes,
      noncesBytes,
      commitmentsBytes,
      sppOutputMessageBytes,
      payloadBytes,
      context
    )

    return {
      signingPackage,
      signingPackageArray: Array.from(signingPackage),
      signingPackageHex: toHexString(signingPackage),
      commitmentsJson,
      commitmentsNormalized: normalizedCommitments,
      payloadBytes,
      context
    }
  }

  const aggregateSignatures = ({ signingPackages }) => {
    const { bytes, normalized, json } = serializeByteArrays(signingPackages, 'signingPackages')
    appendOutput(`Aggregating ${signingPackages.length} signing package(s).`)
    appendOutput(`Signing packages bytes length: ${bytes.length}`)
    appendOutput(
      `Signing packages bytes (hex preview): ${toHexString(bytes.slice(0, Math.min(bytes.length, 64)), {
        withPrefix: true
      })}${bytes.length > 64 ? '…' : ''}`
    )
    const aggregatedSignature = window.wasm_aggregate_threshold_signature(bytes)

    return {
      aggregatedSignature,
      aggregatedSignatureArray: Array.from(aggregatedSignature),
      aggregatedSignatureHex: toHexString(aggregatedSignature),
      signingPackagesJson: json,
      signingPackagesNormalized: normalized
    }
  }

  const verifySignature = async ({ message, signature, publicKey, context = '' }) => {
    await initializeCrypto()

    const signatureBytes = toUint8ArrayNormalized(signature, 'signature')
    const publicKeyBytes = toUint8ArrayNormalized(publicKey, 'publicKey')
    const payloadBytes = toPayloadUint8Array(message, 'message')

    if (context && typeof context !== 'string') {
      throw new Error('Context must be a string when provided')
    }

    if (context) {
      const contextBytes = textEncoder.encode(context)
      const combined = new Uint8Array(contextBytes.length + payloadBytes.length)
      combined.set(contextBytes, 0)
      combined.set(payloadBytes, contextBytes.length)
      return sr25519Verify(combined, signatureBytes, publicKeyBytes)
    }

    return sr25519Verify(payloadBytes, signatureBytes, publicKeyBytes)
  }

  return {
    generateAllMessage,
    processAllMessages,
    runRound1,
    runRound2,
    aggregateSignatures,
    verifySignature,
    utils: {
      toUint8Array: toUint8ArrayNormalized,
      toHexString,
      serializeByteArrays
    }
  }
}

const updatePeerRound1CommitmentsStatus = () => {
  const statusElement = document.getElementById('round1-commitments-status')
  if (!statusElement) return

  if (receivedRound1Commitments.length === 0) {
    statusElement.textContent = 'No peer commitments loaded.'
    statusElement.style.color = '#555'
  } else {
    statusElement.textContent = `Loaded ${receivedRound1Commitments.length} commitment set(s).`
    statusElement.style.color = '#2f855a'
  }
}

const updatePeerSigningPackagesStatus = () => {
  const statusElement = document.getElementById('signing-packages-status')
  if (!statusElement) return

  if (receivedSigningPackages.length === 0) {
    statusElement.textContent = 'No peer signing packages loaded.'
    statusElement.style.color = '#555'
  } else {
    statusElement.textContent = `Loaded ${receivedSigningPackages.length} signing package(s).`
    statusElement.style.color = '#2f855a'
  }
}

const parsePeerByteArraysInput = (rawInput, label) => {
  let parsed
  try {
    parsed = JSON.parse(rawInput)
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error.message}`)
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${label} must be a non-empty JSON array`)
  }

  return parsed.map((entry, index) => {
    try {
      const bytes = toUint8ArrayNormalized(entry, `${label}[${index}]`)
      return Array.from(bytes)
    } catch (error) {
      throw new Error(`${label}[${index}]: ${error.message}`)
    }
  })
}

// Utility Functions
const appendOutput = (message) => {
  const div = document.createElement('div')
  div.appendChild(document.createTextNode(message))
  output.append(div)
}

const printTestOutput = () => {
  appendOutput('Test output section: button clicked.')
}

const arraysEqual = (a, b) => {
  if (a.length !== b.length) {
    return false
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false
    }
  }
  return true
}

const pushUniqueByteArray = (target, entry) => {
  const normalized = Array.from(entry)
  const exists = target.some(existing => arraysEqual(existing, normalized))
  if (exists) {
    return false
  }
  target.push([...normalized])
  return true
}

const parseIncomingByteArrays = (payload, label) => {
  const trimmed = payload.trim()
  if (!trimmed) {
    throw new Error(`${label} payload is empty`)
  }

  const normalizedHex = normalizeHexString(trimmed)
  if (normalizedHex) {
    return [Array.from(hexToU8a(normalizedHex))]
  }

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    return parsePeerByteArraysInput(trimmed, label)
  }

  throw new Error(`${label} payload is not valid hex or JSON`)
}

const updatePeerCommitmentsState = () => {
  if (window.thresholdSigningState) {
    window.thresholdSigningState.peerCommitments = receivedRound1Commitments.map(entry => [...entry])
  }
  const textarea = document.getElementById('peer-round1-commitments')
  if (textarea) {
    textarea.value = JSON.stringify(receivedRound1Commitments, null, 2)
  }
  updatePeerRound1CommitmentsStatus()
}

const updatePeerSigningPackagesState = () => {
  if (window.thresholdSigningState) {
    window.thresholdSigningState.peerSigningPackages = receivedSigningPackages.map(entry => [...entry])
  }
  const textarea = document.getElementById('peer-signing-packages')
  if (textarea) {
    textarea.value = JSON.stringify(receivedSigningPackages, null, 2)
  }
  updatePeerSigningPackagesStatus()
}

const handleReceivedAllMessage = (payload) => {
  const [messageBytes] = parseIncomingByteArrays(payload, 'AllMessage')
  receivedAllMessage = Uint8Array.from(messageBytes)
  appendOutput(`✓ AllMessage received and stored: ${receivedAllMessage.length} bytes`)
  persistReceivedAllMessage(receivedAllMessage)
}

const handleReceivedRound1Commitments = (payload) => {
  const entries = parseIncomingByteArrays(payload, 'peer commitments')
  let added = 0
  for (const entry of entries) {
    if (pushUniqueByteArray(receivedRound1Commitments, entry)) {
      added++
      appendOutput(`✓ Round 1 commitments received and stored: ${entry.length} bytes`)
    }
  }

  if (added > 0) {
    appendOutput(`✓ Total received commitments: ${receivedRound1Commitments.length}`)
    updatePeerCommitmentsState()
  } else {
    appendOutput('ℹ️ Received Round 1 commitments were duplicates and were ignored')
  }
}

const normalizeHexWithPrefix = (value, label) => {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a hex string`)
  }
  const normalized = normalizeHexString(value)
  if (!normalized) {
    throw new Error(`${label} must be a hex string (with or without 0x prefix)`)
  }
  return normalized
}

const handleReceivedSigningPackages = (payload) => {
  const trimmed = payload.trim()
  if (!trimmed) {
    throw new Error('Received signing package payload is empty')
  }

  const addPackageEntry = (packageArray, metadata) => {
    const arrayCopy = Array.from(packageArray)
    const inserted = pushUniqueByteArray(receivedSigningPackages, arrayCopy)
    if (inserted) {
      receivedSigningPackagesMetadata.push(metadata ?? null)
      appendOutput(`✓ Signing package received and stored: ${arrayCopy.length} bytes`)
    } else if (metadata) {
      const index = receivedSigningPackages.findIndex(existing => arraysEqual(existing, arrayCopy))
      if (index !== -1) {
        receivedSigningPackagesMetadata[index] = metadata
        appendOutput(`ℹ️ Duplicate signing package received; metadata updated.`)
      } else {
        appendOutput('ℹ️ Duplicate signing package received and ignored.')
      }
    } else {
      appendOutput('ℹ️ Duplicate signing package received and ignored.')
    }
  }

  const parseMetadataEntry = (entry) => {
    if (!entry || typeof entry !== 'object') {
      return null
    }

    const metadata = {}

    if (entry.context !== undefined && entry.context !== null) {
      if (typeof entry.context !== 'string') {
        throw new Error('Signing package context metadata must be a string when provided')
      }
      metadata.context = entry.context
    }

    if (entry.payloadHex) {
      metadata.payloadHex = normalizeHexWithPrefix(entry.payloadHex, 'payloadHex')
    }

    if (entry.sppOutputHex) {
      metadata.sppOutputHex = normalizeHexWithPrefix(entry.sppOutputHex, 'sppOutputHex')
    }

    if (entry.commitmentsHex) {
      if (!Array.isArray(entry.commitmentsHex) || entry.commitmentsHex.length === 0) {
        throw new Error('commitmentsHex metadata must be a non-empty array when provided')
      }
      metadata.commitmentsHex = entry.commitmentsHex.map((value, index) =>
        normalizeHexWithPrefix(value, `commitmentsHex[${index}]`)
      )
    }

    return metadata
  }

  const processJsonPayload = (jsonPayload) => {
    let parsed
    try {
      parsed = JSON.parse(jsonPayload)
    } catch (error) {
      throw new Error(`Signing package JSON must be valid: ${error.message}`)
    }

    if (Array.isArray(parsed)) {
      parsed.forEach((entry, index) => {
        const normalizedEntry = Array.isArray(entry) ? entry : null
        if (!normalizedEntry) {
          throw new Error(`Signing package array entry at index ${index} must be an array of numbers`)
        }
        addPackageEntry(normalizedEntry, null)
      })
      return
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Signing package JSON payload must be an object or array')
    }

    if (Array.isArray(parsed.packages)) {
      parsed.packages.forEach((pkg, index) => {
        if (!pkg || typeof pkg !== 'object') {
          throw new Error(`packages[${index}] must be an object with packageHex`)
        }
        if (!pkg.packageHex) {
          throw new Error(`packages[${index}].packageHex is required`)
        }
        const packageHex = normalizeHexWithPrefix(pkg.packageHex, `packages[${index}].packageHex`)
        const packageBytes = Array.from(hexToU8a(packageHex))
        const metadata = parseMetadataEntry(pkg)
        addPackageEntry(packageBytes, metadata)
      })
      return
    }

    if (!parsed.packageHex) {
      throw new Error('Signing package JSON payload requires packageHex')
    }

    const packageHex = normalizeHexWithPrefix(parsed.packageHex, 'packageHex')
    const packageBytes = Array.from(hexToU8a(packageHex))
    const metadata = parseMetadataEntry(parsed)
    addPackageEntry(packageBytes, metadata)
  }

  try {
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      processJsonPayload(trimmed)
    } else {
      const entries = parseIncomingByteArrays(trimmed, 'peer signing packages')
      entries.forEach((entry) => addPackageEntry(entry, null))
    }
  } finally {
    if (receivedSigningPackages.length > 0) {
      updatePeerSigningPackagesState()
    }
  }
}

const processThresholdProtocolMessage = (message) => {
  if (message.startsWith('ALL_MESSAGE:')) {
    const payload = message.substring('ALL_MESSAGE:'.length)
    try {
      handleReceivedAllMessage(payload)
    } catch (err) {
      appendOutput(`Error parsing received AllMessage: ${err.message}`)
    }
    return true
  }

  if (message.startsWith('ROUND1_COMMITMENTS:')) {
    const payload = message.substring('ROUND1_COMMITMENTS:'.length)
    try {
      handleReceivedRound1Commitments(payload)
    } catch (err) {
      appendOutput(`Error parsing received commitments: ${err.message}`)
    }
    return true
  }

  if (message.startsWith('SIGNING_PACKAGE:')) {
    const payload = message.substring('SIGNING_PACKAGE:'.length)
    try {
      handleReceivedSigningPackages(payload)
    } catch (err) {
      appendOutput(`Error parsing received signing package: ${err.message}`)
    }
    return true
  }

  return false
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
const RELAY_PEER_ID = '12D3KooWAWN7MuqoNvFdoVKuSDG3HJvQA1txQzu5ujri49nhm2hn'
const RELAY_ADDRESS = `/ip4/${RELAY_HOST}/tcp/${RELAY_PORT}/ws/p2p/${RELAY_PEER_ID}`

// Connection Management
const verifyRelayPeer = (connection) => {
  const remotePeerId = connection?.remotePeer?.toString?.()
  if (remotePeerId !== RELAY_PEER_ID) {
    const peerLabel = remotePeerId ?? 'unknown'
    appendOutput(
      `Relay identity mismatch: expected ${RELAY_PEER_ID}, received ${peerLabel}`
    )
    return false
  }

  return true
}

const connectToRelay = async () => {
  try {
    appendOutput('Connecting to relay...')
    const relayMultiaddr = multiaddr(RELAY_ADDRESS)
    const signal = AbortSignal.timeout(CONNECTION_TIMEOUT)
    const connection = await node.dial(relayMultiaddr, { signal })
    if (!verifyRelayPeer(connection)) {
      await connection.close()
      throw new Error('Relay peer identity mismatch')
    }
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
      processThresholdProtocolMessage(message)
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
          processThresholdProtocolMessage(message)
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
    restorePersistedAllMessages(polkadotAddress)
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

    window.thresholdSigning = createThresholdSigningApi()
    window.thresholdSigningState = {
      lastGeneratedAllMessage: null,
      lastProcessedThreshold: null,
      lastRound1: null,
      lastRound2: null,
      lastAggregatedSignature: null,
      peerCommitments: [],
      peerSigningPackages: []
    }
    window.cachedRound1Signing = null

    updatePeerRound1CommitmentsStatus()
    updatePeerSigningPackagesStatus()

    window.cachedThresholdSigning = null
    appendOutput('Run Process AllMessages to generate signing keypair.')

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

window['agregate-signing-packages'].onclick = () => {
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
    try {
      const aggregation = window.thresholdSigning.aggregateSignatures({
        signingPackages: allSigningPackages
      })

      appendOutput(`JSON length: ${aggregation.signingPackagesJson.length} characters`)
      appendOutput(`Bytes length: ${new TextEncoder().encode(aggregation.signingPackagesJson).length} bytes`)

      appendOutput(`✓ Signature aggregation completed`)
      appendOutput(`✓ Aggregated signature: ${aggregation.aggregatedSignatureArray.length} bytes`)
      appendOutput(`✓ Signature (hex): ${aggregation.aggregatedSignatureHex}`)

      const signingPackageOutput = document.getElementById('signing-package-output')
      if (signingPackageOutput) {
        signingPackageOutput.innerHTML = `
          <p><strong>Aggregated Signature (${aggregation.aggregatedSignatureArray.length} bytes):</strong></p>
          <p style="word-break: break-all;">${aggregation.aggregatedSignatureHex}</p>
        `
      }

      window.aggregatedSignature = Array.from(aggregation.aggregatedSignature)
      window.thresholdSigningState.lastAggregatedSignature = aggregation
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

window['submit-extrinsic'].onclick = async () => {
  try {
    appendOutput('Preparing to submit threshold extrinsic...')

    const state = window.thresholdSigningState || {}
    let aggregatedSignatureBytes = null

    if (state.lastAggregatedSignature?.aggregatedSignature instanceof Uint8Array) {
      aggregatedSignatureBytes = new Uint8Array(state.lastAggregatedSignature.aggregatedSignature)
    } else if (Array.isArray(window.aggregatedSignature)) {
      aggregatedSignatureBytes = Uint8Array.from(window.aggregatedSignature)
    }

    if (!aggregatedSignatureBytes || aggregatedSignatureBytes.length === 0) {
      appendOutput('No aggregated signature found. Please aggregate signing packages first.')
      return
    }

    if (aggregatedSignatureBytes.length !== 64) {
      appendOutput(`Aggregated signature must be 64 bytes for Sr25519. Current length: ${aggregatedSignatureBytes.length} bytes.`)
      return
    }

    const signableDetails = state.lastSignablePayload
    if (!signableDetails) {
      appendOutput('Missing signable payload details. Please run Round 2 signing before submitting.')
      return
    }

    let signablePayloadBytes = signableDetails.signableU8a instanceof Uint8Array
      ? signableDetails.signableU8a
      : null

    if (!signablePayloadBytes && signableDetails.signableHex) {
      signablePayloadBytes = hexToU8a(signableDetails.signableHex)
    }

    if (!signablePayloadBytes) {
      appendOutput('Unable to determine signable payload bytes. Re-run Round 2 signing.')
      return
    }

    const determineThresholdPublicKey = () => {
      if (state.lastProcessedThreshold?.thresholdPublicKey) {
        return new Uint8Array(state.lastProcessedThreshold.thresholdPublicKey)
      }
      if (window.generatedThresholdKey) {
        return window.generatedThresholdKey instanceof Uint8Array
          ? new Uint8Array(window.generatedThresholdKey)
          : Uint8Array.from(window.generatedThresholdKey)
      }
      if (window.cachedThresholdSigning?.thresholdPublicKey) {
        return window.cachedThresholdSigning.thresholdPublicKey instanceof Uint8Array
          ? new Uint8Array(window.cachedThresholdSigning.thresholdPublicKey)
          : new Uint8Array(window.cachedThresholdSigning.thresholdPublicKey)
      }
      return null
    }

    const thresholdPublicKey = determineThresholdPublicKey()

    if (!thresholdPublicKey) {
      appendOutput('Threshold public key is unavailable. Please process AllMessages or load cached artifacts.')
      return
    }

    const wsEndpoint = signableDetails.wsEndpoint || EXTRINSIC_TEST_CONFIG.wsEndpoint
    const remarkHex = signableDetails.remarkHex ||
      (() => {
        const encoder = new TextEncoder()
        return toHexString(encoder.encode(EXTRINSIC_TEST_CONFIG.remarkText), { withPrefix: true })
      })()

    const context = signableDetails.signingContext || EXTRINSIC_TEST_CONFIG.signingContext || ''
    const payloadHexPreview = signableDetails.signableHex?.substring(0, 100) ?? '(unavailable)'

    appendOutput(`Using WS endpoint: ${wsEndpoint}`)
    appendOutput(`Signable payload hex (preview): ${payloadHexPreview}...`)

    const provider = new WsProvider(wsEndpoint)
    let api

    try {
      api = await ApiPromise.create({ provider })
      await api.isReady

      const chainName = api.runtimeChain.toString()
      appendOutput(`Connected to chain: ${chainName}`)
      appendOutput(`Runtime specVersion: ${api.runtimeVersion.specVersion.toString()} | transactionVersion: ${api.runtimeVersion.transactionVersion.toString()}`)

      if (typeof signableDetails.specVersion === 'number' && signableDetails.specVersion !== api.runtimeVersion.specVersion.toNumber()) {
        appendOutput(`⚠️  Warning: Current specVersion (${api.runtimeVersion.specVersion.toString()}) differs from the one used during signing (${signableDetails.specVersion}).`)
      }

      const remark = api.tx.system.remark(remarkHex)
      const accountId32 = api.registry.createType('AccountId32', thresholdPublicKey)
      const accountIdHex = accountId32.toHex()
      const accountIdSS58 = signableDetails.accountId32SS58 || accountId32.toHuman()

      appendOutput(`Threshold account (hex): ${accountIdHex}`)
      appendOutput(`Threshold account (SS58): ${accountIdSS58}`)

      let signatureVerified = false
      try {
        if (context) {
          const encoder = new TextEncoder()
          const contextBytes = encoder.encode(context)
          const combined = new Uint8Array(contextBytes.length + signablePayloadBytes.length)
          combined.set(contextBytes, 0)
          combined.set(signablePayloadBytes, contextBytes.length)
          signatureVerified = sr25519Verify(combined, aggregatedSignatureBytes, thresholdPublicKey)
        } else {
          signatureVerified = sr25519Verify(signablePayloadBytes, aggregatedSignatureBytes, thresholdPublicKey)
        }
      } catch (verifyError) {
        appendOutput(`⚠️  Failed to verify signature locally: ${verifyError.message}`)
      }

      appendOutput(`Signature verification result: ${signatureVerified ? 'valid' : 'invalid or unchecked'}`)

      const eraValue = signableDetails.payloadFields?.era ?? signableDetails.eraHex ?? '0x00'
      const nonceValue = signableDetails.payloadFields?.nonce ?? signableDetails.nonce ?? '0'
      const tipValue = signableDetails.payloadFields?.tip ?? '0'

      const era = api.registry.createType('ExtrinsicEra', eraValue)
      const nonce = api.registry.createType('Index', nonceValue)

      const signatureType = api.registry.createType('MultiSignature', {
        Sr25519: aggregatedSignatureBytes
      })

      const signedExtrinsic = remark.addSignature(
        accountId32,
        signatureType,
        {
          era,
          nonce,
          tip: tipValue
        }
      )

      const signedHex = signedExtrinsic.toHex()
      appendOutput(`Signed extrinsic length: ${signedHex.length} characters`)
      appendOutput(`Signed extrinsic (preview): ${signedHex.substring(0, 200)}...`)

      let balanceInfo = null
      let paymentInfo = null

      try {
        balanceInfo = await api.query.system.account(accountId32)
        paymentInfo = await signedExtrinsic.paymentInfo(accountId32)
      } catch (queryError) {
        appendOutput(`⚠️  Unable to fetch balance or payment info: ${queryError.message}`)
      }

      let sufficientBalance = true
      if (balanceInfo && paymentInfo) {
        const free = balanceInfo.data.free.toBigInt()
        const fee = paymentInfo.partialFee.toBigInt()
        const buffer = 10_000_000_000n // 0.00001 WND buffer
        const required = fee + buffer
        const wnd = (value) => Number(value) / 1e12

        appendOutput(`Account balance: ${free.toString()} Planck (${wnd(free).toFixed(6)} WND)`)
        appendOutput(`Estimated fee: ${fee.toString()} Planck (${wnd(fee).toFixed(6)} WND)`)
        appendOutput(`Required balance (fee + buffer): ${required.toString()} Planck (${wnd(required).toFixed(6)} WND)`)

        if (free < required) {
          sufficientBalance = false
          appendOutput('⚠️  Insufficient balance to cover fee. Skipping submission. Fund the threshold account and try again.')
        }
      } else {
        appendOutput('⚠️  Proceeding without balance check (data unavailable).')
      }

      if (!sufficientBalance) {
        return
      }

      try {
        appendOutput('Submitting extrinsic...')
        const txHash = await api.rpc.author.submitExtrinsic(signedHex)
        appendOutput(`✓ Extrinsic submitted successfully. TxHash: ${txHash.toHex()}`)
      } catch (submissionError) {
        appendOutput(`⚠️  Extrinsic submission failed: ${submissionError.message}`)
      }
    } finally {
      if (api) {
        await api.disconnect()
      } else {
        await provider.disconnect?.()
      }
    }
  } catch (err) {
    appendOutput(`Error submitting extrinsic: ${err.message}`)
    console.error('submit-extrinsic error:', err)
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
    try {
      const generation = window.thresholdSigning.generateAllMessage({
        secretKey: secretKeyInput,
        recipients,
        threshold
      })

      generatedAllMessage = generation.allMessage
      window.thresholdSigningState.lastGeneratedAllMessage = generation

      appendOutput(`Generated keypair: ${generation.keypairBytes.length} bytes`)
      appendOutput(`Concatenated recipients: ${generation.recipientsConcat.length} bytes`)
      appendOutput(`✓ AllMessage generated successfully: ${generation.allMessage.length} bytes`)
      appendOutput(`First 16 bytes: ${Array.from(generation.allMessage.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`)

      const outputDiv = document.getElementById('all-message-output')
      outputDiv.textContent = `AllMessage (${generation.allMessage.length} bytes): ${generation.allMessageHex}`

      const actionsDiv = document.getElementById('all-message-actions')
      actionsDiv.style.display = 'block'

      appendOutput('AllMessage ready for sending or storage')
      persistGeneratedAllMessage(generation)
    } catch (err) {
      appendOutput(`Error generating AllMessage: ${err.message}`)
      console.error('Generate AllMessage error:', err)
    }

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

    try {
      const processing = window.thresholdSigning.processAllMessages({
        secretKey: secretKeyInput,
        allMessages: [generatedAllMessage, receivedAllMessage]
      })

      appendOutput('Calling wasm_simplpedpop_recipient_all...')
      appendOutput(`✓ Threshold key generated successfully: ${processing.thresholdPublicKey.length} bytes`)
      appendOutput(`✓ SPP Output Message: ${processing.sppOutputMessage.length} bytes`)
      appendOutput(`SPP Output Message (hex): ${processing.sppOutputMessageHex}`)
      appendOutput(`✓ Signing Keypair: ${processing.signingKeypair.length} bytes`)
      appendOutput(`First 16 bytes: ${processing.thresholdPublicKeyArray.slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join(' ')}`)
      appendOutput(`Threshold Public Key (hex): ${processing.thresholdPublicKeyHex}`)

      const normalizedProcessing = setThresholdProcessingState(processing) || processing
      appendOutput('✓ Threshold key processing completed successfully!')
      appendOutput('The threshold public key, SPP output message, and signing keypair are now available for use in threshold signing operations.')
      persistThresholdArtifacts(normalizedProcessing)

      const round1Actions = document.getElementById('round1-signing-actions')
      if (round1Actions) {
        round1Actions.style.display = 'block'
      }
    } catch (err) {
      appendOutput(`Error processing AllMessages: ${err.message}`)
      console.error('Process AllMessages error:', err)
      return
    }

  } catch (err) {
    appendOutput(`Error processing AllMessages: ${err.message}`)
    console.error('Process AllMessages error:', err)
  }
}

const updateRound1StateAndUi = (result, { ownerAddress = null, source = 'runtime' } = {}) => {
  const normalizeArray = (value) => {
    if (value instanceof Uint8Array) {
      return Array.from(value)
    }
    if (Array.isArray(value)) {
      return value.slice()
    }
    return []
  }

  round1Nonces = normalizeArray(result.signingNoncesArray)
  round1Commitments = normalizeArray(result.signingCommitmentsArray)
  window.thresholdSigningState = window.thresholdSigningState || {}
  window.thresholdSigningState.lastRound1 = result

  if (round1Nonces.length > 0 && round1Commitments.length > 0) {
    window.cachedRound1Signing = {
      ownerAddress,
      source,
      nonces: Uint8Array.from(round1Nonces),
      commitments: Uint8Array.from(round1Commitments)
    }
  }

  const noncesLength = Array.isArray(round1Nonces) ? round1Nonces.length : 0
  const commitmentsLength = Array.isArray(round1Commitments) ? round1Commitments.length : 0

  appendOutput(`✓ Round 1 signing completed`)
  appendOutput(`✓ Nonces: ${noncesLength} bytes`)
  appendOutput(`✓ Commitments: ${commitmentsLength} bytes`)

  const round1Output = document.getElementById('round1-output')
  if (round1Output) {
    const noncesHexSummary = Array.isArray(result.signingNoncesHex)
      ? result.signingNoncesHex[0]
      : result.signingNoncesHex
    const commitmentsHexSummary = Array.isArray(result.signingCommitmentsHex)
      ? result.signingCommitmentsHex[0]
      : result.signingCommitmentsHex

    round1Output.innerHTML = `
      <p><strong>Nonces (${noncesLength} bytes):</strong> ${noncesHexSummary?.substring(0, 64) ?? 'n/a'}...</p>
      <p><strong>Commitments (${commitmentsLength} bytes):</strong> ${commitmentsHexSummary?.substring(0, 64) ?? 'n/a'}...</p>
    `
  }

  const sendCommitmentsButton = document.getElementById('send-round1-commitments')
  if (sendCommitmentsButton) {
    sendCommitmentsButton.style.display = 'block'
  }

  const round2Actions = document.getElementById('round2-signing-actions')
  if (round2Actions) {
    round2Actions.style.display = 'block'
  }
}

const updateRound2StateAndUi = (result) => {
  round2SigningPackage = result.signingPackageArray
  window.thresholdSigningState = window.thresholdSigningState || {}
  window.thresholdSigningState.lastRound2 = result
  if (result.commonData) {
    window.thresholdSigningState.lastRound2CommonData = result.commonData
  }

  const commitmentsJsonLength = typeof result.commitmentsJson === 'string'
    ? result.commitmentsJson.length
    : 0
  const signingPackageLength = Array.isArray(round2SigningPackage) ? round2SigningPackage.length : 0

  appendOutput(`Commitments JSON length: ${commitmentsJsonLength} characters`)
  appendOutput(`✓ Round 2 signing completed`)
  appendOutput(`✓ Signing package: ${signingPackageLength} bytes`)

  const round2Output = document.getElementById('round2-output')
  if (round2Output) {
    const signingPackagePreview = typeof result.signingPackageHex === 'string'
      ? result.signingPackageHex.substring(0, 128)
      : ''
    const commonData = result.commonData
    const commonDataHtml = commonData
      ? `
        <p><strong>Context:</strong> ${commonData.context}</p>
        <p><strong>Payload Hex (first 64 chars):</strong> ${commonData.payloadHex.substring(0, 66)}...</p>
        <p><strong>Commitments:</strong> ${commonData.commitmentsHex.length}</p>
      `
      : ''
    round2Output.innerHTML = `
      <p><strong>Signing Package (${signingPackageLength} bytes):</strong> ${signingPackagePreview}...</p>
      ${commonDataHtml}
    `
  }

  const signingPackageActions = document.getElementById('signing-package-actions')
  if (signingPackageActions) {
    signingPackageActions.style.display = 'block'
  }

  if (round2SigningPackage && typeof sessionState !== 'undefined' && sessionState && sessionState.peerMultiaddr) {
    appendOutput('Automatically sending signing package to connected peer...')
    sendSigningPackageToPeer()
  }
}

const hydrateRound1FromPolkadotCache = (targetAddress = null) => {
  if (!POLKADOT_ROUND1_CACHE) {
    return false
  }

  const peers = POLKADOT_ROUND1_CACHE.peers || {}
  const availableAddresses = Object.keys(peers)

  if (availableAddresses.length === 0) {
    return false
  }

  let localAddress = null

  if (targetAddress && peers[targetAddress]) {
    localAddress = targetAddress
  } else {
    localAddress = DEFAULT_PEER_SS58_ADDRESSES.find((addr) => peers[addr]) ?? availableAddresses[0]
  }

  const localEntry = peers[localAddress]

  if (!localEntry) {
    return false
  }

  appendOutput(`Using cached Round 1 nonces and commitments from polkadot-round1-cache.json for ${localAddress}.`)

  const cachedResult = {
    signingNoncesArray: Array.from(localEntry.nonces),
    signingCommitmentsArray: Array.from(localEntry.commitments),
    signingNoncesHex: toHexString(localEntry.nonces, { withPrefix: true }),
    signingCommitmentsHex: toHexString(localEntry.commitments, { withPrefix: true })
  }

  updateRound1StateAndUi(cachedResult, {
    ownerAddress: localAddress,
    source: 'polkadot-round1-cache'
  })

  if (receivedRound1Commitments.length === 0) {
    const peerAddress = availableAddresses.find((addr) => addr !== localAddress)
    const peerEntry = peerAddress ? peers[peerAddress] : null

    if (peerEntry && peerEntry.commitments && peerEntry.commitments.length > 0) {
      receivedRound1Commitments = [Array.from(peerEntry.commitments)]
      window.thresholdSigningState = window.thresholdSigningState || {}
      window.thresholdSigningState.peerCommitments = receivedRound1Commitments.map((entry) => [...entry])
      updatePeerRound1CommitmentsStatus()
      appendOutput(`Loaded cached peer commitments from polkadot-round1-cache.json for ${peerAddress}.`)
    }
  } else {
    window.thresholdSigningState = window.thresholdSigningState || {}
    window.thresholdSigningState.peerCommitments = receivedRound1Commitments.map((entry) => [...entry])
    updatePeerRound1CommitmentsStatus()
  }

  return true
}

async function sendSigningPackageToPeer() {
  try {
    if (!round2SigningPackage) {
      appendOutput('No signing package available. Please run Round 2 signing first.')
      return
    }

    if (typeof sessionState === 'undefined' || !sessionState.peerMultiaddr) {
      appendOutput('No peer connected. Please connect to a peer first.')
      return
    }

    appendOutput('Sending signing package to connected peer...')
    appendOutput(`Signing package size: ${round2SigningPackage.length} bytes`)

    const packageHex = toHexString(Uint8Array.from(round2SigningPackage), { withPrefix: true })
    const commonData = window.thresholdSigningState?.lastRound2CommonData || null
    const messagePayload = {
      version: 1,
      packageHex,
      context: commonData?.context ?? null,
      payloadHex: commonData?.payloadHex ?? null,
      commitmentsHex: commonData?.commitmentsHex ?? null,
      sppOutputHex: commonData?.sppOutputHex ?? null
    }
    const messageToSend = `SIGNING_PACKAGE:${JSON.stringify(messagePayload)}`

    const streamReady = await handleChatStream()
    if (!streamReady) {
      return
    }

    await sendMessage(messageToSend)
    appendOutput('✓ Signing package sent successfully to connected peer')
  } catch (err) {
    appendOutput(`Error sending signing package: ${err.message}`)
    console.error('Send signing package error:', err)
  }
}

// Round 1 Signing Handler
window['run-round1-signing'].onclick = async () => {
  try {
    const registeredAddress = typeof sessionState !== 'undefined' ? sessionState.mySS58Address : null
    let signingKeypairToUse = window.generatedSigningKeypair

    if (!signingKeypairToUse && registeredAddress) {
      const persisted = loadPersistedUserState(registeredAddress)
      const persistedHex = persisted?.thresholdArtifacts?.signingKeypairHex
      if (typeof persistedHex === 'string') {
        const decoded = decodeStoredHexToBytes(persistedHex)
        if (decoded) {
          signingKeypairToUse = decoded
          window.generatedSigningKeypair = decoded
          appendOutput('Using stored signing keypair from browser storage for Round 1 signing.')
        }
      }
    }

    if (!signingKeypairToUse) {
      appendOutput('No signing keypair available. Please process AllMessages first.')
      return
    }

    appendOutput('Running Round 1 signing...')
    const result = window.thresholdSigning.runRound1({ signingKeypair: signingKeypairToUse })

    updateRound1StateAndUi(result, {
      ownerAddress: registeredAddress,
      source: 'round1-signing'
    })

  } catch (err) {
    appendOutput(`Error in Round 1 signing: ${err.message}`)
    console.error('Round 1 signing error:', err)
  }
}

// Round 2 Signing Handler
const constructSignablePayloadForRound2 = async () => {
  const thresholdState = window.thresholdSigningState?.lastProcessedThreshold
  const thresholdPublicKey = thresholdState?.thresholdPublicKey

  if (!thresholdPublicKey) {
    throw new Error('Threshold public key unavailable. Please process AllMessages first.')
  }

  const { remarkText, wsEndpoint, signingContext } = EXTRINSIC_TEST_CONFIG
  const provider = new WsProvider(wsEndpoint)
  let api = null

  try {
    api = await ApiPromise.create({ provider })
    await api.isReady

    const chain = api.runtimeChain.toString()
    const textEncoder = new TextEncoder()
    const remarkBytes = textEncoder.encode(remarkText)
    const remarkHex = toHexString(remarkBytes, { withPrefix: true })
    const remark = api.tx.system.remark(remarkHex)
    const accountId32 = api.registry.createType('AccountId32', thresholdPublicKey)
    const accountInfo = await api.query.system.account(accountId32)
    const nonceType = accountInfo?.nonce ?? api.registry.createType('Index', 0)
    const nonce = nonceType.toString()
    const era = api.registry.createType('ExtrinsicEra', '0x00')
    const genesisHash = api.genesisHash.toHex()

    const payloadFields = {
      method: remark.method.toHex(),
      nonce,
      era: era.toHex(),
      tip: '0',
      specVersion: api.runtimeVersion.specVersion.toNumber(),
      transactionVersion: api.runtimeVersion.transactionVersion.toNumber(),
      genesisHash,
      blockHash: genesisHash
    }

    const extrinsicPayload = api.registry.createType('ExtrinsicPayload', payloadFields, {
      version: api.extrinsicVersion
    })

    const signableU8a = extrinsicPayload.toU8a({ method: true })

    return {
      signableU8a,
      signableHex: u8aToHex(signableU8a),
      remarkHex,
      payloadFields,
      chain,
      wsEndpoint,
      accountId32Hex: accountId32.toHex(),
      accountId32SS58: accountId32.toHuman(),
      nonce,
      eraHex: era.toHex(),
      genesisHash,
      blockHash: genesisHash,
      specVersion: api.runtimeVersion.specVersion.toNumber(),
      transactionVersion: api.runtimeVersion.transactionVersion.toNumber(),
      signingContext: signingContext || 'substrate'
    }
  } finally {
    if (api) {
      await api.disconnect()
    }
  }
}

window['run-round2-signing'].onclick = async () => {
  try {
    const registeredAddress = typeof sessionState !== 'undefined' ? sessionState.mySS58Address : null
    const signingKeypairToUse = window.generatedSigningKeypair
    const sppOutputMessageToUse = window.generatedSppOutputMessage

    if (!signingKeypairToUse) {
      appendOutput('No signing keypair available. Please process AllMessages first.')
      return
    }

    if (!sppOutputMessageToUse) {
      appendOutput('No SPP output message available. Please process AllMessages first.')
      return
    }

    const payloadInput = document.getElementById('round2-payload-input')
    const manualPayload = payloadInput && payloadInput.value.trim()
      ? payloadInput.value.trim()
      : ''
    if (manualPayload) {
      appendOutput('Manual payload input detected but will be replaced with constructed extrinsic payload.')
    }

    const contextInput = document.getElementById('round2-context-input')
    const contextRaw = contextInput && contextInput.value.trim()
      ? contextInput.value.trim()
      : ''
    const defaultContext = EXTRINSIC_TEST_CONFIG.signingContext || 'substrate'
    const contextText = contextRaw || defaultContext
    const currentRound1Owner = window.cachedRound1Signing?.ownerAddress || null
    const lastRound1Result = window.thresholdSigningState?.lastRound1 || null

    if (registeredAddress && currentRound1Owner && currentRound1Owner !== registeredAddress) {
      appendOutput(
        `Round 1 signing artifacts currently loaded belong to ${currentRound1Owner}, but registered address is ${registeredAddress}. Please run Round 1 signing for the registered address before Round 2.`
      )
      return
    }

    const cloneRound1Arrays = (value) => {
      if (!Array.isArray(value)) {
        return []
      }
      return value.map((entry) => (Array.isArray(entry) ? entry.slice() : entry))
    }

    let hasRound1Arrays =
      Array.isArray(round1Nonces) &&
      round1Nonces.length > 0 &&
      Array.isArray(round1Commitments) &&
      round1Commitments.length > 0

    if (!hasRound1Arrays && lastRound1Result) {
      if (Array.isArray(lastRound1Result.signingNoncesArray) && lastRound1Result.signingNoncesArray.length > 0) {
        round1Nonces = cloneRound1Arrays(lastRound1Result.signingNoncesArray)
      }
      if (
        Array.isArray(lastRound1Result.signingCommitmentsArray) &&
        lastRound1Result.signingCommitmentsArray.length > 0
      ) {
        round1Commitments = cloneRound1Arrays(lastRound1Result.signingCommitmentsArray)
      }

      hasRound1Arrays =
        Array.isArray(round1Nonces) &&
        round1Nonces.length > 0 &&
        Array.isArray(round1Commitments) &&
        round1Commitments.length > 0
    }

    if (!hasRound1Arrays) {
      appendOutput('Round 1 signing data not found in this session. Please run Round 1 signing before Round 2.')
      return
    }

    appendOutput('Using existing Round 1 signing data.')

    const ensureByteArray = (value, label) => {
      if (value instanceof Uint8Array) {
        return value
      }

      if (Array.isArray(value)) {
        if (value.length > 0 && Array.isArray(value[0])) {
          const flattened = value.flat(Infinity)
          if (!flattened.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
            throw new Error(`${label} contains invalid byte values`)
          }
          return Uint8Array.from(flattened)
        }

        if (!value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
          throw new Error(`${label} must contain numeric byte values`)
        }
        return Uint8Array.from(value)
      }

      if (typeof value === 'string') {
        const normalizedHex = normalizeHexString(value)
        if (!normalizedHex) {
          throw new Error(`${label} string must be hex-encoded`)
        }
        return hexToU8a(normalizedHex)
      }

      throw new Error(`${label} must be an array, Uint8Array, or hex string`)
    }

    if (!Array.isArray(round1Commitments) || round1Commitments.length === 0) {
      appendOutput('No local commitments available. Please re-run Round 1 signing.')
      appendOutput('No commitments available to run Round 2 signing.')
      return
    }

    const commitmentEntries = []

    try {
      commitmentEntries.push({
        source: 'local',
        bytes: ensureByteArray(round1Commitments, 'Local commitments')
      })
    } catch (error) {
      appendOutput(`Failed to normalize local commitments: ${error.message}`)
      return
    }

    receivedRound1Commitments.forEach((commitment, index) => {
      try {
        commitmentEntries.push({
          source: `peer[${index}]`,
          bytes: ensureByteArray(commitment, `Peer commitments[${index}]`)
        })
      } catch (error) {
        appendOutput(`Failed to normalize peer commitments[${index}]: ${error.message}`)
      }
    })

    if (commitmentEntries.length === 0) {
      appendOutput('No commitments available to run Round 2 signing.')
      return
    }

    const seenCommitments = new Set()
    const uniqueCommitments = []
    commitmentEntries.forEach((entry) => {
      const hex = toHexString(entry.bytes, { withPrefix: true })
      if (seenCommitments.has(hex)) {
        appendOutput(`Duplicate commitment detected from ${entry.source}; ignoring duplicate.`)
        return
      }
      seenCommitments.add(hex)
      uniqueCommitments.push({
        ...entry,
        hex
      })
    })

    if (uniqueCommitments.length === 0) {
      appendOutput('No unique commitments available after deduplication.')
      return
    }

    // Order commitments according to verifying keys order in SPP output
    // The verifying keys order matches the recipients order from AllMessage generation
    const recipients = window.thresholdSigningState?.lastGeneratedAllMessage?.recipients || null
    let orderedCommitments = []

    if (recipients && Array.isArray(recipients) && recipients.length > 0) {
      // Get local commitment
      const localCommitmentEntry = uniqueCommitments.find(entry => entry.source === 'local')
      const peerCommitmentEntries = uniqueCommitments.filter(entry => entry.source !== 'local')

      // Create a map of commitments by participant index
      const commitmentsByRecipientIndex = new Map()

      // Match local commitment to registered address position in recipients
      let useRecipientsOrder = true
      if (localCommitmentEntry && registeredAddress) {
        const localIndex = recipients.indexOf(registeredAddress)
        if (localIndex !== -1) {
          commitmentsByRecipientIndex.set(localIndex, localCommitmentEntry)
        } else {
          appendOutput(`Warning: Registered address ${registeredAddress} not found in recipients list. Using canonical ordering as fallback.`)
          useRecipientsOrder = false
        }
      } else if (localCommitmentEntry) {
        // If no registered address, assume local is first recipient
        commitmentsByRecipientIndex.set(0, localCommitmentEntry)
      }

      if (!useRecipientsOrder) {
        // Fallback to canonical ordering
        orderedCommitments = [...uniqueCommitments]
        orderedCommitments.sort((a, b) => b.hex.localeCompare(a.hex))
      } else {

        // Distribute peer commitments to remaining positions
        // We'll assign them to positions that don't have a commitment yet, in order
        let peerIndex = 0
        for (let i = 0; i < recipients.length && peerIndex < peerCommitmentEntries.length; i++) {
          if (!commitmentsByRecipientIndex.has(i)) {
            commitmentsByRecipientIndex.set(i, peerCommitmentEntries[peerIndex])
            peerIndex++
          }
        }

        // If we still have peer commitments, add them to remaining positions
        while (peerIndex < peerCommitmentEntries.length) {
          for (let i = 0; i < recipients.length && peerIndex < peerCommitmentEntries.length; i++) {
            if (!commitmentsByRecipientIndex.has(i)) {
              commitmentsByRecipientIndex.set(i, peerCommitmentEntries[peerIndex])
              peerIndex++
              break
            }
          }
        }

        // Sort by recipient index to match verifying keys order
        const sortedIndices = Array.from(commitmentsByRecipientIndex.keys()).sort((a, b) => a - b)
        orderedCommitments = sortedIndices.map(index => commitmentsByRecipientIndex.get(index))

        appendOutput(`Ordered ${orderedCommitments.length} commitment(s) according to verifying keys order in SPP output`)
      }
    } else {
      // Fallback to canonical ordering if recipients order is not available
      appendOutput('Warning: Recipients order not available. Using canonical ordering as fallback.')
      orderedCommitments = [...uniqueCommitments]
      orderedCommitments.sort((a, b) => b.hex.localeCompare(a.hex))
    }

    if (orderedCommitments.length === 0) {
      appendOutput('No commitments available after ordering.')
      return
    }

    const allCommitmentsBytes = orderedCommitments.map((entry) => entry.bytes)
    appendOutput(`Using ${allCommitmentsBytes.length} commitment set(s) ordered by verifying keys`)

    appendOutput('Constructing signable payload using extrinsic configuration...')

    let signablePayloadDetails
    try {
      signablePayloadDetails = await constructSignablePayloadForRound2()
    } catch (error) {
      appendOutput(`Failed to construct signable payload: ${error.message}`)
      return
    }

    appendOutput(`✓ Signable payload ready (${signablePayloadDetails.signableU8a.length} bytes) from ${signablePayloadDetails.chain}`)
    appendOutput(`Payload preview: ${signablePayloadDetails.signableHex.substring(0, 66)}...`)

    window.thresholdSigningState = window.thresholdSigningState || {}
    window.thresholdSigningState.lastSignablePayload = {
      ...signablePayloadDetails,
      length: signablePayloadDetails.signableU8a.length
    }

    appendOutput('Running Round 2 signing...')
    appendOutput(`Context: ${contextText}`)

    const commitmentsNormalized = allCommitmentsBytes.map((bytes) => Array.from(bytes))
    const commitmentsHex = allCommitmentsBytes.map((bytes) => toHexString(bytes, { withPrefix: true }))
    const commitmentsJson = JSON.stringify(commitmentsNormalized)
    const commitmentsBytes = new TextEncoder().encode(commitmentsJson)

    const signingKeypairBytes = ensureByteArray(signingKeypairToUse, 'Signing keypair')
    const signingNoncesBytes = ensureByteArray(round1Nonces, 'Signing nonces')
    const sppOutputMessageBytes = ensureByteArray(sppOutputMessageToUse, 'SPP output message')
    const payloadBytes = signablePayloadDetails.signableU8a
    const payloadHex = toHexString(payloadBytes, { withPrefix: true })
    const sppOutputHex = toHexString(sppOutputMessageBytes, { withPrefix: true })

    appendOutput('wasm_threshold_sign_round2 inputs:')
    appendOutput(`• signingKeypairBytes (${signingKeypairBytes.length} bytes): ${toHexString(signingKeypairBytes, { withPrefix: true })}`)
    appendOutput(
      `  ↳ bytes: [${Array.from(signingKeypairBytes)
        .map((byte) => byte.toString())
        .join(', ')}]`
    )
    appendOutput(`• signingNoncesBytes (${signingNoncesBytes.length} bytes): ${toHexString(signingNoncesBytes, { withPrefix: true })}`)
    appendOutput(
      `  ↳ bytes: [${Array.from(signingNoncesBytes)
        .map((byte) => byte.toString())
        .join(', ')}]`
    )
    appendOutput(`• commitmentsBytes (${commitmentsBytes.length} bytes): ${toHexString(commitmentsBytes, { withPrefix: true })}`)
    appendOutput(
      `  ↳ bytes: [${Array.from(commitmentsBytes)
        .map((byte) => byte.toString())
        .join(', ')}]`
    )
    appendOutput(`• sppOutputMessageBytes (${sppOutputMessageBytes.length} bytes): ${sppOutputHex}`)
    appendOutput(
      `  ↳ bytes: [${Array.from(sppOutputMessageBytes)
        .map((byte) => byte.toString())
        .join(', ')}]`
    )
    appendOutput(`• payloadBytes (${payloadBytes.length} bytes): ${payloadHex}`)
    appendOutput(
      `  ↳ bytes: [${Array.from(payloadBytes)
        .map((byte) => byte.toString())
        .join(', ')}]`
    )
    appendOutput(`• context: ${contextText}`)

    const signingPackage = window.wasm_threshold_sign_round2(
      signingKeypairBytes,
      signingNoncesBytes,
      commitmentsBytes,
      sppOutputMessageBytes,
      payloadBytes,
      contextText
    )

    const result = {
      signingPackage,
      signingPackageArray: Array.from(signingPackage),
      signingPackageHex: toHexString(signingPackage),
      commitmentsJson,
      commitmentsNormalized,
      payloadBytes,
      context: contextText,
      commonData: {
        context: contextText,
        payloadHex,
        commitmentsHex,
        sppOutputHex
      }
    }

    window.thresholdSigningState = window.thresholdSigningState || {}
    window.thresholdSigningState.lastRound2CommonData = result.commonData

    updateRound2StateAndUi(result)
  } catch (err) {
    appendOutput(`Error in Round 2 signing: ${err.message}`)
    console.error('Round 2 signing error:', err)
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

window['load-round1-commitments'].onclick = () => {
  const textarea = document.getElementById('peer-round1-commitments')
  if (!textarea) {
    appendOutput('Peer commitments input not found in DOM.')
    return
  }

  const rawText = textarea.value.trim()
  if (!rawText) {
    appendOutput('Please paste peer commitments JSON before loading.')
    return
  }

  try {
    const normalized = parsePeerByteArraysInput(rawText, 'peer commitments')
    receivedRound1Commitments = normalized
    window.thresholdSigningState.peerCommitments = normalized.map(entry => [...entry])
    textarea.value = JSON.stringify(normalized, null, 2)
    updatePeerRound1CommitmentsStatus()
    appendOutput(`Loaded ${normalized.length} peer commitment set(s) from manual input.`)
  } catch (error) {
    appendOutput(`Failed to load peer commitments: ${error.message}`)
  }
}

window['clear-round1-commitments'].onclick = () => {
  const textarea = document.getElementById('peer-round1-commitments')
  if (textarea) {
    textarea.value = ''
  }
  receivedRound1Commitments = []
  window.thresholdSigningState.peerCommitments = []
  updatePeerRound1CommitmentsStatus()
  appendOutput('Peer commitments cleared.')
}

// Send Signing Package Handler
window['send-signing-package'].onclick = () => {
  sendSigningPackageToPeer()
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
    try {
      const aggregation = window.thresholdSigning.aggregateSignatures({
        signingPackages: allSigningPackages
      })

      appendOutput(`JSON length: ${aggregation.signingPackagesJson.length} characters`)
      appendOutput(`Bytes length: ${new TextEncoder().encode(aggregation.signingPackagesJson).length} bytes`)

      appendOutput(`✓ Signature aggregation completed`)
      appendOutput(`✓ Aggregated signature: ${aggregation.aggregatedSignatureArray.length} bytes`)
      appendOutput(`✓ Signature (hex): ${aggregation.aggregatedSignatureHex}`)

      const signingPackageOutput = document.getElementById('signing-package-output')
      if (signingPackageOutput) {
        signingPackageOutput.innerHTML = `
          <p><strong>Aggregated Signature (${aggregation.aggregatedSignatureArray.length} bytes):</strong></p>
          <p style="word-break: break-all;">${aggregation.aggregatedSignatureHex}</p>
        `
      }

      window.aggregatedSignature = Array.from(aggregation.aggregatedSignature)
      window.thresholdSigningState.lastAggregatedSignature = aggregation
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

window['load-signing-packages'].onclick = () => {
  const textarea = document.getElementById('peer-signing-packages')
  if (!textarea) {
    appendOutput('Peer signing packages input not found in DOM.')
    return
  }

  const rawText = textarea.value.trim()
  if (!rawText) {
    appendOutput('Please paste peer signing packages JSON before loading.')
    return
  }

  try {
    const normalized = parsePeerByteArraysInput(rawText, 'peer signing packages')
    receivedSigningPackages = normalized
    window.thresholdSigningState.peerSigningPackages = normalized.map(entry => [...entry])
    textarea.value = JSON.stringify(normalized, null, 2)
    updatePeerSigningPackagesStatus()
    appendOutput(`Loaded ${normalized.length} peer signing package(s) from manual input.`)
  } catch (error) {
    appendOutput(`Failed to load peer signing packages: ${error.message}`)
  }
}

window['clear-signing-packages'].onclick = () => {
  const textarea = document.getElementById('peer-signing-packages')
  if (textarea) {
    textarea.value = ''
  }
  receivedSigningPackages = []
  window.thresholdSigningState.peerSigningPackages = []
  updatePeerSigningPackagesStatus()
  appendOutput('Peer signing packages cleared.')
}




