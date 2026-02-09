'use strict';

const RoomDataBus = require('./roomDataBus');

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

class Peer {
  constructor({ id, socket, memberAgentMetaData }) {
    this.id = id;
    this.socket = socket;
    this.transports = new Map();
    this.producers = new Map();
    this.consumers = new Map();
    this.dataProducers = new Map();
    this.dataConsumers = new Map();
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
    producer.on('@close', () => {
      this.producers.delete(producer.id);
    });
    producer.on('transportclose', () => {
      this.producers.delete(producer.id);
    });
  }

  addConsumer(consumer) {
    this.consumers.set(consumer.id, consumer);
    consumer.on('@close', () => {
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

  addDataProducer(dataProducer) {
    this.dataProducers.set(dataProducer.id, dataProducer);
    const cleanup = () => {
      this.dataProducers.delete(dataProducer.id);
    };
    dataProducer.on('@close', cleanup);
    dataProducer.on('transportclose', cleanup);
  }

  getDataProducer(dataProducerId) {
    return this.dataProducers.get(dataProducerId);
  }

  addDataConsumer(dataConsumer) {
    this.dataConsumers.set(dataConsumer.id, dataConsumer);
    const cleanup = () => {
      this.dataConsumers.delete(dataConsumer.id);
    };
    dataConsumer.on('@close', cleanup);
    dataConsumer.on('transportclose', cleanup);
  }

  getDataConsumer(dataConsumerId) {
    return this.dataConsumers.get(dataConsumerId);
  }

  close() {
    for (const consumer of this.consumers.values()) {
      consumer.close();
    }
    for (const producer of this.producers.values()) {
      producer.close();
    }
    for (const dataConsumer of this.dataConsumers.values()) {
      dataConsumer.close();
    }
    for (const dataProducer of this.dataProducers.values()) {
      dataProducer.close();
    }
    for (const transport of this.transports.values()) {
      transport.close();
    }

    this.consumers.clear();
    this.producers.clear();
    this.dataConsumers.clear();
    this.dataProducers.clear();
    this.transports.clear();
  }
}

class Room {
  constructor({ id, router, mediasoupConfig, onEmpty }) {
    this.id = id;
    this.router = router;
    this.mediasoupConfig = mediasoupConfig;
    this.onEmpty = typeof onEmpty === 'function' ? onEmpty : null;
    this.peers = new Map();
    this.producers = new Map();
    this.dataBus = null;
  }

  addPeer({ peerId, socket, memberAgentMetaData }) {
    if (this.peers.has(peerId)) {
      throw new Error(`Peer with id "${peerId}" already joined`);
    }

    const peer = new Peer({ id: peerId, socket, memberAgentMetaData: cloneMeta(memberAgentMetaData) });
    this.peers.set(peerId, peer);
    const dataChannels = this.getPeerDataChannelInfo(peerId, { allocate: true });
    this.broadcast(
      'peerJoined',
      {
        peerId,
        memberAgentMetaData: cloneMeta(peer.memberAgentMetaData),
        dataChannels
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
    if (this.dataBus) {
      this.dataBus.handlePeerClosed(peer);
    }

    this.broadcast('peerClosed', {
      peerId,
      memberAgentMetaData: cloneMeta(peer.memberAgentMetaData)
    });

    if (!this.peers.size) {
      if (this.dataBus) {
        this.dataBus.close();
        this.dataBus = null;
      }
      this.router.close();
      if (this.onEmpty) {
        this.onEmpty(this);
      }
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
        memberAgentMetaData: cloneMeta(peer.memberAgentMetaData),
        dataChannels: this.getPeerDataChannelInfo(peerId, { allocate: true })
      });
    }
    return peers;
  }

  getPeerDataChannelInfo(peerId, { allocate = false } = {}) {
    if (!peerId || !this.dataBus || this.dataBus.closed) {
      return null;
    }

    if (allocate) {
      return this.dataBus.describePeerChannels(peerId);
    }

    const base = this.dataBus.getPeerSubchannelBase(peerId);
    if (typeof base !== 'number') {
      return null;
    }

    return this.dataBus.describePeerChannels(peerId);
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
      enableSctp,
      numSctpStreams,
      maxSctpMessageSize,
      appData: transportAppData = {}
    } = this.mediasoupConfig.webRtcTransport;

    const transport = await this.router.createWebRtcTransport({
      listenIps,
      enableUdp,
      enableTcp,
      preferUdp,
      initialAvailableOutgoingBitrate,
      minimumAvailableOutgoingBitrate,
      enableSctp,
      numSctpStreams,
      maxSctpMessageSize,
      appData: {
        ...transportAppData,
        peerId: peer.id,
        direction
      }
    });

    if (this.mediasoupConfig.webRtcTransport.maxIncomingBitrate) {
      try {
        await transport.setMaxIncomingBitrate(this.mediasoupConfig.webRtcTransport.maxIncomingBitrate);
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
      console.log(`Producer closed [producerId:${producer.id}, peerId:${peer.id}]`);
    };

    producer.on('transportclose', onClose);
    producer.on('@close', onClose);

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

  async ensureDataBus() {
    if (this.dataBus && !this.dataBus.closed) {
      return this.dataBus;
    }

    this.dataBus = await RoomDataBus.create({ room: this, mediasoupConfig: this.mediasoupConfig });
    return this.dataBus;
  }

  async attachDataProducer({ peer, dataProducer }) {
    const bus = await this.ensureDataBus();
    await bus.attachPeerProducer({ peer, dataProducer });
  }

  detachDataProducer(producerId) {
    if (this.dataBus) {
      this.dataBus.detachPeerProducer(producerId);
    }
  }

  async createDataBusConsumer({ peer, transport }) {
    const bus = await this.ensureDataBus();
    return bus.createConsumerForPeer({ peer, transport });
  }

  getDataBusInfo(peerId) {
    const ready = Boolean(this.dataBus && !this.dataBus.closed);
    const broadcastSubchannel = this.dataBus ? this.dataBus.getBroadcastSubchannel() : 0;
    const subchannelBucketSize = this.dataBus ? this.dataBus.getSubchannelBucketSize() : 10;
    const description = ready ? this.dataBus.describePeerChannels(peerId) : null;
    return {
      ready,
      broadcastSubchannel,
      subchannelBucketSize,
      subchannelBase:
        description && typeof description.subchannelBase === 'number'
          ? description.subchannelBase
          : null,
      subchannelRange: description?.subchannelRange || null,
      assignedSubchannels: description?.assignedSubchannels || []
    };
  }
}

module.exports = {
  Room,
  cloneMeta
};
