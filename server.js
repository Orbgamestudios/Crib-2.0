import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { Game } from './lib/game.js?v=3';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

const rooms = new Map(); // id -> room
let nextRoomId = 1;

function normalizeMode(mode) {
  if (mode === 'board') return 'board';
  if (mode === 'endless') return 'endless';
  return 'blind';
}

function makeRoom(name, opts = {}) {
  const mode = normalizeMode(opts.mode);
  const room = {
    id: 'r' + (nextRoomId++),
    name: (name || 'Cribbage Table').slice(0, 30),
    mode,
    goalScore: mode === 'board' ? 121 : null,
    deckEffects: opts.deckEffects !== false,
    players: [], // { id, name, ws, connected }
    game: null,
    logs: [],
  };
  rooms.set(room.id, room);
  return room;
}

function roomSummary(room) {
  return {
    id: room.id, name: room.name,
    players: room.players.map(p => p.name),
    count: room.players.filter(p => p.connected).length,
    mode: room.mode,
    goalScore: room.goalScore,
    deckEffects: room.deckEffects,
    inGame: !!room.game && room.game.phase !== 'gameover',
  };
}

function openRooms() {
  return [...rooms.values()]
    .filter(r => !r.game || r.game.phase === 'gameover')
    .filter(r => r.players.length < 6)
    .map(roomSummary);
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcastRooms() {
  const list = openRooms();
  for (const ws of wss.clients) {
    if (ws.readyState === 1 && !ws.meta.roomId) send(ws, { t: 'rooms', rooms: list });
  }
}

function broadcastRoom(room) {
  for (const p of room.players) {
    if (!p.connected) continue;
    if (room.game) {
      send(p.ws, { t: 'state', room: roomSummary(room), state: room.game.stateFor(p.id) });
    } else {
      send(p.ws, {
        t: 'roomUpdate',
        room: roomSummary(room),
        hostId: room.players[0] && room.players[0].id,
        youId: p.id,
        players: room.players.map(pl => ({ id: pl.id, name: pl.name, connected: pl.connected, deckArt: pl.deckArt })),
      });
    }
  }
}

function roomLog(room, text) {
  room.logs.push(text);
  if (room.logs.length > 60) room.logs.shift();
  for (const p of room.players) {
    if (p.connected) send(p.ws, { t: 'log', text });
  }
}

function startGame(room, opts = {}) {
  if (opts.mode) {
    room.mode = normalizeMode(opts.mode);
    room.goalScore = room.mode === 'board' ? 121 : null;
  }
  if (typeof opts.deckEffects === 'boolean') room.deckEffects = opts.deckEffects;
  room.game = new Game(
    room.players.map(p => ({ id: p.id, name: p.name, connected: p.connected, deckArt: p.deckArt })),
    {
      onUpdate: () => broadcastRoom(room),
      log: text => roomLog(room, text),
    },
    { mode: room.mode, goalScore: room.goalScore, deckEffects: room.deckEffects }
  );
  broadcastRoom(room);
  broadcastRooms();
}

function leaveRoom(ws) {
  const room = rooms.get(ws.meta.roomId);
  ws.meta.roomId = null;
  if (!room) return;
  const p = room.players.find(pl => pl.id === ws.meta.playerId);
  if (p) {
    if (room.game && room.game.phase !== 'gameover') {
      p.connected = false;
      p.ws = null;
      room.game.playerDisconnected(p.id);
      roomLog(room, `${p.name} disconnected`);
    } else {
      room.players = room.players.filter(pl => pl.id !== p.id);
    }
  }
  if (room.players.length === 0 || room.players.every(pl => !pl.connected)) {
    if (room.game) room.game.destroy();
    rooms.delete(room.id);
  } else {
    broadcastRoom(room);
  }
  broadcastRooms();
}

let nextPlayerId = 1;

function handleMessage(ws, msg) {
  const meta = ws.meta;
  const room = rooms.get(meta.roomId);
  const game = room && room.game;
  const gp = game && game.byId(meta.playerId);

  switch (msg.t) {
    case 'listRooms':
      send(ws, { t: 'rooms', rooms: openRooms() });
      break;

    case 'createRoom': {
      if (meta.roomId) return;
      const name = String(msg.playerName || '').trim().slice(0, 16);
      if (!name) return send(ws, { t: 'error', text: 'Enter a name first.' });
      const newRoom = makeRoom(msg.roomName, msg);
      joinPlayer(newRoom, ws, name, msg.deckArt);
      break;
    }

    case 'createSolo': {
      if (meta.roomId) return;
      const name = String(msg.playerName || '').trim().slice(0, 16);
      if (!name) return send(ws, { t: 'error', text: 'Enter a name first.' });
      const soloRoom = makeRoom(`${name} vs The House`, msg);
      joinPlayer(soloRoom, ws, name, msg.deckArt);
      soloRoom.game = new Game(
        [
          ...soloRoom.players.map(p => ({ id: p.id, name: p.name, connected: true, deckArt: p.deckArt })),
          { id: 'house-' + soloRoom.id, name: 'The House', isBot: true },
        ],
        { onUpdate: () => broadcastRoom(soloRoom), log: t => roomLog(soloRoom, t) },
        { mode: soloRoom.mode, goalScore: soloRoom.goalScore, deckEffects: soloRoom.deckEffects }
      );
      broadcastRoom(soloRoom);
      broadcastRooms();
      break;
    }

    case 'sync':
      if (room) broadcastRoom(room);
      else send(ws, { t: 'rooms', rooms: openRooms() });
      break;

    case 'joinRoom': {
      if (meta.roomId) return;
      const name = String(msg.playerName || '').trim().slice(0, 16);
      if (!name) return send(ws, { t: 'error', text: 'Enter a name first.' });
      const target = rooms.get(msg.roomId);
      if (!target) return send(ws, { t: 'error', text: 'Room no longer exists.' });
      // reconnect: reclaim a disconnected seat with the same name
      const seat = target.players.find(p => !p.connected && p.name === name);
      if (seat) {
        seat.ws = ws; seat.connected = true;
        if (!target.game && msg.deckArt) seat.deckArt = msg.deckArt;
        meta.roomId = target.id; meta.playerId = seat.id;
        if (target.game) target.game.playerReconnected(seat.id);
        roomLog(target, `${name} reconnected`);
        send(ws, { t: 'joined', roomId: target.id, logs: target.logs });
        broadcastRoom(target);
        broadcastRooms();
        return;
      }
      if (target.game && target.game.phase !== 'gameover') {
        return send(ws, { t: 'error', text: 'That game is already underway.' });
      }
      if (target.players.length >= 6) return send(ws, { t: 'error', text: 'Room is full.' });
      if (target.players.some(p => p.name === name)) {
        return send(ws, { t: 'error', text: 'That name is taken in this room.' });
      }
      if (target.game && target.game.phase === 'gameover') {
        target.game.destroy();
        target.game = null;
        target.players = target.players.filter(p => p.connected);
      }
      joinPlayer(target, ws, name, msg.deckArt);
      break;
    }

    case 'leaveRoom':
      leaveRoom(ws);
      send(ws, { t: 'left', rooms: openRooms() });
      break;

    case 'startGame': {
      if (!room || room.game) return;
      if (room.players[0].id !== meta.playerId) {
        return send(ws, { t: 'error', text: 'Only the host can start the game.' });
      }
      const connected = room.players.filter(p => p.connected);
      if (connected.length < 2) return send(ws, { t: 'error', text: 'Need at least 2 players.' });
      room.players = connected;
      startGame(room, msg);
      break;
    }

    case 'setDeckArt': {
      if (!room || room.game) return;
      const p = room.players.find(pl => pl.id === meta.playerId);
      if (!p) return;
      p.deckArt = String(msg.deckArt || 'classic');
      broadcastRoom(room);
      broadcastRooms();
      break;
    }

    case 'setDeckEffects': {
      if (!room || room.game) return;
      if (room.players[0].id !== meta.playerId) {
        return send(ws, { t: 'error', text: 'Only the host can change deck effects.' });
      }
      room.deckEffects = msg.enabled !== false;
      broadcastRoom(room);
      broadcastRooms();
      break;
    }

    case 'discard':
      if (gp) fail(ws, game.discard(gp, msg.cards));
      break;
    case 'playCard':
      if (gp) fail(ws, game.playCard(gp, msg.card));
      break;
    case 'useTarot':
      if (gp) fail(ws, game.useTarot(gp, msg.idx, msg.targets));
      break;
    case 'buy':
      if (gp) fail(ws, game.buyItem(gp, msg.idx));
      break;
    case 'reroll':
      if (gp) fail(ws, game.reroll(gp));
      break;
    case 'pickPack':
      if (gp) fail(ws, game.pickPack(gp, msg.idx));
      break;
    case 'sellJoker':
      if (gp) fail(ws, game.sellJoker(gp, msg.idx));
      break;
    case 'sellTarot':
      if (gp) fail(ws, game.sellTarot(gp, msg.idx));
      break;
    case 'ready':
      if (gp) fail(ws, game.setReady(gp));
      break;
    case 'reorderJokers':
      if (gp) fail(ws, game.reorderJokers(gp, msg.order));
      break;
    case 'backToLobby':
      leaveRoom(ws);
      send(ws, { t: 'left', rooms: openRooms() });
      break;
  }
}

function fail(ws, err) {
  if (typeof err === 'string') send(ws, { t: 'error', text: err });
}

function joinPlayer(room, ws, name, deckArt = 'classic') {
  const player = { id: 'p' + (nextPlayerId++), name, ws, connected: true, deckArt };
  room.players.push(player);
  ws.meta.roomId = room.id;
  ws.meta.playerId = player.id;
  send(ws, { t: 'joined', roomId: room.id, logs: room.logs });
  broadcastRoom(room);
  broadcastRooms();
}

// ---- http + ws ----
// Static files are served from the repo root so the exact same tree deploys
// to GitHub Pages (which runs the P2P transport instead of this server).

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath.includes('node_modules') || urlPath.includes('/.')) {
    res.writeHead(404); return res.end('Not found');
  }
  const file = path.join(ROOT, path.normalize(urlPath));
  const type = MIME[path.extname(file)];
  if (!file.startsWith(ROOT) || !type) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

// belt-and-braces: rebroadcast room state so a dropped message never
// leaves a client staring at a stale screen
setInterval(() => {
  for (const room of rooms.values()) broadcastRoom(room);
}, 2500);

wss.on('connection', ws => {
  ws.meta = { roomId: null, playerId: null };
  send(ws, { t: 'rooms', rooms: openRooms() });
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try { handleMessage(ws, msg); } catch (e) {
      console.error('handleMessage error:', e);
      send(ws, { t: 'error', text: 'Server error.' });
    }
  });
  ws.on('close', () => leaveRoom(ws));
});

export function start(port) {
  return new Promise(resolve => {
    server.listen(port, () => {
      console.log(`Crib server running at http://localhost:${port}`);
      resolve(server);
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  start(process.env.PORT || 3000);
}
