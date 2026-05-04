const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const upload = multer({ storage: multer.memoryStorage() });

const publicDir = path.join(__dirname, 'public');
const publicIndex = path.join(publicDir, 'index.html');
const rootIndex = path.join(__dirname, 'index.html');

app.use(express.static(publicDir));

app.get('/', (req, res) => {
  const indexPath = fs.existsSync(publicIndex) ? publicIndex : rootIndex;
  res.sendFile(indexPath);
});

const PLAY_LEAD_MS = 3000;

// ============================================================
// SERVER STATE
// ============================================================
let audioState = {
  buffer: null,
  mimeType: null,
  fileName: null,
  revision: 0,
  commandSeq: 0,
  isPlaying: false,
  isPaused: false,
  startServerTime: null,
  startOffset: 0,
  pausedAtOffset: 0,
};

// ws -> { id, token, name, role, joined, audioActivated, audioReady }
const clients = new Map();
let clientIdCounter = 1;
let hostClientId = null;

// ============================================================
// AUTH / SESSION HELPERS
// ============================================================
function makeToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function sessionClients() {
  const list = [];
  clients.forEach(c => { if (c.joined) list.push(c); });
  return list;
}

function getClientById(id) {
  for (const [ws, client] of clients.entries()) {
    if (client.id === id) return { ws, client };
  }
  return null;
}

function getClientByToken(token) {
  if (!token) return null;
  for (const [ws, client] of clients.entries()) {
    if (client.token === token) return { ws, client };
  }
  return null;
}

function isHost(client) {
  return !!client && client.joined && client.id === hostClientId && client.role === 'host';
}

function hasLiveHost() {
  const found = getClientById(hostClientId);
  return !!found && isHost(found.client);
}

function assignRole(client, requestedRole) {
  const wantsHost = requestedRole === 'host';
  const canBecomeHost = wantsHost && (!hasLiveHost() || hostClientId === client.id);

  if (canBecomeHost) {
    hostClientId = client.id;
    client.role = 'host';
    client.audioActivated = true;
    client.audioReady = true;
    return;
  }

  if (hostClientId === client.id) hostClientId = null;
  client.role = 'listener';
  client.audioActivated = false;
  client.audioReady = false;
}

function sendRole(ws, client) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    type: 'role_assigned',
    role: client.role,
    canControl: isHost(client),
    hostClientId,
  }));
}

function audioFilePayload() {
  return audioState.buffer
    ? { fileName: audioState.fileName, fileUrl: `/audio?v=${audioState.revision}`, revision: audioState.revision }
    : null;
}

function resetPlaybackState() {
  audioState.isPlaying = false;
  audioState.isPaused = false;
  audioState.startServerTime = null;
  audioState.startOffset = 0;
  audioState.pausedAtOffset = 0;
}

function nextCommandSeq() {
  audioState.commandSeq++;
  return audioState.commandSeq;
}

function playbackSnapshot() {
  return {
    type: 'state_snapshot',
    commandSeq: audioState.commandSeq,
    audioFile: audioFilePayload(),
    isPlaying: audioState.isPlaying,
    isPaused: audioState.isPaused,
    startServerTime: audioState.startServerTime,
    startOffset: audioState.startOffset,
    pausedAtOffset: audioState.pausedAtOffset,
    serverTime: Date.now(),
  };
}

function resetListenerReadyState() {
  clients.forEach(c => {
    if (c.role === 'listener') c.audioReady = false;
  });
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
  broadcast({
    type: 'session_updated',
    sessionCount: sessionClients().length,
    clients: clientsPayload(),
    hostClientId,
  });
}

function broadcast(msg) {
  const str = JSON.stringify(msg);
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(str);
  });
}

function clampOffset(offset) {
  if (typeof offset !== 'number' || !Number.isFinite(offset)) return 0;
  return Math.max(0, offset);
}

// ============================================================
// AUDIO ENDPOINTS
// ============================================================
app.get('/audio', (req, res) => {
  if (!audioState.buffer) return res.status(404).send('No audio loaded');

  const total = audioState.buffer.length;
  res.set('Accept-Ranges', 'bytes');
  res.set('Cache-Control', 'private, max-age=3600');
  res.set('Content-Type', audioState.mimeType || 'audio/mpeg');

  const range = req.headers.range;
  if (!range) {
    res.set('Content-Length', total);
    return res.send(audioState.buffer);
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    res.set('Content-Range', `bytes */${total}`);
    return res.status(416).end();
  }

  const start = match[1] ? parseInt(match[1], 10) : 0;
  const end = match[2] ? parseInt(match[2], 10) : total - 1;
  if (start >= total || end >= total || start > end) {
    res.set('Content-Range', `bytes */${total}`);
    return res.status(416).end();
  }

  res.status(206);
  res.set('Content-Range', `bytes ${start}-${end}/${total}`);
  res.set('Content-Length', end - start + 1);
  res.send(audioState.buffer.subarray(start, end + 1));
});

app.post('/upload', upload.single('audio'), (req, res) => {
  const requester = getClientByToken(req.get('x-bandsync-client'));
  if (!requester || !isHost(requester.client)) {
    return res.status(403).json({ success: false, error: 'Only the host can upload audio.' });
  }
  if (!req.file) return res.status(400).json({ success: false, error: 'No file' });

  audioState.buffer = req.file.buffer;
  audioState.mimeType = req.file.mimetype;
  audioState.fileName = req.file.originalname;
  audioState.revision++;
  nextCommandSeq();
  resetPlaybackState();
  resetListenerReadyState();

  console.log('File loaded by host ' + requester.client.id + ': ' + audioState.fileName + ' (' + (audioState.buffer.length / 1024 / 1024).toFixed(2) + ' MB)');

  broadcast({ type: 'file_loaded', commandSeq: audioState.commandSeq, ...audioFilePayload() });
  broadcastSession();
  res.json({ success: true, ...audioFilePayload() });
});

// ============================================================
// WEBSOCKET
// ============================================================
wss.on('connection', (ws) => {
  const clientId = clientIdCounter++;
  const client = {
    id: clientId,
    token: makeToken(),
    name: null,
    role: 'listener',
    joined: false,
    audioActivated: false,
    audioReady: false,
  };

  clients.set(ws, client);
  console.log('Client ' + clientId + ' connected. Total: ' + clients.size);

  ws.send(JSON.stringify({
    type: 'init',
    clientId,
    uploadToken: client.token,
    sessionCount: sessionClients().length,
    hostClientId,
    commandSeq: audioState.commandSeq,
    audioFile: audioFilePayload(),
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

      case 'state_ping':
        ws.send(JSON.stringify(playbackSnapshot()));
        break;

      case 'join':
        client.name = (msg.name || 'Unknown').slice(0, 20);
        client.joined = true;
        assignRole(client, msg.role === 'host' ? 'host' : 'listener');
        console.log('Joined: ' + client.name + ' as ' + client.role + (isHost(client) ? ' (authority)' : ''));
        sendRole(ws, client);
        broadcastSession();
        break;

      case 'set_role':
        if (!client.joined) break;
        assignRole(client, msg.role === 'host' ? 'host' : 'listener');
        console.log('Role request from client ' + client.id + ': ' + msg.role + ' -> ' + client.role);
        sendRole(ws, client);
        broadcastSession();
        break;

      case 'listener_activated':
        if (!client.joined || client.role !== 'listener') break;
        client.audioActivated = true;
        broadcastSession();
        break;

      case 'listener_ready':
        if (!client.joined || client.role !== 'listener') break;
        client.audioReady = true;
        client.audioActivated = true;
        broadcastSession();
        break;

      case 'play':
        if (!isHost(client) || !audioState.buffer) break;
        nextCommandSeq();
        audioState.isPlaying = true;
        audioState.isPaused = false;
        audioState.startServerTime = Date.now() + PLAY_LEAD_MS;
        audioState.startOffset = clampOffset(msg.offset);
        audioState.pausedAtOffset = 0;
        broadcast({
          type: 'play',
          commandSeq: audioState.commandSeq,
          playAtServerTime: audioState.startServerTime,
          startOffset: audioState.startOffset,
          revision: audioState.revision,
        });
        break;

      case 'pause':
        if (!isHost(client)) break;
        nextCommandSeq();
        audioState.isPlaying = false;
        audioState.isPaused = true;
        audioState.pausedAtOffset = clampOffset(msg.pausedAtOffset);
        audioState.startServerTime = null;
        broadcast({ type: 'pause', commandSeq: audioState.commandSeq, pausedAtOffset: audioState.pausedAtOffset, revision: audioState.revision });
        break;

      case 'stop':
        if (!isHost(client)) break;
        nextCommandSeq();
        resetPlaybackState();
        broadcast({ type: 'stop', commandSeq: audioState.commandSeq, revision: audioState.revision });
        break;

      case 'clear_audio':
        if (!isHost(client)) break;
        nextCommandSeq();
        audioState.buffer = null;
        audioState.mimeType = null;
        audioState.fileName = null;
        audioState.revision++;
        resetPlaybackState();
        resetListenerReadyState();
        broadcast({ type: 'audio_cleared', commandSeq: audioState.commandSeq, revision: audioState.revision });
        broadcastSession();
        break;

      case 'kick':
        if (!isHost(client)) break;
        const targetId = msg.clientId;
        const target = getClientById(targetId);
        if (target && target.ws !== ws) {
          target.ws.send(JSON.stringify({ type: 'kicked', reason: 'Removed by host' }));
          setTimeout(() => { try { target.ws.close(); } catch(e) {} }, 100);
          console.log('Client ' + targetId + ' kicked by host ' + client.id);
        }
        break;
    }
  });

  ws.on('close', () => {
    const closing = clients.get(ws);
    clients.delete(ws);
    if (closing && closing.id === hostClientId) hostClientId = null;
    console.log('Client ' + clientId + ' disconnected. Total: ' + clients.size);
    broadcastSession();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('BandSync v1.4 playback-control running on port ' + PORT));
