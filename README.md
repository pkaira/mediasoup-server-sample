# mediasoup-server-sample

Minimal mediasoup server built with Express and Socket.IO. The server exposes a single Socket.IO namespace that allows peers to join a room, negotiate WebRTC transports, and exchange mediasoup producers/consumers for audio and video streams. A lightweight web client (powered by Vite) is included for manual testing.

## Getting started

1. Install dependencies:
	```powershell
	npm install
	```
2. Start the mediasoup server:
	```powershell
	npm start
	```
3. For rapid UI iteration, run the Vite dev server in a separate terminal:
	```powershell
	npm run client:dev
	```
	The dev server proxies `/socket.io` traffic to the Node process on port `3000`. Override the target with `VITE_SIGNALING_URL` if the signaling server lives elsewhere.

4. To serve the static client from Express, first build it:
	```powershell
	npm run client:build
	```
	Then browse to `http://localhost:3000` to load the compiled assets from `dist/`.

By default the server listens on `0.0.0.0:3000`. Override runtime settings with environment variables (see `config.js`).

Create a `.env` file (see `.env` template) to define these environment variables locally. ** Rename `.env.sample` to `.env` to get started as all values are filled in. **

## Socket.IO events

The client is responsible for emitting the following events in order:

- `join({ roomId, peerId })` ⇒ `{ ok, routerRtpCapabilities, existingProducers }`
- `createWebRtcTransport({ direction })` ⇒ transport parameters for producing or consuming
- `connectWebRtcTransport({ transportId, dtlsParameters })`
- `produce({ transportId, kind, rtpParameters })` ⇒ `{ id }`
- `consume({ producerId, transportId, rtpCapabilities })` ⇒ consumer parameters
- `resumeConsumer({ consumerId })` / `pauseConsumer({ consumerId })`
- `closeProducer({ producerId })`
- `leave()` when the peer exits the room

Server emitted notifications:

- `newProducer` when a remote peer starts producing
- `producerClosed` when a producer ends
- `peerClosed` when a peer leaves the room

Consult the upstream [mediasoup-demo](https://github.com/versatica/mediasoup-demo) repository for ideas on the client workflow.

## Configuration

Adjust mediasoup worker and transport settings in `config.js`. Useful environment variables:

- `PORT` and `LISTEN_IP` to change the HTTP bind address.
- `MEDIASOUP_LISTEN_IP` (defaults to the first non-internal IPv4) to choose the interface mediasoup binds to.
- `ANNOUNCED_IP` when running behind NAT.
- `MEDIASOUP_MIN_PORT` / `MEDIASOUP_MAX_PORT` to override RTP port range.

### SSL/HTTPS Configuration

The server supports SSL/HTTPS for secure connections. To enable SSL:

1. **For Development (Self-signed certificates):**
   ```bash
   ./generate-certs.sh
   ```
   This creates self-signed certificates in the `certs/` directory.

2. **For Production:**
   - Obtain SSL certificates from a trusted Certificate Authority (CA)
   - Place your certificate files in the `certs/` directory or specify custom paths

3. **Enable SSL in your environment:**
   ```bash
   SSL_ENABLED=true
   SSL_PORT=3443
   SSL_CERT=certs/cert.pem
   SSL_KEY=certs/key.pem
   ```

4. **Additional SSL Environment Variables:**
   - `SSL_ENABLED` - Set to `true` to enable HTTPS (default: `false`)
   - `SSL_PORT` - HTTPS port (default: `3443`)
   - `SSL_CERT` - Path to SSL certificate file (default: `certs/cert.pem`)
   - `SSL_KEY` - Path to SSL private key file (default: `certs/key.pem`)

When SSL is enabled, the server will run both HTTP and HTTPS servers:
- HTTP: `http://localhost:3000` (or your configured port)
- HTTPS: `https://localhost:3443` (or your configured SSL port)

**Note:** For WebRTC to work properly in production, HTTPS is required by modern browsers for accessing user media (camera/microphone).

## Background Process Management

For production deployments, you may want to run the server in the background so it continues running even after SSH disconnection.

### 🚀 Starting the Server in Background

**Start with SSL on port 443 (requires sudo):**
```bash
sudo nohup npm start > mediasoup.log 2>&1 &
```

**Alternative - Direct Node.js command:**
```bash
sudo nohup node server.js > mediasoup.log 2>&1 &
```

**For non-privileged ports (3000, 3443):**
```bash
nohup npm start > mediasoup.log 2>&1 &
```

### 📊 Process Management Commands

**Check if process is running:**
```bash
ps aux | grep "node server.js" | grep -v grep
```

**Get process ID:**
```bash
pgrep -f "node server.js"
```

**Check specific process by PID:**
```bash
ps -p <PID>
```

### 📝 Log Management

**View live logs:**
```bash
tail -f mediasoup.log
```

**View recent logs:**
```bash
tail -n 20 mediasoup.log
```

**View all logs:**
```bash
cat mediasoup.log
```

### ⛔ Stopping the Server

**Kill by process ID:**
```bash
sudo kill <PID>
```

**Force kill by process ID:**
```bash
sudo kill -9 <PID>
```

**Kill by process name:**
```bash
sudo pkill -f "node server.js"
```

**Force kill by process name:**
```bash
sudo pkill -9 -f "node server.js"
```

### 🔍 Server Access

When running with SSL enabled, your server will be accessible at:
- **HTTP**: `http://your-server-ip:3000`
- **HTTPS**: `https://your-server-ip:443`
