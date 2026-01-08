# Google Cloud Deployment Guide

This guide explains how to deploy the Decentralized Threshold Signing Service to a Google Cloud instance.

## Prerequisites

- A Google Cloud Compute Engine instance (VM)
- Node.js 22+ installed on the instance
- Ports 8080 (relay server) and 5173 (web client) open in the firewall

## Quick Start

1. **Clone and install dependencies:**
   ```bash
   git clone <your-repo-url>
   cd decentralized_threshold_signing_service
   npm install
   ```

2. **Start both services:**
   ```bash
   npm run start:server
   ```

   This will start:
   - Relay server on port 8080
   - Vite dev server on port 5173 (or the port specified in `VITE_PORT` environment variable)

3. **Access the application:**
   - Open your browser and navigate to: `http://<your-server-external-ip>:5173`
   - The client will automatically connect to the relay server on the same hostname

## Configuration

### Environment Variables

You can configure the services using environment variables:

- `VITE_PORT`: Port for the Vite dev server (default: 5173)
- `VITE_RELAY_HOST`: Override relay host (default: uses `window.location.hostname` in browser)
- `VITE_RELAY_PORT`: Relay server port (default: 8080)
- `EXTERNAL_PORT`: Relay server port (default: 8080)
- `NODE_ENV`: Set to `production` for production mode

### Firewall Configuration

Make sure to open the required ports in Google Cloud:

```bash
# Open port 5173 for web client
gcloud compute firewall-rules create allow-vite \
  --allow tcp:5173 \
  --source-ranges 0.0.0.0/0 \
  --description "Allow Vite dev server"

# Open port 8080 for relay server
gcloud compute firewall-rules create allow-relay \
  --allow tcp:8080 \
  --source-ranges 0.0.0.0/0 \
  --description "Allow LibP2P relay server"
```

Or use the Google Cloud Console:
1. Go to VPC network > Firewall rules
2. Create rules to allow TCP traffic on ports 5173 and 8080

## Running as a Service

To run the application as a systemd service (recommended for production):

1. **Create a systemd service file** (`/etc/systemd/system/threshold-signing.service`):

```ini
[Unit]
Description=Decentralized Threshold Signing Service
After=network.target

[Service]
Type=simple
User=your-username
WorkingDirectory=/path/to/decentralized_threshold_signing_service
Environment="NODE_ENV=production"
Environment="VITE_PORT=5173"
ExecStart=/usr/bin/node start-cloud.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

2. **Enable and start the service:**
   ```bash
   sudo systemctl enable threshold-signing.service
   sudo systemctl start threshold-signing.service
   ```

3. **Check status:**
   ```bash
   sudo systemctl status threshold-signing.service
   ```

## Production Build (Optional)

For production, you can build the client and serve it with a static file server:

1. **Build the client:**
   ```bash
   npm run build
   ```

2. **Install a simple HTTP server:**
   ```bash
   npm install -g serve
   ```

3. **Run the production setup:**
   ```bash
   # Terminal 1: Start relay server
   npm run relay
   
   # Terminal 2: Serve built files
   serve -s dist -l 5173 --host 0.0.0.0
   ```

## Troubleshooting

### Client can't connect to relay

- Verify the relay server is running: `curl http://localhost:8080` (should fail, but confirms server is listening)
- Check firewall rules allow traffic on port 8080
- Verify the relay peer ID matches in both client and server

### Port already in use

- Change the port using environment variables:
  ```bash
  VITE_PORT=3000 npm run start:server
  ```

### Services not starting

- Check Node.js version: `node --version` (should be 22+)
- Verify all dependencies are installed: `npm install`
- Check logs for specific error messages

## Security Considerations

- Consider using a reverse proxy (nginx) with SSL/TLS certificates
- Restrict firewall rules to specific IP ranges if possible
- Use environment variables for sensitive configuration
- Regularly update dependencies for security patches

