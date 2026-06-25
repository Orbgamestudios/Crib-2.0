import { Game } from '../lib/game.js';

// In-browser authoritative host for static hosting (GitHub Pages): the host's
// tab runs the Game engine and talks to guests over PeerJS data channels using
// the exact same message protocol as server.js. `Peer` comes from the PeerJS
// CDN script tag.

export const PEER_PREFIX = 'orbcrib-v1-';

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
    this.roomName = this.solo ? `${hostName} vs The House` : `${hostName}'s table`;
    this.onLocal = onLocal;       // deliver a protocol message to the host's own client
    this.onStatus = onStatus || (() => {});
    this.players = [{ id: 'p1', name: hostName, conn: null, connected: true }];
    this.nextId = 2;
    this.game = null;
    this.logs = [];
    this.destroyed = false;
    // dropped-message insurance: clients always converge within a heartbeat
    this.heartbeat = setInterval(() => { if (!this.destroyed) this.broadcastRoom(); }, 2500);

    if (this.solo) {
      // fully local — no signalling needed, works offline in the PWA
      this.peer = null;
      setTimeout(() => {
        this.onLocal({ t: 'joined', roomId: 'SOLO', logs: this.logs });
        this.players.push({ id: 'p2', name: 'The House', conn: 'bot', connected: true, isBot: true });
        this.startGame();
      }, 0);
      return;
    }

    this.peer = new Peer(PEER_PREFIX + code, { debug: 1 });
    this.peer.on('open', () => {
      this.onStatus('open');
      this.onLocal({ t: 'joined', roomId: code, logs: this.logs });
      this.broadcastRoom();
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
      inGame: !!this.game && this.game.phase !== 'gameover',
    };
  }

  broadcastRoom() {
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
          players: this.players.map(pl => ({ id: pl.id, name: pl.name, connected: pl.connected })),
        });
      }
    }
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
    if (msg.t === 'startGame') return this.startGame();
    if (msg.t === 'leaveRoom' || msg.t === 'backToLobby') return this.destroy('Host closed the table.');
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
      case 'ready': if (gp) this.fail(conn, game.setReady(gp)); break;
      case 'sync': this.broadcastRoom(); break;
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
    this.players.push({ id: 'p' + (this.nextId++), name, conn, connected: true });
    this.sendTo(conn, { t: 'joined', roomId: this.code, logs: this.logs });
    this.broadcastRoom();
  }

  startGame() {
    if (this.game && this.game.phase !== 'gameover') return;
    const connected = this.players.filter(p => p.connected);
    if (connected.length < 2) {
      return this.onLocal({ t: 'error', text: 'Need at least 2 players.' });
    }
    this.players = connected;
    this.game = new Game(
      this.players.map(p => ({ id: p.id, name: p.name, connected: p.connected, isBot: p.isBot })),
      { onUpdate: () => this.broadcastRoom(), log: text => this.log(text) }
    );
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
    clearInterval(this.heartbeat);
    for (const p of this.players.slice(1)) {
      if (p.connected) this.sendTo(p.conn, { t: 'hostLeft', text: reason });
    }
    if (this.game) this.game.destroy();
    if (this.peer) { try { this.peer.destroy(); } catch { /* already gone */ } }
    this.onLocal({ t: 'left' });
  }

}
