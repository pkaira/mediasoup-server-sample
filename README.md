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
