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
  buffer: null, mimeType: null, fileName: null,
  isPlaying: false, isPaused: false,
  startServerTime: null, startOffset: 0, pausedAtOffset: 0,
};

// ws -> { id, name, role, joined, audioActivated, audioReady }
let clients = new Map();
let clientIdCounter = 1;

// ============================================================
// AUDIO ENDPOINTS
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
  audioState.isPlaying = false;
  audioState.isPaused = false;
  audioState.startServerTime = null;
  audioState.startOffset = 0;
  audioState.pausedAtOffset = 0;

  console.log('File loaded: ' + audioState.fileName + ' (' + (audioState.buffer.length/1024/1024).toFixed(2) + ' MB)');

  // Reset ALL listener ready states — new file means re-load required
  clients.forEach(c => {
    if (c.role === 'listener') {
      c.audioReady = false;
      // Keep audioActivated — they already tapped, just need to re-load file
    }
  });

  broadcast({ type: 'file_loaded', fileName: audioState.fileName, fileUrl: '/audio' });
  broadcastSession();
  res.json({ success: true, fileName: audioState.fileName, fileUrl: '/audio' });
});

// ============================================================
// WEBSOCKET
// ============================================================
wss.on('connection', (ws) => {
  const clientId = clientIdCounter++;
  clients.set(ws, { id: clientId, name: null, role: 'host', joined: false, audioActivated: false, audioReady: false });
  console.log('Client ' + clientId + ' connected. Total: ' + clients.size);

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

      case 'sync_ping':
        ws.send(JSON.stringify({ type: 'sync_pong', clientSendTime: msg.clientSendTime, serverTime: Date.now() }));
        break;

      case 'join':
        client.name = (msg.name || 'Unknown').slice(0, 20);
        client.role = msg.role === 'listener' ? 'listener' : 'host';
        client.joined = true;
        if (client.role === 'host') { client.audioActivated = true; client.audioReady = true; }
        console.log('Joined: ' + client.name + ' as ' + client.role);
        broadcastSession();
        break;

      case 'set_role':
        if (!client.joined) break;
        client.role = msg.role === 'listener' ? 'listener' : 'host';
        if (client.role === 'host') { client.audioActivated = true; client.audioReady = true; }
        else { client.audioActivated = false; client.audioReady = false; }
        broadcastSession();
        break;

      case 'listener_activated':
        client.audioActivated = true;
        broadcastSession();
        break;

      case 'listener_ready':
        client.audioReady = true;
        client.audioActivated = true;
        broadcastSession();
        break;

      case 'play':
        if (!client.joined || !audioState.buffer) break;
        const playAt = Date.now() + 3000;
        audioState.isPlaying = true;
        audioState.isPaused = false;
        audioState.startServerTime = playAt;
        audioState.startOffset = typeof msg.offset === 'number' ? msg.offset : 0;
        audioState.pausedAtOffset = 0;
        broadcast({ type: 'play', playAtServerTime: playAt, startOffset: audioState.startOffset });
        break;

      case 'pause':
        if (!client.joined) break;
        audioState.isPlaying = false;
        audioState.isPaused = true;
        audioState.pausedAtOffset = typeof msg.pausedAtOffset === 'number' ? msg.pausedAtOffset : 0;
        audioState.startServerTime = null;
        broadcast({ type: 'pause', pausedAtOffset: audioState.pausedAtOffset });
        break;

      case 'stop':
        if (!client.joined) break;
        audioState.isPlaying = false; audioState.isPaused = false;
        audioState.startServerTime = null; audioState.startOffset = 0; audioState.pausedAtOffset = 0;
        broadcast({ type: 'stop' });
        break;

      // Host kicks a device
      case 'kick':
        if (!client.joined || client.role !== 'host') break;
        const targetId = msg.clientId;
        let targetWs = null;
        clients.forEach((c, w) => { if (c.id === targetId) targetWs = w; });
        if (targetWs && targetWs !== ws) {
          targetWs.send(JSON.stringify({ type: 'kicked', reason: 'Removed by host' }));
          setTimeout(() => { try { targetWs.close(); } catch(e) {} }, 500);
          console.log('Client ' + targetId + ' kicked by host');
        }
        break;
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log('Client ' + clientId + ' disconnected. Total: ' + clients.size);
    broadcastSession();
  });
});

function sessionClients() {
  const list = [];
  clients.forEach(c => { if (c.joined) list.push(c); });
  return list;
}

function clientsPayload() {
  return sessionClients().map(c => ({ id: c.id, name: c.name, role: c.role, audioActivated: c.audioActivated, audioReady: c.audioReady }));
}

function broadcastSession() {
  broadcast({ type: 'session_updated', sessionCount: sessionClients().length, clients: clientsPayload() });
}

function broadcast(msg) {
  const str = JSON.stringify(msg);
  wss.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(str); });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('BandSync v1.3 running on port ' + PORT));
