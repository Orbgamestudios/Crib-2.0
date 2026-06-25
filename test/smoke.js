// Headless bot game: spins up the server, connects N ws clients, plays full
// matches until one player remains. Exercises discard, tarots, pegging,
// staged scoring reveal, blind checks/elimination, and the shop.
process.env.CRIB_FAST = '1';

import WebSocket from 'ws';
const { start } = await import('../server.js');
const { Game } = await import('../lib/game.js?v=3');
const { cardValue, makeCard } = await import('../lib/cards.js?v=3');
const { scoreBreakdown } = await import('../lib/scoring.js?v=3');
const { JOKERS_BY_ID, TAROTS, jokerCapacity } = await import('../lib/jokers.js?v=3');

const PORT = 3100;

async function testRestorePegClosing() {
  const game = new Game([
    { id: 'p1', name: 'Solo1', connected: true },
    { id: 'p2', name: 'The House', connected: true, isBot: true },
  ], { onUpdate() {}, log() {} });
  game.phase = 'pegging';
  game.pegClosing = true;
  game.pegCount = 12;
  game.turnSeat = null;
  game.lastPlayerSeat = 1;
  game.players[0].pegLeft = [makeCard(5, 0)];
  game.players[1].pegLeft = [];
  const snap = game.snapshot();
  game.destroy();

  const restored = Game.fromSnapshot(snap, { onUpdate() {}, log() {} });
  await new Promise(r => setTimeout(r, 80));
  if (restored.pegClosing || restored.turnSeat !== 0) {
    console.error('FAIL: restored peg-closing game did not resume', {
      pegClosing: restored.pegClosing,
      turnSeat: restored.turnSeat,
    });
    process.exit(1);
  }
  restored.destroy();
}

function testRestoreGoAnnouncements() {
  const game = new Game([
    { id: 'p1', name: 'Solo1', connected: true },
    { id: 'p2', name: 'Skipped', connected: true },
    { id: 'p3', name: 'Next', connected: true },
  ], { onUpdate() {}, log() {} });
  game.phase = 'pegging';
  game.pegCount = 25;
  game.turnSeat = 2;
  game.players[1].pegLeft = [makeCard(13, 0)];
  game.players[2].pegLeft = [makeCard(1, 0)];
  game.goAnnounced = new Set([0]);
  const snap = game.snapshot();
  game.destroy();
  if (!Array.isArray(snap.goAnnounced) || snap.goAnnounced[0] !== 0) {
    console.error('FAIL: go announcements were not serialized as an array', snap.goAnnounced);
    process.exit(1);
  }

  snap.goAnnounced = {};
  const restored = Game.fromSnapshot(snap, { onUpdate() {}, log() {} });
  restored.announceGos(0, 2);
  if (!(restored.goAnnounced instanceof Set) || !restored.goAnnounced.has(1)) {
    console.error('FAIL: legacy go announcements were not restored as a Set', restored.goAnnounced);
    process.exit(1);
  }
  restored.destroy();
}

function testDeckEffects() {
  const aurora = new Game([
    { id: 'p1', name: 'Aurora', connected: true, deckArt: 'aurora' },
    { id: 'p2', name: 'Classic', connected: true },
  ], { onUpdate() {}, log() {} });
  const ap = aurora.players[0];
  const chosen = ap.hand.slice(0, aurora.discardNeed(ap));
  const burned = chosen[chosen.length - 1];
  aurora.discard(ap, chosen.map(c => c.id));
  if (aurora.crib.length !== 2 || ap.deck.some(c => c.id === burned.id) ||
      aurora.cribDeckArts.length !== 2 || aurora.cribDeckArts.some(art => art !== 'aurora')) {
    console.error('FAIL: Aurora did not send two cards and remove the final selection', {
      crib: aurora.crib.length,
      burnedStillInDeck: ap.deck.some(c => c.id === burned.id),
      cribDeckArts: aurora.cribDeckArts,
    });
    process.exit(1);
  }
  aurora.destroy();

  const ruby = new Game([
    { id: 'p1', name: 'Ruby', connected: true, deckArt: 'ruby' },
    { id: 'p2', name: 'Classic', connected: true },
  ], { onUpdate() {}, log() {} });
  const rp = ruby.players[0];
  const rubyDeckSuits = new Set(rp.deck.map(c => c.suit));
  if (!rp.rubySuits || rp.rubySuits.length !== 2 || rubyDeckSuits.size !== 2 || [...rubyDeckSuits].some(s => !rp.rubySuits.includes(s))) {
    console.error('FAIL: Ruby did not choose and apply two suits', rp.rubySuits, [...rubyDeckSuits]);
    process.exit(1);
  }
  ruby.destroy();

  const gambit = new Game([
    { id: 'p1', name: 'Gambit', connected: true, deckArt: 'gambit' },
    { id: 'p2', name: 'Classic', connected: true },
  ], { onUpdate() {}, log() {} });
  const gp = gambit.players[0];
  if (!gp.gambitRandomized || gp.deck.length !== 52 || gp.deck.some(c => c.rank < 1 || c.rank > 13 || c.suit < 0 || c.suit > 3)) {
    console.error('FAIL: Gambit deck was not randomized into valid cards');
    process.exit(1);
  }
  const charged = makeCard(5, 0);
  gp.deck.push(charged);
  gp.hand = [charged];
  gp.kept = [charged];
  gp.pegLeft = [charged];
  gambit.players[1].kept = [];
  gambit.players[1].pegLeft = [makeCard(10, 1)];
  gambit.phase = 'pegging';
  gambit.turnSeat = gp.seat;
  gambit.pegCount = 10;
  gambit.pegStack = [];
  gambit.starter = makeCard(1, 2);
  gambit.playCard(gp, charged.id);
  if (gp.dealHandBonus !== 2 || gp.dealPegMult < 2 || !charged.gambitCharged || gambit.lastPlayAnim.pointGain !== 2) {
    console.error('FAIL: Gambit 15 did not grant Mult, Hand points, and charge the card');
    process.exit(1);
  }
  const charged31 = makeCard(10, 3);
  gp.deck.push(charged31);
  gp.hand.push(charged31);
  gp.kept.push(charged31);
  gp.pegLeft = [charged31];
  gambit.turnSeat = gp.seat;
  gambit.pegCount = 21;
  gambit.pegStack = [];
  gambit.playCard(gp, charged31.id);
  if (gp.dealHandBonus !== 4 || !charged31.gambitCharged || gambit.lastPlayAnim.pointGain !== 2) {
    console.error('FAIL: Gambit 31 did not add another Hand bonus and charge the card');
    process.exit(1);
  }
  clearTimeout(gambit.closeTimer);
  gambit.closeTimer = null;
  gambit.pegClosing = false;
  gambit.doScoring();
  const gambitHand = gambit.scoringResults.find(r => r.kind === 'hand' && r.seat === gp.seat);
  const chargedIds = [charged.id, charged31.id];
  if (!gambitHand || gambitHand.points < 4 ||
      chargedIds.some(id => !gambitHand.cards.some(c => c.id === id && c.gambitCharged)) ||
      chargedIds.some(id => gp.deck.some(c => c.id === id))) {
    console.error('FAIL: Gambit charged card did not score and leave the deck');
    process.exit(1);
  }
  gambit.destroy();

  const triggerGame = new Game([
    { id: 'p1', name: 'Triggers', connected: true },
    { id: 'p2', name: 'Other', connected: true },
  ], { onUpdate() {}, log() {} });
  const tp = triggerGame.players[0];
  const triggerCard = makeCard(3, 0);
  tp.jokers = [{ id: 'odd_todd', stamp: 'foil' }, 'lusty_joker', 'low_rider'];
  tp.hand = [triggerCard];
  tp.kept = [triggerCard];
  tp.pegLeft = [triggerCard];
  triggerGame.players[1].kept = [];
  triggerGame.players[1].pegLeft = [makeCard(10, 1)];
  triggerGame.phase = 'pegging';
  triggerGame.turnSeat = tp.seat;
  triggerGame.pegCount = 12;
  triggerGame.pegStack = [];
  triggerGame.starter = makeCard(1, 2);
  triggerGame.playCard(tp, triggerCard.id);
  if (tp.dealHandBonus !== 6 || triggerGame.lastPlayAnim.pointGain !== 6) {
    console.error('FAIL: play and score-gated Hand jokers did not stack', tp.dealHandBonus);
    process.exit(1);
  }
  triggerGame.doScoring();
  const triggerHand = triggerGame.scoringResults.find(r => r.kind === 'hand' && r.seat === tp.seat);
  if (!triggerHand || triggerHand.points !== 11 || !triggerHand.lines.some(l => l.label.includes('Foil Edition')) ||
      !triggerHand.lines.some(l => l.label.includes('Odd Todd')) ||
      !triggerHand.lines.some(l => l.label.includes('Lusty Joker'))) {
    console.error('FAIL: pegging Hand bonuses were not carried into hand scoring', triggerHand);
    process.exit(1);
  }
  triggerGame.destroy();

  const missGame = new Game([
    { id: 'p1', name: 'Miss', connected: true },
    { id: 'p2', name: 'Other', connected: true },
  ], { onUpdate() {}, log() {} });
  const mp = missGame.players[0];
  const missCard = makeCard(3, 0);
  mp.jokers = ['odd_todd', 'lusty_joker', 'low_rider'];
  mp.pegLeft = [missCard];
  missGame.players[1].pegLeft = [makeCard(10, 1)];
  missGame.phase = 'pegging';
  missGame.turnSeat = mp.seat;
  missGame.pegCount = 0;
  missGame.pegStack = [];
  missGame.playCard(mp, missCard.id);
  if (mp.dealHandBonus !== 2 || missGame.lastPlayAnim.pointGain !== 2) {
    console.error('FAIL: card-play Hand jokers did not trigger without a scoring play');
    process.exit(1);
  }
  missGame.destroy();

  const passiveGame = new Game([
    { id: 'p1', name: 'Passives', connected: true },
    { id: 'p2', name: 'Other', connected: true },
  ], { onUpdate() {}, log() {} });
  const pp = passiveGame.players[0];
  pp.jokers = ['overseer', 'obelisk', 'bull_market', 'even_steven', 'jack_of_all', 'scary_face', 'his_majesty'];
  pp.coins = 10;
  const passiveCard = makeCard(2, 1);
  pp.pegLeft = [passiveCard];
  passiveGame.players[1].pegLeft = [makeCard(10, 0)];
  passiveGame.starter = makeCard(12, 2);
  passiveGame.phase = 'pegging';
  passiveGame.turnSeat = pp.seat;
  passiveGame.pegCount = 0;
  passiveGame.pegStack = [];
  passiveGame.playCard(pp, passiveCard.id);
  if (pp.dealHandBonus !== 5 || passiveGame.lastPlayAnim.pointGain !== 5 || passiveGame.lastPlayAnim.multGain !== 1) {
    console.error('FAIL: passive jokers did not trigger into the Hand and Mult boxes', passiveGame.lastPlayAnim);
    process.exit(1);
  }
  passiveGame.destroy();

  if (jokerCapacity([{ id: 'odd_todd', stamp: 'negative' }]) !== 6 || TAROTS.some(t => t.jokerStamp)) {
    console.error('FAIL: Negative edition capacity or stamp tarot removal is incorrect');
    process.exit(1);
  }

  const editionGame = new Game([
    { id: 'p1', name: 'Editions', connected: true },
    { id: 'p2', name: 'Other', connected: true },
  ], { onUpdate() {}, log() {} });
  const ep = editionGame.players[0];
  ep.jokers = [{ id: 'odd_todd', stamp: 'holographic' }, { id: 'lusty_joker', stamp: 'polychrome' }];
  const editionMult = editionGame.scoreFinalMultOrdered(ep, 1, 'hand', [makeCard(2, 1)], makeCard(6, 2));
  if (editionMult.mult !== 6) {
    console.error('FAIL: Holographic and Polychrome did not resolve left to right', editionMult);
    process.exit(1);
  }
  ep.jokers = ['card_sharp'];
  ep.pegScoreSignatures = [];
  ep.cardSharpUsed = false;
  const pairEvent = [{ type: 'pair', size: 2, pts: 2 }];
  const firstPair = editionGame.scorePegMult(ep, makeCard(7, 0), pairEvent);
  const repeatPair = editionGame.scorePegMult(ep, makeCard(7, 1), pairEvent);
  if (firstPair !== 2 || repeatPair !== 4 || !ep.cardSharpUsed) {
    console.error('FAIL: Card Sharp did not double the repeated scoring play', { firstPair, repeatPair });
    process.exit(1);
  }
  ep.jokers = ['riff_raff'];
  editionGame.startRound();
  if (ep.jokers.length !== 3 || ep.jokers.slice(1).some(j => JOKERS_BY_ID[j.id].rarity !== 'common')) {
    console.error('FAIL: Riff-Raff did not create two Common Jokers', ep.jokers);
    process.exit(1);
  }
  editionGame.destroy();

  const emeraldGame = new Game([
    { id: 'p1', name: 'Emerald', connected: true, deckArt: 'emerald' },
    { id: 'p2', name: 'Other', connected: true },
  ], { onUpdate() {}, log() {} });
  const emeraldPlayer = emeraldGame.players[0];
  if (emeraldPlayer.coins !== 5 || emeraldPlayer.jokers.length !== 1 ||
      JOKERS_BY_ID[emeraldPlayer.jokers[0].id].rarity !== 'common') {
    console.error('FAIL: Emerald Felt did not grant its opening coins and Common Joker');
    process.exit(1);
  }
  emeraldPlayer.jokers = [{ id: 'hologram', hologramMult: 1 }];
  emeraldGame.addCardToDeck(emeraldPlayer, makeCard(9, 2, 'bonus'));
  if (emeraldPlayer.jokers[0].hologramMult !== 1.25) {
    console.error('FAIL: Hologram did not grow when a playing card entered the deck');
    process.exit(1);
  }
  const enhanced = emeraldGame.scoreCardEnhancements(emeraldPlayer, 'hand', [
    makeCard(4, 0, 'bonus'), makeCard(7, 1, 'mult'), makeCard(9, 2, 'gold'),
  ], 1);
  const steel = emeraldGame.scoreCardEnhancements(emeraldPlayer, 'crib', [makeCard(6, 3, 'steel')], 1);
  if (enhanced.points !== 2 || enhanced.mult !== 2 || emeraldPlayer.coins !== 8 || steel.mult !== 1.5) {
    console.error('FAIL: playing-card enhancements did not apply to scoring');
    process.exit(1);
  }
  const wildFlush = scoreBreakdown([
    makeCard(2, 0), makeCard(4, 0), makeCard(6, 0), makeCard(8, 3, 'wild'),
  ], makeCard(10, 0), false);
  const stonePair = scoreBreakdown([makeCard(5, 0), makeCard(5, 1, 'stone')], null, false);
  if (wildFlush.flush !== 5 || stonePair.pairs !== 0 || cardValue(makeCard(13, 3, 'stone')) !== 0) {
    console.error('FAIL: Wild or Stone core cribbage rules are incorrect');
    process.exit(1);
  }
  const tarotCards = [makeCard(3, 0), makeCard(8, 1)];
  emeraldPlayer.hand = tarotCards.slice();
  emeraldPlayer.tarots = ['magician'];
  emeraldPlayer.discarded = false;
  emeraldGame.phase = 'discard';
  emeraldGame.useTarot(emeraldPlayer, 0, tarotCards.map(c => c.id));
  if (tarotCards.some(c => c.enhancement !== 'lucky')) {
    console.error('FAIL: enhancement tarot did not permanently update its targets');
    process.exit(1);
  }
  emeraldPlayer.tarots = ['wheel'];
  const realRandom = Math.random;
  const wheelRolls = [0, 0, 0];
  Math.random = () => wheelRolls.shift() ?? 0;
  emeraldGame.useTarot(emeraldPlayer, 0, []);
  Math.random = realRandom;
  if (emeraldPlayer.jokers[0].stamp !== 'foil') {
    console.error('FAIL: Wheel of Fortune did not add a successful Edition');
    process.exit(1);
  }
  emeraldGame.destroy();
}

function bot(name, opts) {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const b = { name, ws, state: null, done: false };
  ws.on('open', () => {
    if (opts.solo) ws.send(JSON.stringify({ t: 'createSolo', playerName: name }));
    else if (opts.create) ws.send(JSON.stringify({ t: 'createRoom', roomName: 'smoke', playerName: name }));
  });
  ws.on('message', raw => {
    const msg = JSON.parse(raw);
    if (msg.t === 'rooms' && !opts.create && !b.joined && msg.rooms.length) {
      b.joined = true;
      ws.send(JSON.stringify({ t: 'joinRoom', roomId: msg.rooms[0].id, playerName: name }));
    }
    if (msg.t === 'roomUpdate' && opts.create && msg.players.length === opts.total && !b.started) {
      b.started = true;
      ws.send(JSON.stringify({ t: 'startGame' }));
    }
    if (msg.t === 'state') {
      b.state = msg.state;
      act(b);
    }
    if (msg.t === 'error') b.lastError = msg.text;
  });
  ws.on('error', e => { throw e; });
  return b;
}

function act(b) {
  const st = b.state;
  const you = st.you;
  setTimeout(() => {
    if (b.done || !b.state || b.state !== st) return;
    if (st.phase === 'gameover') { b.done = true; return; }
    if (!you.active) return; // spectating
    if (st.phase === 'discard' && you.canDiscard) {
      if (you.tarots.length && Math.random() < 0.5) {
        const def = you.tarots[0];
        const targets = you.hand.slice(0, def.targets).map(c => c.id);
        b.ws.send(JSON.stringify({ t: 'useTarot', idx: 0, targets }));
      } else {
        const cards = you.hand.slice(0, st.discardCount).map(c => c.id);
        b.ws.send(JSON.stringify({ t: 'discard', cards }));
      }
    } else if (st.phase === 'pegging' && st.turnSeat === st.mySeat) {
      const card = you.hand.find(c => st.pegCount + cardValue(c) <= 31);
      if (card) b.ws.send(JSON.stringify({ t: 'playCard', card: card.id }));
    } else if ((st.phase === 'scoring' || st.phase === 'shop' || st.phase === 'roundEnd') && !you.ready) {
      if (st.phase === 'shop' && you.pendingPack) {
        const opts = you.pendingPack.options;
        let idx = opts.findIndex(o => o.kind === 'joker' && you.jokers.length < 5);
        if (idx === -1) idx = opts.findIndex(o => o.kind === 'card');
        if (idx === -1) idx = opts.findIndex(o => o.kind === 'tarot' && you.tarots.length < 2);
        b.ws.send(JSON.stringify({ t: 'pickPack', idx })); // -1 skips
        return;
      }
      if (st.phase === 'shop' && you.shopOffer) {
        const idx = you.shopOffer.findIndex(it => !it.sold && it.cost <= you.coins &&
          (it.kind === 'joker' ? you.jokers.length < 5 :
           it.kind === 'tarot' ? you.tarots.length < 2 : true));
        if (idx >= 0 && Math.random() < 0.7) {
          b.ws.send(JSON.stringify({ t: 'buy', idx }));
          return; // next state update re-triggers act
        }
      }
      b.ws.send(JSON.stringify({ t: 'ready' }));
    }
  }, 5);
}

async function runMatch(nPlayers) {
  console.log(`--- smoke: ${nPlayers} players ---`);
  const bots = [];
  bots.push(bot('Bot1', { create: true, total: nPlayers }));
  await new Promise(r => setTimeout(r, 200));
  for (let i = 2; i <= nPlayers; i++) {
    bots.push(bot('Bot' + i, {}));
    await new Promise(r => setTimeout(r, 100));
  }

  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (bots.every(b => b.done)) break;
    await new Promise(r => setTimeout(r, 200));
  }
  if (!bots.every(b => b.done)) {
    const b = bots.find(x => !x.done);
    console.error('STALLED. phase=', b.state && b.state.phase, 'round=', b.state && b.state.round,
      'turnSeat=', b.state && b.state.turnSeat, 'lastError=', b.lastError);
    for (const x of bots) {
      console.error(`  ${x.name}: done=${x.done} ready=${x.state && x.state.you.ready}`,
        'pendingPack=', x.state && JSON.stringify(x.state.you.pendingPack),
        'active=', x.state && x.state.you.active, 'phase=', x.state && x.state.phase);
    }
    process.exit(1);
  }
  const final = bots[0].state;
  if (!final.standings || final.standings.length !== nPlayers) {
    console.error('FAIL: bad standings', final.standings);
    process.exit(1);
  }
  const winners = final.standings.filter(s => s.eliminatedRound === null);
  console.log(`gameover OK after round ${final.round}:`,
    final.standings.map(s => `${s.name}:${s.score}${s.eliminatedRound === null ? '(W)' : '(r' + s.eliminatedRound + ')'}`).join('  '));
  if (winners.length < 1) {
    console.error('FAIL: no winner recorded');
    process.exit(1);
  }
  for (const b of bots) {
    b.ws.send(JSON.stringify({ t: 'backToLobby' }));
    b.ws.close();
  }
  await new Promise(r => setTimeout(r, 200));
}

async function runSolo() {
  console.log('--- smoke: solo vs The House ---');
  const b = bot('Solo1', { solo: true });
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline && !b.done) {
    await new Promise(r => setTimeout(r, 200));
  }
  if (!b.done) {
    console.error('SOLO STALLED. phase=', b.state && b.state.phase, 'round=', b.state && b.state.round,
      'turnSeat=', b.state && b.state.turnSeat, 'lastError=', b.lastError);
    process.exit(1);
  }
  const final = b.state;
  if (!final.solo || !final.standings || final.standings.length !== 2) {
    console.error('FAIL: bad solo gameover', final.solo, final.standings);
    process.exit(1);
  }
  const me = final.standings.find(s => s.name === 'Solo1');
  console.log(`solo run over OK: reached round ${final.round}, score ${me.score}`);
  b.ws.send(JSON.stringify({ t: 'backToLobby' }));
  b.ws.close();
  await new Promise(r => setTimeout(r, 200));
}

const server = await start(PORT);
testDeckEffects();
await testRestorePegClosing();
testRestoreGoAnnouncements();
await runMatch(2);
await runMatch(3);
await runMatch(5);
await runSolo();
console.log('smoke test passed');
server.close();
process.exit(0);
