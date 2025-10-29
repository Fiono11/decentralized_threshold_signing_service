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

### 🚧 Milestone 2: Distributed Key Generation (PLANNED)

Two browsers will exchange messages and successfully produce a shared threshold public key using the Olaf DKG protocol compiled to WASM.

**Planned Deliverables**:
- Rust to WebAssembly compilation of Olaf DKG protocol
- Integration of DKG protocol with browser client
- Shared threshold public key generation
- Browser-local storage for key shares and protocol state

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

2. **Store your SS58 address with proof of possession:**
   - In the "SS58 Address" input field, enter an SS58 address. For example: `5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY`
   - In the "Secret Key" input field, enter the corresponding 32-byte secret key in hex format. For example: `0x473a77675b8e77d90c1b6dc2dbe6ac533b0853790ea8bcadf0ee8b5da4cfbbce`
   - Click "Store SS58 Address with Proof of Possession"
   - Verify you see: "Address registered with proof of possession!"

3. **Open a second browser window/tab (or incognito window):**
   - Navigate to `http://localhost:5174`
   - Wait for the "Connected to relay" message
   - Store a different SS58 address with its corresponding secret key (this will be used for the connection proof of possession)

4. **Connect to the first peer:**
   - In the "SS58 Address" input field, enter: `5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY`
   - Click "Find Peer & Connect"
   - Wait for "Connected to peer!" message
   - Verify you see proof of possession messages: "Initiating connection proof of possession...", "Received challenge:", "Our signature verified!", "Received mutual challenge:", "Mutual connection proof of possession completed!"

5. **Accept the connection (in the first browser):**
   - In the first browser window, you should see a connection permission request
   - Click "Accept" to allow the connection
   - Verify you see proof of possession messages: "Generated connection challenge for peer:", "Connection challenge verified for peer:", "Generated mutual challenge for peer:", "Mutual connection challenge verified - connection established!"

6. **Verify the connection:**
   - Both browser windows should show the peer connection in "Active Connections"
   - The "Message" section should now be visible in both windows

7. **Send a message from the first browser:**
   - In the first browser window, type a message in the "Message" field
   - Click "Send"
   - Verify the message is received in the second browser window

8. **Send a message from the second browser:**
   - In the second browser window, type a different message
   - Click "Send"
   - Verify the message is received in first browser window

### Cleanup

#### Docker Cleanup
```bash
docker compose down --rmi all --volumes --remove-orphans
```

#### Non-Docker Cleanup
Simply stop the processes with `Ctrl+C` in the terminal windows where they are running.

## License

This project is licensed under the GPLv3 License - see the LICENSE file for details.
