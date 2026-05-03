const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.static('public'));

// ============================================================
// SERVER STATE
// ============================================================
let audioState = {
  buffer: null,
  mimeType: null,
  fileName: null,
  fileUrl: null,
  isPlaying: false,
  isPaused: false,
  startServerTime: null,   // server ms timestamp when play was scheduled
  startOffset: 0,          // seconds into track at play time
  pausedAtOffset: 0,
};

// clients map: ws -> { id, name, role, joined, audioActivated, audioReady }
let clients = new Map();
let clientIdCounter = 1;

// ============================================================
// AUDIO ENDPOINT
// ============================================================
app.get('/audio', (req, res) => {
  if (!audioState.buffer) return res.status(404).send('No audio loaded');
  res.set('Content-Type', audioState.mimeType || 'audio/mpeg');
  res.set('Content-Length', audioState.buffer.length);
  res.set('Cache-Control', 'no-cache');
  res.send(audioState.buffer);
});

app.post('/upload', upload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });

  audioState.buffer = req.file.buffer;
  audioState.mimeType = req.file.mimetype;
  audioState.fileName = req.file.originalname;
  audioState.fileUrl = '/audio';
  audioState.isPlaying = false;
  audioState.isPaused = false;
  audioState.startServerTime = null;
  audioState.startOffset = 0;
  audioState.pausedAtOffset = 0;

  console.log('File loaded: ' + audioState.fileName + ' (' + (audioState.buffer.length / 1024 / 1024).toFixed(2) + ' MB)');

  // Reset all listener ready states
  clients.forEach(c => { c.audioActivated = false; c.audioReady = false; });

  broadcast({ type: 'file_loaded', fileName: audioState.fileName, fileUrl: '/audio' });
  broadcastSession();
  res.json({ success: true, fileName: audioState.fileName, fileUrl: '/audio' });
});

// ============================================================
// WEBSOCKET
// ============================================================
wss.on('connection', (ws) => {
  const clientId = clientIdCounter++;
  clients.set(ws, {
    id: clientId,
    name: null,
    role: 'listener',
    joined: false,
    audioActivated: false,
    audioReady: false,
  });

  console.log('Client ' + clientId + ' connected. Total: ' + clients.size);

  // Send initial state — client not yet in session
  ws.send(JSON.stringify({
    type: 'init',
    clientId,
    sessionCount: sessionClients().length,
    audioFile: audioState.buffer ? { fileName: audioState.fileName, fileUrl: '/audio' } : null,
    isPlaying: audioState.isPlaying,
    isPaused: audioState.isPaused,
    startServerTime: audioState.startServerTime,
    startOffset: audioState.startOffset,
    pausedAtOffset: audioState.pausedAtOffset,
  }));

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch(e) { return; }
    const client = clients.get(ws);
    if (!client) return;

    switch (msg.type) {

      // Clock sync
      case 'sync_ping':
        ws.send(JSON.stringify({ type: 'sync_pong', clientSendTime: msg.clientSendTime, serverTime: Date.now() }));
        break;

      // Join session gate
      case 'join':
        client.name = (msg.name || 'Unknown').slice(0, 20);
        client.role = msg.role || 'host'; // use role sent by client
        client.joined = true;
        if (client.role === 'host') { client.audioActivated = true; client.audioReady = true; }
        console.log('Client ' + clientId + ' joined as: ' + client.name + ' role: ' + client.role);
        broadcastSession();
        break;

      // Role switch
      case 'set_role':
        if (!client.joined) break;
        client.role = msg.role === 'host' ? 'host' : 'listener';
        if (client.role === 'host') {
          client.audioActivated = true;
          client.audioReady = true;
        }
        broadcastSession();
        break;

      // Listener audio states
      case 'listener_activated':
        client.audioActivated = true;
        broadcastSession();
        break;

      case 'listener_ready':
        client.audioReady = true;
        client.audioActivated = true;
        broadcastSession();
        break;

      // Play
      case 'play':
        if (!client.joined || !audioState.buffer) break;
        const playAt = Date.now() + 3000; // 3s lead time
        audioState.isPlaying = true;
        audioState.isPaused = false;
        audioState.startServerTime = playAt;
        audioState.startOffset = typeof msg.offset === 'number' ? msg.offset : 0;
        audioState.pausedAtOffset = 0;
        broadcast({ type: 'play', playAtServerTime: playAt, startOffset: audioState.startOffset });
        break;

      // Pause
      case 'pause':
        if (!client.joined) break;
        audioState.isPlaying = false;
        audioState.isPaused = true;
        audioState.pausedAtOffset = typeof msg.pausedAtOffset === 'number' ? msg.pausedAtOffset : 0;
        audioState.startServerTime = null;
        broadcast({ type: 'pause', pausedAtOffset: audioState.pausedAtOffset });
        break;

      // Stop
      case 'stop':
        if (!client.joined) break;
        audioState.isPlaying = false;
        audioState.isPaused = false;
        audioState.startServerTime = null;
        audioState.startOffset = 0;
        audioState.pausedAtOffset = 0;
        broadcast({ type: 'stop' });
        break;
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log('Client ' + clientId + ' disconnected. Total: ' + clients.size);
    broadcastSession();
  });
});

// ============================================================
// HELPERS
// ============================================================
function sessionClients() {
  // Only joined clients
  const list = [];
  clients.forEach(c => { if (c.joined) list.push(c); });
  return list;
}

function clientsPayload() {
  return sessionClients().map(c => ({
    id: c.id,
    name: c.name,
    role: c.role,
    audioActivated: c.audioActivated,
    audioReady: c.audioReady,
  }));
}

function broadcastSession() {
  const payload = {
    type: 'session_updated',
    sessionCount: sessionClients().length,
    clients: clientsPayload(),
  };
  broadcast(payload);
}

function broadcast(msg) {
  const str = JSON.stringify(msg);
  wss.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(str); });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('BandSync v1.2 running on port ' + PORT));
