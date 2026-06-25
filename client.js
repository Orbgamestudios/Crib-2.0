import { JOKER_ICONS, TAROT_ICONS, PACK_ICONS } from './icons.js?v=16';
import { CARD_ENHANCEMENTS, cardValue } from './lib/cards.js?v=3';
import { pegEvents, scoreBreakdown } from './lib/scoring.js?v=3';
import { JOKERS, TAROTS, aggregateMods, buildScore, effectiveJokerIds, jokerDef, normalizeJoker, stampText } from './lib/jokers.js?v=3';

window.__cribBooted = true;
clearTimeout(window.__cribBootTimer);

const $ = id => document.getElementById(id);
const SUIT_CHARS = ['♥', '♦', '♣', '♠']; // H D C S
const RANK_NAMES = [null, 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const PEER_PREFIX = 'orbcrib-v1-';
const P2P_LOBBY_TOPIC = 'orbcrib-lobbies-v1';
const P2P_LOBBY_TTL = 16000;
const P2P_LOBBY_BROKERS = [
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
];
const P2P_ROOM_TOPIC_PREFIX = 'orbcrib-room-v1';
const TOUCH = 'ontouchstart' in window;
const ANIM = 1.9; // global animation slowdown - everything glides ~half speed
const SOLO_SAVE_KEY = 'crib_solo_house_save_v1';
const PROFILE_KEY = 'crib_profiles_v1';
const ACTIVE_PROFILE_KEY = 'crib_active_profile_pin';
const DIAG_KEY = 'crib_last_diagnostic_v1';
const APP_BUILD = 'client-v108';

// GitHub Pages (or any static host) has no WebSocket server: use P2P rooms.
const P2P_MODE = location.hostname.endsWith('github.io') ||
  new URLSearchParams(location.search).has('p2p');

let ws = null;
let wsOpen = false;
let hostSession = null;   // P2P: I am the host (game runs in this tab)
let guestConn = null;     // P2P: I am a guest
let guestPeer = null;
let mqttGuest = null;
let mqttSyncTimer = null;
let p2pLobbyClients = [];
const p2pRooms = new Map();
let myRoomId = null;
let lastState = null;
let prevState = null;
let lastStateJson = '';
let selected = [];        // card ids picked for discard
let tarotMode = null;     // { idx, def, targets: [] }
let view = 'lobby';
let pendingFly = null;    // { cardId, rect } captured when I click a peg card
let revealShown = -1;     // last scoring result index already animated
let revealKey = '';
let deckOpen = false;     // deck viewer overlay
let raisedCardId = null;
let selectedShopIdx = -1;
let focusMode = null;
let pointerCardDrag = null;
let lastCoinPopKey = '';
let lastRecordedRunKey = '';
let waitingDeckEffects = true;
let intentionalLobbyReturn = false;
let p2pReconnectTimer = null;
let deferredRender = false; // a state update arrived mid-drag; apply on release
let lastUserAction = 'app start';
const messageTrace = [];
function normalizeMode(mode) {
  if (mode === 'board') return 'board';
  if (mode === 'endless') return 'endless';
  return 'blind';
}
let selectedGameMode = normalizeMode(localStorage.getItem('crib_game_mode'));
let selectedDeckArt = localStorage.getItem('crib_deck_art') || 'classic';
const DECK_ARTS = [
  { id: 'classic', name: 'Classic Violet', cost: 0, desc: 'Purple deck: one random shop pack becomes an Arcana tarot pack.' },
  { id: 'emerald', name: 'Emerald Felt', cost: 0, desc: 'Start every run with 5 coins and one free random Common Joker.' },
  { id: 'sapphire', name: 'Sapphire Run', cost: 0, desc: 'Blue deck: start each run with +1 joker slot.' },
  { id: 'ruby', name: 'Ruby Cut', cost: 0, desc: 'At the start of a run, choose two random suits. Every card in your deck permanently becomes one of those two suits.' },
  { id: 'aurora', name: 'Aurora Flow', cost: 0, animated: true, desc: 'Draw one extra card during discard. Select one extra card last; that final card is removed from the run instead of entering the crib.' },
  { id: 'neon', name: 'Neon Circuit', cost: 0, animated: true, desc: 'Neon deck: score the square of the average of Hand and Mult, but your blinds are 2.5x higher.' },
  { id: 'cosmic', name: 'Cosmic Drift', cost: 0, animated: true, desc: 'Cosmic deck: see hands, reveal the crib after discards, and each deal replaces 15s with a mystery target.' },
  { id: 'gambit', name: 'Gambit', cost: 0, animated: true, desc: 'Randomize all 52 ranks and suits. A card that lands pegging on 15 or 31 glows pink, gives +2 Hand Points in addition to its Mult, then leaves the deck after that deal scores.' },
];
const FREE_DECK_IDS = DECK_ARTS.filter(a => a.cost === 0).map(a => a.id);
let boardView = null;
let boardScoreDisplay = new Map();
let boardFx = [];
let lastBoardRevealKey = '';

function isDragging() {
  return !!((pointerCardDrag && pointerCardDrag.dragging) || (jokerDrag && jokerDrag.dragging));
}

function flushDeferredRender() {
  if (deferredRender && lastState) {
    deferredRender = false;
    renderGame(lastState); // no animation on the catch-up frame
  }
}

function ensureBoardShell() {
  let wrap = $('board2dWrap');
  if (wrap) return wrap;
  wrap = document.createElement('div');
  wrap.id = 'board2dWrap';
  wrap.className = 'hidden';
  wrap.innerHTML = '<canvas id="board2d"></canvas><div id="board2dLegend"></div>';
  $('game').appendChild(wrap);
  return wrap;
}

// Joker drag state (pointer-based, works on touch + mouse)
let jokerDrag = null;

// Tutorial mode
let tutorialOn = localStorage.getItem('crib_tutorial') !== '0'; // default on
let lastTutKey = '';

// ---- sound effects ----

let audioCtx = null;
let soundUnlocked = false;
const SFX_GAIN = 0.28;

function ensureAudio() {
  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtor) return null;
  if (!audioCtx) audioCtx = new AudioCtor();
  return audioCtx;
}

function unlockAudio() {
  const ctx = ensureAudio();
  if (!ctx) return;
  soundUnlocked = true;
  if (ctx.state === 'suspended') ctx.resume();
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  const t = ctx.currentTime;
  osc.frequency.setValueAtTime(1, t);
  amp.gain.setValueAtTime(0.0001, t);
  osc.connect(amp).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.02);
}

window.addEventListener('pointerdown', unlockAudio, { passive: true });
window.addEventListener('touchstart', unlockAudio, { passive: true });
window.addEventListener('mousedown', unlockAudio);
window.addEventListener('click', unlockAudio);
window.addEventListener('keydown', unlockAudio);

function tone(freq, delay = 0, dur = 0.08, type = 'sine', gain = 0.45) {
  if (!soundUnlocked) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume();
  const t = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  amp.gain.setValueAtTime(0.0001, t);
  amp.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * SFX_GAIN), t + 0.01);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(amp).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

function sweep(freqA, freqB, delay = 0, dur = 0.14, type = 'sine', gain = 0.4) {
  if (!soundUnlocked) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume();
  const t = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freqA, t);
  osc.frequency.exponentialRampToValueAtTime(freqB, t + dur);
  amp.gain.setValueAtTime(0.0001, t);
  amp.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * SFX_GAIN), t + 0.012);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(amp).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.03);
}

function noise(delay = 0, dur = 0.08, gain = 0.35, filterFreq = 1200) {
  if (!soundUnlocked) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume();
  const t = ctx.currentTime + delay;
  const buffer = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * dur)), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  const src = ctx.createBufferSource();
  const filter = ctx.createBiquadFilter();
  const amp = ctx.createGain();
  src.buffer = buffer;
  filter.type = 'bandpass';
  filter.frequency.setValueAtTime(filterFreq, t);
  filter.Q.setValueAtTime(0.8, t);
  amp.gain.setValueAtTime(gain * SFX_GAIN, t);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(filter).connect(amp).connect(ctx.destination);
  src.start(t);
}

function cardSnap(delay = 0, gain = 0.22) {
  noise(delay, 0.018, gain, 3600);
  noise(delay + 0.012, 0.025, gain * 0.65, 1600);
}

function feltThump(delay = 0, gain = 0.24, pitch = 105) {
  if (!soundUnlocked) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  const t = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(pitch, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(42, pitch * 0.48), t + 0.075);
  amp.gain.setValueAtTime(Math.max(0.0002, gain * SFX_GAIN), t);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
  osc.connect(amp).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.1);
  noise(delay, 0.035, gain * 0.45, 520);
}

function woodTap(delay = 0, gain = 0.18) {
  noise(delay, 0.018, gain, 2100);
  noise(delay + 0.008, 0.035, gain * 0.42, 780);
  feltThump(delay, gain * 0.34, 155);
}

function chipClack(delay = 0, gain = 0.2) {
  noise(delay, 0.014, gain, 4200);
  tone(1180 + Math.random() * 180, delay, 0.045, 'sine', gain * 0.42);
  tone(760 + Math.random() * 90, delay + 0.008, 0.055, 'sine', gain * 0.28);
}

function cardSlide(delay = 0, gain = 0.18) {
  noise(delay, 0.09, gain, 1050);
  noise(delay + 0.055, 0.025, gain * 0.75, 2900);
}

function packTear(delay = 0, gain = 0.22) {
  for (let i = 0; i < 5; i++) noise(delay + i * 0.018, 0.035, gain * (0.7 + i * 0.08), 2300 + i * 420);
  cardSlide(delay + 0.11, gain * 0.9);
}

function shuffleSound() {
  for (let i = 0; i < 9; i++) {
    const d = i * 0.026;
    noise(d, 0.028, 0.12 + Math.random() * 0.05, 1200 + Math.random() * 2400);
  }
  noise(0.22, 0.11, 0.16, 900);
  cardSnap(0.31, 0.16);
}

function sfx(name) {
  if (!soundUnlocked) return;
  switch (name) {
    case 'click': woodTap(0, 0.11); break;
    case 'error': feltThump(0, 0.34, 88); feltThump(0.11, 0.28, 72); break;
    case 'toast': woodTap(0, 0.12); woodTap(0.065, 0.09); break;
    case 'join': cardSlide(0, 0.14); woodTap(0.09, 0.16); break;
    case 'ready': woodTap(0, 0.18); chipClack(0.055, 0.11); break;
    case 'deal': for (let i = 0; i < 6; i++) cardSnap(i * 0.045, 0.14); break;
    case 'shuffle': shuffleSound(); break;
    case 'card': cardSnap(0, 0.2); break;
    case 'discard': cardSlide(0, 0.2); cardSnap(0.07, 0.18); break;
    case 'peg': cardSnap(0, 0.24); woodTap(0.028, 0.12); break;
    case 'score': chipClack(0, 0.14); chipClack(0.06, 0.12); break;
    case 'scoreTick': woodTap(0, 0.1); chipClack(0.018, 0.08); break;
    case 'scoreTotal': chipClack(0, 0.16); chipClack(0.05, 0.15); chipClack(0.105, 0.13); break;
    case 'boardPeg': woodTap(0, 0.2); woodTap(0.055, 0.14); break;
    case 'mult': feltThump(0, 0.24, 128); cardSnap(0.055, 0.14); break;
    case 'coin': chipClack(0, 0.24); chipClack(0.045, 0.18); break;
    case 'shop': feltThump(0, 0.16, 115); cardSlide(0.05, 0.14); cardSnap(0.13, 0.11); break;
    case 'buy': chipClack(0, 0.24); chipClack(0.045, 0.2); feltThump(0.075, 0.12, 140); break;
    case 'sell': cardSlide(0, 0.16); chipClack(0.08, 0.18); break;
    case 'reroll': for (let i = 0; i < 4; i++) cardSnap(i * 0.045, 0.15); break;
    case 'pack': packTear(0, 0.23); break;
    case 'tarot': cardSlide(0, 0.17); noise(0.06, 0.14, 0.1, 3600); cardSnap(0.15, 0.12); break;
    case 'blind': feltThump(0, 0.3, 92); feltThump(0.14, 0.3, 92); feltThump(0.28, 0.34, 76); break;
    case 'gameover': cardSlide(0, 0.22); feltThump(0.18, 0.34, 68); break;
  }
}

// Remove any drag ghost left orphaned by a re-render that happened mid-gesture
// (the heartbeat re-broadcasts state every 2.5s and rebuilds the hand, which
// would otherwise strand the fixed-position clone on screen forever).
function sweepStrayFx() {
  if (pointerCardDrag && pointerCardDrag.el && !pointerCardDrag.el.isConnected) {
    if (pointerCardDrag.ghost) pointerCardDrag.ghost.remove();
    pointerCardDrag = null;
  }
  if (jokerDrag && jokerDrag.tile && !jokerDrag.tile.isConnected) {
    if (jokerDrag.ghost) jokerDrag.ghost.remove();
    jokerDrag = null;
  }
  const keep = (pointerCardDrag && pointerCardDrag.ghost) || (jokerDrag && jokerDrag.ghost) || null;
  document.querySelectorAll('.drag-ghost').forEach(g => { if (g !== keep) g.remove(); });
}

// ---- transport ----

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => {
    wsOpen = true;
    const savedRoom = sessionStorage.getItem('crib_room');
    const name = localStorage.getItem('crib_name');
    if (savedRoom && name) {
      ws.send(JSON.stringify({ t: 'joinRoom', roomId: savedRoom, playerName: name, deckArt: activeDeckArt() }));
    }
  };
  ws.onmessage = e => {
    try { safeHandle(JSON.parse(e.data), 'websocket'); }
    catch (err) { reportCrash('Crash reading server message', err, { raw: e.data }); }
  };
  ws.onclose = () => {
    wsOpen = false;
    toast('Connection lost - reconnecting...');
    setTimeout(connectWs, 2000);
  };
}

function sendMsg(msg) {
  playMessageSfx(msg);
  lastUserAction = msg && msg.t ? `sent ${msg.t}` : 'sent message';
  if (msg && (msg.t === 'leaveRoom' || msg.t === 'backToLobby')) intentionalLobbyReturn = true;
  if (hostSession) hostSession.handleLocal(msg);
  else if (guestConn && guestConn.open) guestConn.send(msg);
  else if (mqttGuest && mqttGuest.open) mqttGuest.send(msg, { qos: 1 });
  else if (wsOpen) ws.send(JSON.stringify(msg));
}

function playMessageSfx(msg) {
  switch (msg && msg.t) {
    case 'createRoom':
    case 'createSolo':
    case 'joinRoom':
    case 'startGame':
      sfx('join'); break;
    case 'discard':
      sfx('discard'); break;
    case 'playCard':
      sfx('peg'); break;
    case 'ready':
      sfx('ready'); break;
    case 'buy':
      sfx('buy'); break;
    case 'sellJoker':
    case 'sellTarot':
      sfx('sell'); break;
    case 'reroll':
      sfx('reroll'); break;
    case 'pickPack':
      sfx('card'); break;
    case 'useTarot':
      sfx('tarot'); break;
    case 'sync':
      sfx('toast'); break;
  }
}

function gameOptions() {
  return {
    mode: selectedGameMode,
    goalScore: selectedGameMode === 'board' ? 121 : null,
    deckArt: activeDeckArt(),
    deckEffects: waitingDeckEffects,
  };
}

function modeLabel(mode, goal) {
  if (mode === 'board') return `Board to ${goal || 121}`;
  if (mode === 'endless') return 'Endless Blind';
  return 'Regular Blind';
}

async function hostTable() {
  const { HostSession, makeCode } = await import('./net/host.js?v=3');
  const code = makeCode();
  hostSession = new HostSession(code, myName(), msg => safeHandle(msg, 'host'), (status, detail) => {
    if (status === 'code-taken') { hostSession = null; toast('Code collision - try again.'); }
    else if (status === 'error') {
      hostSession = null;
      forceLobby('host connection service error', { detail });
    }
  }, gameOptions());
  hostSession.peer.on('error', err => {
    console.warn('Host PeerJS error:', err.type);
    toast('Connection service error: ' + err.type);
  });
}

function joinByCode(code) {
  code = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{5}$/.test(code)) return toast('Codes are 5 letters/digits.');
  clearGuestTransports();
  sessionStorage.setItem('crib_code', code);
  guestPeer = new Peer({ debug: 1 });
  toast('Connecting...');
  let failTimer = null;
  let fallingBack = false;
  const useRelay = () => {
    if (fallingBack) return;
    fallingBack = true;
    clearTimeout(failTimer);
    clearGuestPeer();
    joinByMqttCode(code);
  };
  guestPeer.on('open', () => {
    guestConn = guestPeer.connect(PEER_PREFIX + code, { reliable: true, serialization: 'json' });
    failTimer = setTimeout(() => {
      if (!guestConn || !guestConn.open) useRelay();
    }, 12000);
    guestConn.on('open', () => {
      clearTimeout(failTimer);
      guestConn.send({ t: 'joinRoom', playerName: myName(), deckArt: activeDeckArt() });
    });
    guestConn.on('data', msg => safeHandle(msg, 'direct guest'));
    guestConn.on('close', () => {
      clearTimeout(failTimer);
      if (!fallingBack) recoverP2pGuest('direct host connection closed');
    });
    guestConn.on('error', () => useRelay());
  });
  guestPeer.on('error', err => {
    clearTimeout(failTimer);
    if (err.type === 'peer-unavailable' || err.type === 'network') useRelay();
    else dropGuest('Connection error: ' + err.type, { detail: err.type });
  });
}

function recoverP2pGuest(reason) {
  const code = sessionStorage.getItem('crib_code') || myRoomId;
  if (!code || !/^[A-Z0-9]{5}$/.test(code) || intentionalLobbyReturn) {
    dropGuest('Connection to the host was lost.', { detail: reason });
    return;
  }
  recordDiagnostic('connection hiccup', `${reason}; trying relay reconnect to ${code}`);
  toast('Connection hiccup - trying to reconnect...');
  clearGuestPeer();
  clearTimeout(p2pReconnectTimer);
  p2pReconnectTimer = setTimeout(() => joinByMqttCode(code), 250);
}

function dropGuest(reason, meta = {}) {
  if (!guestPeer && !mqttGuest) return;
  clearGuestTransports();
  forceLobby(reason, meta);
}

function joinByMqttCode(code) {
  if (!window.mqtt) {
    toast('Connecting through lobby relay...');
    setTimeout(() => joinByMqttCode(code), 500);
    return;
  }
  clearMqttGuest();
  toast('Connecting through lobby relay...');
  const guestId = 'g-' + Math.random().toString(36).slice(2);
  const hostTopic = `${P2P_ROOM_TOPIC_PREFIX}/${code}/host`;
  const guestTopic = `${P2P_ROOM_TOPIC_PREFIX}/${code}/guest/${guestId}`;
  const seen = new Set();
  let joined = false;
  const clients = [];
  const joinEnvelope = JSON.stringify({
    id: makeMsgId(),
    guestId,
    msg: { t: 'joinRoom', playerName: myName(), deckArt: activeDeckArt() },
  });
  const sendEnvelope = (msg, opts = {}) => {
    const envelope = JSON.stringify({ id: makeMsgId(), guestId, msg });
    for (const client of clients) {
      if (client.connected) client.publish(hostTopic, envelope, opts);
    }
  };
  const sendJoin = () => {
    for (const client of clients) {
      if (client.connected) client.publish(hostTopic, joinEnvelope, { qos: 1 });
    }
  };
  const failTimer = setTimeout(() => {
    if (!joined) dropGuest('No table found with that code. Make sure the host tab is open.', { detail: `relay join timeout for ${code}` });
  }, 12000);
  mqttGuest = {
    open: true,
    send: sendEnvelope,
    destroy() {
      this.open = false;
      clearTimeout(failTimer);
      for (const client of clients) client.end(true);
    },
  };
  const onMessage = (topic, payload) => {
    if (topic !== guestTopic) return;
    let envelope;
    try { envelope = JSON.parse(payload.toString()); } catch { return; }
    if (!envelope || envelope.guestId !== guestId || seen.has(envelope.id)) return;
    seen.add(envelope.id);
    if (envelope.msg && envelope.msg.t === 'joined') {
      joined = true;
      clearTimeout(failTimer);
    }
    if (envelope.msg) safeHandle(envelope.msg, 'relay guest');
  };
  for (let i = 0; i < P2P_LOBBY_BROKERS.length; i++) {
    const client = window.mqtt.connect(P2P_LOBBY_BROKERS[i], {
      clientId: `orbcrib-guest-${i}-${guestId}`,
      clean: true,
      connectTimeout: 8000,
      reconnectPeriod: 3000,
    });
    clients.push(client);
    client.on('connect', () => {
      client.subscribe(guestTopic, { qos: 1 }, sendJoin);
    });
    client.on('message', onMessage);
    client.on('error', err => console.warn('Lobby relay error:', err && err.message || err));
  }
}

function clearGuestPeer() {
  const peer = guestPeer;
  guestPeer = null;
  guestConn = null;
  if (peer) { try { peer.destroy(); } catch { /* gone */ } }
}

function clearMqttGuest() {
  const relay = mqttGuest;
  mqttGuest = null;
  if (relay) relay.destroy();
}

function clearGuestTransports() {
  clearTimeout(p2pReconnectTimer);
  p2pReconnectTimer = null;
  clearGuestPeer();
  clearMqttGuest();
}

function startMqttSync() {
  stopMqttSync();
  mqttSyncTimer = setInterval(() => {
    if (mqttGuest && mqttGuest.open && view === 'waiting') mqttGuest.send({ t: 'sync' }, { qos: 1 });
  }, 2000);
}

function stopMqttSync() {
  if (mqttSyncTimer) clearInterval(mqttSyncTimer);
  mqttSyncTimer = null;
}

function makeMsgId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function compactJson(value, limit = 2400) {
  let text;
  try { text = JSON.stringify(value); }
  catch (err) { text = String(value); }
  if (text && text.length > limit) return `${text.slice(0, limit)}...`;
  return text || '';
}

function rememberMessage(source, msg) {
  const entry = {
    at: new Date().toISOString(),
    source,
    type: msg && msg.t || typeof msg,
    phase: msg && msg.state && msg.state.phase || '',
    summary: compactJson(msg, 700),
  };
  messageTrace.push(entry);
  while (messageTrace.length > 8) messageTrace.shift();
}

function safeHandle(msg, source = 'message') {
  rememberMessage(source, msg);
  try {
    handle(msg);
  } catch (err) {
    reportCrash(`Crash while handling ${msg && msg.t || 'message'}`, err, { source, message: compactJson(msg) });
  }
}

function leaveP2p() {
  if (hostSession) { hostSession.destroy('Host closed the table.'); hostSession = null; }
  else clearGuestTransports();
  showView('lobby');
}

window.addEventListener('beforeunload', () => {
  if (hostSession) hostSession.destroy('Host closed the table.');
});

function handle(msg) {
  switch (msg.t) {
    case 'rooms':
      if (view === 'lobby' && !P2P_MODE) renderRoomList(msg.rooms);
      break;
    case 'joined':
      myRoomId = msg.roomId;
      intentionalLobbyReturn = false;
      if (!P2P_MODE) sessionStorage.setItem('crib_room', msg.roomId);
      if (mqttGuest) startMqttSync();
      $('log').innerHTML = '';
      (msg.logs || []).forEach(addLog);
      break;
    case 'roomUpdate':
      showView('waiting');
      renderWaiting(msg);
      break;
    case 'state':
      intentionalLobbyReturn = false;
      stopMqttSync();
      showView('game');
      {
        const stateJson = JSON.stringify(msg.state);
        if (stateJson === lastStateJson) break;
        lastStateJson = stateJson;
      }
      if (msg.state.phase !== 'shop') selectedShopIdx = -1;
      // Don't rebuild the table mid-drag - that yanks the card out of your
      // hand ("let go randomly"). Stash it and catch up when the drag ends.
      if (isDragging()) { lastState = msg.state; deferredRender = true; break; }
      prevState = lastState;
      lastState = msg.state;
      const animRefs = captureAnimationRefs(prevState, msg.state);
      renderGame(msg.state);
      runAnimations(prevState, msg.state, animRefs);
      if (msg.state.phase === 'gameover') {
        recordSoloResult(msg.state);
        refreshSoloContinue();
      }
      break;
    case 'log':
      addLog(msg.text);
      break;
    case 'error':
      if (view === 'game' && /room no longer exists/i.test(msg.text || '')) {
        recordDiagnostic('Ignored stale room error', msg.text || 'Room no longer exists.');
        break;
      }
      recordDiagnostic('server/client error', msg.text || 'Unknown error');
      toast(msg.text);
      break;
    case 'hostLeft':
      dropGuest(msg.text || 'The host closed the table.');
      break;
    case 'left':
      if (!intentionalLobbyReturn && view === 'game') {
        recordDiagnostic('Ignored stale lobby return', 'Received a left message after a new game was already active.');
        break;
      }
      if (!intentionalLobbyReturn) {
        recordDiagnostic('unexpected lobby return', 'Received a left message without pressing Leave/Exit.');
      }
      myRoomId = null;
      sessionStorage.removeItem('crib_room');
      hostSession = null;
      stopMqttSync();
      clearGuestTransports();
      showView('lobby');
      intentionalLobbyReturn = false;
      if (!P2P_MODE) renderRoomList(msg.rooms || []);
      refreshSoloContinue();
      break;
  }
}

// ---- views ----

function showView(v) {
  view = v;
  $('lobby').classList.toggle('hidden', v !== 'lobby');
  $('waiting').classList.toggle('hidden', v !== 'waiting');
  $('game').classList.toggle('hidden', v !== 'game');
  if (v !== 'game') {
    $('overlay').classList.add('hidden');
    closeFocus();
    lastState = prevState = null;
    lastStateJson = '';
    lastJokerSig = null;
    lastOverlayPhase = 'none';
    document.body.classList.remove('my-turn', 'mode-board', 'phase-discard', 'phase-pegging', 'phase-scoring', 'phase-roundEnd', 'phase-shop', 'phase-gameover');
    ensureBoardShell().classList.add('hidden');
  }
  if (v === 'lobby') {
    waitingDeckEffects = true;
    refreshSoloContinue();
    renderDiagnosticBanner();
  }
}

function recordDiagnostic(title, detail = '', extra = {}) {
  const diag = {
    title: String(title || 'Diagnostic'),
    detail: String(detail || ''),
    build: APP_BUILD,
    view,
    roomId: myRoomId || '',
    p2p: !!P2P_MODE,
    phase: lastState && lastState.phase || '',
    mode: lastState && lastState.mode || selectedGameMode || '',
    lastAction: lastUserAction,
    recentMessages: messageTrace.slice(),
    url: location.href,
    userAgent: navigator.userAgent,
    at: new Date().toLocaleString(),
    ...extra,
  };
  try { localStorage.setItem(DIAG_KEY, JSON.stringify(diag)); } catch { /* ignore */ }
  console.warn('[Crib diagnostic]', diag);
  return diag;
}

function diagnosticText(diag) {
  return [
    `${diag.title || 'Diagnostic'} (${diag.at || 'unknown time'})`,
    `Detail: ${diag.detail || ''}`,
    `Build: ${diag.build || ''}`,
    `View: ${diag.view || ''}`,
    `Phase: ${diag.phase || ''}`,
    `Mode: ${diag.mode || ''}`,
    `Room: ${diag.roomId || ''}`,
    `P2P: ${diag.p2p ? 'yes' : 'no'}`,
    `Last action: ${diag.lastAction || ''}`,
    `URL: ${diag.url || ''}`,
    `User agent: ${diag.userAgent || ''}`,
    diag.stack ? `\nStack:\n${diag.stack}` : '',
    diag.message ? `\nMessage:\n${diag.message}` : '',
    diag.raw ? `\nRaw:\n${diag.raw}` : '',
    `\nRecent messages:\n${(diag.recentMessages || []).map(m => `${m.at} ${m.source} ${m.type} ${m.phase} ${m.summary}`).join('\n')}`,
  ].filter(Boolean).join('\n');
}

async function copyDiagnostic(diag) {
  const text = diagnosticText(diag);
  try {
    await navigator.clipboard.writeText(text);
    toast('Crash report copied.');
  } catch {
    showInfo('Crash Report', `<textarea class="diagnostic-copy" readonly>${esc(text)}</textarea>`);
  }
}

function showDiagnosticDetails(diag) {
  showInfo('Crash Report', `<div class="diagnostic-details">
    <p>This is saved locally so you can send it after a crash drops you back here.</p>
    <textarea class="diagnostic-copy" readonly>${esc(diagnosticText(diag))}</textarea>
    <button id="copyDiagBtn" class="btn primary wide" type="button">Copy Report</button>
  </div>`);
  $('copyDiagBtn').onclick = () => copyDiagnostic(diag);
}

function renderDiagnosticBanner() {
  const el = $('diagnosticBanner');
  if (!el) return;
  let diag = null;
  try { diag = JSON.parse(localStorage.getItem(DIAG_KEY) || 'null'); } catch { diag = null; }
  if (!diag) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  el.innerHTML = `<b>${esc(diag.title)}</b><span>${esc(diag.detail || '')}</span><small>${esc(diag.at || '')}${diag.phase ? ` - ${esc(diag.phase)}` : ''}${diag.roomId ? ` - room ${esc(diag.roomId)}` : ''}</small><div class="diagnostic-actions"><button type="button" class="btn small" data-diag="details">Details</button><button type="button" class="btn small" data-diag="copy">Copy</button><button type="button" class="btn small" data-diag="dismiss">Dismiss</button></div>`;
  const detailsBtn = el.querySelector('[data-diag="details"]');
  const copyBtn = el.querySelector('[data-diag="copy"]');
  const dismissBtn = el.querySelector('[data-diag="dismiss"]');
  if (detailsBtn) detailsBtn.onclick = () => showDiagnosticDetails(diag);
  if (copyBtn) copyBtn.onclick = () => copyDiagnostic(diag);
  if (dismissBtn) dismissBtn.onclick = () => {
    localStorage.removeItem(DIAG_KEY);
    renderDiagnosticBanner();
  };
}

function reportCrash(title, err, extra = {}) {
  const detail = err && (err.message || String(err)) || 'Unknown error';
  const diag = recordDiagnostic(title, detail, {
    stack: err && err.stack || '',
    ...extra,
  });
  showView('lobby');
  renderDiagnosticBanner();
  toast('Crash report saved on the home screen.');
  return diag;
}

function forceLobby(reason, meta = {}) {
  const detail = meta.detail ? `${reason}: ${meta.detail}` : reason;
  recordDiagnostic('Returned to home screen', detail);
  clearGuestTransports();
  stopMqttSync();
  myRoomId = null;
  sessionStorage.removeItem('crib_room');
  hostSession = null;
  intentionalLobbyReturn = false;
  toast(reason);
  showView('lobby');
}

function toast(text) {
  sfx(text && /error|lost|unavailable|failed|invalid|cannot|not enough/i.test(text) ? 'error' : 'toast');
  const t = $('toast');
  t.textContent = text;
  sanitizeIcons(t);
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 3000);
}

window.addEventListener('error', e => {
  const err = e.error || new Error(`${e.message || 'Unknown error'}${e.filename ? ` at ${e.filename}:${e.lineno || 0}` : ''}`);
  reportCrash('JavaScript error', err, { filename: e.filename || '', line: e.lineno || 0, column: e.colno || 0 });
});

window.addEventListener('unhandledrejection', e => {
  const err = e.reason instanceof Error ? e.reason : new Error(e.reason && String(e.reason) || 'Unknown promise rejection');
  reportCrash('Unhandled app error', err);
});

function showInfo(title, body) {
  $('infoTitle').textContent = title;
  $('infoBody').innerHTML = body;
  $('infoPanel').classList.toggle('wide', !!$('infoBody').querySelector('.dictionary, .howto'));
  $('infoOverlay').classList.remove('hidden');
  sanitizeIcons($('infoOverlay'));
}

document.addEventListener('click', e => {
  const actionEl = e.target.closest('button, .card, .shop-item, .jtile, .sell-cell, .info-btn, [data-solo-deck]');
  if (actionEl) {
    const label = actionEl.textContent && actionEl.textContent.trim().replace(/\s+/g, ' ').slice(0, 80);
    lastUserAction = `clicked ${actionEl.id || actionEl.dataset && Object.keys(actionEl.dataset)[0] || actionEl.className || actionEl.tagName}${label ? ` (${label})` : ''}`;
  }
  const stamp = e.target.closest('.stamp-pill');
  if (stamp) {
    e.stopPropagation();
    e.preventDefault();
    showInfo('Edition', `<p>${esc(stampText(stamp.dataset.stamp))}</p>`);
    return;
  }
  if (actionEl) sfx('click');
});

$('howToBtn').innerHTML = icon('info', 'How to Play');
$('profileBtn').textContent = 'Profile';
$('soloBtn').innerHTML = icon('bot', 'Play Solo vs The House');
$('syncBtn').innerHTML = icon('refresh');
$('exitSoloBtn').textContent = 'Exit';
$('dictBtn').textContent = 'Cards';
$('deckBtn').innerHTML = icon('deck', 'Deck');
sanitizeIcons(document.body);

const continueSoloBtn = document.createElement('button');
continueSoloBtn.id = 'continueSoloBtn';
continueSoloBtn.className = 'btn primary wide';
continueSoloBtn.style.marginTop = '10px';
continueSoloBtn.innerHTML = icon('deck', 'Continue Solo Run');
$('soloBtn').insertAdjacentElement('beforebegin', continueSoloBtn);
continueSoloBtn.classList.add('hidden');
refreshSoloContinue();

$('infoClose').onclick = () => $('infoOverlay').classList.add('hidden');
$('infoOverlay').onclick = e => {
  if (e.target === $('infoOverlay')) $('infoOverlay').classList.add('hidden');
};

function showHowToPlay() {
  showInfo('How to Play', `<div class="howto">
    <h4>The goal</h4>
    <p>Cribbage as a roguelike. Each <b>round</b> you must score at least the
    round's <b>blind</b> or you're knocked out. Blinds climb fast, so you build
    an engine of jokers and tarots to keep up. Multiplayer: last player standing
    wins. Solo vs The House: see how many rounds you can survive.</p>

    <h4>A deal, step by step</h4>
    <ol>
      <li><b>Discard</b> to the crib (the dealer's bonus hand).</li>
      <li><b>Cut</b> a starter card - shared by every hand.</li>
      <li><b>Pegging</b> - take turns laying cards, keeping the running count at 31 or under.</li>
      <li><b>The show</b> - hands are counted, then the crib.</li>
    </ol>

    <h4>Scoring - Points x Mult</h4>
    <p>Your hand's combos are <span class="chip-blue">Points</span> (blue):
    fifteens 2, pairs 2, runs 1 per card, flush, and His Nobs (Jack matching the
    starter's suit).</p>
    <p>Everything you peg becomes <span class="chip-red">Mult</span> (red).
    Each hand starts at <b>x1</b>, and every pegging point (15s, 31s, pairs,
    runs, go, His Heels) adds to it.</p>
    <p>At the show, <b>Points x Mult = the deal's score</b>. So a fat hand with a
    big pegging Mult snowballs - that's how you beat late blinds. The <b>crib</b>
    uses the dealer's Mult too, so dealer turns can swing hard.</p>

    <h4>Pegging points</h4>
    <ul>
      <li>Count reaches <b>15</b> or <b>31</b>: +2 Mult</li>
      <li>Pairs / trips / quads as you lay them: +2 / +6 / +12</li>
      <li>Runs of 3+ in a row: +1 per card</li>
      <li><b>Go</b> / last card when nobody else can play: +1</li>
    </ul>

    <h4>Your deck</h4>
    <p>You own a personal deck (starts as a normal 52) and are dealt from it.
    It's permanent - tarots and packs change the actual cards in it. Tap
    <b>Deck</b> any time to view it.</p>

    <h4>Jokers</h4>
    <p>Passive cards bought in the shop. They sit beside your hand and boost your
    Points or Mult automatically - e.g. stronger fifteens, conditional pegging,
    or crib Mult. Hold up to 5; drag to reorder (<i>Blueprint</i> copies the joker to its
    right).</p>

    <h4>Joker Editions</h4>
    <p>A joker can randomly arrive with one Edition. <b>Foil</b> adds +5 Hand Points,
    <b>Holographic</b> adds +3 Mult, <b>Polychrome</b> multiplies Mult by x1.5, and
    <b>Negative</b> adds one Joker slot. Editions are shown by a glowing badge and finish.</p>
    <div id="editionHowto" class="howto-visual-grid"></div>

    <h4>Playing Card Enhancements</h4>
    <p>Enhanced cards keep their rank unless the effect says otherwise. Their frame shows
    the enhancement, and tapping a card in the deck viewer explains the effect.</p>
    <div id="enhancementHowto" class="howto-visual-grid enhancement-guide"></div>

    <h4>Tarots</h4>
    <p>One-shot cards (hold up to 2), played <b>during the discard phase before
    you discard</b>. They permanently edit your deck - change a card's rank,
    suit, or Enhancement, copy or destroy cards, add a copy, or grab coins.
    Zero-target tarots such as Wheel of Fortune can also be used in the shop.</p>

    <h4>Booster packs &amp; the shop</h4>
    <p>After every deal you earn coins and the shop opens. Buy jokers, tarots, or
    <b>booster packs</b> - open a pack to pick 1 of 3 (jokers, tarots, or cards
    to add to your deck). Tap a shop card to flip it and read it, tap again to
    buy. Reroll for fresh stock.</p>

    <h4>Deck styles</h4>
    <p>Before a House run or while waiting at a table, choose a deck. Hosts can
    turn deck effects off so decks become artwork only.</p>
    <ul>
      ${DECK_ARTS.map(d => `<li><b>${esc(d.name)}</b>: ${esc(d.desc)}</li>`).join('')}
    </ul>

    <h4>Strategy</h4>
    <ul>
      <li><b>Pegging is your multiplier.</b> A 12-point hand at x1 is 12, but
      peg 4 points first and it's 12 x5 = 60. Hunt 15s, 31s and pairs while
      laying cards - often worth more than the points you keep.</li>
      <li><b>Keep Points and Mult balanced.</b> A huge hand at x1, or a tiny
      hand at x8, both fizzle. Buy jokers that lift whichever you're short on.</li>
      <li><b>Build an engine early.</b> Round 1-2 blinds are gentle - spend
      coins on jokers that compound (repricers, suit/rank bonuses, conditional
      pegging) rather than hoarding.</li>
      <li><b>Sculpt your deck.</b> Tarots and Standard packs let you load up on
      one suit (for flushes) or rank (for fifteens/pairs). A focused deck scores
      far more reliably than a random 52.</li>
      <li><b>Mind the crib.</b> It uses the dealer's Mult, so the dealer wants high-scoring
      cards in it - and non-dealers should avoid handing the dealer easy points.
      Crib jokers (Golden/Steel Crib, Copier, 5-Maker) only pay you on your deal.</li>
      <li><b>Race for the blind.</b> Clearing it first earns the most bonus
      coins - and once everyone clears, the round ends early.</li>
    </ul>

    <h4>Controls</h4>
    <p>Tap a card to lift it, tap again or <b>drag</b> it onto the crib/pile to
    play. Toggle <b>Tips</b> (top bar) for in-game hints.</p>
  </div>`);
  const editionGrid = $('editionHowto');
  const editionDefs = [
    ['foil', 'Foil', '+5 Hand Points'],
    ['holographic', 'Holographic', '+3 Mult'],
    ['polychrome', 'Polychrome', 'x1.5 Mult'],
    ['negative', 'Negative', '+1 Joker slot'],
  ];
  for (const [stamp, name, effect] of editionDefs) {
    const cell = document.createElement('div');
    cell.className = 'howto-visual';
    cell.appendChild(jtile('joker', { ...JOKERS[0], stamp }));
    cell.insertAdjacentHTML('beforeend', `<b>${name}</b><span>${effect}</span>`);
    editionGrid.appendChild(cell);
  }
  const enhancementGrid = $('enhancementHowto');
  Object.entries(CARD_ENHANCEMENTS).forEach(([id, meta], idx) => {
    const cell = document.createElement('div');
    cell.className = 'howto-visual';
    cell.appendChild(cardEl({ id: `guide-${id}`, rank: (idx % 9) + 1, suit: idx % 4, enhancement: id }));
    cell.insertAdjacentHTML('beforeend', `<b>${esc(meta.name)}</b><span>${esc(meta.desc)}</span>`);
    enhancementGrid.appendChild(cell);
  });
}

$('howToBtn').onclick = () => showHowToPlay();

function addLog(text) {
  const log = $('log');
  const div = document.createElement('div');
  if (text.startsWith('---') || text.startsWith('===')) div.className = 'hl';
  div.textContent = text;
  sanitizeIcons(div);
  log.appendChild(div);
  while (log.children.length > 60) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

function addInfoButton(el, title, body) {
  const btn = document.createElement('button');
  btn.className = 'info-btn';
  btn.type = 'button';
  btn.textContent = 'i';
  btn.onclick = e => {
    e.stopPropagation();
    e.preventDefault();
    showInfo(title, body);
  };
  el.appendChild(btn);
  return btn;
}

function showItemInfo(kind, def, action) {
  const timing = kind === 'joker'
    ? 'Jokers are passive. They trigger automatically whenever their condition is met.'
    : 'Tarots are one-shot cards. Use them before you discard, then pick the required target card(s).';
  showInfo(def.name, `<p>${esc(def.desc)}</p><p>${timing}</p>`);
  if (action) {
    const meta = div.querySelector('.meta');
    if (meta) meta.textContent = `${modeLabel(r.mode, r.goalScore)} - ${r.count}/6 players - ${(r.players || []).join(', ')}`;
    const btn = document.createElement('button');
    btn.className = 'btn primary';
    btn.textContent = `Use ${def.name}`;
    btn.onclick = () => {
      $('infoOverlay').classList.add('hidden');
      action();
    };
    $('infoBody').appendChild(btn);
  }
}

// ---- lobby ----

function myName() {
  return $('nameInput').value.trim();
}

function readProfiles() {
  try {
    const data = JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}');
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function writeProfiles(profiles) {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profiles));
}

function activeProfilePin() {
  const pin = localStorage.getItem(ACTIVE_PROFILE_KEY) || '';
  return /^\d{4}$/.test(pin) ? pin : '';
}

function activeProfile() {
  const pin = activeProfilePin();
  return pin ? readProfiles()[pin] || null : null;
}

function normalizeProfile(p) {
  if (!p) return null;
  p.deckTokens = Math.max(0, p.deckTokens || 0);
  p.ownedDecks = Array.isArray(p.ownedDecks) && p.ownedDecks.length
    ? [...new Set([...FREE_DECK_IDS, ...p.ownedDecks])]
    : FREE_DECK_IDS.slice();
  p.deckArt = p.ownedDecks.includes(p.deckArt) ? p.deckArt : 'classic';
  return p;
}

function activeDeckArt() {
  if (view === 'game' && lastState && lastState.you && lastState.you.deckArt) return lastState.you.deckArt;
  const p = normalizeProfile(activeProfile());
  return (p && p.deckArt) || selectedDeckArt || 'classic';
}

function normalizeDeckArtId(id) {
  return DECK_ARTS.some(a => a.id === id) ? id : 'classic';
}

function deckEffectsOn(st) {
  return !st || !st.you || st.you.deckEffects !== false;
}

function generateLightningSvg(seed, width, height, color = '#63f7ff') {
  let n = seed >>> 0;
  const rand = () => {
    n = (n * 1664525 + 1013904223) >>> 0;
    return n / 4294967296;
  };
  const pts = [];
  const steps = 8;
  const startY = height * (0.32 + rand() * 0.36);
  for (let i = 0; i <= steps; i++) {
    const x = -18 + (width + 36) * (i / steps);
    const y = startY + (rand() - 0.5) * height * 0.44 + Math.sin(i * 1.45 + seed) * height * 0.12;
    pts.push([Math.round(x), Math.round(Math.max(-12, Math.min(height + 12, y)))]);
  }
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join(' ');
  const branches = [];
  for (let i = 2; i < pts.length - 1; i++) {
    if (rand() < 0.92) {
      const [x, y] = pts[i];
      const dir = rand() < 0.5 ? -1 : 1;
      const len = 24 + rand() * 42;
      const bx = x + (18 + rand() * 28);
      const by = y + dir * len;
      const kinkX = x + 8 + rand() * 16;
      const kinkY = y + dir * (10 + rand() * 18);
      branches.push(`M${x} ${y} L${Math.round(kinkX)} ${Math.round(kinkY)} L${Math.round(bx)} ${Math.round(by)}`);
      if (rand() < 0.45) {
        const twigX = kinkX + 14 + rand() * 18;
        const twigY = kinkY - dir * (8 + rand() * 18);
        branches.push(`M${Math.round(kinkX)} ${Math.round(kinkY)} L${Math.round(twigX)} ${Math.round(twigY)}`);
      }
    }
  }
  const branchPath = branches.join(' ');
  const glow = encodeURIComponent(color);
  const core = encodeURIComponent('#ffffff');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="${path} ${branchPath}" stroke="${glow}" stroke-width="13" stroke-opacity=".24"/><path d="${path} ${branchPath}" stroke="${glow}" stroke-width="6" stroke-opacity=".50"/><path d="${path}" stroke="${core}" stroke-width="2.8" stroke-opacity=".96"/><path d="${branchPath}" stroke="${core}" stroke-width="1.8" stroke-opacity=".76"/></g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function initNeonLightning() {
  const root = document.documentElement;
  root.style.setProperty('--neon-lightning-a', generateLightningSvg(0xC1A011, 170, 125, '#63f7ff'));
  root.style.setProperty('--neon-lightning-b', generateLightningSvg(0xB0177A, 140, 108, '#8fe7ff'));
}
initNeonLightning();

function animateDeckBackground(now = 0) {
  const root = document.documentElement;
  root.style.setProperty('--deck-bg-x', `${now / 18}px`);
  root.style.setProperty('--deck-bg-y', `${now / 60}px`);
  root.style.setProperty('--deck-bg-x2', `${now / 30}px`);
  root.style.setProperty('--deck-bg-y2', `${now / 84}px`);
  root.style.setProperty('--deck-bg-x3', `${now / 46}px`);
  root.style.setProperty('--deck-bg-y3', `${now / 120}px`);
  root.style.setProperty('--neon-bolt-x', `${now / 170}px`);
  root.style.setProperty('--neon-bolt-y', `${now / 280}px`);
  root.style.setProperty('--neon-bolt-x2', `${-(now / 230)}px`);
  root.style.setProperty('--neon-bolt-y2', `${now / 340}px`);
  root.style.setProperty('--aurora-x', `${Math.sin(now / 2200) * 95}px`);
  root.style.setProperty('--aurora-y', `${Math.cos(now / 2500) * 62}px`);
  root.style.setProperty('--aurora-x2', `${Math.cos(now / 2600) * 80}px`);
  root.style.setProperty('--aurora-y2', `${Math.sin(now / 2300) * 55}px`);
  root.style.setProperty('--gambit-x', `${now / 24}px`);
  root.style.setProperty('--gambit-y', `${Math.sin(now / 1800) * 55}px`);
  root.style.setProperty('--gambit-x2', `${-(now / 38)}px`);
  root.style.setProperty('--gambit-y2', `${Math.cos(now / 2100) * 44}px`);
  document.querySelectorAll('.card.back.deck-aurora, .card.back.deck-neon, .card.back.deck-cosmic, .card.back.deck-gambit').forEach((card) => {
    const rect = card.getBoundingClientRect();
    card.style.setProperty('--deck-card-left', `${rect.left}px`);
    card.style.setProperty('--deck-card-top', `${rect.top}px`);
  });
  requestAnimationFrame(animateDeckBackground);
}
requestAnimationFrame(animateDeckBackground);

function saveSelectedDeckArt(id) {
  id = normalizeDeckArtId(id);
  selectedDeckArt = id;
  localStorage.setItem('crib_deck_art', id);
  const pin = activeProfilePin();
  if (!pin) return;
  const profiles = readProfiles();
  const p = normalizeProfile(profiles[pin]);
  if (!p || !p.ownedDecks.includes(id)) return;
  p.deckArt = id;
  p.updatedAt = Date.now();
  profiles[pin] = p;
  writeProfiles(profiles);
  renderProfileStatus();
}

function saveActiveProfileName() {
  const pin = activeProfilePin();
  if (!pin) return;
  const name = myName();
  if (!name) return;
  const profiles = readProfiles();
  const p = profiles[pin];
  if (!p) return;
  p.name = name;
  p.updatedAt = Date.now();
  writeProfiles(profiles);
  renderProfileStatus();
}

function renderProfileStatus() {
  const el = $('profileStatus');
  if (!el) return;
  const p = activeProfile();
  normalizeProfile(p);
  el.textContent = p ? `Profile: ${p.name} - Deck tokens ${p.deckTokens || 0}` : 'No profile saved';
}

$('nameInput').value = localStorage.getItem('crib_name') || (activeProfile() && activeProfile().name) || '';
$('nameInput').addEventListener('input', () => {
  localStorage.setItem('crib_name', myName());
  saveActiveProfileName();
});
renderProfileStatus();

function showProfile() {
  const p = activeProfile();
  const saved = readSoloSave();
  const leaderboard = leaderboardRows();
  const savedDeck = saved && saved.game && saved.game.players
    ? (saved.game.players.find(x => !x.isBot) || {}).deckArt || 'classic'
    : 'classic';
  const savedRound = saved && saved.game ? saved.game.round || 1 : 1;
  const savedScore = saved && saved.game && saved.game.players
    ? (saved.game.players.find(x => !x.isBot) || {}).score || 0
    : 0;
  showInfo('Profile', `<div class="profile-box profile-grid">
    <div class="profile-section">
      <h4>Account</h4>
      <label>Name</label>
      <input id="profileNameInput" maxlength="16" value="${esc(myName() || (p && p.name) || '')}" placeholder="Your name">
      <label>4-digit PIN</label>
      <input id="profilePinInput" maxlength="4" inputmode="numeric" pattern="[0-9]*" value="${esc(activeProfilePin())}" placeholder="1234">
      <div class="profile-actions">
        <button id="profileSaveBtn" class="btn primary">Save / Login</button>
        <button id="profileLogoutBtn" class="btn">Forget PIN</button>
      </div>
      <p class="hint">Profiles and leaderboard scores are saved on this device.</p>
    </div>
    <div class="profile-section">
      <h4>House Games</h4>
      ${saved ? `<div class="solo-save-row"><b>Saved House run</b><span>Round ${savedRound} - ${Math.round(savedScore)} points</span><div class="card back deck-${esc(savedDeck)} small"></div><button id="profileContinueSoloBtn" class="btn primary wide">Continue Run</button></div>` : '<p class="hint">No saved House run on this device.</p>'}
    </div>
    <div class="profile-section">
      <h4>Leaderboard</h4>
      <div class="leaderboard">${leaderboard}</div>
    </div>
    <div class="profile-section">
      <h4>Deck Collection</h4>
      <button id="profileDecksBtn" class="btn wide">Choose Deck Artwork</button>
    </div>
  </div>`);
  const nameInput = $('profileNameInput');
  const pinInput = $('profilePinInput');
  $('profileSaveBtn').onclick = () => {
    const name = nameInput.value.trim();
    const pin = pinInput.value.trim();
    if (!name) return toast('Enter a name first.');
    if (!/^\d{4}$/.test(pin)) return toast('PIN must be 4 digits.');
    const profiles = readProfiles();
    const existing = normalizeProfile(profiles[pin]) || {};
    profiles[pin] = {
      pin,
      name,
      bestBlind: Math.max(0, existing.bestBlind || 0),
      bestScore: Math.max(0, existing.bestScore || 0),
      deckTokens: Math.max(0, existing.deckTokens || 0),
      ownedDecks: existing.ownedDecks || ['classic'],
      deckArt: existing.deckArt || selectedDeckArt || 'classic',
      updatedAt: Date.now(),
    };
    writeProfiles(profiles);
    localStorage.setItem(ACTIVE_PROFILE_KEY, pin);
    localStorage.setItem('crib_name', name);
    $('nameInput').value = name;
    renderProfileStatus();
    toast('Profile saved.');
  };
  $('profileLogoutBtn').onclick = () => {
    localStorage.removeItem(ACTIVE_PROFILE_KEY);
    renderProfileStatus();
    toast('PIN forgotten on this device.');
  };
  const cont = $('profileContinueSoloBtn');
  if (cont) cont.onclick = () => continueSoloRun();
  $('profileDecksBtn').onclick = () => showDeckArtShop();
}

function recordSoloResult(st) {
  if (!st.solo || st.phase !== 'gameover' || !st.you) return;
  const me = (st.standings || []).find(s => s.seat === st.mySeat) || { score: st.you.score || 0 };
  const score = Math.max(0, me.score || 0);
  const blind = Math.max(0, st.you.blindsPassed || 0);
  const key = `${score}-${blind}-${st.round}`;
  if (key === lastRecordedRunKey) return;
  lastRecordedRunKey = key;
  const pin = activeProfilePin();
  if (!pin) return;
  const profiles = readProfiles();
  const p = profiles[pin];
  if (!p) return;
  p.name = myName() || p.name;
  p.bestScore = Math.max(p.bestScore || 0, score);
  p.bestBlind = Math.max(p.bestBlind || 0, blind);
  normalizeProfile(p);
  const wonRegular = st.mode === 'blind' && blind >= 9;
  if (wonRegular && p.lastDeckTokenRun !== key) {
    p.deckTokens = (p.deckTokens || 0) + 1;
    p.lastDeckTokenRun = key;
    toast('Regular run cleared! +1 deck token.');
  }
  p.updatedAt = Date.now();
  writeProfiles(profiles);
  renderProfileStatus();
}

function selectDeckArt(id, sync = true) {
  saveSelectedDeckArt(id);
  if (sync && view === 'waiting') sendMsg({ t: 'setDeckArt', deckArt: id });
}

function leaderboardRows() {
  const profiles = Object.values(readProfiles())
    .filter(p => p && p.name)
    .sort((a, b) => (b.bestBlind || 0) - (a.bestBlind || 0) || (b.bestScore || 0) - (a.bestScore || 0) || a.name.localeCompare(b.name));
  return profiles.length ? profiles.map((p, i) =>
    `<div class="leader-row"><span>${i + 1}. ${esc(p.name)}</span><span>Blind ${p.bestBlind || 0}</span><span>${p.bestScore || 0} pts</span></div>`
  ).join('') : '<p class="hint">No solo runs recorded yet. Save a profile, play The House, then come back.</p>';
}

function showLeaderboard() {
  const rows = leaderboardRows();
  showInfo('Leaderboard', `<div class="leaderboard">${rows}</div>`);
}

function showDeckArtShop() {
  const pin = activeProfilePin();
  const profiles = readProfiles();
  const p = pin ? normalizeProfile(profiles[pin]) : null;
  const tokens = p ? p.deckTokens || 0 : 0;
  const owned = p ? p.ownedDecks : ['classic'];
  const active = p ? p.deckArt : activeDeckArt();
  const cards = DECK_ARTS.map(art => {
    const has = owned.includes(art.id) || art.cost === 0;
    const selected = active === art.id;
    return `<div class="deck-art-item${selected ? ' selected' : ''}" data-deck="${art.id}">
      <div class="card back deck-${art.id} preview"></div>
      <div class="deck-art-copy">
        <b>${esc(art.name)}</b>
        <span>${esc(art.desc)}</span>
        <small>${art.cost ? `${art.cost} deck token${art.cost === 1 ? '' : 's'}` : 'Free'}${art.animated ? ' - animated' : ''}</small>
      </div>
      <button class="btn small ${has ? '' : 'primary'}" data-deck-action="${art.id}">${selected ? 'Selected' : has ? 'Select' : 'Buy'}</button>
    </div>`;
  }).join('');
  showInfo('Decks', `<div class="deck-art-shop">
    <div class="deck-token-row">Deck tokens: <b>${tokens}</b></div>
    ${pin ? '' : '<p class="hint">Save a profile with a 4-digit PIN to earn and spend deck tokens.</p>'}
    ${cards}
  </div>`);
  document.querySelectorAll('[data-deck-action]').forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.deckAction;
      const art = DECK_ARTS.find(a => a.id === id);
      if (!art) return;
      const activePin = activeProfilePin();
      if (!activePin) return toast('Save a profile first.');
      const all = readProfiles();
      const prof = normalizeProfile(all[activePin]);
      if (!prof) return toast('Save a profile first.');
      const bought = !prof.ownedDecks.includes(id);
      if (bought) {
        if ((prof.deckTokens || 0) < art.cost) return toast('Not enough deck tokens.');
        prof.deckTokens -= art.cost;
        prof.ownedDecks.push(id);
      }
      prof.deckArt = id;
      prof.updatedAt = Date.now();
      all[activePin] = prof;
      writeProfiles(all);
      selectDeckArt(id);
      showDeckArtShop();
      toast(bought ? `${art.name} bought and selected.` : `${art.name} selected.`);
    };
  });
}

$('profileBtn').onclick = () => showProfile();

function syncModeControls() {
  document.querySelectorAll('#modeToggle button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === selectedGameMode);
  });
}

document.querySelectorAll('#modeToggle button').forEach(btn => {
  btn.onclick = () => {
    selectedGameMode = normalizeMode(btn.dataset.mode);
    localStorage.setItem('crib_game_mode', selectedGameMode);
    syncModeControls();
  };
});
syncModeControls();

if (P2P_MODE) {
  $('wsPanel').classList.add('hidden');
  $('p2pPanel').classList.remove('hidden');
  $('hostBtn').onclick = () => {
    if (!myName()) return toast('Enter a name first.');
    hostTable();
  };
  $('refreshBtn').onclick = () => {
    pruneP2pRooms();
    renderP2pRooms();
  };
  renderP2pRooms();
  startP2pLobbyDiscovery();
} else {
  $('createBtn').onclick = () => {
    if (!myName()) return toast('Enter a name first.');
    sendMsg({ t: 'createRoom', roomName: $('roomNameInput').value.trim() || `${myName()}'s table`, playerName: myName(), ...gameOptions() });
  };
  $('refreshBtn').onclick = () => sendMsg({ t: 'listRooms' });
}

$('soloBtn').onclick = () => {
  if (!myName()) return toast('Enter a name first.');
  showSoloDeckPicker();
};

async function startSoloVsHouse(deckArt) {
  selectDeckArt(deckArt, false);
  $('infoOverlay').classList.add('hidden');
  if (P2P_MODE) {
    const { HostSession, makeCode } = await import('./net/host.js?v=3');
    hostSession = new HostSession(makeCode(), myName(), msg => safeHandle(msg, 'solo host'), () => {}, { solo: true, saveKey: SOLO_SAVE_KEY, ...gameOptions() });
  } else {
    sendMsg({ t: 'createSolo', playerName: myName(), ...gameOptions() });
  }
}

function showSoloDeckPicker() {
  const active = activeDeckArt();
  const cards = DECK_ARTS.map(art => `<div class="deck-art-item${active === art.id ? ' selected' : ''}" data-solo-deck="${art.id}">
    <div class="card back deck-${art.id} preview"></div>
    <div class="deck-art-copy">
      <b>${esc(art.name)}</b>
      <span>${esc(art.desc)}</span>
      <small>${art.animated ? 'Animated' : 'Classic'}</small>
    </div>
  </div>`).join('');
  showInfo('Choose Deck', `<div class="solo-deck-picker">${cards}</div>`);
  document.querySelectorAll('[data-solo-deck]').forEach(el => {
    el.onclick = () => startSoloVsHouse(el.dataset.soloDeck);
  });
}

async function continueSoloRun() {
  const saved = readSoloSave();
  if (!saved) return refreshSoloContinue();
  const hostName = (saved.game && saved.game.players && saved.game.players.find(p => !p.isBot)?.name) || myName() || 'Player';
  localStorage.setItem('crib_name', hostName);
  $('nameInput').value = hostName;
  $('infoOverlay').classList.add('hidden');
  const { HostSession, makeCode } = await import('./net/host.js?v=3');
  hostSession = new HostSession(makeCode(), hostName, msg => safeHandle(msg, 'solo restore'), () => {}, {
    solo: true,
    saveKey: SOLO_SAVE_KEY,
    restoreState: saved,
  });
}

continueSoloBtn.onclick = () => continueSoloRun();

function readSoloSave() {
  try {
    const raw = localStorage.getItem(SOLO_SAVE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (!saved || !saved.game || !Array.isArray(saved.game.players)) return null;
    return saved;
  } catch {
    localStorage.removeItem(SOLO_SAVE_KEY);
    return null;
  }
}

function refreshSoloContinue() {
  continueSoloBtn.classList.add('hidden');
}

$('syncBtn').onclick = () => { sendMsg({ t: 'sync' }); toast('Refreshed.'); };
$('dictBtn').onclick = () => showDictionary();
$('exitSoloBtn').onclick = () => {
  sendMsg({ t: 'backToLobby' });
  toast('Solo run saved.');
};

$('updateBtn').onclick = async () => {
  try {
    if ('caches' in window) {
      for (const k of await caches.keys()) await caches.delete(k);
    }
    if (navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) await r.unregister();
    }
  } catch { /* best effort */ }
  location.reload();
};

function renderRoomList(rooms) {
  const el = $('roomList');
  el.innerHTML = '';
  if (!rooms.length) {
    el.innerHTML = '<div class="empty">No open tables - create one!</div>';
    return;
  }
  for (const r of rooms) {
    const div = document.createElement('div');
    div.className = 'room-item';
    div.innerHTML = `<div><b>${esc(r.name)}</b><div class="meta">${r.count}/6 players - ${esc(r.players.join(', '))}</div></div>`;
    const btn = document.createElement('button');
    btn.className = 'btn small primary';
    btn.textContent = 'Join';
    btn.onclick = () => {
      if (!myName()) return toast('Enter a name first.');
      if (P2P_MODE) joinByMqttCode(r.id);
      else sendMsg({ t: 'joinRoom', roomId: r.id, playerName: myName(), deckArt: activeDeckArt() });
    };
    div.appendChild(btn);
    el.appendChild(div);
  }
}

function startP2pLobbyDiscovery() {
  if (!P2P_MODE || p2pLobbyClients.length) return;
  if (!window.mqtt) {
    setTimeout(startP2pLobbyDiscovery, 500);
    return;
  }
  const onMessage = (topic, payload) => {
    if (topic !== P2P_LOBBY_TOPIC) return;
    let msg;
    try { msg = JSON.parse(payload.toString()); } catch { return; }
    if (msg.t !== 'lobbyUpdate' || !/^[A-Z0-9]{5}$/.test(String(msg.code || ''))) return;
    p2pRooms.set(msg.code, {
      id: msg.code,
      name: msg.name || `${msg.code} table`,
      count: Number(msg.count) || 1,
      players: Array.isArray(msg.players) ? msg.players : [],
      mode: normalizeMode(msg.mode),
      goalScore: 121,
      lastSeen: Date.now(),
    });
    renderP2pRooms();
  };
  p2pLobbyClients = P2P_LOBBY_BROKERS.map((url, idx) => {
    const client = window.mqtt.connect(url, {
      clientId: `orbcrib-list-${idx}-` + Math.random().toString(36).slice(2),
      clean: true,
      connectTimeout: 8000,
      reconnectPeriod: 3000,
    });
    client.on('connect', () => client.subscribe(P2P_LOBBY_TOPIC));
    client.on('message', onMessage);
    client.on('error', err => console.warn('Lobby discovery error:', url, err && err.message || err));
    return client;
  });
  setInterval(() => {
    if (pruneP2pRooms()) renderP2pRooms();
  }, 3000);
}

function pruneP2pRooms() {
  let changed = false;
  const now = Date.now();
  for (const [code, room] of p2pRooms) {
    if (now - room.lastSeen > P2P_LOBBY_TTL) {
      p2pRooms.delete(code);
      changed = true;
    }
  }
  return changed;
}

function renderP2pRooms() {
  renderRoomList([...p2pRooms.values()].sort((a, b) => b.lastSeen - a.lastSeen));
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

function icon(name, label = '') {
  return `<span class="ui-icon icon-${name}" aria-hidden="true"></span>${label}`;
}

function chip(amount = '') {
  return `<span class="ui-icon icon-chip" aria-hidden="true"></span>${amount}`;
}

function cleanLabel(label) {
  return String(label || '').replace(new RegExp(`\\s*${String.fromCodePoint(0x1F0CF)}`, 'gu'), ' [Joker]');
}

function sanitizeIcons(root = document.body) {
  const cp = n => String.fromCodePoint(n);
  const reps = [
    [cp(0x1FA99), chip()],
    [cp(0x1F916), icon('bot')],
    [cp(0x1F3C6), icon('winner')],
    [cp(0x1F451), icon('crown')],
    [cp(0x2728), icon('spark')],
    [cp(0x1F0A0), icon('deck')],
    [cp(0x24D8), icon('info')],
    [cp(0x1F504), icon('refresh')],
    [cp(0x1F0CF), icon('joker')],
    [cp(0x1F52E), icon('tarot')],
  ];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) {
    const n = walker.currentNode;
    if (reps.some(([token]) => n.nodeValue.includes(token))) nodes.push(n);
  }
  for (const node of nodes) {
    let html = esc(node.nodeValue);
    for (const [token, replacement] of reps) html = html.split(esc(token)).join(replacement);
    const frag = document.createElement('span');
    frag.innerHTML = html;
    node.replaceWith(...frag.childNodes);
  }
}

// ---- waiting room ----

function renderWaiting(msg) {
  $('waitRoomName').textContent = msg.room.name;
  $('waitCode').innerHTML = msg.code
    ? `Share this code: <b class="code">${esc(msg.code)}</b><div style="font-size:12px;margin-top:10px;color:#ff7b6e;"><b>Mobile Users:</b> Keep this tab open! Mobile browsers pause background tabs which causes the game to disconnect.</div>`
    : '';
  const el = $('waitPlayers');
  el.innerHTML = '';
  for (const p of msg.players) {
    const div = document.createElement('div');
    div.className = 'wp' + (p.connected ? '' : ' off');
    div.innerHTML = `<span class="wait-player-main">${esc(p.name)}${p.id === msg.hostId ? ' (host)' : ''}${p.connected ? '' : ' - disconnected'}</span>`;
    div.prepend(backEl(true, p.deckArt || 'classic'));
    el.appendChild(div);
  }
  const isHost = msg.youId === msg.hostId;
  const n = msg.players.filter(p => p.connected).length;
  waitingDeckEffects = !(msg.room && msg.room.deckEffects === false);
  renderWaitingDeckControls(msg, isHost);
  $('startBtn').classList.toggle('hidden', !isHost);
  $('startBtn').disabled = n < 2;
  const mode = normalizeMode(msg.room && msg.room.mode);
  const goal = msg.room && msg.room.goalScore;
  $('waitHint').textContent = n < 2 ? 'Waiting for at least 2 players...' :
    mode === 'board'
      ? `${n} players. Board mode: classic cribbage scoring - first to ${goal || 121} wins.`
      : mode === 'endless'
        ? `${n} players. Endless Blind: beat as many blinds as you can.`
        : `${n} players. Regular Blind: clear 9 blinds to win and earn a deck token.`;
}

function renderWaitingDeckControls(msg, isHost) {
  const el = $('waitDeckControls');
  if (!el) return;
  const current = normalizeDeckArtId((msg.players.find(p => p.id === msg.youId) || {}).deckArt || activeDeckArt());
  const signature = `${current}:${isHost}:${waitingDeckEffects}:${DECK_ARTS.length}`;
  if (el.dataset.signature === signature) return;
  el.dataset.signature = signature;
  el.innerHTML = `<div class="wait-deck-title">Your deck</div><div class="wait-deck-hint">Scroll to choose</div>`;
  const carousel = document.createElement('div');
  carousel.className = 'wait-deck-carousel';
  const row = document.createElement('div');
  row.className = 'wait-deck-row';
  for (const art of DECK_ARTS) {
    const btn = document.createElement('button');
    btn.className = `wait-deck-choice${art.id === current ? ' selected' : ''}`;
    btn.title = `${art.name}: ${art.desc}`;
    btn.dataset.deck = art.id;
    btn.appendChild(backEl(false, art.id));
    btn.insertAdjacentHTML('beforeend', `<span>${esc(art.name)}</span>`);
    btn.onclick = () => btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    row.appendChild(btn);
  }
  carousel.appendChild(row);
  el.appendChild(carousel);
  const description = document.createElement('div');
  description.className = 'wait-deck-description';
  el.appendChild(description);

  let centeredId = current;
  let settleTimer = null;
  let frame = 0;
  const updateCarousel = () => {
    frame = 0;
    const center = carousel.getBoundingClientRect().left + carousel.clientWidth / 2;
    let closest = null;
    let closestDistance = Infinity;
    row.querySelectorAll('.wait-deck-choice').forEach(btn => {
      const rect = btn.getBoundingClientRect();
      const distance = Math.abs(rect.left + rect.width / 2 - center);
      const ratio = Math.min(1, distance / Math.max(1, carousel.clientWidth * 0.48));
      btn.style.opacity = String(1 - ratio * 0.55);
      btn.style.transform = `scale(${1 - ratio * 0.28})`;
      if (distance < closestDistance) { closest = btn; closestDistance = distance; }
    });
    if (!closest) return;
    centeredId = closest.dataset.deck;
    row.querySelectorAll('.wait-deck-choice').forEach(btn => btn.classList.toggle('centered', btn === closest));
    const art = DECK_ARTS.find(d => d.id === centeredId);
    description.innerHTML = art ? `<b>${esc(art.name)}</b><span>${esc(art.desc)}</span>` : '';
  };
  const scheduleUpdate = () => {
    if (!frame) frame = requestAnimationFrame(updateCarousel);
    clearTimeout(settleTimer);
    settleTimer = setTimeout(commitCentered, 700);
  };
  const commitCentered = () => {
    clearTimeout(settleTimer);
    updateCarousel();
    if (centeredId !== current) selectDeckArt(centeredId);
  };
  carousel.addEventListener('scroll', scheduleUpdate, { passive: true });
  carousel.addEventListener('scrollend', commitCentered, { passive: true });
  carousel.addEventListener('wheel', e => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    e.preventDefault();
    carousel.scrollLeft += e.deltaY;
  }, { passive: false });
  let mouseDrag = null;
  let suppressClickUntil = 0;
  carousel.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    mouseDrag = { id: e.pointerId, x: e.clientX, scrollLeft: carousel.scrollLeft, moved: false };
    carousel.setPointerCapture(e.pointerId);
    carousel.classList.add('dragging');
  });
  carousel.addEventListener('pointermove', e => {
    if (!mouseDrag || e.pointerId !== mouseDrag.id) return;
    const dx = e.clientX - mouseDrag.x;
    if (Math.abs(dx) > 5) mouseDrag.moved = true;
    if (!mouseDrag.moved) return;
    e.preventDefault();
    carousel.scrollLeft = mouseDrag.scrollLeft - dx;
  });
  const finishMouseDrag = e => {
    if (!mouseDrag || e.pointerId !== mouseDrag.id) return;
    if (mouseDrag.moved) suppressClickUntil = Date.now() + 250;
    try { carousel.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    mouseDrag = null;
    carousel.classList.remove('dragging');
    scheduleUpdate();
  };
  carousel.addEventListener('pointerup', finishMouseDrag);
  carousel.addEventListener('pointercancel', finishMouseDrag);
  carousel.addEventListener('click', e => {
    if (Date.now() < suppressClickUntil) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
  requestAnimationFrame(() => {
    const selectedBtn = row.querySelector(`[data-deck="${current}"]`);
    if (selectedBtn) selectedBtn.scrollIntoView({ block: 'nearest', inline: 'center' });
    updateCarousel();
  });
  const effects = document.createElement('label');
  effects.className = `wait-effects-toggle${isHost ? '' : ' disabled'}`;
  effects.innerHTML = `<input type="checkbox" ${waitingDeckEffects ? 'checked' : ''} ${isHost ? '' : 'disabled'}>` +
    `<span>Deck effects ${waitingDeckEffects ? 'on' : 'off'}</span>`;
  if (isHost) {
    const input = effects.querySelector('input');
    input.onchange = () => {
      waitingDeckEffects = input.checked;
      sendMsg({ t: 'setDeckEffects', enabled: waitingDeckEffects });
    };
  }
  el.appendChild(effects);
}

$('startBtn').onclick = () => sendMsg({ t: 'startGame', ...gameOptions() });
$('leaveBtn').onclick = () => { if (P2P_MODE) leaveP2p(); else sendMsg({ t: 'leaveRoom' }); };

// ---- cards ----

function cardEl(card, opts = {}) {
  const div = document.createElement('div');
  div.className = 'card' + (card.suit < 2 && card.enhancement !== 'wild' ? ' red' : '') + (opts.small ? ' small' : '') +
    (card.enhancement ? ` enhancement-${card.enhancement}` : '');
  if (card.gambitCharged) div.classList.add('gambit-charged');
  if (card.enhancement === 'stone') {
    div.innerHTML = '<span class="stone-mark">STONE</span>';
  } else if (card.enhancement === 'wild') {
    div.innerHTML = `<span>${RANK_NAMES[card.rank]}</span><span class="wild-suit" aria-label="all suits"><i class="heart">&#9829;</i><i class="diamond">&#9830;</i><i class="club">&#9827;</i><i class="spade">&#9824;</i></span><span class="enhancement-badge">Wild</span>`;
  } else {
    const badge = card.enhancement ? `<span class="enhancement-badge">${esc(CARD_ENHANCEMENTS[card.enhancement].name.replace(' Card', ''))}</span>` : '';
    div.innerHTML = `<span>${RANK_NAMES[card.rank]}</span><span class="suit">${SUIT_CHARS[card.suit]}</span>${badge}`;
  }
  return div;
}

function backEl(small, deckArt = activeDeckArt()) {
  const div = document.createElement('div');
  div.className = `card back deck-${normalizeDeckArtId(deckArt)}` + (small ? ' small' : '');
  return div;
}

// ---- game rendering ----

function renderGame(st) {
  sweepStrayFx();
  $('dealInfo').textContent = `Round ${st.round} - Deal ${st.dealIndexInRound}/${st.dealsInRound}`;
  $('phaseInfo').textContent = phaseLabel(st);
  const turnP = st.players.find(p => p.seat === st.turnSeat);
  $('turnInfo').textContent =
    st.phase === 'pegging' && turnP ? (turnP.seat === st.mySeat ? 'Your turn' : `${turnP.name}'s turn`) : '';
  const effectsOn = deckEffectsOn(st);
  const cosmicTarget = effectsOn && st.you && st.you.deckArt === 'cosmic' && st.cosmicTarget ? st.cosmicTarget : null;
  if (cosmicTarget) $('turnInfo').textContent += `${$('turnInfo').textContent ? ' - ' : ''}Target ${cosmicTarget}`;
  $('exitSoloBtn').classList.toggle('hidden', !st.solo || st.phase === 'gameover');
  document.body.classList.remove('phase-discard', 'phase-pegging', 'phase-scoring', 'phase-roundEnd', 'phase-shop', 'phase-gameover');
  document.body.classList.add(`phase-${st.phase}`);
  document.body.classList.toggle('mode-board', st.mode === 'board');
  document.body.classList.toggle('deck-neon-active', !!(effectsOn && st.you && st.you.deckArt === 'neon'));
  ensureBoardShell().classList.toggle('hidden', st.mode !== 'board' || st.phase !== 'scoring');

  const myMove = !!st.you && st.you.active &&
    ((st.phase === 'pegging' && st.turnSeat === st.mySeat) || st.you.canDiscard);
  document.body.classList.toggle('my-turn', myMove);

  renderBlindBar(st);
  renderSeats(st);
  renderCenter(st);
  renderMyArea(st);
  renderOverlay(st);
  renderTutorial(st);
  sanitizeIcons($('game'));
}

function phaseLabel(st) {
  switch (st.phase) {
    case 'discard': return `Discard ${st.discardCount} to the crib`;
    case 'pegging': return 'Pegging';
    case 'scoring': return 'Counting hands';
    case 'roundEnd': return 'Blind check';
    case 'shop': return 'Shop';
    case 'gameover': return 'Game over';
    default: return '';
  }
}

// ---- blind progress bar ----

function renderBlindBar(st) {
  const el = $('blindProgress');
  const fill = $('blindBarFill');
  const label = $('blindBarLabel');

  if (st.mode === 'board') {
    const goal = st.goalScore || 121;
    const pct = st.you ? Math.min(100, Math.round(100 * st.you.score / goal)) : 0;
    el.classList.remove('out-label');
    fill.style.width = pct + '%';
    fill.className = pct >= 100 ? 'done' : pct >= 75 ? 'high' : pct >= 45 ? 'mid' : '';
    label.style.color = '';
    label.textContent = st.you ? `${st.you.score} / ${goal}  -  Board` : `Board to ${goal}`;
    return;
  }

  if (!st.you || !st.you.active) {
    el.classList.add('out-label');
    label.textContent = 'OUT - spectating';
    label.style.color = '#ff7b6e';
    fill.style.width = '0%';
    fill.className = '';
    return;
  }

  el.classList.remove('out-label');
  const blind = st.you.blind || st.blind;
  const pct = Math.min(100, Math.round(100 * st.you.roundScore / blind));
  fill.style.width = pct + '%';

  // Color classes based on progress
  fill.className = '';
  if (pct >= 100) fill.classList.add('done');
  else if (pct >= 75) fill.classList.add('high');
  else if (pct >= 45) fill.classList.add('mid');

  label.style.color = '';
  label.textContent = `${st.you.roundScore} / ${blind}  -  Blind`;
}

function renderSeats(st) {
  const el = $('seats');
  el.innerHTML = '';
  const n = st.players.length;
  const opponents = st.players.filter(p => p.seat !== st.mySeat);
  opponents.sort((a, b) =>
    ((a.seat - st.mySeat + n) % n) - ((b.seat - st.mySeat + n) % n));
  opponents.forEach((p, i) => {
    const k = opponents.length;
    const ang = (180 + (i + 1) * 180 / (k + 1)) * Math.PI / 180;
    const x = 50 + 40 * Math.cos(ang);
    const y = 54 + 38 * Math.sin(ang); // ring lowered so top seats clear the tip banner
    const seat = document.createElement('div');
    seat.className = 'seat' + (p.seat === st.turnSeat ? ' turn' : '')
      + (p.connected ? '' : ' off') + (p.active ? '' : ' out');
    seat.dataset.seat = p.seat;
    seat.style.left = x + '%';
    seat.style.top = y + '%';

    const plaque = document.createElement('div');
    plaque.className = 'plaque';
    plaque.innerHTML =
      `<span class="nm">${esc(p.name)}${p.isBot ? ' ' + icon('bot') : ''}</span> ${p.isDealer && p.active ? '<span class="dealer-chip">D</span>' : ''}`;
    if (p.isBot) {
      const nm = plaque.querySelector('.nm');
      if (nm) nm.innerHTML = `${esc(p.name)} ${icon('bot')}`;
    }
    // how far this player is toward the round's blind
    if (p.active && (st.blind || st.mode === 'board')) {
      const goal = st.mode === 'board' ? (st.goalScore || 121) : (p.blind || st.blind);
      const score = st.mode === 'board' ? p.score : p.roundScore;
      const pct = Math.min(100, Math.round(100 * score / goal));
      const done = score >= goal;
      plaque.insertAdjacentHTML('beforeend',
        `<div class="seat-blind${done ? ' done' : ''}">` +
        `<div class="seat-blind-fill" style="width:${pct}%"></div>` +
        `<span class="seat-blind-label">${score}/${goal}</span></div>`);
    }
    plaque.onclick = () => showPlayerJokers(p);
    plaque.title = `${p.name}'s jokers`;
    seat.appendChild(plaque);

    // the backs of their hand
    const backs = document.createElement('div');
    backs.className = 'backs' + (p.handCards && p.handCards.length ? ' cosmic-reveal' : '');
    if (p.handCards && p.handCards.length) {
      p.handCards.forEach(c => backs.appendChild(cardEl(c, { small: true })));
    } else {
      for (let c = 0; c < p.handCount; c++) backs.appendChild(backEl(true, p.deckArt));
    }
    seat.appendChild(backs);
    el.appendChild(seat);
  });
}

function renderCenter(st) {
  const deck = $('deckPile');
  deck.innerHTML = '';
  deck.appendChild(backEl());
  deck.insertAdjacentHTML('beforeend', '<div class="lbl">Deck</div>');

  const starter = $('starterPile');
  starter.innerHTML = '';
  starter.appendChild(st.starter ? cardEl(st.starter) : backEl());
  starter.insertAdjacentHTML('beforeend', '<div class="lbl">Starter</div>');

  const crib = $('cribPile');
  crib.innerHTML = '';
  const cribStack = document.createElement('div');
  cribStack.className = 'crib-card-stack';
  if (st.cribCards && st.cribCards.length) {
    st.cribCards.forEach(c => cribStack.appendChild(cardEl(c, { small: true })));
  } else if (st.cribDeckArts && st.cribDeckArts.length) {
    st.cribDeckArts.forEach(art => cribStack.appendChild(backEl(false, art)));
  } else {
    cribStack.appendChild(backEl());
  }
  crib.appendChild(cribStack);
  const dealer = st.players.find(p => p.isDealer);
  crib.insertAdjacentHTML('beforeend',
    `<div class="lbl">Crib x${st.cribCount} (${esc(dealer ? dealer.name : '')})</div>`);
  const stack = $('pegStack');
  stack.innerHTML = '';
  for (const c of st.pegStack) {
    const el = cardEl(c);
    el.dataset.cardId = c.id;
    stack.appendChild(el);
  }
  $('pegCount').textContent = st.phase === 'pegging' ? st.pegCount : '';
  const cosmicTarget = deckEffectsOn(st) && st.you && st.you.deckArt === 'cosmic' && st.cosmicTarget ? st.cosmicTarget : null;
  if (cosmicTarget) $('pegCount').dataset.target = `Target ${cosmicTarget}`;
  else delete $('pegCount').dataset.target;
}

const BOARD_COLORS = ['#ffd76e', '#63b8ff', '#ff6262', '#7ee08b', '#dfc8ff', '#ff9f43'];

function initBoard2d() {
  const canvas = $('board2d');
  if (!canvas) return boardView;
  if (boardView && boardView.canvas === canvas) return boardView;
  boardView = { canvas, ctx: canvas.getContext('2d'), targets: new Map(), lastTs: 0 };
  requestAnimationFrame(boardFrame);
  return boardView;
}

function boardPoint(score, lane, rect) {
  const n = Math.max(0, Math.min(121, score));
  const cols = 41;
  const row = Math.floor(n / cols);
  const colRaw = n % cols;
  const col = row % 2 ? cols - 1 - colRaw : colRaw;
  const padX = 34;
  const top = 34;
  const rowGap = Math.max(30, (rect.height - 86) / 2);
  return {
    x: padX + col * ((rect.width - padX * 2) / (cols - 1)),
    y: top + row * rowGap + (lane - 1) * 7,
  };
}

function addBoardSparkles(x, y, color) {
  for (let i = 0; i < 16; i++) {
    const a = Math.random() * Math.PI * 2;
    const speed = 26 + Math.random() * 46;
    boardFx.push({
      x, y, color, age: 0, life: 0.55 + Math.random() * 0.28,
      vx: Math.cos(a) * speed, vy: Math.sin(a) * speed - 20,
    });
  }
  sfx('boardPeg');
}

function boardFrame(ts) {
  const view = boardView;
  if (!view) return;
  const dt = Math.min(0.05, ((ts || 0) - (view.lastTs || ts || 0)) / 1000);
  view.lastTs = ts || 0;
  if (lastState && lastState.mode === 'board' && lastState.phase === 'scoring') {
    drawBoard2d(view, lastState, dt);
  }
  requestAnimationFrame(boardFrame);
}

function drawBoard2d(view, st, dt = 0) {
  const canvas = view.canvas;
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  const ctx = view.ctx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.fillStyle = '#5a351d';
  ctx.strokeStyle = '#2a170c';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(8, 8, rect.width - 16, rect.height - 18, 18);
  ctx.fill(); ctx.stroke();

  for (let lane = 0; lane < 3; lane++) {
    for (let i = 0; i <= 121; i++) {
      const hp = boardPoint(i, lane, rect);
      ctx.fillStyle = i % 5 === 0 ? '#130b06cc' : '#1f120bcc';
      ctx.beginPath();
      ctx.arc(hp.x, hp.y, i === 121 ? 6 : 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  boardPlayersFor(st).forEach((p, idx) => {
    const target = Math.min(121, p.score || 0);
    const cur = boardScoreDisplay.get(p.seat) ?? target;
    const next = cur + (target - cur) * Math.min(1, dt * 5.5);
    const landed = Math.abs(next - target) < 0.35 && Math.abs(cur - target) >= 0.35;
    boardScoreDisplay.set(p.seat, landed ? target : next);
    const pos = boardPoint(boardScoreDisplay.get(p.seat) || 0, idx % 3, rect);
    const color = BOARD_COLORS[p.seat % BOARD_COLORS.length];
    if (landed) addBoardSparkles(pos.x, pos.y, color);
    ctx.fillStyle = color;
    ctx.strokeStyle = '#fff8';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 8, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
  });

  boardFx = boardFx.filter(f => {
    f.age += dt;
    if (f.age >= f.life) return false;
    f.x += f.vx * dt;
    f.y += f.vy * dt;
    f.vy += 90 * dt;
    const alpha = 1 - f.age / f.life;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = f.color;
    ctx.beginPath();
    ctx.arc(f.x, f.y, 2 + 3 * alpha, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    return true;
  });
}

function renderBoard2d(st) {
  if (st.mode !== 'board' || st.phase !== 'scoring') return;
  const view = initBoard2d();
  const r = st.scoringResults && st.scoringResults[Math.min(st.revealIndex, st.scoringResults.length - 1)];
  const key = r ? `${st.dealNumber}:${st.revealIndex}:${r.seat}:${r.scoreAfter}` : '';
  if (r && key !== lastBoardRevealKey) {
    lastBoardRevealKey = key;
    boardScoreDisplay.set(r.seat, Math.min(121, r.scoreBefore || 0));
  }
  const boardPlayers = boardPlayersFor(st);
  $('board2dLegend').innerHTML = boardPlayers.map(p => {
    const color = BOARD_COLORS[p.seat % BOARD_COLORS.length];
    return `<span class="board-legend-item" style="color:${color}"><span class="board-dot" style="background:${color}"></span>${esc(p.name)} ${p.score}/121</span>`;
  }).join('');
  boardPlayers.forEach(p => {
    view.targets.set(p.seat, Math.min(121, p.score || 0));
    if (!boardScoreDisplay.has(p.seat)) boardScoreDisplay.set(p.seat, p.score || 0);
  });
  drawBoard2d(view, st, 0);
}

function boardPlayersFor(st) {
  const players = st.players.map(p => ({ ...p }));
  const future = (st.scoringResults || []).slice((st.revealIndex || 0) + 1);
  for (const r of future) {
    const p = players.find(x => x.seat === r.seat);
    if (p) p.score -= r.total || 0;
  }
  return players.map(p => ({ ...p, score: Math.max(0, Math.min(121, Math.round(p.score || 0))) }));
}

// joker/tarot rendered as a little card tile, Balatro-row style
function jtile(kind, def, opts = {}) {
  const d = document.createElement('div');
  const rarity = kind === 'joker' ? (def.rarity || 'common') : '';
  const stamp = kind === 'joker' ? def.stamp : '';
  d.className = 'jtile ' + kind + (rarity ? ' r-' + rarity : '') + (stamp ? ' stamp-' + stamp : '');
  const icon = (kind === 'joker' ? JOKER_ICONS : TAROT_ICONS)[def.id] || '';
  const rarityTag = rarity ? ` <i class="rar">(${rarity})</i>` : '';
  d.innerHTML = `<span class="jt-icon">${icon}<span class="jt-foil"></span></span>` +
    `<span class="jt-name">${esc(def.name)}</span>` +
    `<div class="tip">${esc(def.desc)}${rarityTag}${opts.tipExtra || ''}</div>`;
  return d;
}

function showDictionary() {
  const body = document.createElement('div');
  body.className = 'dictionary';
  body.appendChild(dictionarySection('Jokers', sortedJokersForDictionary(), 'joker'));
  body.appendChild(dictionarySection('Tarots', TAROTS, 'tarot'));
  showInfo('Card Dictionary', body.outerHTML);
}

function sortedJokersForDictionary() {
  const rank = { common: 0, rare: 1, ultra: 2 };
  return JOKERS.slice().sort((a, b) =>
    (rank[a.rarity || 'common'] ?? 0) - (rank[b.rarity || 'common'] ?? 0) ||
    a.name.localeCompare(b.name));
}

function dictionarySection(title, defs, kind) {
  const section = document.createElement('section');
  section.className = 'dict-section';
  section.innerHTML = `<h4>${esc(title)}</h4>`;
  const grid = document.createElement('div');
  grid.className = 'dict-grid';
  for (const def of defs) grid.appendChild(dictionaryCard(kind, def));
  section.appendChild(grid);
  return section;
}

function dictionaryCard(kind, def) {
  const row = document.createElement('div');
  row.className = 'dict-card ' + kind + (def.rarity ? ' r-' + def.rarity : '');
  row.appendChild(jtile(kind, def));
  const text = document.createElement('div');
  text.className = 'dict-copy';
  const meta = kind === 'joker'
    ? `${def.rarity || 'common'} - cost ${def.cost}`
    : `tarot - cost ${def.cost} - ${def.targets || 0} target${def.targets === 1 ? '' : 's'}`;
  text.innerHTML = `<b>${esc(def.name)}</b><span>${esc(meta)}</span><p>${esc(def.desc)}</p>`;
  row.appendChild(text);
  return row;
}

function showPlayerJokers(player) {
  const names = player.jokers || [];
  const body = document.createElement('div');
  body.className = 'dictionary player-jokers';
  if (!names.length) {
    body.innerHTML = '<p class="hint">No jokers yet.</p>';
  } else {
    const grid = document.createElement('div');
    grid.className = 'dict-grid';
    for (const name of names) {
      const def = JOKERS.find(j => j.name === name);
      if (def) grid.appendChild(dictionaryCard('joker', def));
      else {
        const row = document.createElement('div');
        row.className = 'dict-card joker';
        row.innerHTML = `<div class="dict-copy"><b>${esc(name)}</b></div>`;
        grid.appendChild(row);
      }
    }
    body.appendChild(grid);
  }
  showInfo(`${player.name}'s Jokers`, body.outerHTML);
}

function renderMyArea(st) {
  const you = st.you;
  const mult = you.dealMult || 1;
  renderHandScore(st);
  const myMult = $('myMult');
  myMult.innerHTML = `<span>Mult</span><b>x${mult}</b>`;
  myMult.classList.toggle('boosted', mult > 1);
  $('myCoins').innerHTML = chip(you.coins);
  $('myCoins').innerHTML = chip(you.coins);
  const coinKey = `${st.dealNumber}:${st.phase}:${you.coins}`;
  if (st.mode !== 'board' && prevState && prevState.you && you.coins > prevState.you.coins && coinKey !== lastCoinPopKey) {
    lastCoinPopKey = coinKey;
    showCoinGain(you.coins - prevState.you.coins);
  }
  $('deckBtn').innerHTML = icon('deck', you.deck.length);

  $('deckBtn').innerHTML = icon('deck', you.deck.length);
  renderJokerSlots(st);
  renderTarotSlots(st);
  renderHand(st);
  if (deckOpen) renderDeckOverlay(st);
}

function renderHandScore(st) {
  const you = st.you;
  let cards = [];
  if (st.phase === 'discard' && you.canDiscard) {
    cards = you.hand.filter(c => !selected.includes(c.id));
  } else if (you.kept && you.kept.length) {
    cards = you.kept;
  } else {
    cards = you.hand || [];
  }
  const mods = st.mode === 'board' ? aggregateMods([]) : aggregateMods(you.jokers || []);
  const target = deckEffectsOn(st) && st.you && st.you.deckArt === 'cosmic' ? st.cosmicTarget || 15 : 15;
  const bd = scoreBreakdown(cards, st.starter || null, false, { shortcut: mods.shortcut, target });
  let score = buildScore(bd, mods, 'hand', cards, { starter: st.starter || null, coins: you.coins, target }).total;
  if (st.mode !== 'board') score += you.dealHandBonus || 0;
  $('myScore').innerHTML = st.mode === 'board'
    ? `<span>Score</span><b>${you.score}</b>`
    : `<span>Hand</span><b>${score}</b>`;
}

function showCoinGain(amount) {
  const target = $('myCoins').getBoundingClientRect();
  const pop = document.createElement('div');
  pop.className = 'coin-pop';
  pop.innerHTML = `+${chip(amount)}`;
  pop.innerHTML = `+${chip(amount)}`;
  pop.style.left = `${target.left + target.width / 2}px`;
  pop.style.top = `${target.top}px`;
  $('fx').appendChild(pop);
  setTimeout(() => pop.remove(), 1200);
  pulse($('myCoins'));
}

// ---- joker slots (dynamic with stamp bonuses, pointer-drag to reorder) ----

let lastJokerSig = null;

function renderJokerSlots(st) {
  const you = st.you;
  const cap = you.jokerSlots || 5;
  $('jokerCount').textContent = `${you.jokers.length}/${cap}`;
  const row = $('jokerRow');
  while (row.children.length < cap) {
    const slot = document.createElement('div');
    slot.className = 'jslot empty';
    row.appendChild(slot);
  }
  while (row.children.length > cap) row.lastElementChild.remove();

  const slots = [...row.querySelectorAll('.jslot')];
  const sig = you.jokers.map(j => `${j.id}:${j.stamp || ''}`).join('|') + `/${cap}`;

  // Rebuilding the tiles restarts their foil/glow CSS animations every render
  // (the 2.5s heartbeat, every tap, etc). When the joker set is unchanged,
  // leave the DOM in place and only rebind handlers so the shimmer keeps going.
  if (sig === lastJokerSig && slots.some(s => s.querySelector('.jtile'))) {
    slots.forEach((slot, i) => {
      const tile = slot.querySelector('.jtile');
      if (tile) attachJokerPointer(tile, i, st);
    });
    return;
  }
  lastJokerSig = sig;

  slots.forEach((slot, i) => {
    slot.innerHTML = '';
    slot.className = 'jslot';
    slot.dataset.slot = i;

    if (i < you.jokers.length) {
      slot.classList.add('filled');
      const tile = jtile('joker', you.jokers[i]);
      tile.dataset.jokerIdx = i;
      attachJokerPointer(tile, i, st);
      slot.appendChild(tile);
    } else {
      slot.classList.add('empty');
    }
  });
}

function attachJokerPointer(tile, idx, st) {
  tile.style.touchAction = 'none';
  tile.onpointerdown = e => {
    if (e.button && e.button !== 0) return;
    jokerDrag = {
      idx, tile, startX: e.clientX, startY: e.clientY,
      x: e.clientX, y: e.clientY, dragging: false, ghost: null,
    };
    try { tile.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  tile.onpointermove = e => {
    if (!jokerDrag || jokerDrag.tile !== tile) return;
    jokerDrag.x = e.clientX; jokerDrag.y = e.clientY;
    const dx = e.clientX - jokerDrag.startX;
    const dy = e.clientY - jokerDrag.startY;
    if (!jokerDrag.dragging && Math.hypot(dx, dy) > 7) {
      jokerDrag.dragging = true;
      const g = tile.cloneNode(true);
      g.classList.add('drag-ghost');
      g.style.width = `${tile.offsetWidth}px`;
      g.style.height = `${tile.offsetHeight}px`;
      document.body.appendChild(g);
      jokerDrag.ghost = g;
      tile.classList.add('dragging');
    }
    if (jokerDrag.dragging) {
      e.preventDefault();
      jokerDrag.ghost.style.left = `${jokerDrag.x}px`;
      jokerDrag.ghost.style.top = `${jokerDrag.y}px`;
      highlightJokerSlot(e.clientX, e.clientY);
    }
  };
  const finish = e => {
    if (!jokerDrag || jokerDrag.tile !== tile) return;
    const drag = jokerDrag;
    jokerDrag = null;
    try { tile.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    tile.classList.remove('dragging');
    if (drag.ghost) drag.ghost.remove();
    [...$('jokerRow').querySelectorAll('.jslot')].forEach(s => s.classList.remove('drag-over'));
    if (!drag.dragging) {
      openOwnedFocus('joker', st.you.jokers[idx], idx, st); // a tap just opens the big card
      flushDeferredRender();
      return;
    }
    const toIdx = jokerSlotAt(e.clientX, e.clientY);
    if (toIdx == null || toIdx === drag.idx) { flushDeferredRender(); return; }
    const jokers = st.you.jokers.slice();
    const [moved] = jokers.splice(drag.idx, 1);
    jokers.splice(Math.min(toIdx, jokers.length), 0, moved);
    st.you.jokers = jokers;
    renderJokerSlots(st);
    sendMsg({ t: 'reorderJokers', order: jokers.map(j => ({ id: j.id, stamp: j.stamp || '' })) });
    deferredRender = false; // the reorder ack will re-render us
  };
  tile.onpointerup = finish;
  tile.onpointercancel = finish;
}

function highlightJokerSlot(x, y) {
  const slots = [...$('jokerRow').querySelectorAll('.jslot')];
  slots.forEach(s => s.classList.remove('drag-over'));
  const idx = jokerSlotAt(x, y);
  if (idx != null && slots[idx]) slots[idx].classList.add('drag-over');
}

function jokerSlotAt(x, y) {
  const slots = [...$('jokerRow').querySelectorAll('.jslot')];
  const M = 10;
  for (let i = 0; i < slots.length; i++) {
    const r = slots[i].getBoundingClientRect();
    if (x >= r.left - M && x <= r.right + M && y >= r.top - M && y <= r.bottom + M) return i;
  }
  return null;
}

// ---- tarot slots (2 fixed) ----

function renderTarotSlots(st) {
  const you = st.you;
  const cap = you.tarotSlots == null ? 2 : you.tarotSlots;
  $('tarotCount').textContent = `${you.tarots.length}/${cap}`;

  const slots = $('tarotRow').querySelectorAll('.tslot');
  slots.forEach((slot, i) => {
    slot.classList.toggle('hidden', i >= cap);
    slot.innerHTML = '';
    slot.className = 'tslot';
    slot.dataset.slot = i;

    if (i < you.tarots.length) {
      const t = you.tarots[i];
      slot.classList.add('filled');
      const tile = jtile('tarot', t, {
        tipExtra: you.canDiscard ? '<br><i>Click to use</i>' : '<br><i>Usable before you discard</i>',
      });
      tile.onclick = () => openOwnedFocus('tarot', t, i, st);
      slot.appendChild(tile);
    } else {
      slot.classList.add('empty');
    }
  });
}

function renderHand(st) {
  const you = st.you;
  const handEl = $('hand');
  handEl.innerHTML = '';
  const myTurn = st.phase === 'pegging' && st.turnSeat === st.mySeat;

  selected = selected.filter(id => you.hand.some(c => c.id === id));
  if (!you.hand.some(c => c.id === raisedCardId)) raisedCardId = null;
  setupCardDropTargets(st);

  const mid = (you.hand.length - 1) / 2;
  you.hand.forEach((c, idx) => {
    const el = cardEl(c);
    const preview = myTurn ? peggingPreview(c, st) : null;
    el.dataset.cardId = c.id;
    el.style.setProperty('--fan-rot', `${(idx - mid) * 5}deg`);
    el.style.setProperty('--fan-y', `${Math.abs(idx - mid) * 3}px`);
    el.style.zIndex = String(20 + idx);
    if (you.canDiscard) {
      el.classList.add('clickable');
      addPointerCardDrag(el, c.id);
      if (selected.includes(c.id)) {
        el.classList.add('selected');
        const order = selected.indexOf(c.id);
        const auroraBurn = deckEffectsOn(st) && you.deckArt === 'aurora' && order === st.discardCount - 1;
        el.insertAdjacentHTML('beforeend', `<span class="discard-order-tag${auroraBurn ? ' burn' : ''}">${auroraBurn ? 'BURN' : `CRIB ${order + 1}`}</span>`);
      }
      el.onclick = () => {
        if (el.dataset.dragged === '1') {
          el.dataset.dragged = '';
          return;
        }
        const i = selected.indexOf(c.id);
        if (i >= 0) selected.splice(i, 1);
        else if (selected.length < st.discardCount) selected.push(c.id);
        renderGame(lastState);
      };
    } else if (myTurn) {
      const legal = st.pegCount + cardValue(c) <= 31;
      if (legal) {
        el.classList.add('clickable');
        addPointerCardDrag(el, c.id);
        if (raisedCardId === c.id) el.classList.add('raised');
        if (preview && preview.points > 0) {
          el.classList.add('scores');
          el.insertAdjacentHTML('beforeend', `<span class="scoretag">+${preview.points}</span>`);
        }
        const extraLabels = cardExtraLabels(c, preview, st);
        if (extraLabels.length) {
          el.insertAdjacentHTML('beforeend', `<span class="card-effect-tags">${extraLabels.map(label => `<i>${esc(label)}</i>`).join('')}</span>`);
        }
        el.onclick = () => {
          if (el.dataset.dragged === '1') {
            el.dataset.dragged = '';
            return;
          }
          if (raisedCardId === c.id) playHandCard(c.id);
          else {
            raisedCardId = c.id;
            renderGame(lastState);
          }
        };
      } else {
        el.classList.add('dim');
      }
    }
    handEl.appendChild(el);
  });

  const prompt = $('prompt');
  const btn = $('actionBtn');
  const cancel = $('cancelBtn');
  btn.classList.add('hidden');
  cancel.classList.add('hidden');
  prompt.textContent = '';

  if (!you.active) {
    prompt.textContent = "You're out - spectating the table.";
  } else if (you.canDiscard) {
    const aurora = deckEffectsOn(st) && you.deckArt === 'aurora';
    prompt.textContent = aurora
      ? `Select ${st.discardCount}: the first ${st.discardCount - 1} go to the crib; your final selection is removed from the run`
      : `Select ${st.discardCount} card(s) for ${dealerName(st)} crib`;
    btn.textContent = aurora ? `Send ${st.discardCount - 1} + Burn 1` : `Send ${st.discardCount} to Crib`;
    btn.disabled = selected.length !== st.discardCount;
    btn.classList.remove('hidden');
    btn.onclick = () => { sendMsg({ t: 'discard', cards: selected }); selected = []; };
  } else if (st.phase === 'discard') {
    prompt.textContent = 'Waiting for the others to discard...';
  } else if (st.phase === 'pegging') {
    if (myTurn) {
      const canAny = you.hand.some(c => st.pegCount + cardValue(c) <= 31);
      prompt.textContent = canAny ? 'Play a card' : 'No legal play - go!';
    } else {
      prompt.textContent = 'Waiting for your turn...';
    }
  }
}

function setupCardDropTargets(st) {
  const clear = el => {
    el.ondragover = null;
    el.ondragleave = null;
    el.ondrop = null;
    el.classList.remove('drop-ready');
  };
  const crib = $('cribPile');
  const peg = $('pegArea');
  const stack = $('pegStack');
  [crib, peg, stack].forEach(clear);

  if (st.you.canDiscard) {
    setupDropTarget(crib, cardId => dropHandCard(cardId));
  }
  if (st.phase === 'pegging' && st.turnSeat === st.mySeat) {
    setupDropTarget(peg, cardId => playHandCard(cardId));
    setupDropTarget(stack, cardId => playHandCard(cardId));
  }
}

function setupDropTarget(el, onDrop) {
  el.ondragover = e => {
    e.preventDefault();
    el.classList.add('drop-ready');
  };
  el.ondragleave = () => el.classList.remove('drop-ready');
  el.ondrop = e => {
    e.preventDefault();
    el.classList.remove('drop-ready');
    const cardId = e.dataTransfer.getData('text/plain');
    if (cardId) onDrop(cardId);
  };
}

function addPointerCardDrag(el, cardId) {
  el.onpointerdown = e => {
    if (e.button && e.button !== 0) return;
    pointerCardDrag = {
      cardId,
      el,
      startX: e.clientX,
      startY: e.clientY,
      x: e.clientX,
      y: e.clientY,
      dragging: false,
      ghost: null,
    };
    el.setPointerCapture(e.pointerId);
  };
  el.onpointermove = e => {
    if (!pointerCardDrag || pointerCardDrag.el !== el) return;
    pointerCardDrag.x = e.clientX;
    pointerCardDrag.y = e.clientY;
    const dx = e.clientX - pointerCardDrag.startX;
    const dy = e.clientY - pointerCardDrag.startY;
    if (!pointerCardDrag.dragging && Math.hypot(dx, dy) > 8) {
      pointerCardDrag.dragging = true;
      pointerCardDrag.ghost = el.cloneNode(true);
      pointerCardDrag.ghost.classList.add('drag-ghost');
      pointerCardDrag.ghost.style.width = `${el.offsetWidth}px`;
      pointerCardDrag.ghost.style.height = `${el.offsetHeight}px`;
      document.body.appendChild(pointerCardDrag.ghost);
      el.classList.add('drag-source');
    }
    if (pointerCardDrag.dragging) {
      e.preventDefault();
      movePointerGhost(pointerCardDrag);
      highlightPointerDropTarget(e.clientX, e.clientY);
    }
  };
  el.onpointerup = e => finishPointerCardDrag(e, el);
  el.onpointercancel = e => finishPointerCardDrag(e, el);
}

function movePointerGhost(drag) {
  drag.ghost.style.left = `${drag.x}px`;
  drag.ghost.style.top = `${drag.y}px`;
}

function highlightPointerDropTarget(x, y) {
  for (const el of [$('cribPile'), $('pegArea'), $('pegStack')]) el.classList.remove('drop-ready');
  const target = cardDropTargetAt(x, y);
  if (target) target.classList.add('drop-ready');
}

function finishPointerCardDrag(e, el) {
  if (!pointerCardDrag || pointerCardDrag.el !== el) return;
  const drag = pointerCardDrag;
  pointerCardDrag = null;
  try { el.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
  for (const drop of [$('cribPile'), $('pegArea'), $('pegStack')]) drop.classList.remove('drop-ready');
  if (drag.ghost) drag.ghost.remove();
  el.classList.remove('drag-source');
  if (!drag.dragging) { flushDeferredRender(); return; }
  el.dataset.dragged = '1';
  const target = cardDropTargetAt(e.clientX, e.clientY);
  if (!target) { flushDeferredRender(); return; }
  if (target.id === 'cribPile') dropHandCard(drag.cardId);
  else playHandCard(drag.cardId);
  flushDeferredRender();
}

function cardDropTargetAt(x, y) {
  // generous hit area so cards don't need to land precisely on the small pile
  const M = 90;
  const targets = [$('cribPile'), $('pegStack'), $('pegArea')];
  return targets.find(el => {
    if (!el.ondrop) return false;
    const r = el.getBoundingClientRect();
    return x >= r.left - M && x <= r.right + M && y >= r.top - M && y <= r.bottom + M;
  });
}

function dropHandCard(cardId) {
  const st = lastState;
  if (!st || !st.you.canDiscard) return;
  if (!selected.includes(cardId)) selected.push(cardId);
  selected = selected.slice(-st.discardCount);
  if (selected.length === st.discardCount) {
    sendMsg({ t: 'discard', cards: selected });
    selected = [];
  } else {
    renderGame(st);
  }
}

function playHandCard(cardId) {
  const st = lastState;
  const card = st && st.you.hand.find(c => c.id === cardId);
  if (!st || !card || st.phase !== 'pegging' || st.turnSeat !== st.mySeat) return;
  if (st.pegCount + cardValue(card) > 31) return;
  const el = [...document.querySelectorAll('#hand .card')].find(card => card.dataset.cardId === cardId);
  pendingFly = { cardId, rect: el ? el.getBoundingClientRect() : null };
  raisedCardId = null;
  sendMsg({ t: 'playCard', card: cardId });
}

function peggingPreview(card, st) {
  const count = st.pegCount + cardValue(card);
  if (count > 31) return { legal: false, points: 0, events: [] };
  const target = deckEffectsOn(st) && st.you && st.you.deckArt === 'cosmic' ? st.cosmicTarget || 15 : 15;
  const events = pegEvents(st.pegStack.concat([card]), count, { target });
  return {
    legal: true,
    points: events.reduce((sum, e) => sum + e.pts, 0),
    handPoints: peggingHandBonusPreview(card, events, count, st),
    events,
  };
}

function peggingHandBonusPreview(card, events, count, st) {
  if (st.mode === 'board') return 0;
  let total = deckEffectsOn(st) && st.you.deckArt === 'gambit' &&
    events.some(ev => ev.type === 'fifteen' || ev.type === 'thirtyone') ? 2 : 0;
  for (const raw of effectiveJokerIds(st.you.jokers || [])) {
    const owned = normalizeJoker(raw);
    const def = owned && jokerDef(owned);
    const playBonus = def && def.mods && def.mods.playHandBonus;
    const scoredBonus = def && def.mods && def.mods.pegHandBonus;
    const bonus = playBonus || scoredBonus;
    if (!bonus || (scoredBonus && !events.length)) continue;
    if (card.enhancement === 'stone' && (bonus.ranks || bonus.suit != null)) continue;
    if (bonus.ranks && !bonus.ranks.includes(card.rank)) continue;
    if (bonus.suit != null && bonus.suit !== card.suit) continue;
    if (bonus.starterFace && (!st.starter || st.starter.rank < 11)) continue;
    if (bonus.eventType && !events.some(ev => ev.type === bonus.eventType)) continue;
    if (bonus.count != null && count !== bonus.count) continue;
    if (bonus.minCount != null && count < bonus.minCount) continue;
    if (bonus.minEvents != null && events.length < bonus.minEvents) continue;
    const base = bonus.coinDivisor ? Math.floor(st.you.coins / bonus.coinDivisor) * bonus.pts : bonus.pts;
    if (base > 0) total += base;
  }
  return total;
}

function cardExtraLabels(card, preview, st) {
  const labels = [];
  if (preview && preview.handPoints > 0) labels.push(`+${preview.handPoints} Hand`);
  let extraMult = 0;
  for (const def of effectiveJokerIds(st.you.jokers || []).map(jokerDef).filter(Boolean)) {
    if (def.id === 'even_steven' && card.enhancement !== 'stone' && card.rank % 2 === 0 && card.rank <= 10) extraMult += 1;
    if (preview && preview.events.length && def.id === 'onyx_agate' && (card.suit === 2 || card.enhancement === 'wild')) extraMult += 2;
  }
  if (extraMult) labels.push(`+${extraMult} Mult`);
  const enhancementLabel = {
    bonus: '+2 Hand at show',
    mult: '+1 Mult at show',
    wild: 'All suits',
    glass: 'x2 Mult at show',
    steel: 'x1.5 Mult in crib',
    stone: '+4 Hand / 0 peg',
    gold: '+3 coins at show',
    lucky: 'Lucky rolls at show',
  }[card.enhancement];
  if (enhancementLabel) labels.push(enhancementLabel);
  return labels;
}

function peggingEventText(ev) {
  if (ev.type === 'fifteen') return `making ${ev.target || 15}`;
  if (ev.type === 'thirtyone') return 'hitting 31';
  if (ev.type === 'pair') {
    if (ev.size === 2) return 'pairing the last card';
    if (ev.size === 3) return 'making trips';
    return 'making four of a kind';
  }
  if (ev.type === 'run') return `making a run of ${ev.size}`;
  return ev.type;
}

function scoringOpportunity(st) {
  if (st.phase !== 'pegging' || st.turnSeat !== st.mySeat || !st.you || !st.you.active) return null;
  const options = st.you.hand
    .map(card => ({ card, preview: peggingPreview(card, st) }))
    .filter(o => o.preview.legal && o.preview.points > 0)
    .sort((a, b) => b.preview.points - a.preview.points);
  if (!options.length) return null;
  const best = options[0];
  const why = best.preview.events.map(peggingEventText).join(' and ');
  const count = st.pegCount + cardValue(best.card);
  return {
    key: `score-${best.card.id}-${st.pegCount}-${best.preview.points}-${best.preview.handPoints}`,
    text: `Scoring chance: play ${cardLabel(best.card)} to make the count ${count} and gain +${best.preview.points} Mult for ${why}${best.preview.handPoints ? `, plus +${best.preview.handPoints} Hand Points from your deck and jokers` : ''}.`
  };
}

function cardLabel(card) {
  const base = card.enhancement === 'stone' ? 'Stone Card' : `${RANK_NAMES[card.rank]}${SUIT_CHARS[card.suit]}`;
  return card.enhancement && card.enhancement !== 'stone' ? `${base} ${CARD_ENHANCEMENTS[card.enhancement].name}` : base;
}

function cardInfo(card, st, preview) {
  const value = cardValue(card);
  const bits = [`<p>${cardLabel(card)} counts as ${value} while pegging.</p>`];
  if (card.enhancement) bits.push(`<p><b>${esc(CARD_ENHANCEMENTS[card.enhancement].name)}:</b> ${esc(CARD_ENHANCEMENTS[card.enhancement].desc)}</p>`);
  if (st.phase === 'discard' && st.you.canDiscard) bits.push('<p>Discard phase: select it or drag it to the crib pile.</p>');
  if (st.phase === 'pegging') {
    if (preview && preview.legal) {
      const events = preview.events.map(e => e.type === 'thirtyone' ? '31' : e.type).join(', ');
      bits.push(`<p>Pegging now: playing it makes the count ${st.pegCount + value}${preview.points ? ` and scores ${preview.points} Mult (${events})${preview.handPoints ? ` plus ${preview.handPoints} Hand Points` : ''}` : ' with no immediate points'}.</p>`);
    } else {
      bits.push('<p>Pegging now: this card would push the count over 31, so it cannot be played.</p>');
    }
  }
  return bits.join('');
}

function shopKindTitle(kind) {
  return kind === 'joker' ? 'About Jokers'
    : kind === 'tarot' ? 'About Tarots'
    : kind === 'pack' ? 'About Booster Packs'
    : 'About Playing Cards';
}

function shopKindHelp(kind) {
  if (kind === 'joker') return '<p><b>Jokers</b> are permanent, passive upgrades. Once bought they sit in your joker row and boost your scoring automatically every hand - they\'re never used up. Drag them to reorder (order matters for Blueprint).</p>';
  if (kind === 'tarot') return '<p><b>Tarots</b> are one-time cards. Buy one, then play it during the discard phase before you throw to the crib. Most permanently change cards in your own deck.</p>';
  if (kind === 'pack') return '<p><b>Booster packs</b> open instantly and let you choose one of three rewards - a joker, tarot, or playing card - then the rest vanish. You can also skip.</p>';
  return '<p>A <b>playing card</b> bought here is added permanently to your deck, changing what you can draw in future hands.</p>';
}

function shopTypeLabel(kind) {
  return kind === 'joker' ? 'Joker'
    : kind === 'tarot' ? 'Tarot'
    : kind === 'pack' ? 'Pack'
    : 'Card';
}

function packBlockedReason(item, you) {
  if (!item || item.kind !== 'pack') return '';
  if ((item.id === 'buffoon' || item.id === 'ultra') && you.jokers.length >= (you.jokerSlots || 5)) return 'Jokers full';
  if (item.id === 'arcana' && you.tarots.length >= (you.tarotSlots == null ? 2 : you.tarotSlots)) return 'Tarots full';
  return '';
}

function shopItemHelp(item) {
  const specific = item.kind === 'card'
    ? `<p><b>This card:</b> Adds this exact ${cardLabel(item)} to your permanent deck.</p>`
    : `<p><b>${esc(item.name)}:</b> ${esc(item.desc)}</p>`;
  const stamp = item.stamp ? `<p><b>Edition:</b> ${esc(stampText(item.stamp))}</p>` : '';
  return shopKindHelp(item.kind) + specific + stamp;
}

function rarityPill(item) {
  if (!item || item.kind !== 'joker') return '';
  const rarity = item.rarity || 'common';
  return `<div class="rar-pill ${rarity}">${rarity}</div>`;
}

function stampPill(item) {
  if (!item || !item.stamp) return '';
  const label = stampText(item.stamp).split(':')[0] || `${item.stamp} Edition`;
  return `<button type="button" class="stamp-pill ${item.stamp}" data-stamp="${esc(item.stamp)}">${esc(label)}</button>`;
}

function shopCardFace(item) {
  const face = document.createElement('div');
  face.className = `shop-card-face ${item.kind}`;
  if (item.kind === 'card') {
    face.appendChild(cardEl(item));
    return face;
  }
  const icon = item.kind === 'joker' ? JOKER_ICONS[item.id]
    : item.kind === 'tarot' ? TAROT_ICONS[item.id]
    : PACK_ICONS[item.id];
  face.innerHTML = `<div class="shop-art">${icon || ''}<span class="jt-foil"></span></div>`;
  return face;
}

function focusDisplayCard(item) {
  const art = document.createElement('div');
  art.className = 'focus-art focus-display-card ' + item.kind;
  if (item.kind === 'card') {
    art.appendChild(cardEl(item));
    return art;
  }
  const icon = item.kind === 'joker' ? JOKER_ICONS[item.id]
    : item.kind === 'tarot' ? TAROT_ICONS[item.id]
    : PACK_ICONS[item.id];
  art.innerHTML = `<span class="focus-card-icon">${icon || ''}<span class="jt-foil"></span></span>` +
    `<span class="focus-card-title">${esc(item.name)}</span>`;
  return art;
}

function dealerName(st) {
  const d = st.players.find(p => p.isDealer);
  return d ? (d.seat === st.mySeat ? 'your' : `${d.name}'s`) : '';
}

// ---- deck viewer ----

$('deckBtn').onclick = () => {
  deckOpen = !deckOpen;
  if (deckOpen && lastState) renderDeckOverlay(lastState);
  else $('deckOverlay').classList.add('hidden');
};
$('deckClose').onclick = () => { deckOpen = false; $('deckOverlay').classList.add('hidden'); };
$('deckOverlay').onclick = e => {
  if (e.target === $('deckOverlay')) { deckOpen = false; $('deckOverlay').classList.add('hidden'); }
};

function renderDeckOverlay(st) {
  $('deckOverlay').classList.remove('hidden');
  const body = $('deckBody');
  const deck = st.you.deck;
  $('deckTitle').textContent = `Your deck - ${deck.length} cards`;
  body.innerHTML = '';
  for (let s = 0; s < 4; s++) {
    const cards = deck.filter(c => c.suit === s);
    const row = document.createElement('div');
    row.className = 'deck-row';
    row.innerHTML = `<span class="deck-suit ${s < 2 ? 'red' : ''}">${SUIT_CHARS[s]}<b>${cards.length}</b></span>`;
    const wrap = document.createElement('div');
    wrap.className = 'deck-cards';
    for (const c of cards) wrap.appendChild(cardEl(c, { small: true }));
    row.appendChild(wrap);
    body.appendChild(row);
  }
}

function startTarot(idx, def) {
  tarotMode = { idx, def, targets: [] };
  renderGame(lastState);
}

function toggleTarotTarget(cardId) {
  const i = tarotMode.targets.indexOf(cardId);
  if (i >= 0) tarotMode.targets.splice(i, 1);
  else if (tarotMode.targets.length < tarotMode.def.targets) tarotMode.targets.push(cardId);
  renderGame(lastState);
}

// ---- overlays: scoring, blind check, shop, game over ----

let lastOverlayPhase = 'none';

function renderOverlay(st) {
  const ov = $('overlay');
  const oc = $('overlayContent');
  const key = st.phase + '-' + st.dealNumber;
  if (key !== revealKey) { revealShown = -1; revealKey = key; }

  const phase = ['scoring', 'roundEnd', 'shop', 'gameover'].includes(st.phase) ? st.phase : 'none';
  if (st.phase !== 'shop' && focusMode === 'market') closeFocus(); // dismiss shop-buy zoom when the phase moves on
  const build = () => {
    if (st.phase === 'scoring') renderScoring(oc, st);
    else if (st.phase === 'roundEnd') renderRoundEnd(oc, st);
    else if (st.phase === 'shop') renderShop(oc, st);
    else if (st.phase === 'gameover') renderGameover(oc, st);
  };

  if (phase === 'none') {
    if (lastOverlayPhase !== 'none') slideOutOverlay(); // glide the panel away left
    lastOverlayPhase = 'none';
    return;
  }

  ov.classList.remove('hidden');
  if (phase !== lastOverlayPhase) slideOverlayTransition(build, lastOverlayPhase !== 'none');
  else build();
  lastOverlayPhase = phase;
}

function renderGameover(oc, st) {
  if (st.solo) {
    const me = (st.standings || []).find(s => s.seat === st.mySeat) || { score: 0 };
    const wonRegular = st.mode === 'blind' && (st.you.blindsPassed || 0) >= 9;
    oc.innerHTML = `<h2>${wonRegular ? 'Run Cleared' : 'Run Over'}</h2>` +
      `<div class="run-summary">You reached <b>${st.mode === 'endless' ? 'Endless Blind ' : 'Blind '}${st.you.blindsPassed || st.round}</b> against The House.<br>` +
      `Final score: <b>${me.score}</b> - Blinds beaten: <b>${st.you.blindsPassed}</b>${wonRegular ? '<br>Deck token earned for your profile.' : ''}</div>`;
  } else {
    oc.innerHTML = st.mode === 'board'
      ? `<h2>Board Winner</h2><div class="run-summary">Goal: <b>${st.goalScore || 121}</b> points</div>`
      : '<h2>Final Standings</h2>';
    (st.standings || []).forEach((s, i) => {
      const tag = st.mode === 'board'
        ? (i === 0 ? `${icon('winner')} winner` : 'finished')
        : s.eliminatedRound === null ? `${icon('winner')} winner` : `out round ${s.eliminatedRound}`;
      oc.insertAdjacentHTML('beforeend',
        `<div class="standing${i === 0 ? ' winner' : ''}"><span>${i + 1}. ${esc(s.name)}</span>` +
        `<span class="standing-tag">${tag}</span><span>${s.score} pts</span></div>`);
    });
  }
  const btn = document.createElement('button');
  btn.className = 'btn primary';
  btn.textContent = 'Back to Lobby';
  btn.onclick = () => { if (P2P_MODE) leaveP2p(); else sendMsg({ t: 'backToLobby' }); };
  oc.appendChild(btn);
}

// Cross-slide: the outgoing screen flies left while the new one flies in
// from the right. Used for scoring - shop - next deal, etc.
function slideOverlayTransition(build, hadPrev) {
  const oc = $('overlayContent');
  if (hadPrev && oc.innerHTML.trim()) {
    const rect = oc.getBoundingClientRect();
    const ghost = oc.cloneNode(true);
    ghost.removeAttribute('id');
    ghost.classList.add('overlay-ghost');
    ghost.style.cssText += `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;max-height:${rect.height}px;margin:0;`;
    $('overlay').appendChild(ghost);
    const a = ghost.animate(
      [{ transform: 'translateX(0)', opacity: 1 }, { transform: 'translateX(-60vw)', opacity: 0 }],
      { duration: 300 * ANIM, easing: 'cubic-bezier(.5,0,.3,1)', fill: 'forwards' });
    const done = () => ghost.remove();
    a.onfinish = done; a.oncancel = done;
  }
  build();
  oc.animate(
    [{ transform: 'translateX(60vw)', opacity: 0 }, { transform: 'translateX(0)', opacity: 1 }],
    { duration: 320 * ANIM, easing: 'cubic-bezier(.2,.8,.3,1)' });
}

function slideOutOverlay() {
  const oc = $('overlayContent');
  const ov = $('overlay');
  if (!oc.innerHTML.trim()) { ov.classList.add('hidden'); return; }
  const a = oc.animate(
    [{ transform: 'translateX(0)', opacity: 1 }, { transform: 'translateX(-60vw)', opacity: 0 }],
    { duration: 300 * ANIM, easing: 'cubic-bezier(.5,0,.3,1)' });
  const done = () => { ov.classList.add('hidden'); oc.style.transform = ''; };
  a.onfinish = done; a.oncancel = done;
}

function renderScoring(oc, st) {
  oc.innerHTML = `<h2>Counting - Deal ${st.dealIndexInRound}/${st.dealsInRound}</h2>` +
    `<div class="starter-row">Starter: </div>`;
  oc.lastChild.appendChild(cardEl(st.starter, { small: true }));

  const done = st.revealIndex >= st.scoringResults.length - 1;
  if (st.mode === 'board') {
    const r = st.scoringResults[Math.min(st.revealIndex, st.scoringResults.length - 1)];
    const fresh = st.revealIndex > revealShown;
    oc.appendChild(scoreBlock(r, st, fresh));
    const board = ensureBoardShell();
    board.classList.remove('hidden');
    oc.appendChild(board);
    renderBoard2d(st);
    revealShown = Math.max(revealShown, st.revealIndex);
    oc.insertAdjacentHTML('beforeend',
      `<div class="hint" style="margin-top:8px">${esc(r.name)} moves from ${Math.round(r.scoreBefore || 0)} to ${Math.round(r.scoreAfter || 0)} on the board.</div>`);
    if (done) {
      const winner = st.players.find(p => p.score >= (st.goalScore || 121));
      if (st.you.active) appendReadyBtn(oc, st, winner ? 'Final Standings' : 'Next Deal');
    } else {
      oc.insertAdjacentHTML('beforeend', '<div class="counting-hint">Counting...</div>');
    }
    return;
  }
  for (let i = 0; i <= st.revealIndex && i < st.scoringResults.length; i++) {
    const fresh = i > revealShown;
    oc.appendChild(scoreBlock(st.scoringResults[i], st, fresh));
  }
  revealShown = Math.max(revealShown, st.revealIndex);

  if (done) {
    oc.insertAdjacentHTML('beforeend',
      `<div style="margin:8px 0">You earned <b style="color:#ffd76e">${chip(st.you.coinGain)}</b> this deal.</div>`);
    const last = st.dealIndexInRound >= st.dealsInRound;
    if (st.you.active) appendReadyBtn(oc, st, last ? 'Blind Check' : 'To the Shop');
  } else {
    oc.insertAdjacentHTML('beforeend', '<div class="counting-hint">Counting...</div>');
  }
  oc.scrollTop = oc.scrollHeight;
}

function scoreBlock(r, st, fresh) {
  const div = document.createElement('div');
  div.className = 'score-block' + (fresh ? ' reveal' : '');
  const title = r.kind === 'crib'
    ? `${icon('crown')} ${esc(r.name)} - Crib`
    : esc(r.name) + (r.seat === st.mySeat ? ' (you)' : '');
  const targetBadge = r.deckEffects !== false && r.deckArt === 'cosmic' && st.cosmicTarget ? `<span class="target-pill">Target ${st.cosmicTarget}</span>` : '';
  div.innerHTML = `<div class="sb-head"><span>${title}</span>${targetBadge}</div>`;

  // hand cards + the shared starter (shows how the hand is scored)
  const cards = document.createElement('div');
  cards.className = 'sb-cards';
  const gambitRemoveDelay = 720 + r.lines.length * 130;
  r.cards.forEach((c, i) => {
    const el = cardEl(c, { small: true });
    if (fresh) { el.classList.add('deal-in'); el.style.animationDelay = (i * 80) + 'ms'; }
    if (c.gambitCharged) {
      el.title = 'Gambit charge: +2 Hand Points; removed from the deck after scoring';
      if (fresh) {
        setTimeout(() => {
          if (!el.isConnected) return;
          el.classList.add('gambit-removed');
          const rect = el.getBoundingClientRect();
          burstSparkles(rect.left + rect.width / 2, rect.top + rect.height / 2, 12, 320);
          sfx('card');
        }, gambitRemoveDelay + i * 70);
      } else {
        el.classList.add('gambit-removed');
      }
    }
    cards.appendChild(el);
  });
  if (r.starter) {
    cards.insertAdjacentHTML('beforeend', '<span class="sb-plus">+</span>');
    const sEl = cardEl(r.starter, { small: true });
    sEl.classList.add('sb-starter');
    sEl.title = 'Starter';
    if (fresh) { sEl.classList.add('deal-in'); sEl.style.animationDelay = (r.cards.length * 80) + 'ms'; }
    cards.appendChild(sEl);
  }
  div.appendChild(cards);

  // chip lines
  r.lines.forEach((line, i) => {
    const lineEl = document.createElement('div');
    const lineLabel = cleanLabel(line.label);
    const isJoker = lineLabel.includes('[Joker]');
    lineEl.className = 'sb-line' + (fresh ? ' anim' : '') + (isJoker ? ' joker-line' : '');
    if (fresh) lineEl.style.animationDelay = (250 + i * 130) + 'ms';
    lineEl.innerHTML = `<span>${esc(lineLabel)}</span><span>${line.pts == null ? '' : '+' + line.pts}</span>`;
    div.appendChild(lineEl);
    if (fresh) setTimeout(() => sfx(line.pts == null ? 'mult' : 'scoreTick'), 250 + i * 130);
  });
  if (!r.lines.length) {
    div.insertAdjacentHTML('beforeend', '<div class="sb-line"><span>Nothing scored</span><span>+0</span></div>');
    if (fresh) setTimeout(() => sfx('card'), 250);
  }

  // Normal decks use Points x Mult. Neon rolls both values into their shared average first.
  const eqDelay = 300 + r.lines.length * 130;
  const eq = document.createElement('div');
  const neon = r.deckEffects !== false && r.deckArt === 'neon' && !r.noMult;
  const neonAvg = neon ? Math.round(((r.points + r.mult) / 2) * 10) / 10 : 0;
  eq.className = 'sb-equation' + (neon ? ' neon-eq' : '') + (fresh ? ' anim' : '');
  if (fresh) eq.style.animationDelay = eqDelay + 'ms';
  eq.innerHTML = r.noMult
    ? `<span class="chips" title="Crib points">${r.points}</span>` +
      `<span class="eq-op">=</span>` +
      `<span class="eq-total">${r.total}</span>`
    : neon
      ? `<span class="chips" title="Hand points">${fresh ? r.points : neonAvg.toFixed(1)}</span>` +
        `<span class="eq-op">x</span>` +
        `<span class="mult" title="Pegging Mult">${fresh ? r.mult : neonAvg.toFixed(1)}</span>` +
        `<span class="eq-op">=</span>` +
        `<span class="eq-total">${r.total}</span>`
      : `<span class="chips" title="Hand points">${r.points}</span>` +
      `<span class="eq-op">x</span>` +
      `<span class="mult" title="Pegging multiplier">${r.mult}</span>` +
      `<span class="eq-op">=</span>` +
      `<span class="eq-total">${r.total}</span>`;
  div.appendChild(eq);
  if (fresh) {
    if (neon) {
      countBetween(eq.querySelector('.chips'), r.points, neonAvg, eqDelay + 180, 1);
      countBetween(eq.querySelector('.mult'), r.mult, neonAvg, eqDelay + 180, 1);
    }
    countUp(eq.querySelector('.eq-total'), r.total, eqDelay + 250);
    setTimeout(() => sfx('scoreTotal'), eqDelay + 120);
  }
  return div;
}

function countUp(el, total, duration, prefix = '') {
  const start = performance.now();
  function tick(now) {
    const t = Math.min(1, (now - start) / duration);
    el.textContent = prefix + Math.round(t * total);
    if (t < 1 && el.isConnected) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function countBetween(el, from, to, duration, decimals = 0, prefix = '') {
  const start = performance.now();
  function tick(now) {
    const t = Math.min(1, (now - start) / duration);
    const value = from + (to - from) * t;
    el.textContent = prefix + value.toFixed(decimals);
    if (t < 1 && el.isConnected) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function renderRoundEnd(oc, st) {
  const d = st.roundEndData;
  const title = d.finalBlind ? `Blind Check - ${d.round}/${d.finalBlind}` : `Blind Check - Round ${d.round}`;
  const blindLabel = d.rows.some(r => r.blind !== d.blind) ? `${d.blind} base` : d.blind;
  oc.innerHTML = `<h2>${title}</h2>` +
    `<div class="blind-target">Blind: <b>${blindLabel}</b>${d.dealCount ? ` - cleared after deal ${d.dealCount}` : ''}</div>`;
  if (d.rescued) {
    oc.insertAdjacentHTML('beforeend',
      '<div class="rescued">Nobody beat the blind - top score survives!</div>');
  }
  for (const row of d.rows) {
    const blind = row.blind || d.blind;
    const pct = Math.min(100, Math.round(100 * row.roundScore / blind));
    const bonus = row.reward ? ` ${esc(row.reward)}` : row.bonusCoins > 0 ? ` +${chip(row.bonusCoins)}` : '';
    const place = row.passed && row.place ? `<span class="br-place">#${row.place}</span> ` : '';
    oc.insertAdjacentHTML('beforeend',
      `<div class="blind-row${row.passed ? '' : ' failed'}">` +
      `<span class="br-name">${esc(row.name)}${row.seat === st.mySeat ? ' (you)' : ''}</span>` +
      `<div class="br-bar"><div class="br-fill${row.passed ? ' pass' : ''}" style="width:${pct}%"></div></div>` +
      `<span class="br-score">${row.roundScore}/${blind}</span>` +
      `<span class="br-tag">${row.passed ? place + 'SAFE' + bonus : 'ELIMINATED'}</span></div>`);
  }
  const left = st.players.filter(p => p.active).length;
  if (st.solo) {
    oc.insertAdjacentHTML('beforeend',
      '<div class="hint" style="margin-top:10px">The House is exempt - your run lasts as long as you beat the blinds.</div>');
  } else {
    oc.insertAdjacentHTML('beforeend',
      `<div class="hint" style="margin-top:10px">${left <= 1 ? 'We have a winner!' : left + ' players remain.'}</div>`);
  }
  const regularDone = st.mode === 'blind' && st.you && (st.you.blindsPassed || 0) >= 9;
  if (st.you.active) appendReadyBtn(oc, st, left <= 1 || regularDone ? 'Final Standings' : 'Continue');
  else oc.insertAdjacentHTML('beforeend', '<div class="hint">Spectating...</div>');
}

function renderShop(oc, st) {
  const you = st.you;
  if (!you.active) {
    oc.innerHTML = '<h2>Shop</h2><div class="hint">The survivors are shopping... you\'re spectating.</div>';
    return;
  }
  if (you.pendingPack) return renderPackOpen(oc, st);

  oc.innerHTML = `<h2>Shop</h2><div class="row spread"><span class="shop-coins">${chip(you.coins)}</span>` +
    `<span style="opacity:.7;font-size:13px">Jokers ${you.jokers.length}/${you.jokerSlots || 5} - Tarots ${you.tarots.length}/${you.tarotSlots == null ? 2 : you.tarotSlots} - Deck ${you.deck.length}</span></div>`;
  const grid = document.createElement('div');
  grid.className = 'shop-grid shop-grid-market';
  (you.shopOffer || []).forEach((item, idx) => {
    const div = document.createElement('div');
    const packBlock = packBlockedReason(item, you);
    div.className = `shop-item shop-card ${item.kind}` + (item.sold ? ' sold' : '') +
      (packBlock ? ' unavailable' : '') +
      (item.rarity ? ' r-' + item.rarity : '') + (item.stamp ? ' stamp-' + item.stamp : '');
    div.appendChild(shopCardFace(item));
    div.insertAdjacentHTML('beforeend',
      `<div class="si-name">${esc(item.name)}</div>` +
      rarityPill(item) +
      stampPill(item) +
      `<div class="shop-price">${packBlock || chip(item.cost)}</div>` +
      `<div class="shop-type ${item.kind}">${shopTypeLabel(item.kind)}</div>`);
    addInfoButton(div, item.name, shopItemHelp(item));
    div.onclick = () => {
      if (item.sold || you.ready) return;
      openShopFocus(item, idx, you); // tap a card - it enlarges to centre
    };
    grid.appendChild(div);
  });
  oc.appendChild(grid);

  // your collection - tap an owned card to inspect, sell, or use it
  if ((you.jokers && you.jokers.length) || (you.tarots && you.tarots.length)) {
    const sell = document.createElement('div');
    sell.className = 'shop-sell';
    sell.innerHTML = '<div class="sell-label">Your collection</div>';
    const sellRow = document.createElement('div');
    sellRow.className = 'sell-row';
    const addCell = (kind, def, idx) => {
      const cell = document.createElement('div');
      cell.className = 'sell-cell';
      cell.appendChild(jtile(kind, def));
      cell.onclick = () => openOwnedFocus(kind, def, idx, st);
      sellRow.appendChild(cell);
    };
    (you.jokers || []).forEach((j, idx) => addCell('joker', j, idx));
    (you.tarots || []).forEach((t, idx) => addCell('tarot', t, idx));
    sell.appendChild(sellRow);
    oc.appendChild(sell);
  }

  const row = document.createElement('div');
  row.className = 'row';
  const reroll = document.createElement('button');
  reroll.className = 'btn';
  const rerollCost = you.rerollCost == null ? 2 : you.rerollCost;
  reroll.innerHTML = `Reroll ${chip(rerollCost)}`;
  reroll.disabled = you.coins < rerollCost || you.ready;
  reroll.onclick = () => sendMsg({ t: 'reroll' });
  row.appendChild(reroll);
  oc.appendChild(row);
  const nextRound = st.dealIndexInRound >= st.dealsInRound;
  appendReadyBtn(oc, st, nextRound ? `Round ${st.round + 1}` : 'Next Deal');
}

// Tapping a shop card enlarges it to the centre of the screen for a clear look,
// with its text auto-shrunk to fit. Tap the backdrop to go back; Buy to purchase.
function openShopFocus(item, idx, you) {
  closeFocus();
  focusMode = 'market';
  selectedShopIdx = idx;
  const wrap = document.createElement('div');
  wrap.id = 'shopFocus';
  wrap.onclick = e => { if (e.target === wrap) closeFocus(); };

  const card = focusCardShell(item);

  const packBlock = packBlockedReason(item, you);
  const canAfford = !item.sold && !packBlock && you.coins >= item.cost && !you.ready;
  const buy = document.createElement('button');
  buy.className = 'btn primary focus-buy';
  if (item.sold) buy.innerHTML = 'Sold';
  else if (you.ready) buy.innerHTML = 'Locked in';
  else if (packBlock) buy.innerHTML = packBlock;
  else if (you.coins < item.cost) buy.innerHTML = `Need ${chip(item.cost)}`;
  else buy.innerHTML = `Buy - ${chip(item.cost)}`;
  buy.disabled = !canAfford;
  buy.onclick = e => { e.stopPropagation(); sendMsg({ t: 'buy', idx }); closeFocus(); };
  card.appendChild(buy);

  wrap.appendChild(card);
  document.body.appendChild(wrap);
  sanitizeIcons(wrap);
  requestAnimationFrame(() => fitText(card.querySelector('.focus-desc')));
}

function focusCardShell(item) {
  const card = document.createElement('div');
  card.className = `focus-card ${item.kind}` + (item.rarity ? ' r-' + item.rarity : '') +
    (item.stamp ? ' stamp-' + item.stamp : '');

  const art = focusDisplayCard(item);
  card.appendChild(art);

  card.insertAdjacentHTML('beforeend',
    `<div class="focus-name">${esc(item.name)}</div>` +
    rarityPill(item) +
    stampPill(item) +
    `<div class="focus-desc">${esc(item.desc)}</div>`);

  return card;
}

function openOwnedFocus(kind, def, idx, st, targetMode = false) {
  closeFocus();
  focusMode = targetMode ? 'tarotTargets' : 'owned';
  const item = { ...def, kind };
  const wrap = document.createElement('div');
  wrap.id = 'shopFocus';
  wrap.onclick = e => { if (e.target === wrap) closeFocus(); };

  const card = focusCardShell(item);
  if (targetMode) addTarotTargetPicker(card, def, idx, st);
  else addOwnedActions(card, kind, def, idx, st);

  wrap.appendChild(card);
  document.body.appendChild(wrap);
  sanitizeIcons(wrap);
  requestAnimationFrame(() => fitText(card.querySelector('.focus-desc')));
}

function addOwnedActions(card, kind, def, idx, st) {
  const actions = document.createElement('div');
  actions.className = 'focus-actions';
  if (kind === 'tarot') {
    const use = document.createElement('button');
    use.className = 'btn primary focus-btn';
    const canUse = canUseTarotNow(def, st);
    use.textContent = tarotUseLabel(def, st);
    use.disabled = !canUse;
    use.onclick = e => {
      e.stopPropagation();
      if (!canUse) return;
      if (def.targets > 0) openOwnedFocus('tarot', def, idx, st, true);
      else { sendMsg({ t: 'useTarot', idx, targets: [] }); closeFocus(); }
    };
    actions.appendChild(use);
  }
  if (st.phase === 'shop' && st.you.active && !st.you.ready) {
    const refund = Math.max(1, Math.floor((def.cost || 2) / 2));
    const sell = document.createElement('button');
    sell.className = 'btn focus-btn';
    sell.innerHTML = `Sell - ${chip(refund)}`;
    sell.onclick = e => {
      e.stopPropagation();
      sendMsg({ t: kind === 'joker' ? 'sellJoker' : 'sellTarot', idx });
      closeFocus();
    };
    actions.appendChild(sell);
  }
  if (actions.children.length) card.appendChild(actions);
  else card.insertAdjacentHTML('beforeend', `<div class="focus-note">${kind === 'joker' ? 'Passive joker: it triggers automatically.' : 'Use this tarot during discard before you throw to the crib.'}</div>`);
}

function tarotNeedsHand(def) {
  return def.targets > 0;
}

function canUseTarotNow(def, st) {
  if (!st || !st.you || !st.you.active) return false;
  if (st.phase === 'discard' && st.you.canDiscard) return true;
  return st.phase === 'shop' && !st.you.ready && def.targets === 0 && !tarotNeedsHand(def);
}

function tarotUseLabel(def, st) {
  if (canUseTarotNow(def, st)) return def.targets > 0 ? 'Use: choose hand cards' : 'Use now';
  if (tarotNeedsHand(def)) return 'Use during discard';
  return 'Use in shop or discard';
}

function addTarotTargetPicker(card, def, idx, st) {
  const targets = [];
  card.classList.add('targeting');
  card.insertAdjacentHTML('beforeend', `<div class="focus-note">Choose ${def.targets} card${def.targets === 1 ? '' : 's'} from your hand.</div>`);
  const hand = document.createElement('div');
  hand.className = 'focus-hand';
  const use = document.createElement('button');
  use.className = 'btn primary focus-btn';
  use.textContent = `Use ${def.name}`;
  use.disabled = true;
  const sync = () => {
    hand.querySelectorAll('.card').forEach(el => {
      const pos = targets.indexOf(el.dataset.cardId);
      el.classList.toggle('selected', pos >= 0);
      const old = el.querySelector('.ordertag');
      if (old) old.remove();
      if (pos >= 0 && def.targets > 1) el.insertAdjacentHTML('beforeend', `<span class="ordertag">${pos + 1}</span>`);
    });
    use.disabled = targets.length !== def.targets;
  };
  st.you.hand.forEach(c => {
    const el = cardEl(c);
    el.classList.add('clickable');
    el.dataset.cardId = c.id;
    el.onclick = e => {
      e.stopPropagation();
      const pos = targets.indexOf(c.id);
      if (pos >= 0) targets.splice(pos, 1);
      else if (targets.length < def.targets) targets.push(c.id);
      sync();
    };
    hand.appendChild(el);
  });
  use.onclick = e => {
    e.stopPropagation();
    if (targets.length !== def.targets) return;
    sendMsg({ t: 'useTarot', idx, targets });
    closeFocus();
  };
  card.appendChild(hand);
  card.appendChild(use);
}


function closeFocus() {
  const f = document.getElementById('shopFocus');
  if (f) f.remove();
  selectedShopIdx = -1;
  focusMode = null;
}

function closeShopFocus() { closeFocus(); }

// shrink text until it stops overflowing its (capped) box
function fitText(el, maxPx = 17, minPx = 10) {
  if (!el) return;
  let size = maxPx;
  el.style.fontSize = size + 'px';
  let guard = 0;
  while ((el.scrollHeight > el.clientHeight + 1) && size > minPx && guard++ < 48) {
    size -= 0.5;
    el.style.fontSize = size + 'px';
  }
}

function renderPackOpen(oc, st) {
  const pack = st.you.pendingPack;
  // first time we see this pack? sync the pick entrance with the burst FX
  const firstReveal = !(prevState && prevState.you && prevState.you.pendingPack);
  oc.innerHTML = `<h2>${icon('spark')} ${esc(pack.name)}</h2><div class="hint">Pick one:</div>`;
  const grid = document.createElement('div');
  grid.className = 'shop-grid pack-grid';
  pack.options.forEach((opt, idx) => {
    const div = document.createElement('div');
    const kindCls = opt.kind === 'card' ? 'standardcard' : opt.kind;
    div.className = `shop-item pick ${kindCls}` + (opt.rarity ? ' r-' + opt.rarity : '') +
      (opt.stamp ? ' stamp-' + opt.stamp : '') +
      (firstReveal ? ' pack-rise' : '');
    if (firstReveal) div.style.animationDelay = (900 + idx * 230) + 'ms';
    if (opt.kind === 'card') {
      div.innerHTML = `<div class="si-bigcard"></div><div class="si-name">${esc(cardLabel(opt))} - add to your deck</div>`;
      div.querySelector('.si-bigcard').appendChild(cardEl(opt));
      div.insertAdjacentHTML('beforeend', '<div class="shop-type card">Card</div>');
    } else {
      const icon = (opt.kind === 'joker' ? JOKER_ICONS : TAROT_ICONS)[opt.id] || '';
      div.innerHTML = `<div class="si-icon">${icon}<span class="jt-foil"></span></div><div class="si-name">${esc(opt.name)}</div>` +
        rarityPill(opt) +
        stampPill(opt) +
        `<div class="si-desc">${esc(opt.desc)}</div>`;
      div.insertAdjacentHTML('beforeend', `<div class="shop-type ${opt.kind}">${shopTypeLabel(opt.kind)}</div>`);
    }
    addInfoButton(div, opt.name || cardLabel(opt), shopItemHelp(opt));
    const full = (opt.kind === 'joker' && st.you.jokers.length >= (st.you.jokerSlots || 5) && opt.stamp !== 'negative') ||
      (opt.kind === 'tarot' && st.you.tarots.length >= (st.you.tarotSlots == null ? 2 : st.you.tarotSlots));
    const btn = document.createElement('button');
    btn.className = 'btn small primary';
    btn.textContent = full ? (opt.kind === 'joker' ? 'Jokers full' : 'Tarots full') : 'Take';
    btn.disabled = full;
    const take = e => {
      if (e) e.stopPropagation();
      if (full) return;
      sendMsg({ t: 'pickPack', idx });
    };
    btn.onclick = take;
    div.onclick = take;
    if (full) div.classList.add('sold');
    div.appendChild(btn);
    grid.appendChild(div);
  });
  oc.appendChild(grid);
  const skip = document.createElement('button');
  skip.className = 'btn';
  skip.textContent = 'Skip pack';
  skip.onclick = () => sendMsg({ t: 'pickPack', idx: -1 });
  oc.appendChild(skip);
}

function appendReadyBtn(oc, st, label) {
  const div = document.createElement('div');
  div.className = 'ready-box';
  if (st.you.ready) {
    const waiting = st.players.filter(p => p.active && !p.ready && p.connected).map(p => p.name);
    div.innerHTML = `<span style="opacity:.7">Waiting for ${esc(waiting.join(', ') || '?')}</span>`;
  } else {
    const btn = document.createElement('button');
    btn.className = 'btn primary';
    btn.textContent = label;
    btn.onclick = () => sendMsg({ t: 'ready' });
    div.appendChild(btn);
  }
  if (label !== 'To the Shop') div.appendChild(readyDots(st));
  oc.appendChild(div);
}

function readyDots(st) {
  const wrap = document.createElement('div');
  wrap.className = 'ready-dots';
  for (const p of st.players.filter(p => p.active)) {
    const dot = document.createElement('span');
    dot.className = 'ready-dot' + (p.ready ? ' on' : '') + (!p.connected ? ' off' : '');
    dot.title = `${p.name}: ${p.ready ? 'ready' : p.connected ? 'waiting' : 'offline'}`;
    wrap.appendChild(dot);
  }
  return wrap;
}

// ---- animations ----

function captureAnimationRefs(prev, st) {
  const refs = { discardFrom: new Map(), pegFrom: null, playAnimFrom: null };
  if (!prev || !st) return refs;

  if (prev.dealNumber === st.dealNumber && prev.players) {
    for (const p of st.players || []) {
      const pp = prev.players.find(q => q.seat === p.seat);
      if (!pp || pp.discarded || !p.discarded || !p.active) continue;
      const fromEl = p.seat === st.mySeat
        ? $('hand')
        : document.querySelector(`.seat[data-seat="${p.seat}"] .backs`) ||
          document.querySelector(`.seat[data-seat="${p.seat}"]`);
      if (fromEl) refs.discardFrom.set(p.seat, fromEl.getBoundingClientRect());
    }
  }

  const playAnim = st.lastPlayAnim &&
    (!prev.lastPlayAnim || st.lastPlayAnim.seq !== prev.lastPlayAnim.seq)
    ? st.lastPlayAnim.card
    : null;
  if (playAnim) {
    if (pendingFly && pendingFly.cardId === playAnim.id) refs.playAnimFrom = pendingFly.rect;
    else {
      const seatEl = document.querySelector(`.seat[data-seat="${playAnim.seat}"] .backs`) ||
        document.querySelector(`.seat[data-seat="${playAnim.seat}"]`);
      if (seatEl) refs.playAnimFrom = seatEl.getBoundingClientRect();
    }
  }

  if (!playAnim && st.phase === 'pegging' && prev.dealNumber === st.dealNumber &&
      Array.isArray(prev.pegStack) && st.pegStack.length > prev.pegStack.length) {
    const played = st.pegStack[st.pegStack.length - 1];
    if (pendingFly && pendingFly.cardId === played.id) refs.pegFrom = pendingFly.rect;
    else {
      const seatEl = document.querySelector(`.seat[data-seat="${played.seat}"] .backs`) ||
        document.querySelector(`.seat[data-seat="${played.seat}"]`);
      if (seatEl) refs.pegFrom = seatEl.getBoundingClientRect();
    }
  }
  return refs;
}

function runAnimations(prev, st, refs = {}) {
  if (!prev || prev === st) return;

  if (prev.phase !== st.phase) {
    if (st.phase === 'shop') sfx('shop');
    else if (st.phase === 'scoring') sfx('score');
    else if (st.phase === 'roundEnd') sfx('blind');
    else if (st.phase === 'gameover') sfx('gameover');
    else if (st.phase === 'discard') sfx('deal');
  }

  const newDeal = prev.dealNumber !== st.dealNumber;
  if (newDeal && st.phase === 'discard') {
    sfx('shuffle');
    const deckRect = $('deckPile').getBoundingClientRect();
    shuffleAnim(deckRect);
    const SHUFFLE_MS = 520 * ANIM;
    document.querySelectorAll('#hand .card').forEach((el, i) => {
      const r = el.getBoundingClientRect();
      el.style.setProperty('--dx', (deckRect.left - r.left) + 'px');
      el.style.setProperty('--dy', (deckRect.top - r.top) + 'px');
      el.classList.add('deal-in');
      el.style.animationDelay = (SHUFFLE_MS + i * 120) + 'ms';
    });
    document.querySelectorAll('.seat .backs .card').forEach((el, i) => {
      const r = el.getBoundingClientRect();
      el.style.setProperty('--dx', (deckRect.left - r.left) + 'px');
      el.style.setProperty('--dy', (deckRect.top - r.top) + 'px');
      el.classList.add('deal-in');
      el.style.animationDelay = (SHUFFLE_MS + i * 70) + 'ms';
    });
  }

  if (st.starter && !prev.starter) {
    sfx('card');
    const el = document.querySelector('#starterPile .card');
    if (el) el.classList.add('flip-in');
  }

  // discards glide (face down) from each player's hand to the crib pile
  if (prev.dealNumber === st.dealNumber && prev.players) {
    const cribCard = document.querySelector('#cribPile .card:last-child');
    for (const p of st.players) {
      const pp = prev.players.find(q => q.seat === p.seat);
      if (!pp || pp.discarded || !p.discarded || !p.active || !cribCard) continue;
      let fromRect = refs.discardFrom && refs.discardFrom.get(p.seat);
      if (!fromRect) {
        const fallback = p.seat === st.mySeat
          ? $('hand')
          : document.querySelector(`.seat[data-seat="${p.seat}"] .backs`) ||
            document.querySelector(`.seat[data-seat="${p.seat}"]`);
        if (fallback) fromRect = fallback.getBoundingClientRect();
      }
      if (!fromRect) continue;
      sfx('discard');
      for (let i = 0; i < (p.cribDiscardCount || st.baseDiscardCount || st.discardCount); i++) {
        setTimeout(() => {
          const tgt = document.querySelector('#cribPile .card:last-child');
          if (tgt) flyClone(backEl(false, p.deckArt), fromRect, tgt.getBoundingClientRect(), 460, { rot: p.seat === st.mySeat ? -8 : 8 });
        }, i * 110);
      }
    }
  }

  const playAnim = st.lastPlayAnim &&
    (!prev.lastPlayAnim || st.lastPlayAnim.seq !== prev.lastPlayAnim.seq)
    ? st.lastPlayAnim.card
    : null;
  const multAnim = st.lastMultAnim &&
    (!prev.lastMultAnim || st.lastMultAnim.seq !== prev.lastMultAnim.seq)
    ? st.lastMultAnim
    : null;
  if (playAnim) {
    let fromRect = refs.playAnimFrom || null;
    if (!fromRect) {
      const seatEl = document.querySelector(`.seat[data-seat="${playAnim.seat}"] .backs`) ||
        document.querySelector(`.seat[data-seat="${playAnim.seat}"]`);
      if (seatEl) fromRect = seatEl.getBoundingClientRect();
    }
    pendingFly = null;
    sfx('peg');
    if (fromRect) {
      const stackCards = [...document.querySelectorAll('#pegStack .card')];
      const target = stackCards.find(el => el.dataset.cardId === playAnim.id) ||
        stackCards[stackCards.length - 1];
      if (target) flyCard(playAnim, fromRect, target);
      else {
        const area = $('pegArea').getBoundingClientRect();
        flyClone(cardEl(playAnim), fromRect, {
          left: area.left + area.width / 2 - 34,
          top: area.top + area.height / 2 - 46,
        }, 440, { rot: 5, holdMs: 1200 });
      }
    }
    pulse($('pegCount'));
    const playGain = st.lastPlayAnim.multGain || 0;
    const queuedCloseout = multAnim && multAnim.multGain > 0 && st.pegClosing;
    const multFrom = playAnim.seat === st.mySeat && prev.you ? prev.you.dealMult : null;
    showMultGainForSeat(prev, st, playAnim.seat, playGain, {
      fromMult: multFrom,
      toMult: queuedCloseout && multFrom != null ? multFrom + playGain : null,
    });
    const pointGain = st.lastPlayAnim.pointGain || 0;
    if (pointGain > 0) {
      setTimeout(() => showHandPointGainForSeat(st, playAnim.seat, pointGain), playGain > 0 ? 280 : 0);
    }
  } else if (st.phase === 'pegging' && prev.dealNumber === st.dealNumber &&
      Array.isArray(prev.pegStack) && st.pegStack.length > prev.pegStack.length) {
    const played = st.pegStack[st.pegStack.length - 1];
    const stackCards = document.querySelectorAll('#pegStack .card');
    const target = stackCards[stackCards.length - 1];
    let fromRect = refs.pegFrom || null;
    if (!fromRect) {
      const seatEl = document.querySelector(`.seat[data-seat="${played.seat}"] .backs`) ||
        document.querySelector(`.seat[data-seat="${played.seat}"]`);
      if (seatEl) fromRect = seatEl.getBoundingClientRect();
    }
    pendingFly = null;
    sfx('peg');
    if (fromRect && target) flyCard(played, fromRect, target);
    pulse($('pegCount'));

    // how much pegging Mult this play earned (raw event points), shown rising
    // off the count; if it was MY play, orbs stream into the Mult box.
    const scoreTarget = deckEffectsOn(st) && st.you && st.you.deckArt === 'cosmic' ? st.cosmicTarget || 15 : 15;
    const gained = pegEvents(st.pegStack, st.pegCount, { target: scoreTarget }).reduce((s, e) => s + e.pts, 0);
    if (gained > 0) {
      showMultGainForSeat(prev, st, played.seat, gained);
    }
  }
  if (multAnim && multAnim.multGain > 0 &&
      (!playAnim || st.pegClosing || multAnim.multGain !== (st.lastPlayAnim && st.lastPlayAnim.multGain))) {
    const playGain = playAnim && st.lastPlayAnim ? st.lastPlayAnim.multGain || 0 : 0;
    const delay = playAnim && playGain > 0 ? 360 : 0;
    const multFrom = multAnim.seat === st.mySeat && prev.you ? prev.you.dealMult + playGain : null;
    setTimeout(() => showMultGainForSeat(prev, st, multAnim.seat, multAnim.multGain, {
      fromMult: multFrom,
      toMult: multAnim.seat === st.mySeat && st.you ? st.you.dealMult : null,
    }), delay);
  }

  // booster pack just opened - burst it before the picks rise in
  if (st.phase === 'shop' && st.you && st.you.pendingPack &&
      !(prev.you && prev.you.pendingPack)) {
    sfx('pack');
    playPackOpen(st.you.pendingPack);
  }

  // a tarot was consumed - sparkle the tarot row and shimmer the edited hand
  if (prev.you && st.you && st.you.tarots && prev.you.tarots &&
      st.you.tarots.length < prev.you.tarots.length && st.phase === 'discard') {
    sfx('tarot');
    const row = $('tarotRow').getBoundingClientRect();
    burstSparkles(row.left + row.width / 2, row.top + row.height / 2, 18, 275);
    flashEl($('tarotRow'));
    document.querySelectorAll('#hand .card').forEach(c => {
      c.classList.remove('tarot-flash'); void c.offsetWidth; c.classList.add('tarot-flash');
    });
  }

  // a finished 31/go count sweeps off the table
  if (prev.dealNumber === st.dealNumber && Array.isArray(prev.pegStack) &&
      prev.pegStack.length > 1 && st.pegStack.length === 0 &&
      (st.phase === 'pegging' || st.phase === 'scoring')) {
    const area = $('pegStack').getBoundingClientRect();
    prev.pegStack.forEach((c, i) => {
      const clone = cardEl(c);
      clone.classList.add('sweep');
      clone.style.left = (area.left + i * 28) + 'px';
      clone.style.top = area.top + 'px';
      clone.style.animationDelay = (i * 70) + 'ms';
      $('fx').appendChild(clone);
      setTimeout(() => clone.remove(), 1200 + i * 70);
    });
  }

  for (const p of st.players) {
    const pp = prev.players && prev.players.find(q => q.seat === p.seat);
    if (pp && p.score > pp.score) {
      if (st.mode === 'board' && st.phase === 'pegging') continue;
      if (st.mode === 'board') showBoardPointGain(st, p.seat, p.score - pp.score);
      else {
        sfx('score');
        floatAtSeat(st, p.seat, `+${p.score - pp.score}`, 'fx-pts');
      }
    }
  }
  if (prev.you && st.you && st.you.coins > prev.you.coins && st.phase !== 'shop') {
    sfx('coin');
    floatAtSeat(st, st.mySeat, `+${st.you.coins - prev.you.coins} coin`, 'fx-coin');
  }
}

function shuffleAnim(deckRect) {
  for (let i = 0; i < 6; i++) {
    const clone = backEl();
    clone.classList.add('shuffling', i % 2 ? 'shuf-r' : 'shuf-l');
    clone.style.left = deckRect.left + 'px';
    clone.style.top = deckRect.top + 'px';
    clone.style.animationDelay = (i * 70) + 'ms';
    $('fx').appendChild(clone);
    setTimeout(() => clone.remove(), 1100 + i * 70);
  }
}

// Smooth arced flight via the Web Animations API. WAAPI runs off the main
// thread and always fires onfinish, so cards glide the whole way instead of
// teleporting when a rAF/transition gets pre-empted.
function flyClone(el, fromRect, toRect, ms = 440, opts = {}) {
  el.classList.add('flying');
  el.style.left = fromRect.left + 'px';
  el.style.top = fromRect.top + 'px';
  $('fx').appendChild(el);
  const dx = toRect.left - fromRect.left;
  const dy = toRect.top - fromRect.top;
  const dist = Math.hypot(dx, dy);
  const arc = opts.arc != null ? opts.arc : -Math.min(150, dist * 0.3);
  const rot = opts.rot || 0;
  const anim = el.animate([
    { transform: 'translate(0px,0px) rotate(0deg) scale(1)' },
    { transform: `translate(${dx * 0.5}px, ${dy * 0.5 + arc}px) rotate(${rot * 0.6}deg) scale(1.07)`, offset: 0.55 },
    { transform: `translate(${dx}px, ${dy}px) rotate(${rot}deg) scale(1)` },
  ], { duration: ms * ANIM, easing: 'cubic-bezier(.3,.85,.25,1)', fill: 'forwards' });
  const done = () => {
    const finish = () => { el.remove(); if (opts.onfinish) opts.onfinish(); };
    if (opts.holdMs) setTimeout(finish, opts.holdMs);
    else finish();
  };
  anim.onfinish = done;
  anim.oncancel = done;
  return anim;
}

function flyCard(card, fromRect, target, opts = {}) {
  const toRect = target.getBoundingClientRect();
  target.style.visibility = 'hidden';
  flyClone(cardEl(card), fromRect, toRect, opts.ms || 440, {
    rot: opts.rot || 0,
    onfinish: () => { target.style.visibility = ''; if (opts.onfinish) opts.onfinish(); },
  });
}

// ---- particle / burst helpers ----

function floatRise(x, y, text, cls) {
  const div = document.createElement('div');
  div.className = 'fx-float ' + (cls || '');
  div.textContent = text;
  div.style.left = x + 'px';
  div.style.top = y + 'px';
  $('fx').appendChild(div);
  div.addEventListener('animationend', () => div.remove());
}

function showMultGainForSeat(prev, st, seat, gained, opts = {}) {
  if (!gained) return;
  if (st.mode === 'board') {
    showBoardPointGain(st, seat, gained);
    return;
  }
  sfx('mult');
  const pc = $('pegCount').getBoundingClientRect();
  const fromX = pc.left + pc.width / 2;
  const fromY = pc.top + pc.height / 2;
  floatRise(fromX, pc.top - 6, `+${gained} Mult`, 'fx-mult');

  const target = seat === st.mySeat
    ? $('myMult')
    : document.querySelector(`.seat[data-seat="${seat}"] .plaque`);
  if (!target) return;
  const tr = target.getBoundingClientRect();
  const toX = tr.left + tr.width / 2;
  const toY = tr.top + tr.height / 2;
  flingOrbs(fromX, fromY, toX, toY, Math.min(9, 3 + gained), () => {
    if (seat === st.mySeat && opts.toMult != null) {
      bumpMult(opts.toMult);
    } else if (seat === st.mySeat && prev.you && st.you && st.you.dealMult > prev.you.dealMult) {
      bumpMult(st.you.dealMult);
    }
  });
  floatRise(toX, tr.top - 8, `+${gained} Mult`, 'fx-mult');
  flashEl(target);
  if (seat === st.mySeat) {
    const b = $('myMult').querySelector('b');
    if (b && opts.fromMult != null) b.textContent = 'x' + opts.fromMult;
    else if (b && prev.you && st.you && st.you.dealMult > prev.you.dealMult) b.textContent = 'x' + prev.you.dealMult;
    if (st.you.jokers && st.you.jokers.length) flashEl($('jokerRow'));
  }
}

function showHandPointGainForSeat(st, seat, gained) {
  if (!gained || st.mode === 'board') return;
  sfx('score');
  const pc = $('pegCount').getBoundingClientRect();
  const fromX = pc.left + pc.width / 2;
  const fromY = pc.top + pc.height / 2;
  floatRise(fromX, pc.top - 28, `+${gained} Hand`, 'fx-points-blue');
  const target = seat === st.mySeat
    ? $('myScore')
    : document.querySelector(`.seat[data-seat="${seat}"] .plaque`);
  if (!target) return;
  const tr = target.getBoundingClientRect();
  const toX = tr.left + tr.width / 2;
  const toY = tr.top + tr.height / 2;
  flingOrbs(fromX, fromY, toX, toY, 5, () => {
    flashEl(target);
    if (seat === st.mySeat) pulse($('myScore'));
  }, 'blue');
  floatRise(toX, tr.top - 8, `+${gained} Hand`, 'fx-points-blue');
}

function showBoardPointGain(st, seat, gained) {
  if (!gained) return;
  sfx('score');
  const pc = $('pegCount').getBoundingClientRect();
  let fromX = pc.left + pc.width / 2;
  let fromY = pc.top + pc.height / 2;
  if (!pc.width || !pc.height) {
    const seatEl = seat === st.mySeat
      ? $('blindProgress')
      : document.querySelector(`.seat[data-seat="${seat}"] .plaque`);
    if (seatEl) {
      const sr = seatEl.getBoundingClientRect();
      fromX = sr.left + sr.width / 2;
      fromY = sr.top + sr.height / 2;
    }
  }
  floatRise(fromX, fromY - 20, `+${gained}`, 'fx-points-blue');
  const target = boardScoreTarget(st, seat);
  const tr = target.getBoundingClientRect();
  const toX = tr.left + tr.width / 2;
  const toY = tr.top + tr.height / 2;
  flingOrbs(fromX, fromY, toX, toY, Math.min(10, 3 + gained), () => {
    flashEl(target);
    if (seat === st.mySeat) pulse($('myScore'));
  }, 'blue');
  floatRise(toX, tr.top - 10, `+${gained}`, 'fx-points-blue');
}

function boardScoreTarget(st, seat) {
  if (seat === st.mySeat) return $('blindProgress');
  return document.querySelector(`.seat[data-seat="${seat}"] .seat-blind`) ||
    document.querySelector(`.seat[data-seat="${seat}"] .plaque`) ||
    $('blindProgress');
}

function flingOrbs(fromX, fromY, toX, toY, count, onArrive, variant = '') {
  let landed = 0;
  const finishOne = () => { if (++landed >= count && onArrive) onArrive(); };
  for (let i = 0; i < count; i++) {
    const orb = document.createElement('div');
    orb.className = 'fx-orb' + (variant ? ' ' + variant : '');
    orb.style.left = fromX + 'px';
    orb.style.top = fromY + 'px';
    $('fx').appendChild(orb);
    const jx = (Math.random() - 0.5) * 70;
    const jy = (Math.random() - 0.5) * 50 - 24;
    const anim = orb.animate([
      { transform: 'translate(-50%,-50%) scale(0.5)', opacity: 0.25 },
      { transform: `translate(calc(-50% + ${jx}px), calc(-50% + ${jy}px)) scale(1.15)`, opacity: 1, offset: 0.3 },
      { transform: `translate(calc(-50% + ${toX - fromX}px), calc(-50% + ${toY - fromY}px)) scale(0.35)`, opacity: 0.85 },
    ], { duration: (520 + Math.random() * 240) * ANIM, delay: i * 80, easing: 'cubic-bezier(.45,.05,.55,1)', fill: 'forwards' });
    const done = () => { orb.remove(); finishOne(); };
    anim.onfinish = done;
    anim.oncancel = done;
  }
}

function burstSparkles(cx, cy, count, hue) {
  for (let i = 0; i < count; i++) {
    const s = document.createElement('div');
    s.className = 'fx-spark';
    s.style.left = cx + 'px';
    s.style.top = cy + 'px';
    if (hue != null) s.style.background = `hsl(${hue + (Math.random() - 0.5) * 50}, 95%, 66%)`;
    $('fx').appendChild(s);
    const ang = Math.random() * Math.PI * 2;
    const dist = 50 + Math.random() * 150;
    const anim = s.animate([
      { transform: 'translate(-50%,-50%) scale(1)', opacity: 1 },
      { transform: `translate(calc(-50% + ${Math.cos(ang) * dist}px), calc(-50% + ${Math.sin(ang) * dist}px)) scale(0.2)`, opacity: 0 },
    ], { duration: (600 + Math.random() * 520) * ANIM, easing: 'cubic-bezier(.2,.6,.4,1)', fill: 'forwards' });
    const done = () => s.remove();
    anim.onfinish = done;
    anim.oncancel = done;
  }
}

function flashEl(el) {
  if (!el) return;
  el.classList.remove('fx-flash');
  void el.offsetWidth;
  el.classList.add('fx-flash');
  el.addEventListener('animationend', () => el.classList.remove('fx-flash'), { once: true });
}

function bumpMult(toValue) {
  const m = $('myMult');
  const b = m.querySelector('b');
  if (b && toValue != null) b.textContent = 'x' + toValue;
  m.classList.remove('bump');
  void m.offsetWidth;
  m.classList.add('bump');
  setTimeout(() => m.classList.remove('bump'), 540);
}

function playPackOpen(pack) {
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2 - 30;
  const packEl = document.createElement('div');
  packEl.className = 'fx-pack';
  packEl.innerHTML = PACK_ICONS[pack.type] || '';
  packEl.style.left = cx + 'px';
  packEl.style.top = cy + 'px';
  $('fx').appendChild(packEl);
  const anim = packEl.animate([
    { transform: 'translate(-50%,-50%) scale(0.6) rotate(0deg)', opacity: 0 },
    { transform: 'translate(-50%,-50%) scale(1.15) rotate(-5deg)', opacity: 1, offset: 0.22 },
    { transform: 'translate(-50%,-50%) scale(1.08) rotate(5deg)', offset: 0.4 },
    { transform: 'translate(-50%,-50%) scale(1.16) rotate(-3deg)', offset: 0.55 },
    { transform: `translate(-50%, ${window.innerHeight * 0.75}px) scale(0.7) rotate(22deg)`, opacity: 0 },
  ], { duration: 1150 * ANIM, easing: 'cubic-bezier(.4,0,.55,1)', fill: 'forwards' });
  const done = () => packEl.remove();
  anim.onfinish = done;
  anim.oncancel = done;
  const hue = pack.type === 'arcana' ? 275 : pack.type === 'ultra' ? 315 : pack.type === 'buffoon' ? 45 : 200;
  setTimeout(() => burstSparkles(cx, cy, 26, hue), 470 * ANIM);
  setTimeout(() => burstSparkles(cx, cy, 16, hue), 650 * ANIM);
}

function floatAtSeat(st, seat, text, cls) {
  let rect;
  if (seat === st.mySeat) {
    rect = $('myScore').getBoundingClientRect();
  } else {
    const el = document.querySelector(`.seat[data-seat="${seat}"] .plaque`);
    if (!el) return;
    rect = el.getBoundingClientRect();
  }
  const div = document.createElement('div');
  div.className = 'fx-float ' + cls;
  if (cls === 'fx-coin') div.innerHTML = `+${chip(String(text).replace(/\D/g, ''))}`;
  else div.textContent = text;
  div.style.left = (rect.left + rect.width / 2) + 'px';
  div.style.top = rect.top + 'px';
  $('fx').appendChild(div);
  div.addEventListener('animationend', () => div.remove());
}

function pulse(el) {
  el.classList.remove('pulse');
  void el.offsetWidth;
  el.classList.add('pulse');
}

// ---- tutorial mode ----

$('tutCheck').checked = tutorialOn;
$('tutCheck').onchange = () => {
  tutorialOn = $('tutCheck').checked;
  localStorage.setItem('crib_tutorial', tutorialOn ? '1' : '0');
  lastTutKey = '';
  if (!tutorialOn) $('tutorialBar').classList.add('hidden');
  else if (lastState) renderTutorial(lastState);
};
$('tutClose').onclick = () => $('tutorialBar').classList.add('hidden');

function shopStampTip(st) {
  const items = st.you.pendingPack ? st.you.pendingPack.options : st.you.shopOffer;
  const stamped = (items || []).filter(item => item && item.stamp);
  if (!stamped.length) return null;
  const names = [...new Set(stamped.map(item => stampText(item.stamp)).filter(Boolean))];
  const first = stamped[0];
  const itemName = first.name || (first.kind === 'card' ? cardLabel(first) : 'this item');
  const text = names.length === 1
    ? `Edition spotted - ${itemName} has ${names[0]}. Editions add a bonus on top of a joker's normal effect; tap the edition badge or info button for details.`
    : `Editions spotted - this shop has ${names.join('; ')}. Tap an edition badge or info button to learn what each one does.`;
  const sig = stamped.map(item => `${item.id || item.name}:${item.stamp}`).join('|');
  return { key: `shopStamp-${st.dealNumber}-${sig}`, text };
}

function tutorialMessage(st) {
  if (!st.you) return null;
  if (st.phase === 'scoring') return null;
  if (st.phase === 'roundEnd') {
    return { key: `round-${st.round}`, text: st.solo
      ? 'Blind check - your round score is compared to the target blind. Beat it to keep the run alive; The House can score points, but it cannot knock you out.'
      : 'Blind check - everyone compares their round score to the target blind. Players who cleared it survive and earn bonus coins; anyone short is eliminated.' };
  }
  if (st.phase === 'shop') {
    const stampTip = shopStampTip(st);
    if (stampTip) return stampTip;
    return { key: `shop-${st.dealNumber}`, text: 'Shop - spend coins before the next deal. Tap a card once to enlarge it and read the effect, tap it again to buy; jokers stay passive, tarots are single-use, and packs let you choose one reward.' };
  }
  if (!st.you.active && st.phase !== 'gameover') {
    return { key: 'spectate', text: "You've busted out - sit back and watch the rest of the table." };
  }
  switch (st.phase) {
    case 'discard':
      return st.you.canDiscard
        ? { key: 'discard', text: `Discard phase - send ${st.discardCount} card${st.discardCount > 1 ? 's' : ''} to ${dealerName(st)} crib. Tap a card to pick it (or drag it onto the crib pile), then press the button. Holding a tarot? Play it first.` }
        : { key: 'discardWait', text: 'Everyone secretly throws to the crib. Waiting for the other players...' };
    case 'pegging':
      {
        const chance = scoringOpportunity(st);
        if (chance) return chance;
      }
      return st.turnSeat === st.mySeat
        ? { key: 'pegMine', text: 'Your turn to peg! Every pegging point (15s, 31s, pairs, runs, go) adds to your red MULT for this deal. Keep the count at 31 or under. Tap a card to lift it, tap again or drag it to the pile.' }
        : { key: 'pegWait', text: 'Pegging - players take turns laying cards. Pegging points build your red MULT, applied to your hand at the show.' };
    case 'scoring':
      return { key: 'scoring', text: 'The show - your hand Points x your pegging Mult = the deal total. Hands count left of the dealer first, dealer next, crib last (crib uses the dealer\'s Mult).' };
    case 'roundEnd':
      return { key: 'round', text: st.solo
        ? 'Blind check - beat the blind score or your run ends. The House can never knock you out.'
        : "Blind check - beat this round's blind score or you're eliminated to the rail." };
    case 'shop':
      return { key: 'shop', text: 'Shop - jokers boost your hand Points or pegging Mult. Tap a card to flip it and read what it does, tap again to buy. The info button explains each type. Reroll for fresh stock.' };
    case 'gameover':
      return { key: 'over', text: 'The run is over - start another from the lobby!' };
  }
  return null;
}

function renderTutorial(st) {
  const bar = $('tutorialBar');
  if (!tutorialOn) { bar.classList.add('hidden'); return; }
  const msg = tutorialMessage(st);
  if (!msg) { bar.classList.add('hidden'); return; }
  if (msg.key === lastTutKey) return; // already showing this step
  lastTutKey = msg.key;
  $('tutorialText').textContent = msg.text;
  bar.classList.remove('hidden');
  bar.classList.remove('flash'); void bar.offsetWidth; bar.classList.add('flash');
}

// ---- boot ----

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* offline shell is optional */ });
}

if (!P2P_MODE) connectWs();
