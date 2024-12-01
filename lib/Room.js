const EventEmitter = require('events').EventEmitter;
const mediasoup = require('mediasoup');
const throttle = require('@sitespeed.io/throttle');
const Logger = require('./Logger');
const utils = require('./utils');
const config = require('../config');
const Bot = require('./Bot');

const logger = new Logger('Room');

/**
 * Room class.
 *
 * This is not a "mediasoup Room" by itself, by a custom class that holds
 * a protoo Room (for signaling with WebSocket clients) and a mediasoup Router
 * (for sending and receiving media to/from those WebSocket peers).
 */
class Room extends EventEmitter
{
	/**
	 * Factory function that creates and returns Room instance.
	 *
	 * @async
	 *
	 * @param {mediasoup.Worker} mediasoupWorker - The mediasoup Worker in which a new
	 *   mediasoup Router must be created.
	 * @param {String} roomId - Id of the Room instance.
	 */
	static async create({ mediasoupWorker, roomId, consumerReplicas })
	{
    logger.info('create() [roomId:%s]', roomId);

    // Router media codecs.
    const { mediaCodecs } = config.mediasoup.routerOptions;

    // Create a mediasoup Router.
    const mediasoupRouter = await mediasoupWorker.createRouter({ mediaCodecs });

    // Create a mediasoup AudioLevelObserver.
		const audioLevelObserver = await mediasoupRouter.createAudioLevelObserver(
			{
				maxEntries : 1,
				threshold  : -80,
				interval   : 800
    });

    // Create a mediasoup ActiveSpeakerObserver.
    const activeSpeakerObserver = await mediasoupRouter.createActiveSpeakerObserver();

    const bot = await Bot.create({ mediasoupRouter });

    return new Room({
      roomId,
      mediasoupRouter,
      audioLevelObserver,
      activeSpeakerObserver,
      consumerReplicas,
      bot,
      io,
    });
  }

  constructor({ roomId, mediasoupRouter, audioLevelObserver, activeSpeakerObserver, consumerReplicas, bot, io }) {
    super();

    this.setMaxListeners(Infinity);

		// Room id.
		// @type {String}
    this._roomId = roomId;

		// Closed flag.
		// @type {Boolean}
    this._closed = false;
    this._mediasoupRouter = mediasoupRouter;

		// mediasoup AudioLevelObserver.
		// @type {mediasoup.AudioLevelObserver}
    this._audioLevelObserver = audioLevelObserver;

		// mediasoup ActiveSpeakerObserver.
		// @type {mediasoup.ActiveSpeakerObserver}
    this._activeSpeakerObserver = activeSpeakerObserver;

		// DataChannel bot.
		// @type {Bot}
    this._bot = bot;

		// Consumer replicas.
		// @type {Number}
    this._consumerReplicas = consumerReplicas || 0;

		// Network throttled.
		// @type {Boolean}
    this._networkThrottled = false;
    this._peers = new Map();

		// Handle audioLevelObserver.
    this._handleAudioLevelObserver();

		// Handle activeSpeakerObserver.
    this._handleActiveSpeakerObserver();

    if (io) {
      this._setupSocketIoHandlers(io);
    }

    global.audioLevelObserver = this._audioLevelObserver;
    global.activeSpeakerObserver = this._activeSpeakerObserver;
    global.bot = this._bot;
  }

  _setupSocketIoHandlers(io) {
    io.on('connection', (socket) => {
      socket.on('joinRoom', async ({ roomId, peerId }) => {
        if (roomId !== this._roomId) return;

        logger.info('peer joined room [roomId:%s, peerId:%s]', roomId, peerId);

        if (this._peers.has(peerId)) {
          logger.warn('peer already exists, closing existing peer [peerId:%s]', peerId);
          this._peers.get(peerId).socket.disconnect();
          this._peers.delete(peerId);
        }

        const peer = { id: peerId, socket };
        this._peers.set(peerId, peer);

        socket.on('disconnect', () => {
          logger.info('peer disconnected [peerId:%s]', peerId);
          this._peers.delete(peerId);
          if (this._peers.size === 0) {
            logger.info('last Peer in the room left, closing the room [roomId:%s]', this._roomId);
            this.close();
          }
        });

        socket.on('request', async (request, callback) => {
          try {
            const response = await this._handleSocketIoRequest(peer, request);
            callback({ error: null, data: response });
          } catch (error) {
            logger.error('request failed [peerId:%s, request:%o, error:%o]', peerId, request, error);
            callback({ error: error.message });
          }
        });
      });
    });
  }

  async _handleSocketIoRequest(peer, request) {
    switch (request.method) {
      case 'getRouterRtpCapabilities': {
        return this._mediasoupRouter.rtpCapabilities;
      }

      case 'createWebRtcTransport': {
        const { forceTcp, producing, consuming, sctpCapabilities } = request.data;
        const webRtcTransportOptions = {
          ...utils.clone(config.mediasoup.webRtcTransportOptions),
          webRtcServer: this._mediasoupRouter.appData.webRtcServer,
          iceConsentTimeout: 20,
          enableSctp: Boolean(sctpCapabilities),
          numSctpStreams: (sctpCapabilities || {}).numStreams,
          appData: { producing, consuming },
        };

        if (forceTcp) {
          webRtcTransportOptions.listenInfos = webRtcTransportOptions.listenInfos.filter((listenInfo) => listenInfo.protocol === 'tcp');
          webRtcTransportOptions.enableUdp = false;
          webRtcTransportOptions.enableTcp = true;
        }

        const transport = await this._mediasoupRouter.createWebRtcTransport(webRtcTransportOptions);
        peer.transports = peer.transports || new Map();
        peer.transports.set(transport.id, transport);

        return {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
          sctpParameters: transport.sctpParameters,
        };
      }

      case 'connectWebRtcTransport': {
        const { transportId, dtlsParameters } = request.data;
        const transport = peer.transports.get(transportId);

        if (!transport) throw new Error(`transport with id "${transportId}" not found`);
        await transport.connect({ dtlsParameters });
        return;
      }

      case 'produce': {
        const { transportId, kind, rtpParameters } = request.data;
        let { appData } = request.data;
        const transport = peer.transports.get(transportId);

        if (!transport) throw new Error(`transport with id "${transportId}" not found`);

        appData = { ...appData, peerId: peer.id };
        const producer = await transport.produce({ kind, rtpParameters, appData });

        peer.producers = peer.producers || new Map();
        peer.producers.set(producer.id, producer);

        producer.on('transportclose', () => peer.producers.delete(producer.id));

        // Notify all peers about the new producer
        for (const [otherPeerId, otherPeer] of this._peers) {
          if (otherPeerId === peer.id) continue;
          otherPeer.socket.emit('newProducer', {
            producerId: producer.id,
            kind: producer.kind,
            peerId: peer.id,
          });
        }

        return { id: producer.id };
      }

      case 'consume': {
        const { producerId, rtpCapabilities } = request.data;
        const producer = Array.from(peer.producers.values()).find((p) => p.id === producerId);

        if (!producer) throw new Error(`producer with id "${producerId}" not found`);
        if (!this._mediasoupRouter.canConsume({ producerId, rtpCapabilities })) throw new Error('cannot consume');

        const transport = Array.from(peer.transports.values()).find((t) => t.appData.consuming);
        if (!transport) throw new Error('transport for consuming not found');

        const consumer = await transport.consume({ producerId, rtpCapabilities, paused: true });
        peer.consumers = peer.consumers || new Map();
        peer.consumers.set(consumer.id, consumer);

        consumer.on('transportclose', () => peer.consumers.delete(consumer.id));
        consumer.on('producerclose', () => peer.consumers.delete(consumer.id));

        return {
          id: consumer.id,
          producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
          type: consumer.type,
        };
      }

      default:
        throw new Error(`unknown request.method "${request.method}"`);
    }
  }

  close() {
    logger.debug('close()');
    this._closed = true;
    this._mediasoupRouter.close();
    this._bot.close();
    this.emit('close');
    if (this._networkThrottled) {
      logger.debug('close() | stopping network throttle');
      throttle.stop({}).catch((error) => {
        logger.error(`close() | failed to stop network throttle:${error}`);
      });
    }
  }

  _handleAudioLevelObserver() {
    this._audioLevelObserver.on('volumes', (volumes) => {
      const { producer, volume } = volumes[0];
      logger.debug('audioLevelObserver "volumes" event [producerId:%s, volume:%s]', producer.id, volume);
      for (const peer of this._peers.values()) {
        peer.socket.emit('activeSpeaker', { peerId: producer.appData.peerId, volume });
      }
    });
    this._audioLevelObserver.on('silence', () => {
      logger.debug('audioLevelObserver "silence" event');
      for (const peer of this._peers.values()) {
        peer.socket.emit('activeSpeaker', { peerId: null });
      }
    });
  }

  _handleActiveSpeakerObserver() {
    this._activeSpeakerObserver.on('dominantspeaker', (dominantSpeaker) => {
      logger.debug('activeSpeakerObserver "dominantspeaker" event [producerId:%s]', dominantSpeaker.producer.id);
    });
  }
}

module.exports = Room;
