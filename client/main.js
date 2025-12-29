import { io } from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';

const joinBtn = document.getElementById('joinBtn');
const leaveBtn = document.getElementById('leaveBtn');
const startMediaBtn = document.getElementById('startMediaBtn');
const stopMediaBtn = document.getElementById('stopMediaBtn');
const roomInput = document.getElementById('roomId');
const peerInput = document.getElementById('peerId');
const localVideo = document.getElementById('localVideo');
const remoteVideosEl = document.getElementById('remoteVideos');
const logsEl = document.getElementById('logs');
const dataMessageInput = document.getElementById('dataMessage');
const sendDataBtn = document.getElementById('sendDataBtn');
const dataFeedEl = document.getElementById('dataFeed');
const dataTargetSelect = document.getElementById('dataTarget');

const signalingUrl = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SIGNALING_URL)
  ? import.meta.env.VITE_SIGNALING_URL
  : window.location.origin;

const socket = io(signalingUrl, { autoConnect: false });

let device;
let roomId;
let peerId;
let joined = false;
let localStream;
let sendTransport;
let recvTransport;
let dataProducer;
let dataConsumer;
const textDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

const producers = new Map(); // kind -> producer
const consumers = new Map(); // consumerId -> mediasoup Consumer
const consumersByProducer = new Map(); // producerId -> consumerId
const remoteProducers = new Map(); // producerId -> { peerId, metadata }
const remotePeerViews = new Map(); // peerId -> { container, stream, videoEl, audioEl, titleEl }
const peerMetadata = new Map(); // peerId -> metadata snapshot
const peerDataChannels = new Map(); // peerId -> subchannel metadata snapshot
const DEFAULT_SUBCHANNEL_BUCKET_SIZE = 10;
const BROADCAST_SUBCHANNEL_ID = 0;
const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
const MAX_TRANSPORT_RECOVERY_ATTEMPTS = 3;
const TRANSPORT_RECOVERY_DELAY_MS = 1500;
const transportRecoveryState = {
  recv: { inProgress: false },
  send: { inProgress: false }
};
const dataChannelAllocation = {
  subchannelBase: null,
  subchannelBucketSize: DEFAULT_SUBCHANNEL_BUCKET_SIZE,
  subchannelRange: null,
  broadcastSubchannel: BROADCAST_SUBCHANNEL_ID,
  assignedSubchannels: []
};

function base64ToUint8Array(base64) {
  if (typeof window !== 'undefined' && typeof window.atob === 'function') {
    const binary = window.atob(base64);
    const length = binary.length;
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  if (typeof Buffer !== 'undefined') {
    const buffer = Buffer.from(base64, 'base64');
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  throw new Error('Base64 decoding is not supported in this environment');
}

function uint8ArrayToBase64(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error('uint8ArrayToBase64 expects a Uint8Array input');
  }

  if (typeof window !== 'undefined' && typeof window.btoa === 'function') {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }

  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }

  throw new Error('Base64 encoding is not supported in this environment');
}

function normalizeBinaryInput(data) {
  if (data === undefined || data === null) {
    return new Uint8Array();
  }
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof data === 'string') {
    if (textEncoder) {
      return textEncoder.encode(data);
    }
    const bytes = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i += 1) {
      bytes[i] = data.charCodeAt(i) & 0xff;
    }
    return bytes;
  }
  throw new Error('Unsupported binary payload input');
}

function isBinaryPayloadDescriptor(payload) {
  return (
    payload &&
    typeof payload === 'object' &&
    payload.type === 'binary' &&
    payload.encoding === 'base64' &&
    typeof payload.data === 'string'
  );
}

function normalizeIncomingPayload(payload) {
  if (!isBinaryPayloadDescriptor(payload)) {
    return { value: payload, meta: undefined };
  }

  try {
    const bytes = base64ToUint8Array(payload.data);
    return {
      value: bytes,
      meta: {
        isBinary: true,
        byteLength:
          typeof payload.byteLength === 'number' && Number.isFinite(payload.byteLength)
            ? payload.byteLength
            : bytes.byteLength,
        mimeType: typeof payload.mimeType === 'string' ? payload.mimeType : undefined
      }
    };
  } catch (error) {
    return {
      value: payload,
      meta: {
        isBinary: true,
        byteLength: typeof payload.byteLength === 'number' ? payload.byteLength : 0,
        mimeType: typeof payload.mimeType === 'string' ? payload.mimeType : undefined,
        error: error.message
      }
    };
  }
}

function formatPayloadPreview(payload, payloadInfo) {
  if (payloadInfo?.isBinary) {
    const resolvedLength =
      typeof payloadInfo.byteLength === 'number'
        ? payloadInfo.byteLength
        : payload instanceof Uint8Array
          ? payload.byteLength
          : undefined;
    const sizeText = resolvedLength !== undefined ? `${resolvedLength} bytes` : 'binary payload';
    const mimeSuffix = payloadInfo.mimeType ? ` ${payloadInfo.mimeType}` : '';
    return `[binary ${sizeText}${mimeSuffix}]`;
  }

  if (payload instanceof Uint8Array) {
    return `[binary ${payload.byteLength} bytes]`;
  }

  if (typeof payload === 'string') {
    return payload;
  }

  try {
    return JSON.stringify(payload);
  } catch (error) {
    return String(payload);
  }
}

function createBinaryPayloadDescriptor(data, extra = {}) {
  const bytes = normalizeBinaryInput(data);
  const descriptor = {
    type: 'binary',
    encoding: 'base64',
    data: uint8ArrayToBase64(bytes),
    byteLength: bytes.byteLength
  };

  if (extra.mimeType) {
    descriptor.mimeType = extra.mimeType;
  }
  if (extra.meta !== undefined) {
    descriptor.meta = extra.meta;
  }

  return { descriptor, bytes };
}

function collectMemberAgentMetaData() {
  const base = {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language
  };

  if (navigator.languages) {
    base.languages = navigator.languages;
  }

  if (navigator.hardwareConcurrency) {
    base.hardwareConcurrency = navigator.hardwareConcurrency;
  }

  if (navigator.deviceMemory) {
    base.deviceMemory = navigator.deviceMemory;
  }

  if (typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
    try {
      base.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch (error) {
      // ignore
    }
  }

  if (window.screen) {
    base.screen = {
      width: window.screen.width,
      height: window.screen.height,
      pixelRatio: window.devicePixelRatio
    };
  }

  return base;
}

function sanitizeMetadata(meta) {
  if (!meta || typeof meta !== 'object') {
    return undefined;
  }

  try {
    return JSON.parse(JSON.stringify(meta));
  } catch (error) {
    return { ...meta };
  }
}

function waitMs(duration) {
  return new Promise((resolve) => setTimeout(resolve, duration));
}

function rememberRemoteProducer({ producerId, peerId, memberAgentMetaData }) {
  if (!producerId) {
    return;
  }
  remoteProducers.set(producerId, {
    peerId,
    metadata: sanitizeMetadata(memberAgentMetaData)
  });
}

function forgetRemoteProducer(producerId) {
  if (!producerId) {
    return;
  }
  remoteProducers.delete(producerId);
}

function forgetRemoteProducersForPeer(targetPeerId) {
  if (!targetPeerId) {
    return;
  }
  for (const [producerId, info] of remoteProducers.entries()) {
    if (info?.peerId === targetPeerId) {
      remoteProducers.delete(producerId);
    }
  }
}

function resetTransportRecoveryState() {
  for (const key of Object.keys(transportRecoveryState)) {
    transportRecoveryState[key].inProgress = false;
  }
}

function handleTransportStateTransition(kind, state) {
  if (!joined) {
    return;
  }
  if (state === 'failed') {
    attemptTransportRecovery(kind);
  }
}

async function attemptTransportRecovery(kind) {
  const state = transportRecoveryState[kind];
  if (!state || state.inProgress || !joined) {
    return;
  }
  state.inProgress = true;
  let recovered = false;

  try {
    for (let attempt = 1; attempt <= MAX_TRANSPORT_RECOVERY_ATTEMPTS; attempt += 1) {
      if (!joined) {
        break;
      }
      if (attempt > 1) {
        await waitMs(TRANSPORT_RECOVERY_DELAY_MS * (attempt - 1));
        if (!joined) {
          break;
        }
      }
      log('Attempting transport recovery', { kind, attempt });
      try {
        await performTransportRecovery(kind);
        log('Transport recovery succeeded', { kind, attempt });
        recovered = true;
        break;
      } catch (error) {
        log('Transport recovery attempt failed', { kind, attempt, error: error.message });
      }
    }

    if (!recovered) {
      const reason = joined ? 'exhausted' : 'aborted';
      log('Transport recovery did not complete', {
        kind,
        reason,
        maxAttemptsTried: MAX_TRANSPORT_RECOVERY_ATTEMPTS
      });
    }
  } finally {
    state.inProgress = false;
  }
}

async function performTransportRecovery(kind) {
  if (kind !== 'recv') {
    throw new Error(`Transport recovery not implemented for ${kind}`);
  }

  cleanupRecvTransport();
  await ensureRecvTransport();
  await recoverDataBusConsumer();
  await recoverMediaConsumers();
}

function cleanupRecvTransport() {
  if (dataConsumer) {
    try {
      dataConsumer.close();
    } catch (error) {
      // ignore
    }
    dataConsumer = undefined;
  }

  for (const consumer of Array.from(consumers.values())) {
    try {
      const producerPeerId = consumer.appData?.producerPeerId;
      if (producerPeerId && consumer.track) {
        removeRemoteTrack(producerPeerId, consumer.track);
      }
      consumer.close();
    } catch (error) {
      // ignore
    }
  }
  consumers.clear();
  consumersByProducer.clear();

  if (recvTransport) {
    try {
      recvTransport.close();
    } catch (error) {
      // ignore
    }
    recvTransport = undefined;
  }
}

async function recoverDataBusConsumer() {
  if (!joined) {
    return;
  }
  if (dataConsumer) {
    return;
  }
  await joinDataBus();
}

async function recoverMediaConsumers() {
  if (!joined || !remoteProducers.size) {
    return;
  }

  for (const [producerId, info] of remoteProducers.entries()) {
    if (consumersByProducer.has(producerId)) {
      continue;
    }
    await consumeProducer(producerId, info.peerId, info.metadata).catch((error) => {
      log('Failed to recover consumer', { producerId, error: error.message });
    });
  }
}

function formatPeerSummary(meta) {
  if (!meta) {
    return '';
  }

  if (meta.displayName) {
    return meta.displayName;
  }

  if (meta.platform && meta.language) {
    return `${meta.platform} · ${meta.language}`;
  }

  if (meta.userAgent) {
    return meta.userAgent.split(' ').slice(0, 5).join(' ');
  }

  return '';
}

function updatePeerLabel(peerId) {
  const view = remotePeerViews.get(peerId);
  if (!view) {
    return;
  }

  const summary = formatPeerSummary(peerMetadata.get(peerId));
  view.titleEl.textContent = summary ? `${peerId} — ${summary}` : peerId;
}

function setPeerMetadata(peerId, metadata) {
  if (!peerId) {
    return;
  }

  const sanitized = sanitizeMetadata(metadata);
  if (!sanitized) {
    return;
  }

  const previous = peerMetadata.get(peerId) || {};
  peerMetadata.set(peerId, { ...previous, ...sanitized });
  updatePeerLabel(peerId);
  refreshDataTargetOptions();
}

function clearPeerMetadata(peerId) {
  if (!peerId) {
    return;
  }
  peerMetadata.delete(peerId);
  updatePeerLabel(peerId);
  refreshDataTargetOptions();
}

function coerceFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeSubchannelRange(range, bucketSize, base) {
  if (range && typeof range === 'object') {
    const start = coerceFiniteNumber(range.start);
    const end = coerceFiniteNumber(range.end);
    if (start !== null && end !== null && end >= start) {
      return { start, end };
    }
  }

  if (base !== null && Number.isFinite(bucketSize)) {
    return { start: base, end: base + bucketSize - 1 };
  }

  return null;
}

function cloneSubchannelRange(range) {
  if (!range || typeof range !== 'object') {
    return null;
  }
  const start = coerceFiniteNumber(range.start);
  const end = coerceFiniteNumber(range.end);
  if (start === null || end === null) {
    return null;
  }
  return { start, end };
}

function normalizeAssignedSubchannels(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  const normalized = values
    .map((value) => coerceFiniteNumber(value))
    .filter((value) => value !== null);
  normalized.sort((a, b) => a - b);
  return normalized;
}

function clampChannelIndex(index, bucketSize = DEFAULT_SUBCHANNEL_BUCKET_SIZE) {
  const numeric = Number(index);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  const cappedBucket = Math.max(1, Math.trunc(bucketSize));
  return Math.max(0, Math.min(cappedBucket - 1, Math.trunc(numeric)));
}

function resolvePeerTargetSubchannel(targetPeerId, channelIndex = 0) {
  if (!targetPeerId) {
    return null;
  }
  const info = peerDataChannels.get(targetPeerId);
  if (!info) {
    return null;
  }

  if (Array.isArray(info.assignedSubchannels) && info.assignedSubchannels.length) {
    const boundedIndex = Math.max(0, Math.min(info.assignedSubchannels.length - 1, channelIndex));
    const candidate = info.assignedSubchannels[boundedIndex];
    return typeof candidate === 'number' ? candidate : null;
  }

  if (info.subchannelBase === null || !Number.isFinite(info.subchannelBucketSize)) {
    return null;
  }

  const boundedIndex = clampChannelIndex(channelIndex, info.subchannelBucketSize);
  return info.subchannelBase + boundedIndex;
}

function setPeerDataChannels(peerId, info) {
  if (!peerId || !info || typeof info !== 'object') {
    return;
  }

  const base = coerceFiniteNumber(info.subchannelBase ?? info.channelBase);
  const bucketSize =
    coerceFiniteNumber(info.subchannelBucketSize ?? info.channelBucketSize ?? info.rangeSize) ?? DEFAULT_SUBCHANNEL_BUCKET_SIZE;
  const rangeCandidate = info.subchannelRange ?? info.channelRange ?? info.broadcastRange;
  const range = normalizeSubchannelRange(rangeCandidate, bucketSize, base);
  const assignedSubchannels = normalizeAssignedSubchannels(info.assignedSubchannels);
  const normalized = {
    subchannelBase: base,
    subchannelBucketSize: bucketSize,
    subchannelRange: range,
    broadcastSubchannel:
      coerceFiniteNumber(info.broadcastSubchannel) ?? BROADCAST_SUBCHANNEL_ID,
    assignedSubchannels:
      assignedSubchannels.length
        ? assignedSubchannels
        : base !== null
          ? Array.from({ length: bucketSize }, (_, index) => base + index)
          : []
  };

  peerDataChannels.set(peerId, normalized);
}

function clearPeerDataChannels(peerId) {
  if (!peerId) {
    return;
  }
  peerDataChannels.delete(peerId);
}

function resetDataChannelAllocation() {
  dataChannelAllocation.subchannelBase = null;
  dataChannelAllocation.subchannelBucketSize = DEFAULT_SUBCHANNEL_BUCKET_SIZE;
  dataChannelAllocation.subchannelRange = null;
  dataChannelAllocation.broadcastSubchannel = BROADCAST_SUBCHANNEL_ID;
  dataChannelAllocation.assignedSubchannels = [];
}

function applyRoomDataBusInfo(info) {
  if (!info || typeof info !== 'object') {
    return;
  }

  const bucketSizeCandidate =
    coerceFiniteNumber(info.subchannelBucketSize ?? info.channelBucketSize ?? info.rangeSize);
  if (bucketSizeCandidate !== null) {
    dataChannelAllocation.subchannelBucketSize = bucketSizeCandidate;
  }

  if (typeof info.broadcastSubchannel === 'number' && Number.isFinite(info.broadcastSubchannel)) {
    dataChannelAllocation.broadcastSubchannel = info.broadcastSubchannel;
  }

  const baseCandidate = coerceFiniteNumber(info.subchannelBase ?? info.channelBase);
  if (baseCandidate !== null) {
    dataChannelAllocation.subchannelBase = baseCandidate;
  }

  const rangeCandidate = info.subchannelRange ?? info.channelRange ?? info.broadcastRange;
  const normalizedRange = normalizeSubchannelRange(
    rangeCandidate,
    dataChannelAllocation.subchannelBucketSize,
    dataChannelAllocation.subchannelBase
  );
  if (normalizedRange) {
    dataChannelAllocation.subchannelRange = normalizedRange;
  }

  const assigned = normalizeAssignedSubchannels(info.assignedSubchannels);
  if (assigned.length) {
    dataChannelAllocation.assignedSubchannels = assigned;
  } else if (dataChannelAllocation.subchannelBase !== null) {
    dataChannelAllocation.assignedSubchannels = Array.from(
      { length: dataChannelAllocation.subchannelBucketSize },
      (_, index) => dataChannelAllocation.subchannelBase + index
    );
  }
}

function handleChannelAssignmentUpdate(payload) {
  const previousBase = dataChannelAllocation.subchannelBase;
  applyRoomDataBusInfo(payload);
  if (dataChannelAllocation.subchannelBase !== previousBase && dataChannelAllocation.subchannelBase !== null) {
    log('Updated subchannel assignment', {
      subchannelBase: dataChannelAllocation.subchannelBase,
      subchannelBucketSize: dataChannelAllocation.subchannelBucketSize,
      subchannelRange: dataChannelAllocation.subchannelRange,
      broadcastSubchannel: dataChannelAllocation.broadcastSubchannel,
      assignedSubchannels: dataChannelAllocation.assignedSubchannels
    });
  }
}

function isBroadcastSubchannel(subchannelId) {
  return typeof subchannelId === 'number' && subchannelId === dataChannelAllocation.broadcastSubchannel;
}

function isLocalSubchannel(subchannelId) {
  if (typeof subchannelId !== 'number') {
    return false;
  }
  if (Array.isArray(dataChannelAllocation.assignedSubchannels) && dataChannelAllocation.assignedSubchannels.length) {
    return dataChannelAllocation.assignedSubchannels.includes(subchannelId);
  }
  const range = dataChannelAllocation.subchannelRange;
  if (!range) {
    return false;
  }
  return subchannelId >= range.start && subchannelId <= range.end;
}

function shouldAcceptEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') {
    return true;
  }
  const candidateSubchannel =
    typeof envelope.targetSubchannel === 'number'
      ? envelope.targetSubchannel
      : undefined;
  if (candidateSubchannel === undefined) {
    return true;
  }
  if (isBroadcastSubchannel(candidateSubchannel)) {
    return true;
  }
  if (
    (!Array.isArray(dataChannelAllocation.assignedSubchannels) || !dataChannelAllocation.assignedSubchannels.length) &&
    !dataChannelAllocation.subchannelRange
  ) {
    return true;
  }
  return isLocalSubchannel(candidateSubchannel);
}

function log(message, data) {
  const now = new Date().toLocaleTimeString();
  const text = data ? `${now} ${message} ${JSON.stringify(data)}` : `${now} ${message}`;
  const line = document.createElement('div');
  line.textContent = text;
  logsEl.appendChild(line);
  logsEl.scrollTop = logsEl.scrollHeight;
  console.log(message, data ?? '');
}

function refreshDataTargetOptions() {
  if (!dataTargetSelect) {
    return;
  }

  const previouslySelected = dataTargetSelect.value || 'broadcast';
  dataTargetSelect.innerHTML = '';

  const broadcastOption = document.createElement('option');
  broadcastOption.value = 'broadcast';
  broadcastOption.textContent = 'Broadcast';
  dataTargetSelect.appendChild(broadcastOption);

  for (const [id, meta] of peerMetadata.entries()) {
    if (id === peerId) {
      continue;
    }
    const label = formatPeerSummary(meta);
    const option = document.createElement('option');
    option.value = id;
    option.textContent = label ? `${id} — ${label}` : id;
    dataTargetSelect.appendChild(option);
  }

  const shouldSelectBroadcast = previouslySelected === 'broadcast' || !Array.from(peerMetadata.keys()).includes(previouslySelected);
  dataTargetSelect.value = shouldSelectBroadcast ? 'broadcast' : previouslySelected;
}

function setUiState() {
  joinBtn.disabled = joined;
  leaveBtn.disabled = !joined;
  startMediaBtn.disabled = !joined || producers.size > 0;
  stopMediaBtn.disabled = !joined || producers.size === 0;
  peerInput.disabled = joined;
  roomInput.disabled = joined;
  const dataReady = joined && Boolean(dataProducer);
  if (sendDataBtn) {
    sendDataBtn.disabled = !joined;
  }
  if (dataMessageInput) {
    dataMessageInput.disabled = !joined;
  }
  if (dataTargetSelect) {
    dataTargetSelect.disabled = !joined;
  }
}

function randomId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  return `peer-${Math.random().toString(16).slice(2, 10)}`;
}

function request(event, payload = {}) {
  if (socket.disconnected) {
    throw new Error('Socket is disconnected');
  }
  return new Promise((resolve, reject) => {
    socket.emit(event, payload, (response) => {
      if (!response || response.ok !== true) {
        reject(new Error(response?.error || `Request failed: ${event}`));
        return;
      }
      resolve(response);
    });
  });
}

function getOrCreateRemotePeerView(targetPeerId) {
  if (!remotePeerViews.has(targetPeerId)) {
    const container = document.createElement('div');
    container.className = 'remote-peer';

    const title = document.createElement('h4');
    title.textContent = targetPeerId;

    const stream = new MediaStream();

    const videoEl = document.createElement('video');
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    videoEl.muted = false;
    videoEl.srcObject = stream;

    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.srcObject = stream;
    audioEl.style.display = 'none';

    container.appendChild(title);
    container.appendChild(videoEl);
    container.appendChild(audioEl);
    remoteVideosEl.appendChild(container);

    remotePeerViews.set(targetPeerId, {
      container,
      stream,
      videoEl,
      audioEl,
      titleEl: title
    });
  }

  updatePeerLabel(targetPeerId);
  return remotePeerViews.get(targetPeerId);
}

function removeRemotePeerView(targetPeerId) {
  const entry = remotePeerViews.get(targetPeerId);
  if (!entry) {
    return;
  }
  entry.stream.getTracks().forEach((track) => track.stop());
  entry.videoEl.srcObject = null;
  entry.audioEl.srcObject = null;
  entry.container.remove();
  remotePeerViews.delete(targetPeerId);
}

async function ensureRecvTransport() {
  if (recvTransport) {
    return recvTransport;
  }
  if (!device) {
    throw new Error('Device is not ready');
  }

  const transportOptions = await request('createWebRtcTransport', { direction: 'recv' });
  const transport = device.createRecvTransport(transportOptions);

  transport.on('connect', ({ dtlsParameters }, callback, errback) => {
    request('connectWebRtcTransport', {
      transportId: transport.id,
      dtlsParameters
    })
      .then(() => callback())
      .catch(errback);
  });

  transport.on('connectionstatechange', (state) => {
    log(`recv transport state: ${state}`);
    handleTransportStateTransition('recv', state);
  });

  recvTransport = transport;
  return transport;
}

async function ensureSendTransport() {
  if (sendTransport) {
    return sendTransport;
  }
  if (!device) {
    throw new Error('Device is not ready');
  }

  const transportOptions = await request('createWebRtcTransport', { direction: 'send' });
  const transport = device.createSendTransport(transportOptions);

  transport.on('connect', ({ dtlsParameters }, callback, errback) => {
    request('connectWebRtcTransport', {
      transportId: transport.id,
      dtlsParameters
    })
      .then(() => callback())
      .catch(errback);
  });

  transport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
    request('produce', {
      transportId: transport.id,
      kind,
      rtpParameters,
      appData
    })
      .then(({ id }) => {
        callback({ id });
      })
      .catch(errback);
  });

  transport.on('producedata', ({ sctpStreamParameters, label, protocol, appData }, callback, errback) => {
    request('produceData', {
      transportId: transport.id,
      sctpStreamParameters,
      label,
      protocol,
      appData
    })
      .then(({ id }) => {
        callback({ id });
      })
      .catch(errback);
  });

  transport.on('connectionstatechange', (state) => {
    log(`send transport state: ${state}`);
  });

  sendTransport = transport;
  return transport;
}

async function consumeProducer(producerId, producerPeerId, metadata) {
  let consumer;
  try {
    if (metadata) {
      setPeerMetadata(producerPeerId, metadata);
    }
    const transport = await ensureRecvTransport();
    const consumerParams = await request('consume', {
      producerId,
      transportId: transport.id,
      rtpCapabilities: device.rtpCapabilities
    });

    consumer = await transport.consume({
      id: consumerParams.id,
      producerId: consumerParams.producerId,
      kind: consumerParams.kind,
      rtpParameters: consumerParams.rtpParameters,
      appData: { producerPeerId }
    });

    consumers.set(consumer.id, consumer);
    consumersByProducer.set(producerId, consumer.id);

    consumer.on('transportclose', () => {
      consumers.delete(consumer.id);
      consumersByProducer.delete(producerId);
    });

    consumer.on('trackended', () => {
      log(`consumer track ended (${consumer.id})`);
      removeRemoteTrack(producerPeerId, consumer.track);
      consumer.close();
    });

    const view = getOrCreateRemotePeerView(producerPeerId);
    view.stream.addTrack(consumer.track);
    updatePeerLabel(producerPeerId);

    await request('resumeConsumer', { consumerId: consumer.id });
    await consumer.resume();
    log('Consuming producer', {
      producerId,
      from: producerPeerId,
      kind: consumerParams.kind,
      meta: peerMetadata.get(producerPeerId)
    });
  } catch (error) {
    if (consumer) {
      removeRemoteTrack(producerPeerId, consumer.track);
      consumer.close();
      consumers.delete(consumer.id);
      consumersByProducer.delete(producerId);
    }
    log('Failed to consume producer', { producerId, error: error.message });
  }
}

function removeRemoteTrack(targetPeerId, track) {
  const entry = remotePeerViews.get(targetPeerId);
  if (!entry) {
    return;
  }
  const { stream } = entry;
  const matching = stream.getTracks().find((t) => t.id === track.id);
  if (matching) {
    stream.removeTrack(matching);
    matching.stop();
  }
  if (stream.getTracks().length === 0) {
    removeRemotePeerView(targetPeerId);
  }
}

function decodeDataMessage(message) {
  if (message === undefined || message === null) {
    return undefined;
  }
  if (typeof message === 'string') {
    return message;
  }
  if (message instanceof ArrayBuffer) {
    return textDecoder ? textDecoder.decode(message) : '';
  }
  if (ArrayBuffer.isView(message)) {
    const buffer = message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength);
    return textDecoder ? textDecoder.decode(buffer) : '';
  }
  return message;
}

function appendDataFeed(direction, payload, meta = {}) {
  if (!dataFeedEl) {
    return;
  }
  const channel = meta.channel || 'default';
  const channelIndex = typeof meta.channelIndex === 'number' ? meta.channelIndex : undefined;
  const from = meta.from ? ` ${meta.from}` : '';
  const targetLabel = meta.target || undefined;
  const targetSubchannel = typeof meta.targetSubchannel === 'number' ? meta.targetSubchannel : undefined;
  const targetParts = [];
  if (targetLabel) {
    targetParts.push(targetLabel);
  }
  if (targetSubchannel !== undefined) {
    targetParts.push(`subch#${targetSubchannel}`);
  }
  const targetText = targetParts.length ? ` -> ${targetParts.join(' ')}` : '';
  const preview = formatPayloadPreview(payload, meta.payloadInfo);
  const showChannelIndex = channelIndex !== undefined && channelIndex !== 0;
  const channelDescriptor = showChannelIndex ? `${channel}#${channelIndex}` : channel;
  const line = document.createElement('div');
  const fromText = from ? ` ${from}` : '';
  line.textContent = `${new Date().toLocaleTimeString()} [${direction}] (${channelDescriptor})${fromText}${targetText ? `${targetText}` : ''} ${preview}`;
  dataFeedEl.appendChild(line);
  dataFeedEl.scrollTop = dataFeedEl.scrollHeight;
}

function handleIncomingData(message) {
  const decoded = decodeDataMessage(message);
  if (decoded === undefined) {
    return;
  }

  let parsed = decoded;
  if (typeof decoded === 'string') {
    try {
      parsed = JSON.parse(decoded);
    } catch (error) {
      parsed = decoded;
    }
  }

  if (parsed && typeof parsed === 'object' && !shouldAcceptEnvelope(parsed)) {
    return;
  }

  if (parsed && typeof parsed === 'object') {
    const { value: payloadValue, meta: payloadInfo } = normalizeIncomingPayload(parsed.payload);
    const normalizedPayload =
      payloadInfo?.isBinary
        ? payloadValue
        : payloadValue && typeof payloadValue === 'object' && payloadValue.text !== undefined
          ? payloadValue.text
          : payloadValue ?? parsed.payload;

    if (parsed.payload !== undefined || payloadInfo?.isBinary) {
      appendDataFeed('recv', normalizedPayload, {
        channel: parsed.channel || 'default',
        from: parsed.from,
        channelIndex: typeof parsed.channelIndex === 'number' ? parsed.channelIndex : undefined,
        targetSubchannel: typeof parsed.targetSubchannel === 'number' ? parsed.targetSubchannel : undefined,
        target: parsed.target || parsed.targetPeerId,
        payloadInfo
      });
      return;
    }
  }

  appendDataFeed('recv', parsed, { channel: 'default' });
}

async function ensureDataProducer() {
  if (dataProducer) {
    return dataProducer;
  }
  const transport = await ensureSendTransport();
  const producer = await transport.produceData({
    ordered: true,
    label: 'room-data-client',
    appData: { channel: 'chat' }
  });

  dataProducer = producer;
  producer.on('close', () => {
    dataProducer = undefined;
    setUiState();
  });
  producer.on('transportclose', () => {
    dataProducer = undefined;
    setUiState();
  });

  log('Data bus producer ready', { label: producer.label });
  setUiState();
  return producer;
}

async function joinDataBus() {
  if (dataConsumer) {
    return dataConsumer;
  }
  const transport = await ensureRecvTransport();
  const consumerInfo = await request('joinDataBus', { transportId: transport.id });
  const consumer = await transport.consumeData({
    id: consumerInfo.id,
    dataProducerId: consumerInfo.dataProducerId,
    sctpStreamParameters: consumerInfo.sctpStreamParameters,
    label: consumerInfo.label,
    protocol: consumerInfo.protocol,
    appData: consumerInfo.appData
  });

  dataConsumer = consumer;
  consumer.on('message', (message) => {
    handleIncomingData(message);
  });
  consumer.on('close', () => {
    dataConsumer = undefined;
    setUiState();
  });
  consumer.on('transportclose', () => {
    dataConsumer = undefined;
    setUiState();
  });
  consumer.on('dataproducerclose', () => {
    consumer.close();
    dataConsumer = undefined;
    setUiState();
  });

  log('Joined room data bus', { label: consumer.label });
  setUiState();
  return consumer;
}

async function setupDataBus() {
  if (!joined) {
    return;
  }
  try {
    await joinDataBus();
  } catch (error) {
    log('Failed to join room data bus', { error: error.message });
  }
  try {
    await ensureDataProducer();
  } catch (error) {
    log('Failed to create data bus producer', { error: error.message });
  }
}

async function sendDataMessage() {
  if (!joined) {
    return;
  }
  const textValue = dataMessageInput ? dataMessageInput.value : '';
  const text = textValue.trim();
  if (!text) {
    return;
  }
  try {
    const producer = await ensureDataProducer();
    const targetPeerId = dataTargetSelect ? dataTargetSelect.value : 'broadcast';
    const channelIndex = clampChannelIndex(0, dataChannelAllocation.subchannelBucketSize);
    const envelope = {
      channel: 'chat',
      channelIndex,
      payload: { text },
      target: targetPeerId === 'broadcast' ? undefined : targetPeerId
    };
    producer.send(JSON.stringify(envelope));
    appendDataFeed('send', text, {
      channel: envelope.channel,
      from: peerId,
      target: targetPeerId,
      channelIndex,
      targetSubchannel:
        targetPeerId === 'broadcast'
          ? dataChannelAllocation.broadcastSubchannel
          : resolvePeerTargetSubchannel(targetPeerId, channelIndex)
    });
    if (dataMessageInput) {
      dataMessageInput.value = '';
    }
  } catch (error) {
    log('Failed to send data message', { error: error.message });
  }
}

async function sendBinaryPayload(data, options = {}) {
  if (!joined) {
    throw new Error('Cannot send binary payload before joining a room');
  }

  const targetChoice =
    options.targetPeerId !== undefined
      ? options.targetPeerId
      : dataTargetSelect
        ? dataTargetSelect.value
        : 'broadcast';
  const resolvedTarget = targetChoice && targetChoice !== 'broadcast' ? targetChoice : 'broadcast';
  const channelIndex = clampChannelIndex(
    typeof options.channelIndex === 'number' ? options.channelIndex : 0,
    dataChannelAllocation.subchannelBucketSize
  );

  try {
    const { descriptor, bytes } = createBinaryPayloadDescriptor(data, {
      mimeType: options.mimeType,
      meta: options.meta
    });
    const producer = await ensureDataProducer();
    const envelope = {
      channel: options.channel || 'binary',
      channelIndex,
      payload: descriptor,
      target: resolvedTarget === 'broadcast' ? undefined : resolvedTarget
    };
    producer.send(JSON.stringify(envelope));
    appendDataFeed('send', bytes, {
      channel: envelope.channel,
      from: peerId,
      target: resolvedTarget,
      channelIndex,
      targetSubchannel:
        resolvedTarget === 'broadcast'
          ? dataChannelAllocation.broadcastSubchannel
          : resolvePeerTargetSubchannel(resolvedTarget, channelIndex),
      payloadInfo: {
        isBinary: true,
        byteLength: descriptor.byteLength,
        mimeType: descriptor.mimeType
      }
    });
  } catch (error) {
    log('Failed to send binary payload', { error: error.message });
    throw error;
  }
}

async function startMedia() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    localStream = stream;
    localVideo.srcObject = stream;

    const transport = await ensureSendTransport();

    const tracks = stream.getTracks();
    for (const track of tracks) {
      if (!device.canProduce(track.kind)) {
        log(`Cannot produce track kind=${track.kind}`);
        continue;
      }

      const producer = await transport.produce({ track, appData: { kind: track.kind } });
      producers.set(track.kind, producer);

      producer.on('trackended', () => {
        log(`Local track ended (${track.kind})`);
        producers.delete(track.kind);
        request('closeProducer', { producerId: producer.id }).catch(() => {});
        setUiState();
      });

      producer.on('transportclose', () => {
        producers.delete(track.kind);
        setUiState();
      });

      log('Started producing track', { kind: track.kind, producerId: producer.id });
    }
  } catch (error) {
    log('Failed to acquire media', { error: error.message });
  }
  setUiState();
}

async function stopMedia() {
  for (const producer of Array.from(producers.values())) {
    try {
      await request('closeProducer', { producerId: producer.id });
    } catch (error) {
      log('Failed to close producer', { error: error.message });
    }
    producer.close();
  }
  producers.clear();

  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
    localVideo.srcObject = null;
  }
  setUiState();
}

async function joinRoom() {
  if (joined) {
    return;
  }

  const targetRoom = roomInput.value.trim();
  if (!targetRoom) {
    log('Room ID is required');
    return;
  }

  roomId = targetRoom;
  peerId = peerInput.value.trim() || randomId();

  if (socket.disconnected) {
    socket.connect();
  }

  const memberAgentMetaData = collectMemberAgentMetaData();

  socket.emit('join', { roomId, peerId, memberAgentMetaData }, async (response) => {
    if (!response || response.ok !== true) {
      log('Join failed', response);
      return;
    }

    try {
      applyRoomDataBusInfo(response.roomDataBus);
      device = new mediasoupClient.Device();
      await device.load({ routerRtpCapabilities: response.routerRtpCapabilities });
      joined = true;
      peerInput.value = peerId;
      setPeerMetadata(peerId, memberAgentMetaData);
      setUiState();
      log('Joined room', { roomId, peerId });

      if (Array.isArray(response.existingPeers)) {
        for (const existing of response.existingPeers) {
          setPeerMetadata(existing.peerId, existing.memberAgentMetaData);
          setPeerDataChannels(existing.peerId, existing.dataChannels);
        }
      }

      for (const existing of response.existingProducers || []) {
        setPeerMetadata(existing.peerId, existing.memberAgentMetaData);
        rememberRemoteProducer(existing);
        consumeProducer(existing.producerId, existing.peerId, existing.memberAgentMetaData);
      }

      setupDataBus();
    } catch (error) {
      log('Failed to initialize mediasoup device', { error: error.message });
    }
  });
}

function cleanupClientState() {
  joined = false;
  device = undefined;
  roomId = undefined;
  peerId = undefined;

  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }
  localVideo.srcObject = null;

  if (sendTransport) {
    sendTransport.close();
    sendTransport = undefined;
  }
  if (recvTransport) {
    recvTransport.close();
    recvTransport = undefined;
  }
  if (dataProducer) {
    dataProducer.close();
    dataProducer = undefined;
  }
  if (dataConsumer) {
    dataConsumer.close();
    dataConsumer = undefined;
  }

  for (const producer of Array.from(producers.values())) {
    producer.close();
  }
  producers.clear();

  for (const consumer of Array.from(consumers.values())) {
    consumer.close();
  }
  consumers.clear();
  consumersByProducer.clear();

  for (const peerEntry of Array.from(remotePeerViews.keys())) {
    removeRemotePeerView(peerEntry);
  }

  peerMetadata.clear();
  peerDataChannels.clear();
  remoteProducers.clear();
  resetDataChannelAllocation();
  resetTransportRecoveryState();
  if (dataFeedEl) {
    dataFeedEl.innerHTML = '';
  }
  refreshDataTargetOptions();

  setUiState();
}

function leaveRoom() {
  if (!joined) {
    return;
  }
  socket.emit('leave');
  cleanupClientState();
  log('Left room');
}

function handleProducerClosed(producerId, producerPeerId) {
  const consumerId = consumersByProducer.get(producerId);
  if (!consumerId) {
    return;
  }
  const consumer = consumers.get(consumerId);
  if (consumer) {
    removeRemoteTrack(producerPeerId, consumer.track);
    consumer.close();
  }
  consumers.delete(consumerId);
  consumersByProducer.delete(producerId);
}

socket.on('connect', () => {
  log('Socket connected', { id: socket.id });
});

socket.on('disconnect', (reason) => {
  log('Socket disconnected', { reason });
  cleanupClientState();
});

socket.on('connect_error', (error) => {
  log('Socket error', { message: error.message });
});

socket.on('newProducer', ({ producerId, peerId: producerPeerId, memberAgentMetaData }) => {
  if (!joined || !device) {
    return;
  }
  setPeerMetadata(producerPeerId, memberAgentMetaData);
  rememberRemoteProducer({ producerId, peerId: producerPeerId, memberAgentMetaData });
  log('New producer detected', {
    producerId,
    from: producerPeerId,
    meta: peerMetadata.get(producerPeerId)
  });
  consumeProducer(producerId, producerPeerId, memberAgentMetaData);
});

socket.on('producerClosed', ({ producerId, peerId: producerPeerId, memberAgentMetaData }) => {
  setPeerMetadata(producerPeerId, memberAgentMetaData);
  forgetRemoteProducer(producerId);
  log('Producer closed', {
    producerId,
    peerId: producerPeerId,
    meta: peerMetadata.get(producerPeerId)
  });
  handleProducerClosed(producerId, producerPeerId);
});

socket.on('dataChannelAssignment', (payload) => {
  handleChannelAssignmentUpdate(payload);
});

socket.on('peerClosed', ({ peerId: closedPeerId, memberAgentMetaData }) => {
  setPeerMetadata(closedPeerId, memberAgentMetaData);
  log('Peer left room', {
    peerId: closedPeerId,
    meta: peerMetadata.get(closedPeerId)
  });
  removeRemotePeerView(closedPeerId);
  clearPeerMetadata(closedPeerId);
  clearPeerDataChannels(closedPeerId);
  forgetRemoteProducersForPeer(closedPeerId);
  refreshDataTargetOptions();
});

socket.on('peerJoined', ({ peerId: joinedPeerId, memberAgentMetaData, dataChannels }) => {
  if (!joined) {
    return;
  }
  setPeerMetadata(joinedPeerId, memberAgentMetaData);
  setPeerDataChannels(joinedPeerId, dataChannels);
  refreshDataTargetOptions();
  log('Peer joined room', {
    peerId: joinedPeerId,
    meta: peerMetadata.get(joinedPeerId)
  });
});

joinBtn.addEventListener('click', () => {
  joinRoom();
});

leaveBtn.addEventListener('click', () => {
  leaveRoom();
});

startMediaBtn.addEventListener('click', () => {
  startMedia();
});

stopMediaBtn.addEventListener('click', () => {
  stopMedia();
});

if (sendDataBtn) {
  sendDataBtn.addEventListener('click', () => {
    sendDataMessage();
  });
}

if (dataMessageInput) {
  dataMessageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendDataMessage();
    }
  });
}

window.addEventListener('beforeunload', () => {
  if (joined) {
    socket.emit('leave');
  }
});

if (typeof window !== 'undefined') {
  window.sendBinaryPayload = sendBinaryPayload;
}

setUiState();
