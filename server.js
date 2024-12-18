#!/usr/bin/env node

process.title = 'mediasoup-demo-server';
process.env.DEBUG = process.env.DEBUG || '*INFO* *WARN* *ERROR*';

const config = require('./config');

/* eslint-disable no-console */
console.log('process.env.DEBUG:', process.env.DEBUG);
console.log('config.js:\n%s', JSON.stringify(config, null, '  '));
/* eslint-enable no-console */

const fs = require('fs');
const https = require('https');
const url = require('url');
const mediasoup = require('mediasoup');
const express = require('express');
const bodyParser = require('body-parser');
const { Server } = require('socket.io');
const { AwaitQueue } = require('awaitqueue');
const Logger = require('./lib/Logger');
const utils = require('./lib/utils');
const Room = require('./lib/Room');
const interactiveServer = require('./lib/interactiveServer');
const interactiveClient = require('./lib/interactiveClient');

const logger = new Logger();

// Async queue to manage rooms.
// @type {AwaitQueue}
const queue = new AwaitQueue();

// Map of Room instances indexed by roomId.
// @type {Map<Number, Room>}
const rooms = new Map();

// HTTPS server.
// @type {https.Server}
let httpsServer;

// Express application.
// @type {Function}
let expressApp;
let io;

// mediasoup Workers.
// @type {Array<mediasoup.Worker>}
const mediasoupWorkers = [];

// Index of next mediasoup Worker to use.
// @type {Number}
let nextMediasoupWorkerIdx = 0;

run();

async function run() {
  // Open the interactive server.
  await interactiveServer();

  // Open the interactive client.
  if (process.env.INTERACTIVE === 'true' || process.env.INTERACTIVE === '1')
    await interactiveClient();

  // Run a mediasoup Worker.
  await runMediasoupWorkers();

  // Create Express app.
  await createExpressApp();

  // Run HTTPS server.
  await runHttpsServer();

  // Log rooms status every X seconds.
  setInterval(() => {
    for (const room of rooms.values()) {
      room.logStatus();
    }
  }, 120000);
}

/**
 * Launch as many mediasoup Workers as given in the configuration file.
 */
async function runMediasoupWorkers() {
  const { numWorkers } = config.mediasoup;

  logger.info('running %d mediasoup Workers...', numWorkers);

  for (let i = 0; i < numWorkers; ++i) {
    const worker = await mediasoup.createWorker({
      dtlsCertificateFile: config.mediasoup.workerSettings.dtlsCertificateFile,
      dtlsPrivateKeyFile: config.mediasoup.workerSettings.dtlsPrivateKeyFile,
      logLevel: config.mediasoup.workerSettings.logLevel,
      logTags: config.mediasoup.workerSettings.logTags,
      rtcMinPort: Number(config.mediasoup.workerSettings.rtcMinPort),
      rtcMaxPort: Number(config.mediasoup.workerSettings.rtcMaxPort),
      disableLiburing: Boolean(config.mediasoup.workerSettings.disableLiburing)
    });

    worker.on('died', () => {
      logger.error('mediasoup Worker died, exiting in 2 seconds... [pid:%d]', worker.pid);

      setTimeout(() => process.exit(1), 2000);
    });

    mediasoupWorkers.push(worker);

    // Create a WebRtcServer in this Worker.
    if (process.env.MEDIASOUP_USE_WEBRTC_SERVER !== 'false') {
      const webRtcServerOptions = utils.clone(config.mediasoup.webRtcServerOptions);
      const portIncrement = mediasoupWorkers.length - 1;

      for (const listenInfo of webRtcServerOptions.listenInfos) {
        listenInfo.port += portIncrement;
      }

      const webRtcServer = await worker.createWebRtcServer(webRtcServerOptions);

      worker.appData.webRtcServer = webRtcServer;
    }

    // Log worker resource usage every X seconds.
    setInterval(async () => {
      const usage = await worker.getResourceUsage();

      logger.info('mediasoup Worker resource usage [pid:%d]: %o', worker.pid, usage);

      const dump = await worker.dump();

      logger.info('mediasoup Worker dump [pid:%d]: %o', worker.pid, dump);
    }, 120000);
  }
}

/**
 * Create an Express based API server to manage Broadcaster requests.
 */
async function createExpressApp() {
  logger.info('creating Express app...');

  expressApp = express();

  expressApp.use(bodyParser.json());

  /**
   * POST API to create a new room.
   */
  expressApp.post('/rooms/create/:roomId', async (req, res, next) => {
    const { roomId } = req.params;

    try {
      if (rooms.has(roomId)) {
        throw new Error(`Room with id "${roomId}" already exists`);
      }

      const mediasoupWorker = getMediasoupWorker();
      const room = await Room.create({ mediasoupWorker, roomId, consumerReplicas: 0 });

      rooms.set(roomId, room);
      room.on('close', () => rooms.delete(roomId));

      res.status(200).json({ roomId });
    } catch (error) {
      logger.error('Room creation failed:%o', error);
      next(error);
    }
  });

  /**
   * For every API request, verify that the roomId in the path matches an existing room.
   */
  expressApp.param('roomId', (req, res, next, roomId) => {
    const room = rooms.get(roomId);

    if (!room) {
      const error = new Error(`Room with id "${roomId}" does not exist`);
      error.status = 404;
      return next(error);
    }

    req.room = room;
    next();
  });

  /**
     * API GET resource that returns the mediasoup Router RTP capabilities of
     * the room.
     */
  expressApp.get(
    '/rooms/:roomId', (req, res) =>
    {
    const data = req.room.getRouterRtpCapabilities();

    res.status(200).json(data);
  });

  /**
   * POST API to create a Broadcaster.
   */
  expressApp.post(
    '/rooms/:roomId/broadcasters', async (req, res, next) =>
    {
      const {
        id,
        displayName,
        device,
        rtpCapabilities
      } = req.body;

      try
      {
        const data = await req.room.createBroadcaster(
          {
            id,
            displayName,
            device,
            rtpCapabilities
          });

      res.status(200).json(data);
      }
      catch (error)
      {
      next(error);
    }
  });

  /**
   * DELETE API to delete a Broadcaster.
   */
  expressApp.delete(
    '/rooms/:roomId/broadcasters/:broadcasterId', (req, res) =>
    {
    const { broadcasterId } = req.params;

    req.room.deleteBroadcaster({ broadcasterId });

    res.status(200).send('broadcaster deleted');
  });

  /**
   * POST API to create a mediasoup Transport associated to a Broadcaster.
   * It can be a PlainTransport or a WebRtcTransport depending on the
   * type parameters in the body. There are also additional parameters for
   * PlainTransport.
   */
  expressApp.post(
    '/rooms/:roomId/broadcasters/:broadcasterId/transports',
    async (req, res, next) =>
    {
      const { broadcasterId } = req.params;
      const { type, rtcpMux, comedia, sctpCapabilities } = req.body;

      try
      {
        const data = await req.room.createBroadcasterTransport(
          {
            broadcasterId,
            type,
            rtcpMux,
            comedia, 
            sctpCapabilities
          });

        res.status(200).json(data);
      }
      catch (error)
      {
        next(error);
      }
    });

  /**
   * POST API to connect a Transport belonging to a Broadcaster. Not needed
   * for PlainTransport if it was created with comedia option set to true.
   */
  expressApp.post(
    '/rooms/:roomId/broadcasters/:broadcasterId/transports/:transportId/connect',
    async (req, res, next) =>
    {
      const { broadcasterId, transportId } = req.params;
      const { dtlsParameters } = req.body;

      try
      {
        const data = await req.room.connectBroadcasterTransport(
          {
            broadcasterId,
            transportId,
            dtlsParameters
          });

        res.status(200).json(data);
      }
      catch (error)
      {
        next(error);
      }
    });

  /**
   * POST API to create a mediasoup Producer associated to a Broadcaster.
   * The exact Transport in which the Producer must be created is signaled in
   * the URL path. Body parameters include kind and rtpParameters of the
   * Producer.
   */
  expressApp.post(
    '/rooms/:roomId/broadcasters/:broadcasterId/transports/:transportId/producers',
    async (req, res, next) =>
    {
      const { broadcasterId, transportId } = req.params;
      const { kind, rtpParameters } = req.body;

      try
      {
        const data = await req.room.createBroadcasterProducer(
          {
            broadcasterId,
            transportId,
            kind,
            rtpParameters
          });

        res.status(200).json(data);
      }
      catch (error)
      {
        next(error);
      }
    });

  /**
   * POST API to create a mediasoup Consumer associated to a Broadcaster.
   * The exact Transport in which the Consumer must be created is signaled in
   * the URL path. Query parameters must include the desired producerId to
   * consume.
   */
  expressApp.post(
    '/rooms/:roomId/broadcasters/:broadcasterId/transports/:transportId/consume',
    async (req, res, next) =>
    {
      const { broadcasterId, transportId } = req.params;
      const { producerId } = req.query;

      try
      {
        const data = await req.room.createBroadcasterConsumer(
          {
            broadcasterId,
            transportId,
            producerId
          });

        res.status(200).json(data);
      }
      catch (error)
      {
        next(error);
      }
    });

  /**
   * POST API to create a mediasoup DataConsumer associated to a Broadcaster.
   * The exact Transport in which the DataConsumer must be created is signaled in
   * the URL path. Query body must include the desired producerId to
   * consume.
   */
  expressApp.post(
    '/rooms/:roomId/broadcasters/:broadcasterId/transports/:transportId/consume/data',
    async (req, res, next) =>
    {
      const { broadcasterId, transportId } = req.params;
      const { dataProducerId } = req.body;

      try
      {
        const data = await req.room.createBroadcasterDataConsumer(
          {
            broadcasterId,
            transportId,
            dataProducerId
          });

        res.status(200).json(data);
      }
      catch (error)
      {
        next(error);
      }
    });

  /**
   * POST API to create a mediasoup DataProducer associated to a Broadcaster.
   * The exact Transport in which the DataProducer must be created is signaled in
   */
  expressApp.post(
    '/rooms/:roomId/broadcasters/:broadcasterId/transports/:transportId/produce/data',
    async (req, res, next) =>
    {
      const { broadcasterId, transportId } = req.params;
      const { label, protocol, sctpStreamParameters, appData } = req.body;

      try
      {
        const data = await req.room.createBroadcasterDataProducer(
          {
            broadcasterId,
            transportId,
            label,
            protocol,
            sctpStreamParameters,
            appData
          });

        res.status(200).json(data);
      }
      catch (error)
      {
        next(error);
      }
    });

  /**
	 * Error handler.
	 */
	expressApp.use(
		(error, req, res, next) =>
		{
			if (error)
			{
      logger.warn('Express app %s', String(error));

      error.status = error.status || (error.name === 'TypeError' ? 400 : 500);

      res.statusMessage = error.message;
      res.status(error.status).send(String(error));
			}
			else
			{
      next();
    }
  });
}

/**
 * Create a Node.js HTTPS server. It listens in the IP and port given in the
 * configuration file and reuses the Express application as request listener.
 */
async function runHttpsServer() {
  logger.info('running an HTTPS server...');

  const tls = {
    cert: fs.readFileSync(config.https.tls.cert),
    key: fs.readFileSync(config.https.tls.key)
  };

  httpsServer = https.createServer(tls, expressApp);

  await new Promise((resolve) => {
    httpsServer.listen(Number(config.https.listenPort), config.https.listenIp, resolve);
  });
}

/**
 * Get next mediasoup Worker.
 */
function getMediasoupWorker() {
  const worker = mediasoupWorkers[nextMediasoupWorkerIdx];

  if (++nextMediasoupWorkerIdx === mediasoupWorkers.length) nextMediasoupWorkerIdx = 0;

  return worker;
}

async function runSocketIoServer() {
  logger.info('running Socket.IO server...');
  io = new Server(httpsServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    }
  });

  io.on('connection', (socket) => {
    logger.info('new socket.io connection [id:%s]', socket.id);

    socket.on('joinRoom', async ({ roomId, peerId }) => {
      try {
        const room = rooms.get(roomId);

        if (!room) {
          socket.emit('error', 'Room does not exist');
          return;
        }

        room.handleSocketIoConnection({ peerId, socket });
      } catch (error) {
        logger.error('Room joining failed:%o', error);
        socket.emit('error', 'Room joining failed');
      }
    });
  });
}
