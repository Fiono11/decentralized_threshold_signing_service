# Decentralized Threshold Signing Service

## Overview

This project implements a decentralized threshold signing service leveraging the Olaf protocol. The service operates off-chain, providing a secure and cost-effective alternative to on-chain threshold signature mechanisms within the Substrate/Kusama/Polkadot ecosystem.

Each participant in the threshold signing group runs a browser-based application that performs decentralized key generation and signing operations through the Olaf threshold signature protocol, compiled to WebAssembly (WASM). The networking layer is built using JavaScript and `libp2p` for peer discovery and communication.

The service implements proof of possession mechanisms to ensure that only the legitimate owner of a Substrate/Kusama/Polkadot address can register it with the relay server and establish connections with other peers. This prevents address spoofing and ensures secure peer-to-peer communication.

### 🌐 Networking Layer (JavaScript)

**Transport**: Peers connect to a relay server using WebSockets.

**Discovery**: 
- When a peer connects, it must prove ownership of its Substrate/Polkadot/Kusama address through a cryptographic challenge-response protocol
- The peer requests a challenge from the relay server, signs it with their private key, and submits the proof
- The relay server verifies the signature using the address's public key and stores the mapping: Address → Peer ID
- Peers can query the relay server with a known blockchain address to obtain the corresponding Peer ID

**Direct Peer Communication**: Once a Peer ID is obtained, the peer establishes a WebRTC connection using `libp2p`. Before communication begins, both peers perform mutual proof of possession to verify each other's identity. All protocol messages are exchanged via this secure, direct P2P channel.

### 🔐 Cryptographic Protocol (Rust → WASM)

The cryptographic logic is written in Rust and compiled to WebAssembly (WASM) for browser use.

**Core Functionality**:
- Distributed Key Generation (DKG) to derive a shared threshold public key
- Threshold Signing for signing Substrate/Kusama/Polkadot extrinsics

**State Management**: Key shares and protocol state are stored in browser-local storage (e.g., `IndexedDB`).

### 🔒 Security Features

The service implements proof of possession mechanisms to ensure secure peer-to-peer communication and prevent address spoofing attacks.

#### Address Registration Proof of Possession

When a peer registers their SS58 address with the relay server:

1. **Challenge Generation**: The peer requests a cryptographic challenge from the relay server
2. **Challenge Signing**: The peer signs the challenge using their private key corresponding to the SS58 address
3. **Signature Verification**: The relay server verifies the signature using the address's public key
4. **Registration**: Only upon successful verification is the address registered and mapped to a Peer ID

This ensures that only the legitimate owner of a Substrate/Kusama/Polkadot address can register it with the relay server.

#### Connection Proof of Possession

When two peers establish a direct connection:

1. **Initiator Challenge**: The connecting peer requests a challenge from the target peer
2. **Initiator Response**: The connecting peer signs the challenge and sends their response
3. **Mutual Challenge**: The target peer generates their own challenge for the initiator
4. **Mutual Verification**: Both peers verify each other's signatures
5. **Connection Established**: Only after mutual verification is the connection considered secure

This mutual verification process ensures that both parties can confirm each other's identity before any sensitive protocol messages are exchanged.

#### Cryptographic Implementation

- **Signature Algorithm**: Uses SR25519 (Schnorr signatures over Ristretto25519) for compatibility with Substrate/Kusama/Polkadot
- **Challenge Format**: Random 32-byte challenges generated using cryptographically secure random number generation
- **Signature Verification**: Leverages the `@polkadot/util-crypto` library for signature verification
- **Expiration**: Challenges expire after 5 minutes to prevent replay attacks

## Development Status

### ✅ Milestone 1: Peer Discovery via Blockchain Address (COMPLETED)

This milestone establishes the foundational networking layer where two browsers can connect to a relay server, register with a Substrate/Kusama/Polkadot address, discover each other, and exchange messages directly over WebRTC using `libp2p`.

#### Completed Features:
- ✅ LibP2P relay server with WebSocket transport
- ✅ Peer discovery system using SS58 addresses with proof of possession
- ✅ Cryptographic challenge-response protocol for address registration
- ✅ Address → Peer ID mapping and storage in relay server with verification
- ✅ Browser-based LibP2P client with WebRTC transport
- ✅ Direct peer communication via WebRTC using libp2p
- ✅ Mutual proof of possession for peer-to-peer connections
- ✅ Peer-to-peer message exchange protocol with identity verification
- ✅ Docker containerization for relay server and client
- ✅ Comprehensive automated tests using Playwright
- ✅ Inline documentation and testing guide

### ✅ Milestone 2: Distributed Key Generation (COMPLETED)

Two browsers can exchange messages and successfully produce a shared threshold public key using the Olaf DKG protocol compiled to WASM.

#### Completed Features:
- ✅ Rust to WebAssembly compilation of Olaf DKG protocol (SimplPedPoP)
- ✅ Integration of DKG protocol with browser client
- ✅ Shared threshold public key generation via AllMessage exchange
- ✅ WASM functions for AllMessage generation and threshold key processing
- ✅ Peer-to-peer AllMessage exchange via WebRTC
- ✅ Threshold public key generation and verification
- ✅ Comprehensive documentation and step-by-step guide

### 🚧 Milestone 3: Threshold Signature (PLANNED)

Two browsers will exchange messages and produce a valid threshold signature over a given Substrate/Kusama/Polkadot extrinsic using the Olaf protocol compiled to WASM.

**Planned Deliverables**:
- Threshold signature generation for Substrate extrinsics
- Complete tutorial and article explaining the service
- Production-ready implementation

## Build and Testing

### Without Docker

#### Prerequisites
- Node.js installed
- npm or yarn package manager

#### Relay Peer ID configuration
- The relay server loads a base64-encoded Ed25519 private key from `config/relay-peer-key.json`. Because the private key is hardcoded, every relay startup reuses the exact same LibP2P identity.
- The browser client and automated tests read the public relay peer ID from `config/relay-peer-id.js`. Keep this file in sync with the private key above (generate a new private key with a small Node script and capture its Peer ID).
- To rotate the relay identity, replace the `privateKey` value with a new base64 string and update `config/relay-peer-id.js` with the peer ID emitted when loading that key.
- To generate a new private key and peer ID, run:
```bash
node --input-type=module <<'EOF'
import { createEd25519PeerId } from '@libp2p/peer-id-factory'

const peerId = await createEd25519PeerId()
console.log('Peer ID:', peerId.toString())
console.log('Private key (base64):', Buffer.from(peerId.privateKey).toString('base64'))
EOF
```
  Copy the printed base64 value into `config/relay-peer-key.json` and the peer ID string into `config/relay-peer-id.js`, then restart the relay (and rerun tests) so everything picks up the refreshed identity.

#### Automatic Testing
```bash
npm test
```

#### Manual Testing

1. **Start the relay server:**
   ```bash
   npm run relay
   ```

2. **Start the first client application on port 5173:**
   ```bash
   npm start
   ```

3. **Start the second client application on port 5174 (in a new terminal):**
   ```bash
   npm start
   ```

4. **Follow the manual testing steps below** (same process for both Docker and non-Docker)

### With Docker

#### Prerequisites
- Docker and Docker Compose installed

#### Docker Services

This project provides four Docker services:

1. **`relay-server`** - The LibP2P relay server
   - Runs on port 8080
   - Handles peer discovery and key-value storage
   - Must be started before the clients

2. **`client-a`** - The first client server
   - Runs on port 5173
   - Serves the browser-based client application for the first participant
   - Depends on the relay server being available

3. **`client-b`** - The second client server
   - Runs on port 5174
   - Serves the browser-based client application for the second participant
   - Depends on the relay server being available

4. **`test`** - The automated test runner
   - Uses Playwright for browser automation
   - Runs integration tests against the relay and client services
   - Exits after test completion

#### Docker Setup

Before running the test scenario, ensure Docker is properly set up:

1. **Install Docker Desktop:**
   - Download from: https://www.docker.com/products/docker-desktop/
   - Follow the installation instructions for your operating system

2. **Start Docker Desktop:**
   - On macOS: Open Docker Desktop from Applications folder or run `open -a Docker` command from the terminal
   - On Windows: Start Docker Desktop from Start menu
   - On Linux: Start Docker daemon: `sudo systemctl start docker`

3. **Verify Docker is running:**
   ```bash
   docker ps
   ```
   You should see Docker version information and an empty container list.

#### Automatic Testing
```bash
npm run test:docker
```

#### Manual Testing

**Start the relay-server and the two clients:**
```bash
docker compose up -d
```

### Manual Testing Steps (Same for Both Docker and Non-Docker)

1. **Open the first browser window/tab:**
   - Navigate to `http://localhost:5173`
   - Wait for the "Connected to relay" message
   - In the "SS58 Address" input field, enter an SS58 address. For example: `5CXkZyy4S5b3w16wvKA2hUwzp5q2y7UtRPkXnW97QGvDN8Jw`
   - In the "Secret Key" input field, enter the corresponding 32-byte secret key in hex format. For example: `0x473a77675b8e77d90c1b6dc2dbe6ac533b0853790ea8bcadf0ee8b5da4cfbbce`
   - Click "Store SS58 Address with Proof of Possession"
   - Verify you see: "Address registered with proof of possession!"

2. **Open a second browser window/tab:**
   - Navigate to `http://localhost:5174`
   - Wait for the "Connected to relay" message
   - In the "SS58 Address" input field, enter an SS58 address. For example: `5Gma8SNsn6rkQf9reAWFQ9WKq8bwwHtSzwMYtLTdhYsGPKiy`
   - In the "Secret Key" input field, enter the corresponding 32-byte secret key in hex format. For example: `0xdb9ddbb3d6671c4de8248a4fba95f3d873dc21a0434b52951bb33730c1ac93d7`
   - Click "Store SS58 Address with Proof of Possession"
   - Verify you see: "Address registered with proof of possession!"

3. **Connect to the first peer (in the second browser):**
   - In the "SS58 Address" input field, enter: `5CXkZyy4S5b3w16wvKA2hUwzp5q2y7UtRPkXnW97QGvDN8Jw`
   - Click "Find Peer & Connect"
   - Wait for the other peer to accept the connection

4. **Accept the connection (in the first browser):**
   - In the first browser window, you should see a connection permission request
   - Click "Accept" to allow the connection

5. **Autenticate the connection:**
   - Verify you see the message "Mutual connection proof of possession completed!" or "Mutual connection challenge verified - connection established!"
   - Both browser windows should show the peer connection in "Active Connections"

6. **Shutdown the relay server:**
   - `Ctrl+C` in the relay server terminal (non Docker) or `docker compose stop relay-server` 
   - Verify that both peers maintain their direct WebRTC connection

### Threshold Key Generation and Signing Steps

After establishing a peer-to-peer connection, each peer can participate in the distributed key generation (DKG) process to generate a shared threshold public key, and then use that key to create threshold signatures. The following steps must be performed by each peer in the threshold signing group:

#### Prerequisites

Before starting the threshold key generation process, ensure that:
- Both peers have established a direct WebRTC connection with each other (see steps 1-5 above)

#### Part 1: Threshold Key Generation

**For Both Peers:**

1. **Round 1 Generation:**
   - In the "🔑 Threshold Key Generation" section, enter your secret key in the "Secret Key" field (e.g., `0x473a77675b8e77d90c1b6dc2dbe6ac533b0853790ea8bcadf0ee8b5da4cfbbce` for Peer 1, `0xdb9ddbb3d6671c4de8248a4fba95f3d873dc21a0434b52951bb33730c1ac93d7` for Peer 2)
   - In the "Recipients" field, enter the SS58 addresses of all participants (including yourself), separated by commas (e.g., `5CXkZyy4S5b3w16wvKA2hUwzp5q2y7UtRPkXnW97QGvDN8Jw,5Gma8SNsn6rkQf9reAWFQ9WKq8bwwHtSzwMYtLTdhYsGPKiy`)
   - Enter the threshold value (e.g., `2` for a 2-of-2 threshold)
   - **Important:** The threshold value and recipient list must be identical for all peers
   - Click "Run Round 1 Generation"
   - Verify you see: "✓ AllMessage generated successfully"
   - The message will be automatically sent to the connected peer
   - Verify you see: "✓ AllMessage sent successfully to connected peer"

2. **Receive AllMessage from Other Peer:**
   - Wait for the other peer to send their AllMessage
   - Verify you see: "✓ AllMessage received and stored" in the output log

3. **Round 2 Generation - Process AllMessages to Generate Threshold Key:**
   - Once you have both your generated AllMessage and the received AllMessage from the other peer, click "Run Round 2 Generation"
   - Verify you see: "✓ Threshold key generated successfully"
   - The threshold public key will be displayed in SS58 format in the UI
   - Both peers should generate the same threshold public key

#### Part 2: Threshold Signing

**For Both Peers:**

4. **Round 1 Signing - Generate Commitments:**
   - In the "🔐 Threshold Signing" section, optionally enter a context in the "Context" field (default: empty)
   - Click "Run Round 1 Signing"
   - Verify you see: "✓ Round 1 signing completed"
   - The commitments will be automatically sent to the connected peer
   - Verify you see: "✓ Round 1 commitments sent successfully to connected peer"

5. **Receive Commitments from Other Peer:**
   - Wait for the other peer to send their commitments
   - Verify you see: "✓ Round 1 commitments received and stored" in the output log

6. **Round 2 Signing - Generate Signing Package:**
   - In the "Round 2 Signing" section, enter the payload to sign in the "Payload to Sign" field (e.g., `test payload to sign with threshold signature`)
   - Optionally enter a context in the "Context" field (default: `substrate`)
   - Click "Run Round 2 Signing"
   - Verify you see: "✓ Round 2 signing completed"
   - The signing package will be automatically sent to the connected peer
   - Verify you see: "✓ Signing package sent successfully to connected peer"

7. **Receive Signing Packages from Other Peer:**
   - Wait for the other peer to send their signing package
   - Verify you see: "✓ Signing package received and stored" in the output log

#### Part 3: Signature Aggregation

**For Both Peers:**

8. **Aggregate Signing Packages:**
   - Once you have both your signing package and the received signing package(s) from other peer(s), click "Agregate Signing Packages" (in the "🧪 Agregate Signing Packages" section)
   - Verify you see: "✓ Signature aggregation completed"
   - The aggregated signature will be displayed in hex format
   - Both peers should generate the same aggregated signature

#### Part 4: Extrinsic Submission

**For One Peer (or Both):**

9. **Submit Signed Extrinsic:**
   - Click "Submit Signed Extrinsic" (in the "🛠️ Construct and Submit the Signed Extrinsic" section)
   - The application will:
     - Verify the aggregated signature locally
     - Construct the signed extrinsic
     - Check account balance and fee requirements
     - Submit the extrinsic to the blockchain
   - Verify you see: "✓ Extrinsic submitted successfully. TxHash: [transaction hash]"
   - The transaction hash can be used to track the transaction on the blockchain

**Note:** Only one peer needs to submit the extrinsic, as both peers will have generated the same aggregated signature. However, both peers can submit if desired (the second submission will fail if the transaction is already included in a block).

### Cleanup

#### Docker Cleanup
```bash
docker compose down --rmi all --volumes --remove-orphans
```

#### Non-Docker Cleanup
Simply stop the processes with `Ctrl+C` in the terminal windows where they are running.

## License

This project is licensed under the GPLv3 License - see the LICENSE file for details.
