import { makeDeck, makeCard, sortedDeck, shuffle, cardValue, cardName } from './cards.js?v=3';
import { scoreBreakdown, pegEvents } from './scoring.js?v=3';
import {
  TAROTS_BY_ID,
  aggregateMods, buildScore, buildScoreOrdered, makeShopOffer, openPack, randomCommonJoker, randomJoker, randomTarot,
  effectiveJokerIds, jokerCapacity, jokerDef, jokerId, normalizeJoker,
} from './jokers.js?v=3';

// smoke tests: collapse all pacing (browser has no `process`)
const FAST = typeof process !== 'undefined' && !!(process.env && process.env.CRIB_FAST);
const STARTING_COINS = 0;
const REROLL_START_COST = 2;
const MAX_JOKERS = 5;
const MAX_TAROTS = 2;
const REVEAL_MS = FAST ? 40 : 2200;
const SCORE_DONE_HOLD_MS = FAST ? 0 : 1800;
const PEG_CLOSE_MS = FAST ? 30 : 1150; // hold the closing pile visible before it sweeps
const BOT_ACTION_MS = FAST ? 25 : 1300;
const BOT_REACTION_MS = FAST ? 0 : 1100;
const IDLE_DISCONNECT_MS = FAST ? 1000 : 20000;
const IDLE_ANYONE_MS = FAST ? 5000 : 120000;
const IDLE_POLL_MS = FAST ? 200 : 5000;

// Each deal scores hand/crib Points × pegging Mult (Balatro-style), so per-deal
// yield is far larger than the old additive system — blinds are scaled up to
// match, then made ~30% harder all round. The round multiplier grows
// exponentially: gentle rounds 1-3, biting by 4-5, brutal at 6 (~2x),
// near-impossible by 9 (~5x). Jokers are the only way to keep pace.
const BASE_MULT = 1;        // every hand starts at ×1; pegging adds to it
const PER_DEAL_YIELD = 28;  // avg hand Points × avg pegging Mult per deal
const PER_CRIB_YIELD = 18;  // avg crib Points × dealer Mult
const HARDER = 1.30;        // 30% harder all around
const BOARD_GOAL = 121;
const REGULAR_FINAL_BLIND = 9;
const DECK_IDS = new Set(['classic', 'emerald', 'sapphire', 'ruby', 'aurora', 'neon', 'cosmic', 'gambit']);
function normalizeMode(mode) {
  if (mode === 'board') return 'board';
  if (mode === 'endless') return 'endless';
  return 'blind';
}
function normalizeDeckArt(id) {
  return DECK_IDS.has(id) ? id : 'classic';
}
function randomSuitPair() {
  return shuffle([0, 1, 2, 3]).slice(0, 2);
}

function rubyDeckCard(c, suits) {
  if (!c || suits.includes(c.suit)) return c;
  return makeCard(c.rank, suits[Math.floor(Math.random() * suits.length)], c.enhancement);
}

function gambitDeckCard() {
  return makeCard(1 + Math.floor(Math.random() * 13), Math.floor(Math.random() * 4));
}
export function computeBlind(round, playerCount, dealsInRound) {
  const cribsEach = playerCount === 2 ? 2 : 1;
  const expected = dealsInRound * PER_DEAL_YIELD + cribsEach * PER_CRIB_YIELD;
  const mult = 0.37 * Math.pow(1.33, round - 1) * HARDER;
  const earlyRelief = round === 1 ? 40 : round === 2 ? 20 : 0;
  return Math.max(20, Math.round(expected * mult * 2 / 5) * 5 - earlyRelief);
}

export class Game {
  // seats = [{ id, name, connected }] in join order
  constructor(seats, hooks, opts = {}) {
    this.onUpdate = hooks.onUpdate || (() => {});
    this.logFn = hooks.log || (() => {});
    this.mode = normalizeMode(opts.mode);
    this.deckEffects = opts.deckEffects !== false;
    this.goalScore = this.mode === 'board' ? BOARD_GOAL : null;
    this.players = seats.map((s, i) => ({
      id: s.id, name: s.name, seat: i, connected: s.connected !== false,
      isBot: !!s.isBot,
      deckArt: normalizeDeckArt(s.deckArt),
      rubySuits: null, gambitRandomized: false,
      active: true, eliminatedRound: null, blindsPassed: 0,
      deck: makeDeck(), drawPile: [], pendingPack: null, pegPlays: 0, dealPegMult: 0,
      dealHandBonus: 0, dealHandBonusLines: [],
      score: 0, roundScore: 0, coins: STARTING_COINS, jokers: [], tarots: [],
      hand: [], kept: [], pegLeft: [], discarded: false, ready: false,
      scoringDone: false, dealPoints: 0, shopOffer: null, rerollCost: REROLL_START_COST,
    }));
    this.solo = this.players.some(p => p.isBot);
    this.nextBotAt = Date.now() + BOT_ACTION_MS;
    if (this.solo) this.botTimer = setInterval(() => this.botTick(), FAST ? 25 : 300);
    this.round = 0;
    this.dealNumber = 0;
    this.dealerSeat = -1;
    this.roundComplete = false;
    this.phase = 'idle';
    this.animSeq = 0;
    this.lastPlayAnim = null;
    this.lastMultAnim = null;
    this.lastProgress = Date.now();
    this.idleTimer = setInterval(() => this.checkIdle(), IDLE_POLL_MS);
    this.startRound();
  }

  destroy() {
    clearInterval(this.idleTimer);
    clearInterval(this.revealTimer);
    clearInterval(this.botTimer);
    clearTimeout(this.closeTimer);
  }

  snapshot() {
    const skip = new Set(['onUpdate', 'logFn', 'idleTimer', 'revealTimer', 'botTimer', 'nextBotAt', 'closeTimer']);
    const out = {};
    for (const [k, v] of Object.entries(this)) {
      if (!skip.has(k)) out[k] = k === 'goAnnounced' && v instanceof Set ? [...v] : v;
    }
    return JSON.parse(JSON.stringify(out));
  }

  static fromSnapshot(snapshot, hooks) {
    const seats = (snapshot.players || []).map(p => ({
      id: p.id, name: p.name, connected: p.connected, isBot: p.isBot,
    }));
    const game = new Game(seats, { onUpdate() {}, log() {} });
    const keepTimers = {
      idleTimer: game.idleTimer,
      botTimer: game.botTimer,
    };
    clearInterval(game.revealTimer);
    Object.assign(game, JSON.parse(JSON.stringify(snapshot)));
    const savedGos = Array.isArray(snapshot.goAnnounced)
      ? snapshot.goAnnounced
      : snapshot.goAnnounced instanceof Set ? [...snapshot.goAnnounced] : [];
    game.goAnnounced = new Set(savedGos.filter(seat =>
      Number.isInteger(seat) && seat >= 0 && seat < game.players.length));
    game.mode = normalizeMode(game.mode);
    game.deckEffects = snapshot.deckEffects !== false;
    game.goalScore = game.mode === 'board' ? BOARD_GOAL : null;
    game.onUpdate = hooks.onUpdate || (() => {});
    game.logFn = hooks.log || (() => {});
    game.idleTimer = keepTimers.idleTimer;
    game.botTimer = keepTimers.botTimer;
    game.revealTimer = null;
    game.closeTimer = null;
    game.nextBotAt = Date.now() + BOT_ACTION_MS;
    if (!Array.isArray(game.cribDeckArts)) game.cribDeckArts = [];
    for (const p of game.players) {
      if (!Array.isArray(p.rubySuits)) p.rubySuits = null;
      if (typeof p.gambitRandomized !== 'boolean') p.gambitRandomized = false;
      if (typeof p.dealHandBonus !== 'number') p.dealHandBonus = p.gambitHandBonus || 0;
      if (!Array.isArray(p.dealHandBonusLines)) p.dealHandBonusLines = [];
      p.jokers = (p.jokers || []).map(normalizeJoker).filter(Boolean);
      p.tarots = (p.tarots || []).filter(id => TAROTS_BY_ID[id]);
      if (Array.isArray(p.shopOffer)) p.shopOffer = p.shopOffer.filter(item => item.kind !== 'tarot' || TAROTS_BY_ID[item.id]);
      if (p.pendingPack && Array.isArray(p.pendingPack.options)) {
        p.pendingPack.options = p.pendingPack.options.filter(item => item.kind !== 'tarot' || TAROTS_BY_ID[item.id]);
        if (!p.pendingPack.options.length) p.pendingPack = null;
      }
      if (!Array.isArray(p.pegScoreSignatures)) p.pegScoreSignatures = [];
      if (typeof p.cardSharpUsed !== 'boolean') p.cardSharpUsed = false;
    }
    if (game.phase === 'scoring') {
      game.revealIndex = Math.max(0, (game.scoringResults || []).length - 1);
      game.scoreDoneAt = 0;
    } else if (game.phase === 'pegging' && game.pegClosing) {
      game.closeTimer = setTimeout(() => { game.finishCount(); game.onUpdate(); }, PEG_CLOSE_MS);
    } else if (game.phase === 'pegging' && game.turnSeat == null) {
      game.finishCount();
    }
    return game;
  }

  // ---- The House (solo bot) ----

  botTick() {
    try {
      const now = Date.now();
      if (now < this.nextBotAt) return;
      if (now - this.lastProgress < BOT_REACTION_MS) {
        this.nextBotAt = this.lastProgress + BOT_REACTION_MS;
        return;
      }
      for (const p of this.players) {
        if (!p.isBot || !p.active) continue;
        let acted = false;
        if (this.phase === 'discard' && !p.discarded) { this.botDiscard(p); acted = true; }
        else if (this.phase === 'pegging' && this.turnSeat === p.seat) { this.botPeg(p); acted = true; }
        else if ((this.phase === 'scoring' && (!p.scoringDone || (this.canPlayerShop(p) && !p.ready))) ||
          (this.phase === 'roundEnd' && !p.ready)) {
          if (this.phase !== 'scoring' || this.scoringCanAdvance()) {
            this.setReady(p);
            acted = true;
          }
        } else if (this.phase === 'shop' && !p.ready) { this.botShop(p); acted = true; }
        if (acted) {
          this.nextBotAt = Date.now() + BOT_ACTION_MS;
          return;
        }
      }
    } catch (e) {
      console.error('botTick error:', e);
    }
  }

  botDiscard(p) {
    const combos = [];
    const need = this.discardNeed(p);
    const walk = (start, picked) => {
      if (picked.length === need) { combos.push(picked.slice()); return; }
      for (let i = start; i < p.hand.length; i++) walk(i + 1, picked.concat(p.hand[i]));
    };
    walk(0, []);
    const shortcut = this.mods(p).shortcut;
    let best = combos[0], bestScore = -1;
    for (const combo of combos) {
      const keep = p.hand.filter(c => !combo.includes(c));
      const bd = scoreBreakdown(keep, null, false, { shortcut, target: this.scoringTarget(p) });
      const s = bd.fifteens * 2 + bd.pairs * 2 + bd.runPoints + bd.flush;
      if (s > bestScore) { bestScore = s; best = combo; }
    }
    this.discard(p, best.map(c => c.id));
  }

  botPeg(p) {
    const legal = p.pegLeft.filter(c => this.pegCount + cardValue(c) <= 31);
    if (!legal.length) return;
    let best = legal[0], bestVal = -Infinity;
    for (const c of legal) {
      const count = this.pegCount + cardValue(c);
      const pts = pegEvents([...this.pegStack, c], count, { target: this.scoringTarget(p) }).reduce((a, e) => a + e.pts, 0);
      const v = pts - (count === 5 || count === 21 ? 0.5 : 0) + cardValue(c) * 0.01;
      if (v > bestVal) { bestVal = v; best = c; }
    }
    this.playCard(p, best.id);
  }

  botShop(p) {
    if (p.pendingPack) {
      const opts = p.pendingPack.options;
      let idx = opts.findIndex(o => o.kind === 'joker' && p.jokers.length < this.maxJokers(p));
      if (idx === -1) idx = opts.findIndex(o => o.kind === 'card');
      this.pickPack(p, idx);
      return;
    }
    if (p.shopOffer) {
      const idx = p.shopOffer.findIndex(it => !it.sold && it.cost <= p.coins &&
        (it.kind === 'joker' ? p.jokers.length < this.maxJokers(p) :
         it.kind === 'pack' ? (it.id === 'buffoon' || it.id === 'ultra') && p.jokers.length < this.maxJokers(p) && it.cost + 2 <= p.coins :
         false));
      if (idx >= 0) { this.buyItem(p, idx); return; }
    }
    this.setReady(p);
  }

  log(text) { this.logFn(text); }
  touch() { this.lastProgress = Date.now(); }
  bySeat(s) { return this.players[s]; }
  byId(id) { return this.players.find(p => p.id === id); }
  deckIs(p, id) { return this.deckEffects && normalizeDeckArt(p && p.deckArt) === id; }
  mods(p) { return aggregateMods(p.jokers); }
  maxJokers(p) { return jokerCapacity(p.jokers, MAX_JOKERS + (this.deckIs(p, 'sapphire') ? 1 : 0)); }
  maxTarots(p) { return MAX_TAROTS; }
  blindFor(p) { return this.mode === 'board' ? 0 : Math.round(this.blind * (this.deckIs(p, 'neon') ? 2.5 : 1)); }
  discardNeed(p) { return this.discardCount + (this.mode !== 'board' && this.deckIs(p, 'aurora') ? 1 : 0); }

  prepareDeckEffect(p) {
    if (this.mode === 'board' || !this.deckEffects) return;
    if (this.deckIs(p, 'ruby') && !p.rubySuits) {
      p.rubySuits = randomSuitPair();
      p.deck = p.deck.map(c => rubyDeckCard(c, p.rubySuits));
      this.log(`${p.name}'s Ruby Cut chose ${p.rubySuits.map(s => ['Hearts', 'Diamonds', 'Clubs', 'Spades'][s]).join(' and ')}`);
    }
    if (this.deckIs(p, 'gambit') && !p.gambitRandomized) {
      p.deck = p.deck.map(() => gambitDeckCard());
      p.gambitRandomized = true;
      this.log(`${p.name}'s Gambit deck randomized all 52 cards`);
    }
  }
  scoringTarget(p) { return this.mode !== 'board' && this.deckIs(p, 'cosmic') ? this.cosmicTarget : 15; }
  canOpenPack(p, type) {
    if (type === 'buffoon' || type === 'ultra') return p.jokers.length < this.maxJokers(p);
    if (type === 'arcana') return p.tarots.length < this.maxTarots(p);
    return true;
  }
  actives() { return this.players.filter(p => p.active); }

  addCardToDeck(p, card) {
    p.deck.push(card);
    for (let i = 0; i < p.jokers.length; i++) {
      const owned = normalizeJoker(p.jokers[i]);
      if (!owned || owned.id !== 'hologram') continue;
      owned.hologramMult = Math.round(((owned.hologramMult || 1) + 0.25) * 100) / 100;
      p.jokers[i] = owned;
      this.log(`${p.name}'s Hologram grows to x${owned.hologramMult}`);
    }
  }

  effectiveJokers(p) {
    return effectiveJokerIds(p.jokers).map(j => jokerDef(j)).filter(Boolean);
  }

  nextActiveSeat(from) {
    const n = this.players.length;
    for (let i = 1; i <= n; i++) {
      const s = (from + i + n) % n;
      if (this.bySeat(s).active) return s;
    }
    return -1;
  }

  addPoints(p, pts, why) {
    if (pts <= 0) return;
    p.score += pts;
    p.roundScore += pts;
    p.dealPoints += pts;
    this.log(`${p.name} scores ${pts} (${why})`);
  }

  scorePegHandPoints(p, card, events) {
    if (this.mode === 'board') return 0;
    let total = 0;
    for (const raw of effectiveJokerIds(p.jokers)) {
      const owned = normalizeJoker(raw);
      const def = owned && jokerDef(owned);
      const playBonus = def && def.mods && def.mods.playHandBonus;
      const scoredBonus = def && def.mods && def.mods.pegHandBonus;
      const bonus = playBonus || scoredBonus;
      if (!bonus || (scoredBonus && !events.length)) continue;
      if (card.enhancement === 'stone' && (bonus.ranks || bonus.suit != null)) continue;
      if (bonus.ranks && !bonus.ranks.includes(card.rank)) continue;
      if (bonus.suit != null && bonus.suit !== card.suit && card.enhancement !== 'wild') continue;
      if (bonus.starterFace && (!this.starter || this.starter.rank < 11)) continue;
      if (bonus.eventType && !events.some(ev => ev.type === bonus.eventType)) continue;
      if (bonus.count != null && this.pegCount !== bonus.count) continue;
      if (bonus.minCount != null && this.pegCount < bonus.minCount) continue;
      if (bonus.minEvents != null && events.length < bonus.minEvents) continue;
      const base = bonus.coinDivisor ? Math.floor(p.coins / bonus.coinDivisor) * bonus.pts : bonus.pts;
      if (base <= 0) continue;
      total += base;
      p.dealHandBonusLines.push({ label: `${def.name} [Joker]`, pts: base });
      this.log(`  ${def.name} +${base} Hand Points [Joker]`);
    }
    p.dealHandBonus += total;
    return total;
  }

  scorePegMult(p, card, events) {
    const eventScores = events.map(ev => ({ ev, pts: ev.pts }));
    let total = eventScores.reduce((sum, e) => sum + e.pts, 0);
    const signature = events.map(ev => `${ev.type}:${ev.size || ''}`).sort().join('|');
    const bumpEvent = (type, value, label) => {
      let changed = false;
      for (const row of eventScores) {
        if (row.ev.type !== type || row.pts >= value) continue;
        total += value - row.pts;
        row.pts = value;
        changed = true;
      }
      if (changed) this.log(`  ${label} [Joker]`);
    };
    for (const def of this.effectiveJokers(p)) {
      switch (def.id) {
        case 'fifteen_fanatic':
          bumpEvent('fifteen', 3, 'Fifteen Fanatic');
          break;
        case 'holo_fifteen':
          bumpEvent('fifteen', 4, 'Holo Fifteen');
          break;
        case 'salute_31':
          bumpEvent('thirtyone', 5, '31 Salute');
          break;
        case 'pony_express':
          if (p.pegPlays === 0) {
            total += 2;
            this.log('  Pony Express [Joker]');
          }
          break;
        case 'counter_king':
          if (total > 0 && this.pegCount > 15) {
            total += 2;
            this.log('  Counter King +2 [Joker]');
          }
          break;
        case 'even_steven':
          if (card.enhancement !== 'stone' && card.rank % 2 === 0 && card.rank <= 10) {
            total += 1;
            this.log('  Even Steven +1 Mult [Joker]');
          }
          break;
        case 'card_sharp':
          if (signature && !p.cardSharpUsed && p.pegScoreSignatures.includes(signature)) {
            total *= 2;
            p.cardSharpUsed = true;
            this.log('  Card Sharp x2 [Joker]');
          }
          break;
        case 'onyx_agate':
          if (events.length && (card.suit === 2 || card.enhancement === 'wild')) {
            total += 2;
            this.log('  Onyx Agate +2 Mult [Joker]');
          }
          break;
        case 'bloodstone':
          if (events.length && (card.suit === 0 || card.enhancement === 'wild') && Math.random() < 0.5) {
            total *= 1.5;
            this.log('  Bloodstone x1.5 [Joker]');
          }
          break;
        case 'overclock':
          if (total > 0 && p.pegPlays >= 2) {
            total *= 3;
            this.log('  Overclock ×3 [Joker]');
          }
          break;
        default:
          if (def.mods.pegMult && def.mods.pegMult !== 1 && total > 0) {
            total *= def.mods.pegMult;
            this.log(`  ${def.name} ×${def.mods.pegMult} [Joker]`);
          }
          break;
      }
    }
    if (signature && !p.pegScoreSignatures.includes(signature)) p.pegScoreSignatures.push(signature);
    return total;
  }

  scoreFinalMultOrdered(p, base, kind, cards, starter) {
    let mult = base;
    const lines = [];
    const ranks = new Map();
    for (const card of starter ? cards.concat(starter) : cards) {
      if (card.enhancement !== 'stone') ranks.set(card.rank, (ranks.get(card.rank) || 0) + 1);
    }
    for (const raw of effectiveJokerIds(p.jokers)) {
      const owned = normalizeJoker(raw);
      const def = owned && jokerDef(owned);
      if (!def) continue;
      if (kind === 'hand' && def.id === 'the_trio' && [...ranks.values()].some(n => n >= 3)) {
        mult *= 2;
        lines.push({ label: 'The Trio x2 Mult [Joker]', pts: null });
      } else if (kind === 'hand' && def.id === 'the_family' && [...ranks.values()].some(n => n >= 4)) {
        mult *= 3;
        lines.push({ label: 'The Family x3 Mult [Joker]', pts: null });
      } else if (def.id === 'baseball_card') {
        const rareCount = p.jokers.filter(j => jokerDef(j)?.rarity === 'rare').length;
        if (rareCount) {
          const factor = Math.pow(1.5, rareCount);
          mult *= factor;
          lines.push({ label: `Baseball Card x${factor.toFixed(2)} Mult [Joker]`, pts: null });
        }
      } else if (def.id === 'hologram' && (owned.hologramMult || 1) > 1) {
        mult *= owned.hologramMult;
        lines.push({ label: `Hologram x${owned.hologramMult} Mult [Joker]`, pts: null });
      }
      if (owned.stamp === 'holographic') {
        mult += 3;
        lines.push({ label: `${def.name} Holographic +3 Mult`, pts: null });
      } else if (owned.stamp === 'polychrome') {
        mult *= 1.5;
        lines.push({ label: `${def.name} Polychrome x1.5 Mult`, pts: null });
      }
    }
    return { mult: Math.round(mult * 100) / 100, lines };
  }

  scoreCardEnhancements(p, kind, cards, baseMult) {
    let points = 0;
    let mult = baseMult;
    const lines = [];
    const shatter = [];
    for (const card of cards) {
      switch (card.enhancement) {
        case 'bonus':
          points += 2;
          lines.push({ label: 'Bonus Card [Enhancement]', pts: 2 });
          break;
        case 'mult':
          mult += 1;
          lines.push({ label: 'Mult Card +1 Mult [Enhancement]', pts: null });
          break;
        case 'glass':
          mult *= 2;
          lines.push({ label: 'Glass Card x2 Mult [Enhancement]', pts: null });
          if (Math.random() < 0.25) shatter.push(card.id);
          break;
        case 'steel':
          if (kind === 'crib') {
            mult *= 1.5;
            lines.push({ label: 'Steel Card x1.5 Mult [Enhancement]', pts: null });
          }
          break;
        case 'stone':
          points += 4;
          lines.push({ label: 'Stone Card [Enhancement]', pts: 4 });
          break;
        case 'gold':
          if (kind === 'hand') {
            p.coins += 3;
            p.coinGain = (p.coinGain || 0) + 3;
            lines.push({ label: 'Gold Card +3 coins [Enhancement]', pts: null });
          }
          break;
        case 'lucky':
          if (Math.random() < 0.2) {
            mult += 10;
            lines.push({ label: 'Lucky Card +10 Mult [Enhancement]', pts: null });
          }
          if (Math.random() < 1 / 15) {
            p.coins += 20;
            p.coinGain = (p.coinGain || 0) + 20;
            lines.push({ label: 'Lucky Card +20 coins [Enhancement]', pts: null });
          }
          break;
      }
    }
    return { points, mult: Math.round(mult * 100) / 100, lines, shatter };
  }

  scoreGoMult(p) {
    let total = 1;
    for (const def of this.effectiveJokers(p)) {
      if (def.id === 'last_card_larry') {
        if (total < 3) total += 3 - total;
        this.log('  Last Card Larry [Joker]');
      } else if (def.mods.pegMult && def.mods.pegMult !== 1 && total > 0) {
        total *= def.mods.pegMult;
        this.log(`  ${def.name} ×${def.mods.pegMult} [Joker]`);
      }
    }
    return total;
  }

  scoreCribMultOrdered(p, cribBd, cribPoints) {
    let mult = BASE_MULT + p.dealPegMult;
    const lines = [];
    for (const raw of effectiveJokerIds(p.jokers)) {
      const owned = normalizeJoker(raw);
      const def = owned && jokerDef(owned);
      if (!def) continue;
      switch (def.id) {
        case 'golden_crib':
          if (this.crib.some(c => c.rank === 5)) {
            mult += 2;
            lines.push({ label: `${def.name} +2 Mult [Joker]`, pts: null });
          }
          break;
        case 'steel_crib':
          if (this.crib.every(c => c.rank < 11)) {
            mult += 3;
            lines.push({ label: `${def.name} +3 Mult [Joker]`, pts: null });
          }
          break;
        case 'hayloft': {
          const gain = Math.floor(this.crib.length / 2);
          if (gain) {
            mult += gain;
            lines.push({ label: `${def.name} +${gain} Mult [Joker]`, pts: null });
          }
          break;
        }
        case 'crib_spark':
          if (cribBd.fifteens) {
            mult += cribBd.fifteens;
            lines.push({ label: `${def.name} +${cribBd.fifteens} Mult [Joker]`, pts: null });
          }
          break;
        case 'crib_battery': {
          const suits = this.crib.some(c => c.enhancement === 'wild')
            ? 4
            : new Set(this.crib.filter(c => c.enhancement !== 'stone').map(c => c.suit)).size;
          if (suits) {
            const factor = Math.pow(1.25, suits);
            mult *= factor;
            lines.push({ label: `${def.name} ×${factor.toFixed(2)} [Joker]`, pts: null });
          }
          break;
        }
      }
    }
    return { mult: Math.round(mult * 100) / 100, lines };
  }

  // ---- rounds ----

  startRound() {
    this.round++;
    this.roundComplete = false;
    const k = this.actives().length;
    this.dealsInRound = k >= 3 ? k : 4;
    this.blind = this.mode === 'board' ? 0 : computeBlind(this.round, k, this.dealsInRound);
    this.dealIndexInRound = 0;
    this.blindFinishCounter = 0; // order in which players cross the blind this round
    for (const p of this.players) { p.roundScore = 0; p.blindFinishOrder = null; }
    this.log(this.mode === 'board'
      ? `=== Board game to ${this.goalScore} points — Round ${this.round} ===`
      : `=== Round ${this.round} — beat the blind: ${this.blind} ===`);
    if (this.mode !== 'board') {
      for (const p of this.actives()) {
        if (this.round === 1 && this.deckIs(p, 'emerald')) {
          p.coins += 5;
          const starterJoker = randomCommonJoker(p.jokers);
          if (starterJoker && p.jokers.length < this.maxJokers(p)) p.jokers.push(starterJoker);
          this.log(`${p.name}'s Emerald Felt starts with 5 coins${starterJoker ? ` and ${jokerDef(starterJoker).name}` : ''}`);
        }
        const triggers = this.effectiveJokers(p).filter(j => j.id === 'riff_raff').length;
        for (let i = 0; i < triggers * 2 && p.jokers.length < this.maxJokers(p); i++) {
          const created = randomCommonJoker(p.jokers);
          if (!created) break;
          p.jokers.push(created);
          this.log(`${p.name}'s Riff-Raff created ${jokerDef(created).name}`);
        }
      }
    }
    this.startDeal();
  }

  startDeal() {
    this.dealNumber++;
    this.dealIndexInRound++;
    this.dealerSeat = this.nextActiveSeat(this.dealerSeat);
    const k = this.actives().length;
    this.cardsEach = k === 2 ? 6 : 5;
    this.discardCount = k === 2 ? 2 : 1;
    this.crib = [];
    this.cribDeckArts = [];
    this.starter = null;
    this.pegCount = 0;
    this.pegStack = [];
    this.cosmicTarget = 11 + Math.floor(Math.random() * 10);
    this.last31 = false;
    this.goAnnounced = new Set();
    this.turnSeat = null;
    this.scoringResults = null;
    this.revealIndex = 0;
    this.roundEndData = null;
    const boardPile = this.mode === 'board' ? shuffle(makeDeck()) : null;
    for (const p of this.players) {
      if (p.active) {
        this.prepareDeckEffect(p);
        const pile = this.mode === 'board' ? boardPile : shuffle(p.deck.slice());
        const handSizeMod = this.mode === 'board' ? 0 : this.effectiveJokers(p).reduce((sum, j) => sum + (j.mods.handSize || 0), 0);
        const drawCount = Math.max(this.discardNeed(p) + 1, this.cardsEach + handSizeMod + (this.mode !== 'board' && this.deckIs(p, 'aurora') ? 1 : 0));
        p.hand = pile.slice(0, drawCount);
        if (this.mode === 'board') pile.splice(0, drawCount);
        p.drawPile = this.mode === 'board' ? [] : pile.slice(drawCount);
      } else {
        p.hand = []; p.drawPile = [];
      }
      p.kept = []; p.pegLeft = []; p.pegPlays = 0; p.pendingPack = null;
      p.dealPegMult = 0;
      p.dealHandBonus = 0;
      p.dealHandBonusLines = [];
      p.pegScoreSignatures = [];
      p.cardSharpUsed = false;
      p.rerollCost = REROLL_START_COST;
      p.discarded = !p.active; p.ready = false; p.scoringDone = false; p.dealPoints = 0;
      p.coinGain = 0;
      if (this.mode === 'board') {
        p.jokers = [];
        p.tarots = [];
        p.coins = 0;
      }
    }
    this.sharedDrawPile = boardPile || null;
    if (k === 3) {
      this.crib.push(this.mode === 'board' ? this.sharedDrawPile.pop() : this.bySeat(this.dealerSeat).drawPile.pop());
      this.cribDeckArts.push(normalizeDeckArt(this.bySeat(this.dealerSeat).deckArt));
    }
    this.phase = 'discard';
    this.log(`--- Deal ${this.dealIndexInRound}/${this.dealsInRound} — ${this.bySeat(this.dealerSeat).name} deals ---`);
    this.touch();
    this.onUpdate();
  }

  // ---- discard phase ----

  discard(p, cardIds) {
    if (this.phase !== 'discard' || !p.active || p.discarded) return 'Not your moment to discard.';
    const need = this.discardNeed(p);
    if (!Array.isArray(cardIds) || new Set(cardIds).size !== need) {
      return `Pick exactly ${need} card(s) for the crib.`;
    }
    const picked = cardIds.map(id => p.hand.find(c => c.id === id));
    if (picked.some(c => !c)) return 'Card not in your hand.';
    p.hand = p.hand.filter(c => !cardIds.includes(c.id));
    const pmods = this.mods(p);
    const auroraBurn = this.mode !== 'board' && this.deckIs(p, 'aurora') ? picked[picked.length - 1] : null;
    const cribPicks = auroraBurn ? picked.slice(0, -1) : picked;
    if (auroraBurn) p.deck = p.deck.filter(c => c.id !== auroraBurn.id);
    // 5-Maker uses fresh cards so the player's own deck is untouched.
    const cribCards = pmods.cribFives ? cribPicks.map(c => ({ ...c, rank: 5 })) : cribPicks;
    this.crib.push(...cribCards);
    this.cribDeckArts.push(...cribCards.map(() => normalizeDeckArt(p.deckArt)));
    if (pmods.cribFives) this.log(`${p.name}'s 5-Maker turns the crib drop${cribCards.length > 1 ? 's' : ''} into 5s`);
    const copies = pmods.duplicateFirstCrib;
    if (copies && cribCards[0]) {
      for (let i = 0; i < copies; i++) {
        const copy = makeCard(cribCards[0].rank, cribCards[0].suit, cribCards[0].enhancement);
        this.crib.push(copy);
        this.cribDeckArts.push(normalizeDeckArt(p.deckArt));
        this.addCardToDeck(p, makeCard(copy.rank, copy.suit, copy.enhancement));
      }
      this.log(`${p.name}'s Crib Copier copied ${cardName(cribCards[0])} into the crib and deck`);
    }
    // Crib Diviner: 10+ worth of cards thrown to the crib earns a random tarot
    if (pmods.cribTenTarot && p.tarots.length < this.maxTarots(p)) {
      const worth = cribPicks.reduce((s, c) => s + cardValue(c), 0);
      if (worth >= 10) {
        const t = randomTarot();
        p.tarots.push(t.id);
        this.log(`${p.name}'s Crib Diviner conjures ${t.name} (crib worth ${worth})`);
      }
    }
    if (auroraBurn) this.log(`${p.name}'s Aurora Flow removed ${cardName(auroraBurn)} from the game`);
    p.discarded = true;
    this.log(`${p.name} sent ${cribCards.length} card(s) to the crib${auroraBurn ? ' and burned 1' : ''}`);
    this.touch();
    if (this.actives().every(pl => pl.discarded)) this.cut();
    this.onUpdate();
  }

  useTarot(p, tarotIdx, targetIds) {
    if (!p.active) return 'Spectators cannot use tarots.';
    const tid = p.tarots[tarotIdx];
    const def = tid && TAROTS_BY_ID[tid];
    if (!def) return 'No such tarot.';
    const shopUse = this.canPlayerShop(p) && !p.ready && def.targets === 0;
    const discardUse = this.phase === 'discard' && !p.discarded;
    if (!shopUse && !discardUse) return def.targets
      ? 'This tarot needs your hand. Use it during discard before you throw to the crib.'
      : 'Tarots can only be used in the shop or before you discard.';
    targetIds = targetIds || [];
    if (new Set(targetIds).size !== def.targets) return `${def.name} needs ${def.targets} target card(s).`;
    const targets = targetIds.map(id => p.hand.find(c => c.id === id));
    if (targets.some(c => !c)) return 'Target card not in your hand.';

    const up = c => { c.rank = c.rank % 13 + 1; };
    if (def.enhancement) targets.forEach(c => { c.enhancement = def.enhancement; });
    switch (def.id) {
      case 'sun': up(targets[0]); break;
      case 'moon': targets[0].rank = targets[0].rank === 1 ? 13 : targets[0].rank - 1; break;
      case 'strength': targets.forEach(up); break;
      case 'death':
        targets[0].rank = targets[1].rank;
        targets[0].suit = targets[1].suit;
        targets[0].enhancement = targets[1].enhancement;
        break;
      case 'star': targets[0].rank = 11; break;
      case 'emperor': targets.forEach(c => { c.suit = 1; }); break;
      case 'devil': targets.forEach(c => { c.suit = 2; }); break;
      case 'tower': targets.forEach(c => { c.suit = 3; }); break;
      case 'priestess': {
        const c = targets[0];
        this.addCardToDeck(p, makeCard(c.rank, c.suit, c.enhancement));
        break;
      }
      case 'hanged_man': {
        if (p.deck.length - targets.length < 15) return 'Your deck is too thin to destroy more cards.';
        if (p.drawPile.length < targets.length) return 'Not enough cards left to redraw.';
        const ids = targets.map(c => c.id);
        p.deck = p.deck.filter(c => !ids.includes(c.id));
        p.hand = p.hand.filter(c => !ids.includes(c.id));
        p.hand.push(...p.drawPile.splice(0, targets.length));
        break;
      }
      case 'judgement': {
        if (p.jokers.length >= this.maxJokers(p)) return `You can hold at most ${this.maxJokers(p)} jokers.`;
        const j = randomJoker(p.jokers);
        if (!j) return 'No jokers left to gain.';
        p.jokers.push(j);
        this.log(`${p.name}'s Judgement summons ${jokerDef(j).name}`);
        break;
      }
      case 'wheel': {
        const eligible = p.jokers.map((j, idx) => ({ owned: normalizeJoker(j), idx })).filter(row => row.owned && !row.owned.stamp);
        if (eligible.length && Math.random() < 0.25) {
          const target = eligible[Math.floor(Math.random() * eligible.length)];
          const editions = ['foil', 'holographic', 'polychrome'];
          target.owned.stamp = editions[Math.floor(Math.random() * editions.length)];
          p.jokers[target.idx] = target.owned;
          this.log(`${p.name}'s Wheel added ${target.owned.stamp} Edition to ${jokerDef(target.owned).name}`);
        } else {
          this.log(`${p.name}'s Wheel of Fortune says Nope!`);
        }
        break;
      }
      case 'hermit': p.coins += 5; break;
    }
    p.tarots.splice(tarotIdx, 1);
    this.log(`${p.name} used ${def.name}`);
    this.touch();
    this.onUpdate();
  }

  cut() {
    this.starter = this.mode === 'board' ? this.sharedDrawPile.pop() : this.bySeat(this.dealerSeat).drawPile.pop();
    this.log(`Starter cut: ${cardName(this.starter)}`);
    const dealer = this.bySeat(this.dealerSeat);
    if (this.starter.rank === 11) {
      const heels = this.mode === 'board' ? 2 : this.mods(dealer).heelsVal;
      if (this.mode === 'board') this.addPoints(dealer, heels, 'His Heels');
      else dealer.dealPegMult += heels;
      this.log(this.mode === 'board' ? `His Heels — ${dealer.name} +${heels}` : `His Heels — ${dealer.name} +${heels} Mult`);
    }
    for (const p of this.actives()) {
      const c = this.mods(p).coinOnCut;
      if (c) { p.coins += c; this.log(`${p.name} pockets ${c} coin(s) (Cutpurse)`); }
    }
    for (const p of this.actives()) {
      p.kept = p.hand.slice();
      p.pegLeft = p.hand.slice();
    }
    this.phase = 'pegging';
    this.turnSeat = this.nextActiveSeat(this.dealerSeat);
    this.lastPlayerSeat = null;
  }

  // ---- pegging ----

  canPlay(p) {
    return p.pegLeft.some(c => this.pegCount + cardValue(c) <= 31);
  }

  playCard(p, cardId) {
    if (this.phase !== 'pegging') return 'Not in the pegging phase.';
    if (p.seat !== this.turnSeat) return 'Not your turn.';
    const card = p.pegLeft.find(c => c.id === cardId);
    if (!card) return 'Card not in your hand.';
    if (this.pegCount + cardValue(card) > 31) return 'That would push the count past 31.';

    p.pegLeft = p.pegLeft.filter(c => c.id !== cardId);
    this.pegCount += cardValue(card);
    const playedCard = { ...card, seat: p.seat };
    this.pegStack.push(playedCard);
    this.lastPlayAnim = { seq: ++this.animSeq, card: playedCard, multGain: 0 };
    this.lastPlayerSeat = p.seat;
    this.log(`${p.name} plays ${cardName(card)} — count ${this.pegCount}`);

    const mods = this.mode === 'board' ? aggregateMods([]) : this.mods(p);
    const events = pegEvents(this.pegStack, this.pegCount, { target: this.scoringTarget(p) });
    const gambitHit = this.mode !== 'board' && this.deckIs(p, 'gambit') &&
      events.some(ev => ev.type === 'fifteen' || ev.type === 'thirtyone');
    if (gambitHit) {
      card.gambitCharged = true;
      playedCard.gambitCharged = true;
      p.dealHandBonus += 2;
      p.dealHandBonusLines.push({ label: 'Gambit charge [Deck]', pts: 2 });
    }
    const pointGain = (gambitHit ? 2 : 0) + this.scorePegHandPoints(p, card, events);
    this.lastPlayAnim.pointGain = pointGain;
    const roughGems = this.mode === 'board' || !events.length || (card.suit !== 1 && card.enhancement !== 'wild')
      ? 0
      : this.effectiveJokers(p).filter(j => j.id === 'rough_gem').length;
    if (roughGems) {
      const coinGain = roughGems * 2;
      p.coins += coinGain;
      p.coinGain = (p.coinGain || 0) + coinGain;
      this.log(`  Rough Gem +${coinGain} coins [Joker]`);
    }
    for (const ev of events) {
      this.log(`  ${ev.type === 'thirtyone' ? '31!' : ev.type}${ev.size ? ' of ' + ev.size : ''}`);
    }
    if (gambitHit) this.log(`  Gambit charge: +2 Hand Points; ${cardName(card)} leaves the deck after scoring`);
    if (this.mode !== 'board' && mods.smallBall && card.enhancement !== 'stone' && card.rank >= 2 && card.rank <= 5) {
      this.addPoints(p, mods.smallBall, 'Small Ball');
      this.log('  Small Ball [Joker]');
    }
    let pts = this.mode === 'board'
      ? events.reduce((sum, ev) => sum + ev.pts, 0)
      : this.scorePegMult(p, card, events);
    p.pegPlays++;
    this.lastPlayAnim.multGain = pts;
    if (pts > 0) this.lastMultAnim = { seq: ++this.animSeq, seat: p.seat, multGain: pts };
    if (pts > 0) {
      if (this.mode === 'board') this.addPoints(p, pts, 'Pegging');
      else p.dealPegMult += pts;
      this.log(this.mode === 'board' ? `  ${p.name} +${pts}` : `  ${p.name} +${pts} Mult`);
    }
    this.last31 = this.pegCount === 31;
    this.touch();
    this.advancePeg(p.seat);
    this.onUpdate();
  }

  advancePeg(justPlayedSeat) {
    const n = this.players.length;
    for (let i = 1; i <= n; i++) {
      const s = (justPlayedSeat + i) % n;
      const p = this.bySeat(s);
      if (this.canPlay(p)) {
        this.announceGos(justPlayedSeat, s);
        this.turnSeat = s;
        return;
      }
    }
    // nobody can play: close out this count — award points, then HOLD the
    // finished pile on screen for a beat so everyone sees it before it sweeps
    const last = this.bySeat(this.lastPlayerSeat);
    const allEmpty = this.players.every(p => p.pegLeft.length === 0);
    if (!this.last31) {
      const goPts = this.mode === 'board' ? 1 : this.scoreGoMult(last);
      if (this.mode === 'board') this.addPoints(last, goPts, allEmpty ? 'Last card' : 'Go');
      else last.dealPegMult += goPts;
      this.lastMultAnim = { seq: ++this.animSeq, seat: last.seat, multGain: goPts };
      this.log(this.mode === 'board'
        ? `${last.name} +${goPts} (${allEmpty ? 'last card' : 'go'})`
        : `${last.name} +${goPts} Mult (${allEmpty ? 'last card' : 'go'})`);
    }
    this.turnSeat = null;     // freeze input during the hold
    this.pegClosing = true;   // client keeps the pile visible, then sweeps it
    this.touch();
    clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => { this.finishCount(); this.onUpdate(); }, PEG_CLOSE_MS);
  }

  finishCount() {
    this.pegClosing = false;
    this.pegCount = 0;
    this.pegStack = [];
    this.last31 = false;
    this.goAnnounced = new Set();
    const n = this.players.length;
    for (let i = 1; i <= n; i++) {
      const s = (this.lastPlayerSeat + i) % n;
      if (this.bySeat(s).pegLeft.length) { this.turnSeat = s; return; }
    }
    if (this.bySeat(this.lastPlayerSeat).pegLeft.length) { this.turnSeat = this.lastPlayerSeat; return; }
    this.doScoring();
  }

  announceGos(fromSeat, toSeat) {
    const n = this.players.length;
    for (let s = (fromSeat + 1) % n; s !== toSeat; s = (s + 1) % n) {
      const p = this.bySeat(s);
      if (p.pegLeft.length && !this.canPlay(p) && !this.goAnnounced.has(s)) {
        this.goAnnounced.add(s);
        this.log(`${p.name} says go`);
      }
    }
  }

  // ---- show / scoring ----

  doScoring() {
    this.phase = 'scoring';
    this.turnSeat = null;
    const n = this.players.length;
    const starter = this.starter;
    const shatterIds = [];

    // Pass 1 — each active player's hand Points (chips) and their deal Mult
    // (Mult = 1 + pegging points earned this deal).
    const handBlocks = [];
    for (let i = 1; i <= n; i++) {
      const p = this.bySeat((this.dealerSeat + i) % n);
      if (!p.active) continue;
      const mods = this.mode === 'board' ? aggregateMods([]) : this.mods(p);
      const target = this.scoringTarget(p);
      const bd = scoreBreakdown(p.kept, starter, false, { shortcut: mods.shortcut, target });
      const { total: points, lines } = this.mode === 'board'
        ? buildScore(bd, mods, 'hand', p.kept, { starter, coins: p.coins, target })
        : buildScoreOrdered(bd, p.jokers, 'hand', p.kept, { starter, coins: p.coins, target });
      let handPoints = points;
      let handMult = this.mode === 'board' ? 1 : BASE_MULT + p.dealPegMult;
      if (p.dealHandBonus > 0) {
        handPoints += p.dealHandBonus;
        const grouped = new Map();
        for (const line of p.dealHandBonusLines) grouped.set(line.label, (grouped.get(line.label) || 0) + line.pts);
        for (const [label, pts] of grouped) lines.push({ label, pts });
      }
      if (this.mode !== 'board') {
        const enhancements = this.scoreCardEnhancements(p, 'hand', p.kept, handMult);
        handPoints += enhancements.points;
        handMult = enhancements.mult;
        lines.push(...enhancements.lines);
        shatterIds.push(...enhancements.shatter);
        const finalMult = this.scoreFinalMultOrdered(p, handMult, 'hand', p.kept, starter);
        handMult = finalMult.mult;
        lines.push(...finalMult.lines);
      }
      handBlocks.push({
        kind: 'hand', player: p, seat: p.seat, name: p.name,
        cards: p.kept.slice(), lines, points: handPoints, mult: handMult,
        noMult: this.mode === 'board',
      });
    }

    // Muggins adds chips when an opponent's hand Points come in under 4
    if (this.mode !== 'board') for (const b of handBlocks) {
      const mug = this.mods(b.player).muggins;
      if (!mug) continue;
      for (const other of handBlocks) {
        if (other === b || other.points >= 4) continue;
        b.points += mug;
        b.lines.push({ label: `Muggins on ${other.name} [Joker]`, pts: mug });
      }
    }

    // crib block — scored with the dealer's Mult
    const dealer = this.bySeat(this.dealerSeat);
    const dmods = this.mode === 'board' ? aggregateMods([]) : this.mods(dealer);
    const cribTarget = this.scoringTarget(dealer);
    const cribBd = scoreBreakdown(this.crib, starter, true, { shortcut: dmods.shortcut, target: cribTarget });
    const cribRes = this.mode === 'board'
      ? buildScore(cribBd, dmods, 'crib', this.crib, { starter, coins: dealer.coins, target: cribTarget })
      : buildScoreOrdered(cribBd, dealer.jokers, 'crib', this.crib, { starter, coins: dealer.coins, target: cribTarget });
    const cribMultRes = this.mode === 'board'
      ? { mult: 1, lines: [] }
      : this.scoreCribMultOrdered(dealer, cribBd);
    cribRes.lines.push(...cribMultRes.lines);
    let cribPoints = cribRes.total;
    let cribMult = cribMultRes.mult;
    if (this.mode !== 'board') {
      const enhancements = this.scoreCardEnhancements(dealer, 'crib', this.crib, cribMult);
      cribPoints += enhancements.points;
      cribMult = enhancements.mult;
      cribRes.lines.push(...enhancements.lines);
      shatterIds.push(...enhancements.shatter);
      const finalMult = this.scoreFinalMultOrdered(dealer, cribMult, 'crib', this.crib, starter);
      cribMult = finalMult.mult;
      cribRes.lines.push(...finalMult.lines);
    }
    const cribBlock = {
      kind: 'crib', player: dealer, seat: dealer.seat, name: dealer.name,
      cards: this.crib.slice(), lines: cribRes.lines, points: cribPoints, mult: cribMult,
      noMult: this.mode === 'board',
    };

    // Pass 2 — total = Points × Mult, award, and build the reveal payloads
    const results = [];
    const finalize = b => {
      b.total = this.mode === 'board'
        ? b.points
        : this.deckIs(b.player, 'neon') ? Math.round(Math.pow((b.points + b.mult) / 2, 2)) : b.points * b.mult;
      const before = b.player.score;
      this.addPoints(b.player, b.total, b.kind);
      results.push({
        kind: b.kind, seat: b.seat, name: b.name, cards: b.cards,
        lines: b.lines, points: b.points, mult: b.mult, total: b.total, noMult: !!b.noMult, starter,
        deckArt: normalizeDeckArt(b.player.deckArt),
        deckEffects: this.deckEffects,
        scoreBefore: before, scoreAfter: b.player.score,
      });
    };
    for (const b of handBlocks) finalize(b);
    finalize(cribBlock);

    if (shatterIds.length) {
      const shattered = new Set(shatterIds);
      for (const p of this.actives()) p.deck = p.deck.filter(c => !shattered.has(c.id));
      this.log(`${shatterIds.length} Glass Card${shatterIds.length === 1 ? '' : 's'} shattered after scoring`);
    }

    for (const p of this.actives()) {
      const spent = p.kept.filter(c => c.gambitCharged);
      if (!spent.length) continue;
      const ids = new Set(spent.map(c => c.id));
      p.deck = p.deck.filter(c => !ids.has(c.id));
      this.log(`${p.name}'s Gambit charge removed ${spent.map(cardName).join(', ')} from the deck`);
    }

    if (this.mode !== 'board') for (const p of this.actives()) {
      const mods = this.mods(p);
      // cap the base so a fat crib total doesn't dump coins
      const base = Math.min(7, 2 + Math.floor(p.dealPoints / 18));
      const gain = base + mods.coinsPerDeal + mods.coinPerBlind * p.blindsPassed;
      p.coins += gain;
      p.coinGain = (p.coinGain || 0) + gain;
    }

    if (this.mode !== 'board') {
      // stamp who crossed the blind first (left-of-dealer order breaks ties this
      // deal) so the round-end reward can pay out by finishing position
      for (let i = 1; i <= n; i++) {
        const p = this.bySeat((this.dealerSeat + i) % n);
        if (p.active && p.blindFinishOrder == null && p.roundScore >= this.blindFor(p)) {
          p.blindFinishOrder = ++this.blindFinishCounter;
        }
      }
    }
    for (const p of this.players) { p.ready = !p.active; p.scoringDone = !p.active; }
    this.scoringResults = results;
    this.revealIndex = 0;
    this.scoreDoneAt = 0;
    clearInterval(this.revealTimer);
    this.revealTimer = setInterval(() => {
      if (this.revealIndex < this.scoringResults.length - 1) {
        this.revealIndex++;
        this.touch();
        this.onUpdate();
        if (this.revealIndex >= this.scoringResults.length - 1) {
          clearInterval(this.revealTimer);
          this.scoreDoneAt = Date.now() + SCORE_DONE_HOLD_MS;
          setTimeout(() => {
            this.maybeAdvance(); // auto-open only after everyone is done viewing scoring
            this.onUpdate();
          }, SCORE_DONE_HOLD_MS);
          this.onUpdate();
        }
      }
    }, REVEAL_MS);
    this.touch();
  }

  // ---- blind check ----

  enterRoundEnd() {
    this.phase = 'roundEnd';
    this.roundComplete = true;
    // The House is exempt: in solo your run lasts as long as YOU beat blinds
    const rows = this.actives().filter(p => !p.isBot).map(p => ({
      seat: p.seat, name: p.name, roundScore: p.roundScore, blind: this.blindFor(p),
      passed: p.roundScore >= this.blindFor(p),
    }));
    let rescued = false;
    if (rows.length >= 2 && !rows.some(r => r.passed)) {
      const max = Math.max(...rows.map(r => r.roundScore));
      for (const r of rows) r.passed = r.roundScore === max;
      rescued = true;
    }
    for (const p of this.actives()) {
      if (p.isBot && p.roundScore >= this.blindFor(p)) p.blindsPassed++;
    }
    for (const r of rows) {
      const p = this.bySeat(r.seat);
      r.bonusCoins = 0;
      if (r.passed) {
        p.blindsPassed++;
      } else {
        p.active = false;
        p.eliminatedRound = this.round;
        this.log(`${p.name} failed the blind (${r.roundScore}/${r.blind}) — eliminated!`);
      }
    }
    const passers = rows.filter(r => r.passed).sort((a, b) =>
      (this.bySeat(a.seat).blindFinishOrder || 999) - (this.bySeat(b.seat).blindFinishOrder || 999));
    passers.forEach((r, place) => {
      const p = this.bySeat(r.seat);
      r.place = place + 1;
      if (this.dealIndexInRound === 1) {
        p.pendingPack = { type: 'ultra', name: 'Ultra Pack', options: openPack('ultra', p) };
        r.reward = 'Ultra Pack';
        this.log(`${p.name} cleared the blind in one deal and earned an Ultra Pack.`);
      } else {
        r.bonusCoins = this.dealIndexInRound === 2 ? 4 : this.dealIndexInRound === 3 ? 2 : 0;
        if (r.bonusCoins) {
          p.coins += r.bonusCoins;
          p.coinGain = (p.coinGain || 0) + r.bonusCoins;
          r.reward = `+${r.bonusCoins} coins`;
          this.log(`${p.name} cleared the blind in ${this.dealIndexInRound} deals for ${r.bonusCoins} bonus coin(s).`);
        } else {
          r.reward = 'No bonus';
          this.log(`${p.name} cleared the blind in ${this.dealIndexInRound} deals.`);
        }
      }
    });
    this.roundEndData = { blind: this.blind, round: this.round, rows, rescued, dealCount: this.dealIndexInRound, finalBlind: this.mode === 'blind' ? REGULAR_FINAL_BLIND : null };
    for (const p of this.players) { p.ready = !p.active; p.scoringDone = !p.active; }
    this.touch();
  }

  sellValue(cost) { return Math.max(1, Math.floor((cost || 2) / 2)); }

  scoringLeadsToShop() {
    return this.mode !== 'board' &&
      this.phase === 'scoring' &&
      this.scoringCanAdvance() &&
      this.dealIndexInRound < this.dealsInRound &&
      !this.allHumansBeatBlind();
  }

  canPlayerShop(p) {
    if (this.mode === 'board') return false;
    return this.phase === 'shop' || (this.scoringLeadsToShop() && p.scoringDone);
  }

  ensureShopOffer(p) {
    if (p.active && !p.shopOffer) p.shopOffer = makeShopOffer(p);
  }

  sellJoker(p, idx) {
    if (!this.canPlayerShop(p)) return 'You can only sell in the shop.';
    const owned = normalizeJoker(p.jokers[idx]);
    const def = owned && jokerDef(owned);
    if (!def) return 'No such joker.';
    const refund = this.sellValue(def.cost);
    p.jokers.splice(idx, 1);
    p.coins += refund;
    this.log(`${p.name} sold ${def.name} for ${refund} coin(s).`);
    this.touch();
    this.onUpdate();
  }

  sellTarot(p, idx) {
    if (!this.canPlayerShop(p)) return 'You can only sell in the shop.';
    const id = p.tarots[idx];
    const def = id && TAROTS_BY_ID[id];
    if (!def) return 'No such tarot.';
    const refund = this.sellValue(def.cost);
    p.tarots.splice(idx, 1);
    p.coins += refund;
    this.log(`${p.name} sold ${def.name} for ${refund} coin(s).`);
    this.touch();
    this.onUpdate();
  }

  // ---- shop ----

  openShop(preserveReady = false, forceReroll = false) {
    this.phase = 'shop';
    for (const p of this.players) {
      if (p.active) {
        if (forceReroll) {
          p.shopOffer = makeShopOffer(p, { classicArcana: true });
          p.rerollCost = REROLL_START_COST;
        }
        else this.ensureShopOffer(p);
        // Card Smith: a free Standard Pack waiting at every shop visit
        if (this.mods(p).freeStandardPack && !p.pendingPack) {
          p.pendingPack = { type: 'standard', name: 'Free Standard Pack', options: openPack('standard', p) };
        }
      } else {
        p.shopOffer = null;
      }
      p.ready = p.active ? (preserveReady ? !!p.ready : false) : true;
      p.scoringDone = false;
    }
    this.touch();
  }

  buyItem(p, idx) {
    if (!this.canPlayerShop(p)) return 'The shop is closed.';
    this.ensureShopOffer(p);
    if (p.pendingPack) return 'Open your booster pack first.';
    const item = p.shopOffer && p.shopOffer[idx];
    if (!item || item.sold) return 'Item not available.';
    if (p.coins < item.cost) return 'Not enough coins.';
    if (item.kind === 'joker') {
      if (p.jokers.length >= this.maxJokers(p) && item.stamp !== 'negative') return `You can hold at most ${this.maxJokers(p)} jokers.`;
      p.jokers.push(normalizeJoker(item));
    } else if (item.kind === 'tarot') {
      if (p.tarots.length >= this.maxTarots(p)) return `You can hold at most ${this.maxTarots(p)} tarots.`;
      p.tarots.push(item.id);
    } else if (item.kind === 'card') {
      this.addCardToDeck(p, makeCard(item.rank, item.suit, item.enhancement));
    } else {
      if (item.rewardOnly) return `${item.name} can only be earned as a reward.`;
      if (!this.canOpenPack(p, item.id)) {
        return item.id === 'buffoon' || item.id === 'ultra'
          ? `You can hold at most ${this.maxJokers(p)} jokers.`
          : `You can hold at most ${this.maxTarots(p)} tarots.`;
      }
      p.pendingPack = { type: item.id, name: item.name, options: openPack(item.id, p) };
    }
    p.coins -= item.cost;
    item.sold = true;
    this.log(`${p.name} bought ${item.name}`);
    this.touch();
    this.onUpdate();
  }

  pickPack(p, idx) {
    if (!this.canPlayerShop(p) || !p.pendingPack) return 'No pack to open.';
    if (idx !== -1) {
      const opt = p.pendingPack.options[idx];
      if (!opt) return 'No such option.';
      if (opt.kind === 'joker') {
        if (p.jokers.length >= this.maxJokers(p) && opt.stamp !== 'negative') return `You can hold at most ${this.maxJokers(p)} jokers.`;
        p.jokers.push(normalizeJoker(opt));
      } else if (opt.kind === 'tarot') {
        if (p.tarots.length >= this.maxTarots(p)) return `You can hold at most ${this.maxTarots(p)} tarots.`;
        p.tarots.push(opt.id);
      } else {
        this.addCardToDeck(p, makeCard(opt.rank, opt.suit, opt.enhancement));
      }
      this.log(`${p.name} took ${opt.name || cardName(opt)} from a ${p.pendingPack.name}`);
    } else {
      this.log(`${p.name} skipped a ${p.pendingPack.name}`);
    }
    p.pendingPack = null;
    this.touch();
    this.onUpdate();
  }

  reroll(p) {
    if (!this.canPlayerShop(p)) return 'The shop is closed.';
    if (!p.active) return 'Spectators cannot shop.';
    const cost = p.rerollCost == null ? REROLL_START_COST : p.rerollCost;
    if (p.coins < cost) return 'Not enough coins to reroll.';
    p.coins -= cost;
    p.rerollCost = cost + 1;
    p.shopOffer = makeShopOffer(p);
    this.touch();
    this.onUpdate();
  }

  reorderJokers(p, order) {
    if (!Array.isArray(order) || order.length !== p.jokers.length) return 'Bad joker order.';
    const key = j => {
      const owned = normalizeJoker(j);
      return owned ? `${owned.id}:${owned.stamp || ''}:${owned.hologramMult || ''}` : '';
    };
    const current = p.jokers.map(key).slice().sort().join('|');
    const next = order.map(key).slice().sort().join('|');
    if (current !== next) return 'Bad joker order.';
    const buckets = new Map();
    for (const joker of p.jokers) {
      const k = key(joker);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(joker);
    }
    p.jokers = order.map(item => buckets.get(key(item)).shift()).filter(Boolean);
    this.touch();
    this.onUpdate();
  }

  setReady(p) {
    if (this.phase !== 'scoring' && this.phase !== 'shop' && this.phase !== 'roundEnd') return;
    if (!p.active) return;
    if (this.phase !== 'roundEnd' && p.pendingPack) return 'Open your booster pack first.';
    if (this.phase === 'scoring') {
      if (!this.scoringCanAdvance()) return;
      if (!p.scoringDone) {
        p.scoringDone = true;
        if (this.scoringLeadsToShop()) this.ensureShopOffer(p);
      } else if (this.canPlayerShop(p)) {
        p.ready = true;
      }
      this.touch();
      this.maybeAdvance();
      this.onUpdate();
      return;
    }
    p.ready = true;
    this.touch();
    this.maybeAdvance();
    this.onUpdate();
  }

  advanceFromScoring() {
    if (this.phase !== 'scoring') return;
    if (this.revealIndex < this.scoringResults.length - 1) return;
    clearInterval(this.revealTimer);
    if (this.mode === 'board') {
      if (this.boardWinner()) this.endGame();
      else if (this.dealIndexInRound >= this.dealsInRound) this.startRound();
      else this.startDeal();
      return;
    }
    if (this.dealIndexInRound >= this.dealsInRound || this.allHumansBeatBlind()) this.enterRoundEnd();
    else this.openShop();
  }

  maybeAdvance() {
    if (this.phase === 'scoring') {
      if (!this.actives().every(p => p.scoringDone || p.ready || !p.connected)) return;
      if (this.revealIndex < this.scoringResults.length - 1) return;
      if (!this.scoringCanAdvance()) return;
      clearInterval(this.revealTimer);
      if (this.mode === 'board') {
        if (this.boardWinner()) this.endGame();
        else if (this.dealIndexInRound >= this.dealsInRound) this.startRound();
        else this.startDeal();
      } else if (this.dealIndexInRound >= this.dealsInRound || this.allHumansBeatBlind()) this.enterRoundEnd();
      else {
        this.openShop(true);
        if (this.actives().every(p => p.ready || !p.connected)) this.maybeAdvance();
      }
    } else if (this.phase === 'roundEnd') {
      if (!this.actives().every(p => p.ready || !p.connected)) return;
      if (this.regularWinner() || this.actives().length <= 1) this.endGame();
      else this.openShop(false, true);
    } else if (this.phase === 'shop') {
      if (!this.actives().every(p => p.ready || !p.connected)) return;
      if (this.roundComplete || this.dealIndexInRound >= this.dealsInRound) this.startRound();
      else this.startDeal();
    }
  }

  scoringCanAdvance() {
    return this.revealIndex >= this.scoringResults.length - 1 && (!this.scoreDoneAt || Date.now() >= this.scoreDoneAt);
  }

  // The House never has to clear a blind, and the moment every human (in solo,
  // just you) reaches the blind the round ends — you move straight to the next.
  allHumansBeatBlind() {
    if (this.mode === 'board') return false;
    const humans = this.actives().filter(p => !p.isBot);
    return humans.length > 0 && humans.every(p => p.roundScore >= this.blindFor(p));
  }

  boardWinner() {
    return this.mode === 'board' && this.actives().some(p => p.score >= this.goalScore);
  }

  regularWinner() {
    return this.mode === 'blind' && this.actives().some(p => !p.isBot && p.blindsPassed >= REGULAR_FINAL_BLIND);
  }

  endGame() {
    this.phase = 'gameover';
    this.standings = this.players
      .map(p => ({ seat: p.seat, name: p.name, score: p.score, eliminatedRound: p.eliminatedRound }))
      .sort((a, b) => {
        if (this.mode === 'board') return b.score - a.score;
        if ((a.eliminatedRound === null) !== (b.eliminatedRound === null)) return a.eliminatedRound === null ? -1 : 1;
        if (a.eliminatedRound !== b.eliminatedRound) return b.eliminatedRound - a.eliminatedRound;
        return b.score - a.score;
      });
    if (this.mode === 'board') {
      this.log(`Game over! ${this.standings[0].name} reached the board goal.`);
    } else if (this.solo) {
      const human = this.players.find(p => !p.isBot);
      this.log(`Run over — ${human.name} reached round ${this.round} with ${human.score} points.`);
    } else {
      this.log(`Game over! ${this.standings[0].name} outlasted the table.`);
    }
    this.destroy();
  }

  // ---- stall handling ----

  checkIdle() {
    const idle = Date.now() - this.lastProgress;
    if (idle > IDLE_ANYONE_MS) this.autoAct(true);
    else if (idle > IDLE_DISCONNECT_MS) this.autoAct(false);
  }

  playerDisconnected(id) {
    const p = this.byId(id);
    if (p) p.connected = false;
    this.maybeAdvance();
    this.onUpdate();
  }

  playerReconnected(id) {
    const p = this.byId(id);
    if (p) p.connected = true;
    this.onUpdate();
  }

  autoAct(forceAll) {
    const acts = p => forceAll || !p.connected;
    if (this.phase === 'discard') {
      for (const p of this.actives()) {
        if (!p.discarded && acts(p)) {
          this.discard(p, p.hand.slice(0, this.discardNeed(p)).map(c => c.id));
          this.log(`(auto-discard for ${p.name})`);
        }
      }
    } else if (this.phase === 'pegging') {
      const p = this.bySeat(this.turnSeat);
      if (p && acts(p)) {
        const card = p.pegLeft.find(c => this.pegCount + cardValue(c) <= 31);
        if (card) {
          this.log(`(auto-play for ${p.name})`);
          this.playCard(p, card.id);
        }
      }
    } else if (this.phase === 'scoring' || this.phase === 'shop' || this.phase === 'roundEnd') {
      if (this.phase === 'scoring' && this.revealIndex < this.scoringResults.length - 1) return;
      for (const p of this.actives()) {
        if (p.pendingPack && acts(p)) this.pickPack(p, -1);
        if (acts(p) && (this.phase !== 'scoring' ? !p.ready : (!p.scoringDone || !p.ready))) this.setReady(p);
      }
    }
  }

  // ---- per-player view ----

  stateFor(playerId) {
    const me = this.byId(playerId);
    const inDiscard = this.phase === 'discard';
    const cosmicSight = !!(me && this.mode !== 'board' && this.deckIs(me, 'cosmic'));
    const cribVisible = cosmicSight && this.actives().every(p => p.discarded);
    const personalShop = !!(me && this.scoringLeadsToShop() && me.scoringDone);
    const phase = personalShop ? 'shop' : this.phase;
    if (personalShop) this.ensureShopOffer(me);
    return {
      phase,
      mode: this.mode,
      goalScore: this.goalScore,
      solo: this.solo,
      round: this.round,
      blind: this.blind,
      dealNumber: this.dealNumber,
      dealIndexInRound: this.dealIndexInRound,
      dealsInRound: this.dealsInRound,
      dealerSeat: this.dealerSeat,
      turnSeat: this.turnSeat,
      discardCount: me ? this.discardNeed(me) : this.discardCount,
      baseDiscardCount: this.discardCount,
      cosmicTarget: this.cosmicTarget,
      starter: this.starter,
      pegCount: this.pegCount,
        pegStack: this.pegStack,
        pegClosing: !!this.pegClosing,
        cribCount: this.crib.length,
        cribCards: cribVisible ? this.crib.slice() : null,
        cribDeckArts: this.cribDeckArts.slice(),
        mySeat: me ? me.seat : -1,
      revealIndex: this.revealIndex,
      lastPlayAnim: this.lastPlayAnim,
      lastMultAnim: this.lastMultAnim,
      you: me ? {
        active: me.active,
        hand: inDiscard ? me.hand : me.pegLeft,
        kept: me.kept,
        deck: this.mode === 'board' ? [] : sortedDeck(me.deck),
        coins: this.mode === 'board' ? 0 : me.coins, score: me.score, roundScore: me.roundScore, dealPoints: me.dealPoints,
        blindsPassed: me.blindsPassed, blind: this.blindFor(me), dealMult: BASE_MULT + me.dealPegMult,
        deckArt: normalizeDeckArt(me.deckArt),
        deckEffects: this.deckEffects,
        dealHandBonus: me.dealHandBonus || 0,
        rerollCost: me.rerollCost == null ? REROLL_START_COST : me.rerollCost,
        jokerSlots: this.maxJokers(me),
        tarotSlots: this.maxTarots(me),
        jokers: this.mode === 'board' ? [] : me.jokers.map(j => {
          const owned = normalizeJoker(j);
          const def = jokerDef(owned);
          return {
            ...def,
            ...owned,
            desc: owned.id === 'hologram' ? `${def.desc} Currently x${owned.hologramMult || 1} Mult.` : def.desc,
          };
        }),
        tarots: this.mode === 'board' ? [] : me.tarots.map(id => TAROTS_BY_ID[id]),
        discarded: me.discarded, ready: me.ready, coinGain: me.coinGain || 0,
        canDiscard: inDiscard && me.active && !me.discarded,
        shopOffer: this.mode !== 'board' && phase === 'shop' ? me.shopOffer : null,
        pendingPack: this.mode !== 'board' && phase === 'shop' ? me.pendingPack : null,
      } : null,
      players: this.players.map(p => ({
        seat: p.seat, name: p.name, score: p.score, roundScore: p.roundScore, coins: p.coins,
        connected: p.connected, active: p.active, eliminatedRound: p.eliminatedRound, isBot: p.isBot,
        handCount: inDiscard ? p.hand.length : p.pegLeft.length,
        handCards: cosmicSight && p.id !== playerId ? (inDiscard ? p.hand : p.pegLeft) : null,
        discardCount: this.discardNeed(p),
        cribDiscardCount: this.discardCount,
        played: this.phase === 'pegging'
          ? p.kept.filter(c => !p.pegLeft.some(l => l.id === c.id))
          : [],
        discarded: p.discarded, ready: p.ready,
        deckArt: normalizeDeckArt(p.deckArt),
        blind: this.blindFor(p),
        jokers: this.mode === 'board' ? [] : p.jokers.map(j => jokerDef(j).name),
        tarotCount: this.mode === 'board' ? 0 : p.tarots.length,
        deckCount: this.mode === 'board' ? 0 : p.deck.length,
        isDealer: p.seat === this.dealerSeat,
      })),
      scoringResults: phase === 'scoring' ? this.scoringResults : null,
      roundEndData: phase === 'roundEnd' ? this.roundEndData : null,
      standings: phase === 'gameover' ? this.standings : null,
    };
  }
}
