require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mediasoup = require('mediasoup');
const config = require('./config');

const { listenIp, listenPort, mediasoup: mediasoupConfig } = config;

function cloneMeta(meta) {
  if (!meta || typeof meta !== 'object') {
    return {};
  }

  try {
    return JSON.parse(JSON.stringify(meta));
  } catch (error) {
    return { ...meta };
  }
}

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
const io = new Server(httpServer, {
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
    pendingRooms.set(roomId, Room.create({ roomId }));
  }

  const room = await pendingRooms.get(roomId);
  pendingRooms.delete(roomId);
  rooms.set(roomId, room);
  return room;
}

class Room {
  static async create({ roomId }) {
    const worker = await getWorker();
    const router = await worker.createRouter(mediasoupConfig.router);
    return new Room({ id: roomId, router });
  }

  constructor({ id, router }) {
    this.id = id;
    this.router = router;
    this.peers = new Map();
    this.producers = new Map();
  }

  addPeer({ peerId, socket, memberAgentMetaData }) {
    if (this.peers.has(peerId)) {
      throw new Error(`Peer with id "${peerId}" already joined`);
    }

    const peer = new Peer({ id: peerId, socket, memberAgentMetaData: cloneMeta(memberAgentMetaData) });
    this.peers.set(peerId, peer);
    this.broadcast(
      'peerJoined',
      {
        peerId,
        memberAgentMetaData: cloneMeta(peer.memberAgentMetaData)
      },
      { exceptPeerId: peerId }
    );
    return peer;
  }

  getPeer(peerId) {
    return this.peers.get(peerId);
  }

  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) {
      return;
    }

    this.peers.delete(peerId);
    peer.close();

    this.broadcast('peerClosed', {
      peerId,
      memberAgentMetaData: cloneMeta(peer.memberAgentMetaData)
    });

    if (!this.peers.size) {
      this.router.close();
      rooms.delete(this.id);
    }
  }

  listProducers(exceptPeerId) {
    const list = [];
    for (const { peerId, producer } of this.producers.values()) {
      if (peerId === exceptPeerId) {
        continue;
      }
      const peer = this.peers.get(peerId);
      list.push({
        peerId,
        producerId: producer.id,
        memberAgentMetaData: cloneMeta(peer?.memberAgentMetaData)
      });
    }
    return list;
  }

  listPeers(exceptPeerId) {
    const peers = [];
    for (const [peerId, peer] of this.peers) {
      if (peerId === exceptPeerId) {
        continue;
      }
      peers.push({
        peerId,
        memberAgentMetaData: cloneMeta(peer.memberAgentMetaData)
      });
    }
    return peers;
  }

  broadcast(event, payload, { exceptPeerId } = {}) {
    for (const [peerId, peer] of this.peers) {
      if (peerId === exceptPeerId) {
        continue;
      }

      if (peer.socket && !peer.socket.disconnected) {
        peer.socket.emit(event, payload);
      }
    }
  }

  async createTransport({ peer, direction }) {
    const {
      listenIps,
      enableUdp,
      enableTcp,
      preferUdp,
      initialAvailableOutgoingBitrate,
      minimumAvailableOutgoingBitrate,
      appData: transportAppData = {}
    } = mediasoupConfig.webRtcTransport;

    const transport = await this.router.createWebRtcTransport({
      listenIps,
      enableUdp,
      enableTcp,
      preferUdp,
      initialAvailableOutgoingBitrate,
      minimumAvailableOutgoingBitrate,
      appData: {
        ...transportAppData,
        peerId: peer.id,
        direction
      }
    });

    if (mediasoupConfig.webRtcTransport.maxIncomingBitrate) {
      try {
        await transport.setMaxIncomingBitrate(mediasoupConfig.webRtcTransport.maxIncomingBitrate);
      } catch (error) {
        console.warn('setMaxIncomingBitrate failed:', error.message);
      }
    }

    transport.on('dtlsstatechange', (state) => {
      if (state === 'closed') {
        transport.close();
      }
    });

    transport.on('close', () => {
      peer.transports.delete(transport.id);
    });

    peer.transports.set(transport.id, transport);

    return transport;
  }

  trackProducer({ peer, producer }) {
  this.producers.set(producer.id, { peerId: peer.id, producer });

    let closed = false;
    const onClose = () => {
      if (closed) {
        return;
      }
      closed = true;
      this.producers.delete(producer.id);
      this.broadcast(
        'producerClosed',
        { producerId: producer.id, peerId: peer.id },
        { exceptPeerId: peer.id }
      );
    };

    producer.on('transportclose', onClose);
    producer.on('close', onClose);

    this.broadcast(
      'newProducer',
      {
        producerId: producer.id,
        peerId: peer.id,
        memberAgentMetaData: cloneMeta(peer.memberAgentMetaData)
      },
      { exceptPeerId: peer.id }
    );
  }

  getProducer(producerId) {
    return this.producers.get(producerId);
  }
}

class Peer {
  constructor({ id, socket, memberAgentMetaData }) {
    this.id = id;
    this.socket = socket;
    this.transports = new Map();
    this.producers = new Map();
    this.consumers = new Map();
    this.memberAgentMetaData = cloneMeta(memberAgentMetaData);
  }

  getTransport(transportId) {
    const transport = this.transports.get(transportId);
    if (!transport) {
      throw new Error(`Transport "${transportId}" not found`);
    }
    return transport;
  }

  addProducer(producer) {
    this.producers.set(producer.id, producer);
    producer.on('close', () => {
      this.producers.delete(producer.id);
    });
    producer.on('transportclose', () => {
      this.producers.delete(producer.id);
    });
  }

  addConsumer(consumer) {
    this.consumers.set(consumer.id, consumer);
    consumer.on('close', () => {
      this.consumers.delete(consumer.id);
    });
    consumer.on('transportclose', () => {
      this.consumers.delete(consumer.id);
    });
  }

  getConsumer(consumerId) {
    const consumer = this.consumers.get(consumerId);
    if (!consumer) {
      throw new Error(`Consumer "${consumerId}" not found`);
    }
    return consumer;
  }

  close() {
    for (const consumer of this.consumers.values()) {
      consumer.close();
    }
    for (const producer of this.producers.values()) {
      producer.close();
    }
    for (const transport of this.transports.values()) {
      transport.close();
    }

    this.consumers.clear();
    this.producers.clear();
    this.transports.clear();
  }
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
      const peer = room.addPeer({ peerId, socket, memberAgentMetaData: meta });
      socket.data = { roomId, peerId, memberAgentMetaData: meta };

      socket.once('disconnect', () => {
        room.removePeer(peer.id);
      });

      ackSuccess(callback, {
        routerRtpCapabilities: room.router.rtpCapabilities,
        existingProducers: room.listProducers(peer.id),
        existingPeers: room.listPeers(peer.id)
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

  socket.on('closeProducer', ({ producerId }, callback) => {
    try {
      const { peer } = resolvePeerFromSocket(socket);
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

  socket.on('resumeConsumer', async ({ consumerId }, callback) => {
    try {
      const { peer } = resolvePeerFromSocket(socket);
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
      const { peer } = resolvePeerFromSocket(socket);
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
  console.log(`mediasoup server listening on ${listenIp}:${listenPort}`);
});
