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

const producers = new Map(); // kind -> producer
const consumers = new Map(); // consumerId -> mediasoup Consumer
const consumersByProducer = new Map(); // producerId -> consumerId
const remotePeerViews = new Map(); // peerId -> { container, stream, videoEl, audioEl, titleEl }
const peerMetadata = new Map(); // peerId -> metadata snapshot

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
}

function clearPeerMetadata(peerId) {
  if (!peerId) {
    return;
  }
  peerMetadata.delete(peerId);
  updatePeerLabel(peerId);
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

function setUiState() {
  joinBtn.disabled = joined;
  leaveBtn.disabled = !joined;
  startMediaBtn.disabled = !joined || producers.size > 0;
  stopMediaBtn.disabled = !joined || producers.size === 0;
  peerInput.disabled = joined;
  roomInput.disabled = joined;
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
        }
      }

      for (const existing of response.existingProducers || []) {
        setPeerMetadata(existing.peerId, existing.memberAgentMetaData);
        consumeProducer(existing.producerId, existing.peerId, existing.memberAgentMetaData);
      }
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
  log('New producer detected', {
    producerId,
    from: producerPeerId,
    meta: peerMetadata.get(producerPeerId)
  });
  consumeProducer(producerId, producerPeerId, memberAgentMetaData);
});

socket.on('producerClosed', ({ producerId, peerId: producerPeerId, memberAgentMetaData }) => {
  setPeerMetadata(producerPeerId, memberAgentMetaData);
  log('Producer closed', {
    producerId,
    peerId: producerPeerId,
    meta: peerMetadata.get(producerPeerId)
  });
  handleProducerClosed(producerId, producerPeerId);
});

socket.on('peerClosed', ({ peerId: closedPeerId, memberAgentMetaData }) => {
  setPeerMetadata(closedPeerId, memberAgentMetaData);
  log('Peer left room', {
    peerId: closedPeerId,
    meta: peerMetadata.get(closedPeerId)
  });
  removeRemotePeerView(closedPeerId);
  clearPeerMetadata(closedPeerId);
});

socket.on('peerJoined', ({ peerId: joinedPeerId, memberAgentMetaData }) => {
  if (!joined) {
    return;
  }
  setPeerMetadata(joinedPeerId, memberAgentMetaData);
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

window.addEventListener('beforeunload', () => {
  if (joined) {
    socket.emit('leave');
  }
});

setUiState();
