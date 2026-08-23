// =============================================================
// TIDEWRECK ISLAND - server/index.js
// Express static host + Socket.io signalling. Serves ./public as the
// web root and ../shared at /shared so the browser can import the very
// same constants.js the server runs on.
//
//   npm start   ->   http://localhost:3000
// =============================================================

import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { Server as SocketIOServer } from 'socket.io';

import { RoomManager } from './rooms.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const SHARED_DIR = path.join(ROOT_DIR, 'shared');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// ---------------- HTTP ----------------

const app = express();
app.disable('x-powered-by');

/** Everything here is regenerated on every edit — never let a browser cache it. */
function noCache(res, filePath) {
  res.setHeader('Cache-Control', 'no-cache');
  if (filePath.endsWith('.js') || filePath.endsWith('.mjs')) {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  }
}

// The shared game data module, importable from the browser as /shared/constants.js
app.use('/shared', express.static(SHARED_DIR, {
  index: false,
  etag: true,
  lastModified: true,
  maxAge: 0,
  setHeaders: noCache,
}));

// The game client itself.
app.use(express.static(PUBLIC_DIR, {
  index: 'index.html',
  etag: true,
  lastModified: true,
  maxAge: 0,
  setHeaders: noCache,
}));

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    ...rooms.stats(),
  });
});

// Single-page fallback: any other GET without a file extension gets index.html.
app.get('*', (req, res, next) => {
  if (req.method !== 'GET') return next();
  if (path.extname(req.path)) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'), (err) => {
    if (err) res.status(404).type('text/plain').send('Tidewreck Island: client not found.');
  });
});

// ---------------- Sockets ----------------

const server = createServer(app);

const io = new SocketIOServer(server, {
  serveClient: true,          // /socket.io/socket.io.js for the browser
  pingInterval: 20000,
  pingTimeout: 25000,
  maxHttpBufferSize: 1e6,
  cors: { origin: true, credentials: false },
});

const rooms = new RoomManager(io);

io.on('connection', (socket) => {
  rooms.handleConnection(socket);
});

io.engine.on('connection_error', (err) => {
  console.warn('[socket.io] connection error:', err && err.message ? err.message : err);
});

// ---------------- Boot ----------------

function lanAddresses() {
  const out = [];
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      const family = typeof net.family === 'string' ? net.family : (net.family === 4 ? 'IPv4' : 'IPv6');
      if (family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

server.listen(PORT, HOST, () => {
  const lines = [
    '',
    '  ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
    '   TIDEWRECK ISLAND  -  server up',
    '  ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
    `   local:   http://localhost:${PORT}`,
  ];
  for (const addr of lanAddresses()) lines.push(`   network: http://${addr}:${PORT}`);
  lines.push('   share the room code with your crew.', '');
  console.log(lines.join('\n'));
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Start with PORT=xxxx npm start.`);
    process.exit(1);
  }
  console.error('[http]', err);
});

function shutdown(signal) {
  console.log(`\n[server] ${signal} - closing down.`);
  io.close(() => { /* sockets flushed */ });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => console.error('[uncaught]', err));
process.on('unhandledRejection', (err) => console.error('[unhandled]', err));

export { app, server, io, rooms };
