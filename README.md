# Decentralized Threshold Signing Service

## Overview

This project implements a decentralized threshold signing service leveraging the Olaf protocol. The service operates off-chain, providing a secure and cost-effective alternative to on-chain threshold signature mechanisms within the Substrate/Kusama/Polkadot ecosystem.

Each participant in the threshold signing group runs a browser-based application that performs decentralized key generation and signing operations through the Olaf threshold signature protocol, compiled to WebAssembly (WASM). The networking layer is built using JavaScript and `libp2p` for peer discovery and communication.

### 🌐 Networking Layer (JavaScript)

**Transport**: Peers connect to a relay server using WebSockets.

**Discovery**: 
- When a peer connects, it sends its Substrate/Polkadot/Kusama address to the relay server
- The relay server assigns the peer a random `libp2p` Peer ID and stores the mapping: Address → Peer ID
- Peers can query the relay server with a known blockchain address to obtain the corresponding Peer ID

**Direct Peer Communication**: Once a Peer ID is obtained, the peer establishes a WebRTC connection using `libp2p`. All protocol messages are exchanged via this secure, direct P2P channel.

### 🔐 Cryptographic Protocol (Rust → WASM)

The cryptographic logic is written in Rust and compiled to WebAssembly (WASM) for browser use.

**Core Functionality**:
- Distributed Key Generation (DKG) to derive a shared threshold public key
- Threshold Signing for signing Substrate/Kusama/Polkadot extrinsics

**State Management**: Key shares and protocol state are stored in browser-local storage (e.g., `IndexedDB`).

## Development Status

### ✅ Milestone 1: Peer Discovery via Blockchain Address (COMPLETED)

This milestone establishes the foundational networking layer where two browsers can connect to a relay server, register with a Substrate/Kusama/Polkadot address, discover each other, and exchange messages directly over WebRTC using `libp2p`.

#### Completed Features:
- ✅ LibP2P relay server with WebSocket transport
- ✅ Peer discovery system using SS58 addresses  
- ✅ Address → Peer ID mapping and storage in relay server
- ✅ Browser-based LibP2P client with WebRTC transport
- ✅ Direct peer communication via WebRTC using libp2p
- ✅ Peer-to-peer message exchange protocol
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

2. **Store your SS58 address:**
   - In the "SS58 Address" input field, enter an SS58 address. For example: `5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY`
   - Click "Store SS58 Address in Relay"
   - Verify you see: "Address stored successfully"

3. **Open a second browser window/tab (or incognito window):**
   - Navigate to `http://localhost:5174`
   - Wait for the "Connected to relay" message

4. **Connect to the first peer:**
   - In the "SS58 Address" input field, enter: `5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY`
   - Click "Find Peer & Connect"
   - Wait for "Connected to peer!" message

5. **Verify the connection:**
   - Both browser windows should show the peer connection in "Active Connections"
   - The "Message" section should now be visible in both windows

6. **Send a message from the first browser:**
   - In the first browser window, type a message in the "Message" field
   - Click "Send"
   - Verify the message is received in the second browser window

7. **Send a message from the second browser:**
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
