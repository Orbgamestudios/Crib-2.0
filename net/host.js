import { Game } from '../lib/game.js?v=3';

// In-browser authoritative host for static hosting (GitHub Pages): the host's
// tab runs the Game engine and talks to guests over PeerJS data channels using
// the exact same message protocol as server.js. `Peer` comes from the PeerJS
// CDN script tag.

export const PEER_PREFIX = 'orbcrib-v1-';
const P2P_LOBBY_TOPIC = 'orbcrib-lobbies-v1';
const P2P_LOBBY_BROKERS = [
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
];
const P2P_ROOM_TOPIC_PREFIX = 'orbcrib-room-v1';

function normalizeMode(mode) {
  if (mode === 'board') return 'board';
  if (mode === 'endless') return 'endless';
  return 'blind';
}

export function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

export class HostSession {
  constructor(code, hostName, onLocal, onStatus, opts = {}) {
    this.code = code;
    this.solo = !!opts.solo;
    this.gameMode = normalizeMode(opts.mode);
    this.goalScore = this.gameMode === 'board' ? 121 : null;
    this.deckEffects = opts.deckEffects !== false;
    this.saveKey = opts.saveKey || null;
    this.roomName = this.solo ? `${hostName} vs The House` : `${hostName}'s table`;
    this.onLocal = onLocal;       // deliver a protocol message to the host's own client
    this.onStatus = onStatus || (() => {});
    this.players = [{ id: 'p1', name: hostName, conn: null, connected: true, deckArt: opts.deckArt || 'classic' }];
    this.nextId = 2;
    this.game = null;
    this.logs = [];
    this.destroyed = false;
    this.mqttConns = new Map();
    this.seenMqtt = new Set();
    // dropped-message insurance: clients always converge within a heartbeat
    this.heartbeat = setInterval(() => { if (!this.destroyed) this.broadcastRoom(); }, 2500);

    if (this.solo) {
      // fully local — no signalling needed, works offline in the PWA
      this.peer = null;
      setTimeout(() => {
        this.onLocal({ t: 'joined', roomId: 'SOLO', logs: this.logs });
        if (opts.restoreState) this.restoreSolo(opts.restoreState);
        else {
          this.players.push({ id: 'p2', name: 'The House', conn: 'bot', connected: true, isBot: true, deckArt: 'classic' });
          this.startGame();
        }
      }, 0);
      return;
    }

    this.peer = new Peer(PEER_PREFIX + code, { debug: 1 });
    this.peer.on('open', () => {
      this.onStatus('open');
      this.onLocal({ t: 'joined', roomId: code, logs: this.logs });
      this.broadcastRoom();
      this.startMqttBroadcast();
    });
    this.peer.on('error', err => {
      if (err.type === 'unavailable-id') this.onStatus('code-taken');
      else this.onStatus('error', err.type);
    });
    this.peer.on('connection', conn => {
      conn.on('data', raw => {
        let msg = raw;
        if (typeof raw === 'string') { try { msg = JSON.parse(raw); } catch { return; } }
        try { this.handle(conn, msg); } catch (e) {
          console.error(e);
          this.sendTo(conn, { t: 'error', text: 'Host error.' });
        }
      });
      conn.on('close', () => this.dropConn(conn));
      conn.on('error', () => this.dropConn(conn));
    });
  }

  sendTo(target, msg) {
    if (target === 'bot') return;                    // The House needs no mail
    if (target === null) this.onLocal(msg);          // host player
    else if (target.open) target.send(msg);
  }

  byConn(conn) { return this.players.find(p => p.conn === conn); }

  mqttConn(guestId) {
    let conn = this.mqttConns.get(guestId);
    if (conn) return conn;
    conn = {
      open: true,
      send: msg => this.sendMqtt(guestId, msg),
      close: () => { conn.open = false; },
    };
    this.mqttConns.set(guestId, conn);
    return conn;
  }

  sendMqtt(guestId, msg) {
    if (!this.mqttClients) return;
    const topic = `${P2P_ROOM_TOPIC_PREFIX}/${this.code}/guest/${guestId}`;
    const envelope = JSON.stringify({ id: makeMsgId(), guestId, msg });
    for (const client of this.mqttClients) {
      if (client.connected) client.publish(topic, envelope, { qos: 1 });
    }
  }

  handleMqtt(topic, payload) {
    if (topic !== `${P2P_ROOM_TOPIC_PREFIX}/${this.code}/host`) return;
    let envelope;
    try { envelope = JSON.parse(payload.toString()); } catch { return; }
    if (!envelope || !envelope.id || !envelope.guestId || this.seenMqtt.has(envelope.id)) return;
    this.seenMqtt.add(envelope.id);
    if (this.seenMqtt.size > 500) this.seenMqtt.clear();
    this.handle(this.mqttConn(envelope.guestId), envelope.msg || {});
  }

  log(text) {
    this.logs.push(text);
    if (this.logs.length > 60) this.logs.shift();
    for (const p of this.players) {
      if (p.connected) this.sendTo(p.conn, { t: 'log', text });
    }
  }

  roomSummary() {
    return {
      id: this.code, name: this.roomName,
      players: this.players.map(p => p.name),
      count: this.players.filter(p => p.connected).length,
      mode: this.gameMode,
      goalScore: this.goalScore,
      deckEffects: this.deckEffects,
      inGame: !!this.game && this.game.phase !== 'gameover',
    };
  }

  broadcastRoom() {
    this.saveSolo();
    for (const p of this.players) {
      if (!p.connected) continue;
      if (this.game) {
        this.sendTo(p.conn, { t: 'state', room: this.roomSummary(), state: this.game.stateFor(p.id) });
      } else {
        this.sendTo(p.conn, {
          t: 'roomUpdate',
          room: this.roomSummary(),
          code: this.code,
          hostId: 'p1',
          youId: p.id,
          players: this.players.map(pl => ({ id: pl.id, name: pl.name, connected: pl.connected, deckArt: pl.deckArt })),
        });
      }
    }
  }

  saveSolo() {
    if (!this.solo || !this.saveKey || !this.game) return;
    if (this.game.phase === 'gameover') { this.clearSoloSave(); return; }
    try {
      localStorage.setItem(this.saveKey, JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        logs: this.logs,
        game: this.game.snapshot(),
      }));
    } catch { /* storage may be full or blocked */ }
  }

  clearSoloSave() {
    if (!this.saveKey) return;
    try { localStorage.removeItem(this.saveKey); } catch { /* ignore */ }
  }

  restoreSolo(payload) {
    const snap = payload && payload.game;
    if (!snap || !Array.isArray(snap.players)) return this.startGame();
    this.logs = Array.isArray(payload.logs) ? payload.logs.slice(-60) : [];
    this.players = snap.players.map(p => ({
      id: p.id, name: p.name, conn: p.isBot ? 'bot' : null, deckArt: p.deckArt || 'classic',
      connected: true, isBot: !!p.isBot,
    }));
    this.game = Game.fromSnapshot(snap, { onUpdate: () => this.broadcastRoom(), log: text => this.log(text) });
    this.gameMode = normalizeMode(this.game.mode);
    this.goalScore = this.gameMode === 'board' ? 121 : null;
    this.deckEffects = this.game.deckEffects !== false;
    this.broadcastRoom();
  }

  handle(conn, msg) {
    const p = this.byConn(conn);
    if (msg.t === 'joinRoom') return this.join(conn, msg);
    if (!p || !p.connected) return;
    this.dispatch(p, msg, conn);
  }

  // the host's own client calls this directly instead of going over the wire
  handleLocal(msg) {
    if (this.destroyed) return;
    const p = this.players[0];
    if (msg.t === 'startGame') return this.startGame(msg);
    if (msg.t === 'setDeckEffects') {
      if (this.game) return;
      this.deckEffects = msg.enabled !== false;
      this.broadcastRoom();
      return;
    }
    if (msg.t === 'leaveRoom' || msg.t === 'backToLobby') {
      this.saveSolo();
      return this.destroy('Host closed the table.');
    }
    this.dispatch(p, msg, null);
  }

  dispatch(p, msg, conn) {
    const game = this.game;
    const gp = game && game.byId(p.id);
    switch (msg.t) {
      case 'discard': if (gp) this.fail(conn, game.discard(gp, msg.cards)); break;
      case 'playCard': if (gp) this.fail(conn, game.playCard(gp, msg.card)); break;
      case 'useTarot': if (gp) this.fail(conn, game.useTarot(gp, msg.idx, msg.targets)); break;
      case 'buy': if (gp) this.fail(conn, game.buyItem(gp, msg.idx)); break;
      case 'reroll': if (gp) this.fail(conn, game.reroll(gp)); break;
      case 'pickPack': if (gp) this.fail(conn, game.pickPack(gp, msg.idx)); break;
      case 'sellJoker': if (gp) this.fail(conn, game.sellJoker(gp, msg.idx)); break;
      case 'sellTarot': if (gp) this.fail(conn, game.sellTarot(gp, msg.idx)); break;
      case 'ready': if (gp) this.fail(conn, game.setReady(gp)); break;
      case 'reorderJokers': if (gp) this.fail(conn, game.reorderJokers(gp, msg.order)); break;
      case 'sync': this.broadcastRoom(); break;
      case 'setDeckArt':
        if (!this.game) {
          p.deckArt = msg.deckArt || 'classic';
          this.broadcastRoom();
        }
        break;
      case 'setDeckEffects':
        if (!this.game) this.sendTo(conn, { t: 'error', text: 'Only the host can change deck effects.' });
        break;
      case 'leaveRoom':
      case 'backToLobby':
        this.dropConn(conn);
        this.sendTo(conn, { t: 'left' });
        break;
    }
  }

  fail(conn, err) {
    if (typeof err === 'string') this.sendTo(conn, { t: 'error', text: err });
  }

  join(conn, msg) {
    const name = String(msg.playerName || '').trim().slice(0, 16);
    if (!name) return this.sendTo(conn, { t: 'error', text: 'Enter a name first.' });
    const seat = this.players.find(p => !p.connected && p.name === name);
    if (seat) {
      seat.conn = conn; seat.connected = true;
      if (!this.game && msg.deckArt) seat.deckArt = msg.deckArt;
      if (this.game) this.game.playerReconnected(seat.id);
      this.log(`${name} reconnected`);
      this.sendTo(conn, { t: 'joined', roomId: this.code, logs: this.logs });
      this.broadcastRoom();
      return;
    }
    if (this.game && this.game.phase !== 'gameover') {
      return this.sendTo(conn, { t: 'error', text: 'That game is already underway.' });
    }
    if (this.players.length >= 6) return this.sendTo(conn, { t: 'error', text: 'Room is full.' });
    if (this.players.some(p => p.name === name)) {
      return this.sendTo(conn, { t: 'error', text: 'That name is taken in this room.' });
    }
    this.players.push({ id: 'p' + (this.nextId++), name, conn, connected: true, deckArt: msg.deckArt || 'classic' });
    this.sendTo(conn, { t: 'joined', roomId: this.code, logs: this.logs });
    this.broadcastRoom();
  }

  startGame(opts = {}) {
    if (this.game && this.game.phase !== 'gameover') return;
    this.gameMode = opts.mode ? normalizeMode(opts.mode) : this.gameMode;
    this.goalScore = this.gameMode === 'board' ? 121 : null;
    if (typeof opts.deckEffects === 'boolean') this.deckEffects = opts.deckEffects;
    const connected = this.players.filter(p => p.connected);
    if (connected.length < 2) {
      return this.onLocal({ t: 'error', text: 'Need at least 2 players.' });
    }
    this.players = connected;
    this.game = new Game(
      this.players.map(p => ({ id: p.id, name: p.name, connected: p.connected, isBot: p.isBot, deckArt: p.deckArt })),
      { onUpdate: () => this.broadcastRoom(), log: text => this.log(text) },
      { mode: this.gameMode, goalScore: this.goalScore, deckEffects: this.deckEffects }
    );
    this.stopLobbyAdvertising();
    this.broadcastRoom();
  }

  dropConn(conn) {
    if (!conn) return;
    const p = this.byConn(conn);
    if (!p) return;
    if (this.game && this.game.phase !== 'gameover') {
      p.connected = false;
      p.conn = null;
      this.game.playerDisconnected(p.id);
      this.log(`${p.name} disconnected`);
    } else {
      this.players = this.players.filter(pl => pl !== p);
    }
    this.broadcastRoom();
  }

  destroy(reason) {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopMqttBroadcast();
    clearInterval(this.heartbeat);
    for (const p of this.players.slice(1)) {
      if (p.connected) this.sendTo(p.conn, { t: 'hostLeft', text: reason });
    }
    if (this.game) this.game.destroy();
    if (this.peer) { try { this.peer.destroy(); } catch { /* already gone */ } }
    this.onLocal({ t: 'left' });
  }

  startMqttBroadcast() {
    if (this.solo || this.destroyed) return;
    if (!window.mqtt) {
      this.mqttRetry = setTimeout(() => this.startMqttBroadcast(), 500);
      return;
    }
    const publish = client => {
      if (this.game || this.destroyed || !client || !client.connected) return;
      const connectedCount = this.players.filter(p => p.connected).length;
      if (connectedCount >= 6) return; // Full
      const payload = JSON.stringify({
        t: 'lobbyUpdate',
        code: this.code,
        name: this.roomName,
        count: connectedCount,
        players: this.players.filter(p => p.connected).map(p => p.name),
        mode: this.gameMode,
        goalScore: this.goalScore,
      });
      client.publish(P2P_LOBBY_TOPIC, payload);
    };
    const hostTopic = `${P2P_ROOM_TOPIC_PREFIX}/${this.code}/host`;
    this.mqttClients = P2P_LOBBY_BROKERS.map((url, idx) => {
      const client = window.mqtt.connect(url, {
        clientId: `orbcrib-host-${idx}-${this.code}-` + Math.random().toString(36).slice(2),
        clean: true,
        connectTimeout: 8000,
        reconnectPeriod: 3000,
      });
      client.on('connect', () => {
        client.subscribe(hostTopic, { qos: 1 });
        publish(client);
      });
      client.on('message', (topic, payload) => this.handleMqtt(topic, payload));
      client.on('error', err => console.warn('Lobby broadcast error:', url, err && err.message || err));
      return client;
    });
    this.mqttTimer = setInterval(() => this.mqttClients.forEach(publish), 5000);
  }

  stopMqttBroadcast() {
    this.stopLobbyAdvertising();
    if (this.mqttClients) {
      for (const client of this.mqttClients) client.end(true);
      this.mqttClients = null;
    }
    for (const conn of this.mqttConns.values()) conn.close();
    this.mqttConns.clear();
  }

  stopLobbyAdvertising() {
    if (this.mqttRetry) clearTimeout(this.mqttRetry);
    if (this.mqttTimer) clearInterval(this.mqttTimer);
    this.mqttRetry = null;
    this.mqttTimer = null;
  }
}

function makeMsgId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}
