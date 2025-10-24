const os = require('os');

const listenIp = process.env.LISTEN_IP || '0.0.0.0';

function getDefaultIpAddress() {
  const networks = os.networkInterfaces();
  for (const net of Object.values(networks)) {
    if (!net) {
      continue;
    }
    for (const detail of net) {
      if (detail.family === 'IPv4' && !detail.internal) {
        return detail.address;
      }
    }
  }
  return '127.0.0.1';
}

const mediasoupListenIp = process.env.MEDIASOUP_LISTEN_IP || getDefaultIpAddress();

module.exports = {
  listenIp,
  listenPort: Number(process.env.PORT) || 3000,
  mediasoup: {
    numWorkers: Math.max(os.cpus().length, 1),
    worker: {
      rtcMinPort: Number(process.env.MEDIASOUP_MIN_PORT) || 40000,
      rtcMaxPort: Number(process.env.MEDIASOUP_MAX_PORT) || 49999,
      logLevel: process.env.MEDIASOUP_LOG_LEVEL || 'warn',
      logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp']
    },
    router: {
      mediaCodecs: [
        {
          kind: 'audio',
          mimeType: 'audio/opus',
          clockRate: 48000,
          channels: 2
        },
        {
          kind: 'video',
          mimeType: 'video/VP8',
          clockRate: 90000,
          parameters: {
            'x-google-start-bitrate': 1000
          }
        },
        {
          kind: 'video',
          mimeType: 'video/h264',
          clockRate: 90000,
          parameters: {
            'packetization-mode': 1,
            'profile-level-id': '42e01f',
            'level-asymmetry-allowed': 1,
            'x-google-start-bitrate': 1000
          }
        },
        {
          kind: 'video',
          mimeType: 'video/h264',
          clockRate: 90000,
          parameters: {
            'packetization-mode': 1,
            'profile-level-id': '4d0032',
            'level-asymmetry-allowed': 1,
            'x-google-start-bitrate': 1000
          }
        }
      ]
    },
    webRtcTransport: {
      listenIps: [
        {
          ip: mediasoupListenIp,
          announcedIp: process.env.ANNOUNCED_IP || undefined
        }
      ],
      initialAvailableOutgoingBitrate: 1_000_000,
      minimumAvailableOutgoingBitrate: 600_000,
      maxIncomingBitrate: 1_500_000,
      enableUdp: true,
      enableTcp: true,
      preferUdp: true
    }
  }
};