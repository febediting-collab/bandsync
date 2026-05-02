const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const upload = multer({ dest: 'uploads/' });

app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// State
let state = {
  audioFile: null,
  audioFileName: null,
  isPlaying: false,
  startServerTime: null,
  startOffset: 0, // seconds into the track when play was pressed
};

let clients = new Map(); // ws -> { id, name, offset }
let clientIdCounter = 1;

// Upload endpoint
app.post('/upload', upload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });

  // Remove old file
  if (state.audioFile) {
    try { fs.unlinkSync(state.audioFile); } catch (e) {}
  }

  state.audioFile = req.file.path;
  state.audioFileName = req.file.originalname;
  state.isPlaying = false;
  state.startServerTime = null;

  // Notify all clients
  broadcast({
    type: 'file_loaded',
    fileName: state.audioFileName,
    fileUrl: '/' + req.file.path,
  });

  res.json({ success: true, fileName: state.audioFileName, fileUrl: '/' + req.file.path });
});

// WebSocket
wss.on('connection', (ws) => {
  const clientId = clientIdCounter++;
  clients.set(ws, { id: clientId, name: `Device ${clientId}`, clockOffset: 0 });

  console.log(`Client ${clientId} connected. Total: ${clients.size}`);

  // Send current state to new client
  ws.send(JSON.stringify({
    type: 'init',
    clientId,
    clientCount: clients.size,
    audioFile: state.audioFile ? {
      fileName: state.audioFileName,
      fileUrl: '/uploads/' + path.basename(state.audioFile),
    } : null,
    isPlaying: state.isPlaying,
    startServerTime: state.startServerTime,
    startOffset: state.startOffset,
  }));

  // Notify others
  broadcastExcept(ws, {
    type: 'client_joined',
    clientCount: clients.size,
    clientId,
  });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }

    switch (msg.type) {

      // NTP clock sync - client sends their local time, we reply with server time
      case 'sync_ping': {
        ws.send(JSON.stringify({
          type: 'sync_pong',
          clientSendTime: msg.clientSendTime,
          serverTime: Date.now(),
        }));
        break;
      }

      case 'set_name': {
        const info = clients.get(ws);
        if (info) {
          info.name = msg.name.slice(0, 20);
          broadcastClientList();
        }
        break;
      }

      case 'play': {
        if (!state.audioFile) break;
        // Schedule play 2 seconds from now so all clients have time to prepare
        const playAt = Date.now() + 2000;
        state.isPlaying = true;
        state.startServerTime = playAt;
        state.startOffset = msg.offset || 0;

        broadcast({
          type: 'play',
          playAtServerTime: playAt,
          startOffset: state.startOffset,
        });
        break;
      }

      case 'stop': {
        state.isPlaying = false;
        state.startServerTime = null;
        broadcast({ type: 'stop' });
        break;
      }

      case 'seek': {
        if (!state.audioFile) break;
        const seekPlayAt = Date.now() + 2000;
        state.startServerTime = seekPlayAt;
        state.startOffset = msg.offset || 0;
        if (state.isPlaying) {
          broadcast({
            type: 'play',
            playAtServerTime: seekPlayAt,
            startOffset: state.startOffset,
          });
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`Client ${clientId} disconnected. Total: ${clients.size}`);
    broadcastExcept(ws, {
      type: 'client_left',
      clientCount: clients.size,
      clientId,
    });
  });
});

function broadcast(msg) {
  const str = JSON.stringify(msg);
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(str);
  });
}

function broadcastExcept(except, msg) {
  const str = JSON.stringify(msg);
  wss.clients.forEach(ws => {
    if (ws !== except && ws.readyState === WebSocket.OPEN) ws.send(str);
  });
}

function broadcastClientList() {
  const list = [];
  clients.forEach((info) => list.push({ id: info.id, name: info.name }));
  broadcast({ type: 'client_list', clients: list });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`BandSync running on port ${PORT}`));
