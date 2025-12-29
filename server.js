require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const mediasoup = require('mediasoup');
const config = require('./config');
const { Room, cloneMeta } = require('./room');

const { listenIp, listenPort, ssl, mediasoup: mediasoupConfig } = config;

const app = express();
app.disable('x-powered-by');
const PUBLIC_DIR = path.join(__dirname, 'dist');
let staticMiddleware;
app.use((req, res, next) => {
  if (!staticMiddleware && fs.existsSync(PUBLIC_DIR)) {
    staticMiddleware = express.static(PUBLIC_DIR);
  }

  if (staticMiddleware) {
    staticMiddleware(req, res, next);
  } else {
    next();
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/', (req, res) => {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
    return;
  }
  res.send('mediasoup server running');
});

const httpServer = http.createServer(app);

// Create HTTPS server if SSL is enabled
let httpsServer;
if (ssl.enabled) {
  try {
    const sslOptions = {
      key: fs.readFileSync(ssl.key),
      cert: fs.readFileSync(ssl.cert)
    };
    httpsServer = https.createServer(sslOptions, app);
    console.log('SSL enabled with certificate:', ssl.cert);
  } catch (error) {
    console.error('Failed to load SSL certificates:', error.message);
    console.error('SSL will be disabled. Please check your certificate files.');
    httpsServer = null;
  }
}

// Use HTTPS server if available, otherwise fall back to HTTP
const serverForSocketIO = httpsServer || httpServer;

const io = new Server(serverForSocketIO, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const rooms = new Map();
const pendingRooms = new Map();

let workerPromise;

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection', error);
});

async function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker();
  }
  return workerPromise;
}

async function createWorker() {
  const worker = await mediasoup.createWorker(mediasoupConfig.worker);
  worker.on('died', () => {
    console.error('mediasoup worker died, exiting in 2 seconds... [pid:%d]', worker.pid);
    setTimeout(() => process.exit(1), 2000);
  });
  return worker;
}

async function getOrCreateRoom(roomId) {
  if (rooms.has(roomId)) {
    return rooms.get(roomId);
  }

  if (!pendingRooms.has(roomId)) {
    pendingRooms.set(roomId, createRoomInstance(roomId));
  }

  const room = await pendingRooms.get(roomId);
  pendingRooms.delete(roomId);
  rooms.set(roomId, room);
  return room;
}

async function createRoomInstance(roomId) {
  const worker = await getWorker();
  const router = await worker.createRouter(mediasoupConfig.router);
  return new Room({
    id: roomId,
    router,
    mediasoupConfig,
    onEmpty: () => {
      rooms.delete(roomId);
    }
  });
}


function ackSuccess(callback, payload = {}) {
  if (typeof callback === 'function') {
    callback({ ok: true, ...payload });
  }
}

function ackError(callback, error) {
  if (typeof callback === 'function') {
    const message = error && error.message ? error.message : String(error);
    callback({ ok: false, error: message });
  }
}

function resolvePeerFromSocket(socket) {
  const { roomId, peerId } = socket.data || {};
  if (!roomId || !peerId) {
    throw new Error('Peer has not joined a room yet');
  }

  const room = rooms.get(roomId);
  if (!room) {
    throw new Error('Room is not available');
  }

  const peer = room.getPeer(peerId);
  if (!peer) {
    throw new Error('Peer not found in room');
  }

  return { room, peer };
}

io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  socket.on('join', async ({ roomId, peerId, memberAgentMetaData }, callback) => {
    try {
      if (!roomId || !peerId) {
        throw new Error('Both roomId and peerId are required');
      }

      const meta = cloneMeta(memberAgentMetaData);
      const room = await getOrCreateRoom(roomId);
      await room.ensureDataBus();
      const peer = room.addPeer({ peerId, socket, memberAgentMetaData: meta });
      socket.data = { roomId, peerId, memberAgentMetaData: meta };

      socket.once('disconnect', () => {
        room.removePeer(peer.id);
      });

      ackSuccess(callback, {
        routerRtpCapabilities: room.router.rtpCapabilities,
        existingProducers: room.listProducers(peer.id),
        existingPeers: room.listPeers(peer.id),
        roomDataBus: room.getDataBusInfo(peer.id)
      });
    } catch (error) {
      console.error('join error', error);
      ackError(callback, error);
    }
  });

  socket.on('createWebRtcTransport', async ({ direction }, callback) => {
    try {
      if (!direction) {
        throw new Error('direction is required');
      }

      const { room, peer } = resolvePeerFromSocket(socket);
      const transport = await room.createTransport({ peer, direction });

      ackSuccess(callback, {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
        sctpParameters: transport.sctpParameters
      });
    } catch (error) {
      console.error('createWebRtcTransport error', error);
      ackError(callback, error);
    }
  });

  socket.on('connectWebRtcTransport', async ({ transportId, dtlsParameters }, callback) => {
    try {
      if (!transportId || !dtlsParameters) {
        throw new Error('transportId and dtlsParameters are required');
      }

      const { peer } = resolvePeerFromSocket(socket);
      const transport = peer.getTransport(transportId);
      await transport.connect({ dtlsParameters });
      ackSuccess(callback);
    } catch (error) {
      console.error('connectWebRtcTransport error', error);
      ackError(callback, error);
    }
  });

  socket.on('produce', async ({ transportId, kind, rtpParameters, appData }, callback) => {
    try {
      const { room, peer } = resolvePeerFromSocket(socket);
      const transport = peer.getTransport(transportId);
      const producer = await transport.produce({
        kind,
        rtpParameters,
        appData: {
          ...appData,
          peerId: peer.id
        }
      });

      peer.addProducer(producer);
      room.trackProducer({ peer, producer });

      ackSuccess(callback, { id: producer.id });
    } catch (error) {
      console.error('produce error', error);
      ackError(callback, error);
    }
  });

  socket.on('produceData', async ({ transportId, sctpStreamParameters, label, protocol, appData }, callback) => {
    try {
      if (!transportId || !sctpStreamParameters) {
        throw new Error('transportId and sctpStreamParameters are required');
      }

      const { room, peer } = resolvePeerFromSocket(socket);
      const transport = peer.getTransport(transportId);
      const dataProducer = await transport.produceData({
        sctpStreamParameters,
        label,
        protocol,
        appData: {
          ...appData,
          peerId: peer.id
        }
      });

      peer.addDataProducer(dataProducer);

      const detach = () => {
        room.detachDataProducer(dataProducer.id);
      };
      dataProducer.on('close', detach);
      dataProducer.on('transportclose', detach);

      await room.attachDataProducer({ peer, dataProducer });

      ackSuccess(callback, { id: dataProducer.id });
    } catch (error) {
      console.error('produceData error', error);
      ackError(callback, error);
    }
  });

  socket.on('closeProducer', ({ producerId }, callback) => {
    try {
      // Check if peer has joined a room before attempting to close producer
      const { roomId, peerId } = socket.data || {};
      if (!roomId || !peerId) {
        // Peer hasn't joined a room yet, silently acknowledge
        ackSuccess(callback);
        return;
      }

      const room = rooms.get(roomId);
      if (!room) {
        // Room doesn't exist anymore, silently acknowledge
        ackSuccess(callback);
        return;
      }

      const peer = room.getPeer(peerId);
      if (!peer) {
        // Peer not found in room, silently acknowledge
        ackSuccess(callback);
        return;
      }

      const producer = peer.producers.get(producerId);
      if (producer) {
        producer.close();
      }
      ackSuccess(callback);
    } catch (error) {
      console.error('closeProducer error', error);
      ackError(callback, error);
    }
  });

  socket.on('closeDataProducer', ({ dataProducerId }, callback) => {
    try {
      const { roomId, peerId } = socket.data || {};
      if (!roomId || !peerId) {
        ackSuccess(callback);
        return;
      }

      const room = rooms.get(roomId);
      if (!room) {
        ackSuccess(callback);
        return;
      }

      const peer = room.getPeer(peerId);
      if (!peer) {
        ackSuccess(callback);
        return;
      }

      const dataProducer = peer.getDataProducer(dataProducerId);
      if (dataProducer) {
        dataProducer.close();
        room.detachDataProducer(dataProducer.id);
      }
      ackSuccess(callback);
    } catch (error) {
      console.error('closeDataProducer error', error);
      ackError(callback, error);
    }
  });

  socket.on('consume', async ({ producerId, transportId, rtpCapabilities }, callback) => {
    try {
      const { room, peer } = resolvePeerFromSocket(socket);
      const producerInfo = room.getProducer(producerId);

      if (!producerInfo) {
        throw new Error('Producer not found');
      }

      if (!room.router.canConsume({ producerId, rtpCapabilities })) {
        throw new Error('Cannot consume this producer');
      }

      const transport = peer.getTransport(transportId);
      const consumer = await transport.consume({
        producerId,
        rtpCapabilities,
        appData: {
          peerId: peer.id,
          producerPeerId: producerInfo.peerId
        }
      });

      peer.addConsumer(consumer);

      consumer.on('producerclose', () => {
        consumer.close();
      });

      ackSuccess(callback, {
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        type: consumer.type,
        producerPaused: consumer.producerPaused
      });
    } catch (error) {
      console.error('consume error', error);
      ackError(callback, error);
    }
  });

  socket.on('joinDataBus', async ({ transportId }, callback) => {
    try {
      if (!transportId) {
        throw new Error('transportId is required');
      }

      const { room, peer } = resolvePeerFromSocket(socket);
      const transport = peer.getTransport(transportId);
      const consumer = await room.createDataBusConsumer({ peer, transport });
      peer.addDataConsumer(consumer);
      consumer.on('dataproducerclose', () => {
        consumer.close();
      });

      ackSuccess(callback, {
        id: consumer.id,
        dataProducerId: consumer.dataProducerId,
        sctpStreamParameters: consumer.sctpStreamParameters,
        label: consumer.label,
        protocol: consumer.protocol,
        appData: consumer.appData
      });
    } catch (error) {
      console.error('joinDataBus error', error);
      ackError(callback, error);
    }
  });

  socket.on('resumeConsumer', async ({ consumerId }, callback) => {
    try {
      // Check if peer has joined a room before attempting to resume consumer
      const { roomId, peerId } = socket.data || {};
      if (!roomId || !peerId) {
        ackError(callback, new Error('Peer has not joined a room yet'));
        return;
      }

      const room = rooms.get(roomId);
      if (!room) {
        ackError(callback, new Error('Room is not available'));
        return;
      }

      const peer = room.getPeer(peerId);
      if (!peer) {
        ackError(callback, new Error('Peer not found in room'));
        return;
      }

      const consumer = peer.getConsumer(consumerId);
      await consumer.resume();
      ackSuccess(callback);
    } catch (error) {
      console.error('resumeConsumer error', error);
      ackError(callback, error);
    }
  });

  socket.on('pauseConsumer', async ({ consumerId }, callback) => {
    try {
      // Check if peer has joined a room before attempting to pause consumer
      const { roomId, peerId } = socket.data || {};
      if (!roomId || !peerId) {
        ackError(callback, new Error('Peer has not joined a room yet'));
        return;
      }

      const room = rooms.get(roomId);
      if (!room) {
        ackError(callback, new Error('Room is not available'));
        return;
      }

      const peer = room.getPeer(peerId);
      if (!peer) {
        ackError(callback, new Error('Peer not found in room'));
        return;
      }

      const consumer = peer.getConsumer(consumerId);
      await consumer.pause();
      ackSuccess(callback);
    } catch (error) {
      console.error('pauseConsumer error', error);
      ackError(callback, error);
    }
  });

  socket.on('leave', () => {
    try {
      const { room, peer } = resolvePeerFromSocket(socket);
      room.removePeer(peer.id);
      socket.data = {};
    } catch (error) {
      // Peer already removed or not joined.
    }
  });
});

httpServer.listen(listenPort, listenIp, () => {
  console.log(`mediasoup HTTP server listening on ${listenIp}:${listenPort}`);
});

// Start HTTPS server if SSL is enabled
if (httpsServer) {
  httpsServer.listen(ssl.listenPort, listenIp, () => {
    console.log(`mediasoup HTTPS server listening on ${listenIp}:${ssl.listenPort}`);
  });
}
