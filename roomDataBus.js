'use strict';

const DEFAULT_MAX_MESSAGE_SIZE = 262144;
const SUBCHANNEL_BUCKET_SIZE = 10;
const BROADCAST_SUBCHANNEL = 0;
const MIN_PEER_SUBCHANNEL = SUBCHANNEL_BUCKET_SIZE;
const RESERVED_CHANNEL_PREFIXES = ['system', 'broadcast'];
const RESERVED_EVENT_KEYWORDS = [
  ['dataproducer', 'create'],
  ['dataproducer', 'created'],
  ['dataproducer', 'close'],
  ['dataproducer', 'closed'],
  ['dataproducer', 'super']
];

function isArrayBufferView(payload) {
  return typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(payload);
}

function isArrayBufferInstance(payload) {
  return typeof ArrayBuffer !== 'undefined' && payload instanceof ArrayBuffer;
}

function isBinaryLike(payload) {
  if (!payload) {
    return false;
  }
  return Buffer.isBuffer(payload) || isArrayBufferInstance(payload) || isArrayBufferView(payload);
}

function bufferFromBinary(payload) {
  if (Buffer.isBuffer(payload)) {
    return payload;
  }
  if (isArrayBufferInstance(payload)) {
    return Buffer.from(payload);
  }
  if (isArrayBufferView(payload)) {
    return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  if (typeof payload === 'string') {
    return Buffer.from(payload, 'utf8');
  }
  return Buffer.from([]);
}

function estimateBase64ByteLength(base64) {
  if (typeof base64 !== 'string' || !base64.length) {
    return 0;
  }
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function encodeBinaryDescriptor(payload) {
  const buffer = bufferFromBinary(payload);
  return {
    type: 'binary',
    encoding: 'base64',
    data: buffer.toString('base64'),
    byteLength: buffer.length
  };
}

function isBinaryDescriptor(payload) {
  return (
    payload &&
    typeof payload === 'object' &&
    payload.type === 'binary' &&
    typeof payload.data === 'string'
  );
}

function normalizeBinaryDescriptor(payload) {
  if (!isBinaryDescriptor(payload)) {
    return payload;
  }

  const encoding = payload.encoding === 'base64' ? 'base64' : 'base64';
  const data = typeof payload.data === 'string' ? payload.data : '';
  const normalized = {
    type: 'binary',
    encoding,
    data
  };

  const lengthCandidate = Number.isFinite(payload.byteLength) ? Number(payload.byteLength) : undefined;
  const byteLength =
    typeof lengthCandidate === 'number' && lengthCandidate >= 0 ? lengthCandidate : estimateBase64ByteLength(data);
  if (byteLength >= 0) {
    normalized.byteLength = byteLength;
  }

  if (payload.mimeType) {
    normalized.mimeType = payload.mimeType;
  }
  if (payload.meta !== undefined) {
    normalized.meta = payload.meta;
  }

  return normalized;
}

function serializePayloadForEnvelope(payload) {
  if (payload === undefined) {
    return undefined;
  }

  if (isBinaryDescriptor(payload)) {
    return normalizeBinaryDescriptor(payload);
  }

  if (isBinaryLike(payload)) {
    return encodeBinaryDescriptor(payload);
  }

  return payload;
}

function extractPayloadBody(parsed) {
  if (!parsed) {
    return undefined;
  }
  if (typeof parsed === 'object' && !isBinaryLike(parsed) && parsed.payload !== undefined) {
    return parsed.payload;
  }
  return parsed;
}

function safeJsonParse(payload) {
  if (payload === undefined || payload === null) {
    return undefined;
  }

  if (typeof payload === 'object' && !isBinaryLike(payload)) {
    return payload;
  }

  const asString = isBinaryLike(payload)
    ? bufferFromBinary(payload).toString('utf8')
    : String(payload);

  try {
    return JSON.parse(asString);
  } catch (error) {
    return isBinaryLike(payload) ? bufferFromBinary(payload) : payload;
  }
}

class RoomDataBus {
  static async create({ room, mediasoupConfig }) {
    const maxMessageSize = mediasoupConfig?.router?.maxMessageSize || DEFAULT_MAX_MESSAGE_SIZE;
    const transport = await room.router.createDirectTransport({
      maxMessageSize,
      appData: {
        roomId: room.id,
        role: 'room-data-bus-transport'
      }
    });

    const dataProducer = await transport.produceData({
      label: 'room-data-bus',
      ordered: true,
      appData: {
        roomId: room.id,
        role: 'room-data-bus-producer'
      }
    });

    return new RoomDataBus({ room, transport, dataProducer });
  }

  constructor({ room, transport, dataProducer }) {
    this.room = room;
    this.transport = transport;
    this.dataProducer = dataProducer;
    this.peerInputs = new Map();
    this.peerOutputs = new Map();
    this.closed = false;
    this.peerSubchannelBases = new Map();
    this.nextSubchannelBase = MIN_PEER_SUBCHANNEL;

    this.transport.on('close', () => {
      this.close();
    });

    this.dataProducer.on('close', () => {
      this.close();
    });

    this.broadcastSuperDataProducerCreated();
  }

  async attachPeerProducer({ peer, dataProducer }) {
    if (this.closed) {
      return;
    }

    this.ensurePeerSubchannelBase(peer.id);
    this.notifyPeerChannelAssignment(peer.id);

    let consumer;
    try {
      consumer = await this.transport.consumeData({
        dataProducerId: dataProducer.id,
        label: `room-data-input-${peer.id}`,
        appData: {
          roomId: this.room.id,
          peerId: peer.id,
          role: 'room-data-input'
        }
      });
    } catch (error) {
      console.error('Failed to attach data producer to room bus', error.message);
      return;
    }

    const entry = { peerId: peer.id, consumer };
    this.peerInputs.set(dataProducer.id, entry);

    consumer.on('message', (message, ppid) => {
      this.forwardMessage({ peerId: peer.id, message, ppid });
    });

    const cleanup = () => {
      this.peerInputs.delete(dataProducer.id);
    };
    consumer.on('close', cleanup);
    consumer.on('transportclose', cleanup);
  }

  detachPeerProducer(dataProducerId) {
    const entry = this.peerInputs.get(dataProducerId);
    if (!entry) {
      return;
    }
    this.peerInputs.delete(dataProducerId);
    entry.consumer.close();
  }

  async createConsumerForPeer({ peer, transport }) {
    if (this.closed) {
      throw new Error('Room data bus is closed');
    }

    this.ensurePeerSubchannelBase(peer.id);
    this.notifyPeerChannelAssignment(peer.id);

    const consumer = await transport.consumeData({
      dataProducerId: this.dataProducer.id,
      label: `room-data-output-${peer.id}`,
      subchannels: this.getSubchannelsForPeer(peer.id),
      appData: {
        roomId: this.room.id,
        peerId: peer.id,
        role: 'room-data-output'
      }
    });

    const entry = { peerId: peer.id, consumer };
    this.peerOutputs.set(consumer.id, entry);

    const cleanup = () => {
      this.peerOutputs.delete(consumer.id);
    };
    consumer.on('close', cleanup);
    consumer.on('transportclose', cleanup);

    return consumer;
  }

  handlePeerClosed(peer) {
    for (const [dataProducerId, entry] of Array.from(this.peerInputs.entries())) {
      if (entry.peerId === peer.id) {
        entry.consumer.close();
        this.peerInputs.delete(dataProducerId);
      }
    }

    for (const [consumerId, entry] of Array.from(this.peerOutputs.entries())) {
      if (entry.peerId === peer.id) {
        entry.consumer.close();
        this.peerOutputs.delete(consumerId);
      }
    }

    this.peerSubchannelBases.delete(peer.id);

  }

  forwardMessage({ peerId, message }) {
    if (this.closed || !this.dataProducer || this.dataProducer.closed) {
      return;
    }

    const parsed = safeJsonParse(message);
    if (parsed === undefined) {
      return;
    }
    if (this.isReservedSystemEvent(parsed)) {
      console.warn('Dropping reserved system event from peer', {
        peerId,
        channel: parsed && parsed.channel,
        event: parsed && (parsed.event || parsed.type)
      });
      return;
    }
    const offset = this.resolveSubchannelOffset(parsed);
    const requestedTargetPeerId = this.resolveTargetPeerId(parsed);
    const isDirectTarget = Boolean(requestedTargetPeerId);
    const subchannels = this.resolveTargetSubchannels({
      targetPeerId: isDirectTarget ? requestedTargetPeerId : undefined,
      offset
    });
    const payloadBody = extractPayloadBody(parsed);
    const normalizedPayload = serializePayloadForEnvelope(payloadBody);

    const envelope = {
      from: peerId,
      ts: Date.now(),
      channel: parsed && typeof parsed === 'object' && parsed.channel ? parsed.channel : 'default',
      channelIndex: offset,
      targetPeerId: isDirectTarget ? requestedTargetPeerId : null,
      target: isDirectTarget ? requestedTargetPeerId : 'broadcast',
      payload: normalizedPayload
    };

    if (Array.isArray(subchannels) && subchannels.length === 1) {
      envelope.targetSubchannel = subchannels[0];
    }

    try {
      this.dataProducer.send(JSON.stringify(envelope), undefined, subchannels);
    } catch (error) {
      console.warn('Failed to broadcast room data message', error.message);
    }
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;

    for (const entry of this.peerInputs.values()) {
      try {
        entry.consumer.close();
      } catch (error) {
        // ignore
      }
    }
    this.peerInputs.clear();

    for (const entry of this.peerOutputs.values()) {
      try {
        entry.consumer.close();
      } catch (error) {
        // ignore
      }
    }
    this.peerOutputs.clear();

    this.peerSubchannelBases.clear();
    this.nextSubchannelBase = MIN_PEER_SUBCHANNEL;

    if (this.dataProducer) {
      try {
        this.dataProducer.close();
      } catch (error) {
        // ignore
      }
    }

    if (this.transport) {
      try {
        this.transport.close();
      } catch (error) {
        // ignore
      }
    }
  }

  ensurePeerSubchannelBase(peerId) {
    if (!peerId) {
      return null;
    }

    if (this.peerSubchannelBases.has(peerId)) {
      return this.peerSubchannelBases.get(peerId);
    }

    const base = this.nextSubchannelBase;
    this.nextSubchannelBase += SUBCHANNEL_BUCKET_SIZE;
    this.peerSubchannelBases.set(peerId, base);
    return base;
  }

  getPeerSubchannelBase(peerId) {
    if (!peerId) {
      return null;
    }
    return this.peerSubchannelBases.get(peerId) ?? null;
  }

  getPeerSubchannelRange(peerId) {
    const base = this.getPeerSubchannelBase(peerId);
    if (typeof base !== 'number') {
      return null;
    }
    return {
      start: base,
      end: base + SUBCHANNEL_BUCKET_SIZE - 1
    };
  }

  resolveSubchannelOffset(parsed) {
    if (!parsed || typeof parsed !== 'object') {
      return 0;
    }

    let rawCandidate;
    if (parsed.channelOffset !== undefined) {
      rawCandidate = parsed.channelOffset;
    } else if (parsed.channelIndex !== undefined) {
      rawCandidate = parsed.channelIndex;
    } else if (parsed.channelId !== undefined) {
      rawCandidate =
        typeof parsed.channelId === 'number' ? parsed.channelId % 10 : parsed.channelId;
    } else {
      rawCandidate = parsed.channel;
    }

    const numericValue = typeof rawCandidate === 'string' ? Number(rawCandidate) : rawCandidate;

    if (!Number.isFinite(numericValue)) {
      return 0;
    }

    const clamped = Math.max(0, Math.min(SUBCHANNEL_BUCKET_SIZE - 1, Math.trunc(numericValue)));
    return clamped;
  }

  resolveTargetPeerId(parsed) {
    if (!parsed || typeof parsed !== 'object') {
      return undefined;
    }

    const direct = typeof parsed.target === 'string' ? parsed.target : undefined;
    if (direct) {
      return direct;
    }

    if (typeof parsed.targetPeerId === 'string') {
      return parsed.targetPeerId;
    }

    return undefined;
  }

  resolveTargetSubchannels({ targetPeerId, offset }) {
    if (targetPeerId) {
      const base = this.ensurePeerSubchannelBase(targetPeerId);
      const normalized = Math.max(0, Math.min(SUBCHANNEL_BUCKET_SIZE - 1, Number(offset) || 0));
      return [base + normalized];
    }
    return [BROADCAST_SUBCHANNEL];
  }

  getSubchannelsForPeer(peerId) {
    const subchannels = new Set([BROADCAST_SUBCHANNEL]);
    if (peerId) {
      const base = this.ensurePeerSubchannelBase(peerId);
      for (let i = 0; i < SUBCHANNEL_BUCKET_SIZE; i += 1) {
        subchannels.add(base + i);
      }
    }
    return Array.from(subchannels);
  }

  notifyPeerChannelAssignment(peerId) {
    if (!this.room || typeof this.room.getPeer !== 'function') {
      return;
    }
    const peer = this.room.getPeer(peerId);
    if (!peer || !peer.socket || peer.socket.disconnected) {
      return;
    }
    const subchannelBase = this.ensurePeerSubchannelBase(peerId);
    if (typeof subchannelBase !== 'number') {
      return;
    }

    try {
      peer.socket.emit('dataChannelAssignment', {
        subchannelBase,
        subchannelBucketSize: SUBCHANNEL_BUCKET_SIZE,
        subchannelRange: {
          start: subchannelBase,
          end: subchannelBase + SUBCHANNEL_BUCKET_SIZE - 1
        },
        broadcastSubchannel: BROADCAST_SUBCHANNEL,
        assignedSubchannels: this.getSubchannelsForPeer(peerId).filter((value) => value !== BROADCAST_SUBCHANNEL)
      });
    } catch (error) {
      console.warn('Failed to notify peer about data channel assignment', {
        peerId,
        error: error.message
      });
    }
  }

  isReservedSystemEvent(parsed) {
    if (!parsed || typeof parsed !== 'object') {
      return false;
    }

    const channelName = typeof parsed.channel === 'string' ? parsed.channel.toLowerCase() : '';
    if (channelName) {
      for (const prefix of RESERVED_CHANNEL_PREFIXES) {
        if (channelName.startsWith(prefix)) {
          return true;
        }
      }

      if (
        channelName.includes('dataproducer') &&
        (channelName.includes('create') || channelName.includes('super') || channelName.includes('announce'))
      ) {
        return true;
      }
    }

    const eventName = this.extractEventName(parsed);
    if (eventName) {
      const lowered = eventName.toLowerCase();
      for (const keywords of RESERVED_EVENT_KEYWORDS) {
        if (keywords.every((keyword) => lowered.includes(keyword))) {
          return true;
        }
      }
    }

    return false;
  }

  extractEventName(parsed) {
    if (!parsed || typeof parsed !== 'object') {
      return undefined;
    }
    if (typeof parsed.event === 'string') {
      return parsed.event;
    }
    if (typeof parsed.type === 'string') {
      return parsed.type;
    }
    if (typeof parsed.action === 'string') {
      return parsed.action;
    }
    return undefined;
  }

  broadcastSuperDataProducerCreated() {
    if (!this.room || !this.room.broadcast) {
      return;
    }
    try {
      this.room.broadcast('dataProducerCreated', {
        dataProducerId: this.dataProducer.id,
        role: 'room-data-bus-super',
        subchannelRange: { start: BROADCAST_SUBCHANNEL, end: BROADCAST_SUBCHANNEL },
        subchannelBucketSize: SUBCHANNEL_BUCKET_SIZE,
        broadcastSubchannel: BROADCAST_SUBCHANNEL
      });
    } catch (error) {
      console.warn('Failed to announce super data producer creation', error.message);
    }
  }

  getSubchannelBucketSize() {
    return SUBCHANNEL_BUCKET_SIZE;
  }

  getBroadcastSubchannel() {
    return BROADCAST_SUBCHANNEL;
  }

  describePeerChannels(peerId) {
    if (!peerId) {
      return null;
    }

    const subchannelBase = this.ensurePeerSubchannelBase(peerId);
    const subchannelRange = this.getPeerSubchannelRange(peerId);
    const assignedSubchannels = this.getSubchannelsForPeer(peerId).filter(
      (value) => value !== BROADCAST_SUBCHANNEL
    );

    return {
      subchannelBase,
      subchannelBucketSize: SUBCHANNEL_BUCKET_SIZE,
      subchannelRange,
      assignedSubchannels,
      broadcastSubchannel: BROADCAST_SUBCHANNEL
    };
  }
}

module.exports = RoomDataBus;
