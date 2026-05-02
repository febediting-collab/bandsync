const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Store file in MEMORY — no filesystem needed
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.static('public'));

// State
let state = {
  audioBuffer: null,
  audioMimeType: null,
  audioFileName: null,
  isPlaying: false,
  startServerTime: null,
  startOffset: 0,
};

let clients = new Map();
let clientIdCounter = 1;

// Serve audio from memory
app.get('/audio', (req, res) => {
  if (!state.audioBuffer) return res.status(404).send('No audio loaded');
  res.set('Content-Type', state.audioMimeType || 'audio/mpeg');
  res.set('Content-Length', state.audioBuffer.length);
  res.set('Accept-Ranges', 'bytes');
  res.set('Cache-Control', 'no-cache');
  res.send(state.audioBuffer);
});

// Upload endpoint
app.post('/upload', upload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });

  state.audioBuffer = req.file.buffer;
  state.audioMimeType = req.file.mimetype;
  state.audioFileName = req.file.originalname;
  state.isPlaying = false;
  state.startServerTime = null;

  console.log('File loaded: ' + state.audioFileName + ' (' + (state.audioBuffer.length/1024/1024).toFixed(2) + ' MB)');

  broadcast({ type: 'file_loaded', fileName: state.audioFileName, fileUrl: '/audio' });
  res.json({ success: true, fileName: state.audioFileName, fileUrl: '/audio' });
});

// WebSocket
wss.on('connection', (ws) => {
  const clientId = clientIdCounter++;
  clients.set(ws, { id: clientId, name: 'Device ' + clientId });
  console.log('Client ' + clientId + ' connected. Total: ' + clients.size);

  ws.send(JSON.stringify({
    type: 'init',
    clientId,
    clientCount: clients.size,
    audioFile: state.audioBuffer ? { fileName: state.audioFileName, fileUrl: '/audio' } : null,
    isPlaying: state.isPlaying,
    startServerTime: state.startServerTime,
    startOffset: state.startOffset,
  }));

  broadcastExcept(ws, { type: 'client_joined', clientCount: clients.size, clientId });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }

    switch (msg.type) {
      case 'sync_ping':
        ws.send(JSON.stringify({ type: 'sync_pong', clientSendTime: msg.clientSendTime, serverTime: Date.now() }));
        break;

      case 'set_name':
        const info = clients.get(ws);
        if (info) { info.name = msg.name.slice(0, 20); broadcastClientList(); }
        break;

      case 'play':
        if (!state.audioBuffer) break;
        const playAt = Date.now() + 3000;
        state.isPlaying = true;
        state.startServerTime = playAt;
        state.startOffset = msg.offset || 0;
        broadcast({ type: 'play', playAtServerTime: playAt, startOffset: state.startOffset });
        break;

      case 'stop':
        state.isPlaying = false;
        state.startServerTime = null;
        broadcast({ type: 'stop' });
        break;

      case 'seek':
        if (!state.audioBuffer) break;
        const seekAt = Date.now() + 3000;
        state.startServerTime = seekAt;
        state.startOffset = msg.offset || 0;
        if (state.isPlaying) broadcast({ type: 'play', playAtServerTime: seekAt, startOffset: state.startOffset });
        break;
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log('Client ' + clientId + ' disconnected. Total: ' + clients.size);
    broadcastExcept(ws, { type: 'client_left', clientCount: clients.size, clientId });
  });
});

function broadcast(msg) {
  const str = JSON.stringify(msg);
  wss.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(str); });
}

function broadcastExcept(except, msg) {
  const str = JSON.stringify(msg);
  wss.clients.forEach(ws => { if (ws !== except && ws.readyState === WebSocket.OPEN) ws.send(str); });
}

function broadcastClientList() {
  const list = [];
  clients.forEach((info) => list.push({ id: info.id, name: info.name }));
  broadcast({ type: 'client_list', clients: list });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('BandSync running on port ' + PORT));
