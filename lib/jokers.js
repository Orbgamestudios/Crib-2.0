import { makeCard, randomCardEnhancement } from './cards.js?v=3';

// Jokers are passive modifiers. `mods` keys are aggregated by aggregateMods:
//   *Mult keys multiply, *Val keys take the best value, flags OR, the rest add.
export const JOKERS = [
  // scoring repricers
  { id: 'fifteen_fanatic', name: 'Fifteen Fanatic', desc: 'During hand or crib scoring, every combo that totals 15 is worth 3 points instead of the normal 2.', cost: 5, mods: { fifteenVal: 3 } },
  { id: 'pair_pal', name: 'Pair Pal', desc: 'During hand or crib scoring, every pair you score is worth 3 points instead of the normal 2.', cost: 5, mods: { pairVal: 3 } },
  { id: 'run_baron', name: 'Run Baron', desc: 'During pegging, when your played card scores a run, add +5 Hand Points for this deal.', cost: 4, mods: { pegHandBonus: { eventType: 'run', pts: 5 } } },
  { id: 'flush_broker', name: 'Flush Broker', desc: 'If your hand is a flush and the starter card is the same suit, double the flush points.', cost: 4, mods: { flushStarterMult: 2 } },
  { id: 'sir_nobs', name: 'Sir Nobs', desc: 'If you score His Nobs, the matching-suit Jack is worth 5 points instead of 1.', cost: 3, mods: { nobsVal: 5 } },
  { id: 'golden_crib', name: 'Golden Crib', desc: 'When your crib is scored, gain +2 crib Mult if any card in the crib is a 5.', cost: 6, mods: { cribFiveMult: 2 } },
  { id: 'overseer', name: 'The Overseer', desc: 'Each card you play during pegging adds +1 Hand Point for this deal, whether or not that card scores.', cost: 6, mods: { playHandBonus: { pts: 1 } } },
  { id: 'shortcut', name: 'Shortcut', desc: 'Your runs can skip one missing rank, so patterns like 3-5-7 can count as a run.', cost: 6, mods: { shortcut: true } },
  // per-card bonuses
  { id: 'five_alive', name: 'Five Alive', desc: 'During pegging, when a 5 you play scores a 15, 31, pair, or run, add +5 Hand Points for this deal.', cost: 4, mods: { pegHandBonus: { ranks: [5], pts: 5 } } },
  { id: 'jack_of_all', name: 'Jack of All', desc: 'Each Jack you play during pegging adds +2 Hand Points for this deal, whether or not it scores.', cost: 3, mods: { playHandBonus: { ranks: [11], pts: 2 } } },
  { id: 'even_steven', name: 'Even Steven', desc: 'Each 2, 4, 6, 8, or 10 you play during pegging adds +1 Mult for this deal, whether or not it scores.', cost: 4, mods: {} },
  { id: 'odd_todd', name: 'Odd Todd', desc: 'Each Ace, 3, 5, 7, or 9 you play during pegging adds +1 Hand Point for this deal, whether or not it scores.', cost: 4, mods: { playHandBonus: { ranks: [1, 3, 5, 7, 9], pts: 1 } } },
  { id: 'fibonacci', name: 'Fibonacci', desc: 'During pegging, when an Ace, 2, 3, 5, or 8 you play scores a 15, 31, pair, or run, add +4 Hand Points for this deal.', cost: 5, mods: { pegHandBonus: { ranks: [1, 2, 3, 5, 8], pts: 4 } } },
  { id: 'walkie_talkie', name: 'Walkie Talkie', desc: 'During pegging, when a 4 or 10 you play scores a 15, 31, pair, or run, add +5 Hand Points for this deal.', cost: 4, mods: { pegHandBonus: { ranks: [4, 10], pts: 5 } } },
  { id: 'scary_face', name: 'Scary Face', desc: 'Each Jack, Queen, or King you play during pegging adds +2 Hand Points for this deal, whether or not it scores.', cost: 4, mods: { playHandBonus: { ranks: [11, 12, 13], pts: 2 } } },
  { id: 'greedy_joker', name: 'Greedy Joker', desc: 'Each Diamond you play during pegging adds +1 Hand Point for this deal, whether or not it scores.', cost: 4, mods: { playHandBonus: { suit: 1, pts: 1 } } },
  { id: 'lusty_joker', name: 'Lusty Joker', desc: 'Each Heart you play during pegging adds +1 Hand Point for this deal, whether or not it scores.', cost: 4, mods: { playHandBonus: { suit: 0, pts: 1 } } },
  { id: 'gluttonous_joker', name: 'Gluttonous Joker', desc: 'Each Club you play during pegging adds +1 Hand Point for this deal, whether or not it scores.', cost: 4, mods: { playHandBonus: { suit: 2, pts: 1 } } },
  { id: 'wrathful_joker', name: 'Wrathful Joker', desc: 'Each Spade you play during pegging adds +1 Hand Point for this deal, whether or not it scores.', cost: 4, mods: { playHandBonus: { suit: 3, pts: 1 } } },
  // conditional hand bonuses
  { id: 'nineteen', name: 'The Nineteen', desc: 'During pegging, if your card already scores and leaves the count exactly at 19, add +12 Hand Points for this deal.', cost: 5, mods: { pegHandBonus: { count: 19, pts: 12 } } },
  { id: 'skunk_line', name: 'Skunk Line', desc: 'During pegging, if your card scores while the count is above 20, add +6 Hand Points for this deal.', cost: 5, mods: { pegHandBonus: { minCount: 21, pts: 6 } } },
  { id: 'his_majesty', name: 'His Majesty', desc: 'When the starter is a Jack, Queen, or King, every card you play during pegging adds +1 Hand Point for this deal.', cost: 4, mods: { playHandBonus: { starterFace: true, pts: 1 } } },
  { id: 'bull_market', name: 'Bull Market', desc: 'Each card you play during pegging adds +1 Hand Point for every 10 coins you hold, whether or not it scores.', cost: 5, mods: { playHandBonus: { coinDivisor: 10, pts: 1 } } },
  { id: 'muggins', name: 'Muggins', desc: 'During pegging, when one card scores two or more things at once, add +8 Hand Points for this deal.', cost: 5, mods: { pegHandBonus: { minEvents: 2, pts: 8 } } },
  // pegging
  { id: 'counter_king', name: 'Counter King', desc: 'During pegging, if your play scores Mult and leaves the count above 15, gain +2 bonus Mult.', cost: 6, mods: {} },
  { id: 'last_card_larry', name: 'Last Card Larry', desc: 'During pegging, when you score Go or Last Card, score 3 pegging points instead of 1.', cost: 3, mods: { goVal: 3 } },
  { id: 'salute_31', name: '31 Salute', desc: 'During pegging, if you hit exactly 31, score 5 pegging points instead of 2.', cost: 4, mods: { thirtyOneVal: 5 } },
  { id: 'pony_express', name: 'Pony Express', desc: 'During each deal, your first card played in pegging scores +2 extra pegging points.', cost: 3, mods: { pegFirst: 2 } },
  { id: 'small_ball', name: 'Small Ball', desc: 'During pegging, each time you play a 2, 3, 4, or 5, score +1 extra pegging point.', cost: 4, mods: { smallBall: 1 } },
  // economy
  { id: 'mugs_coin', name: "Mug's Coin", desc: 'After every deal ends, gain +2 extra coins before you shop.', cost: 5, mods: { coinsPerDeal: 2 } },
  { id: 'cutpurse', name: 'Cutpurse', desc: 'Each time the starter card is cut, gain +1 coin immediately.', cost: 3, mods: { coinOnCut: 1 } },
  { id: 'rocket', name: 'Rocket', desc: 'After each deal, gain +1 coin for each blind you have already passed.', cost: 5, mods: { coinPerBlind: 1 } },
  { id: 'heels_hunter', name: 'Heels Hunter', desc: 'When you are dealer and the starter is a Jack, His Heels scores 5 points instead of 2.', cost: 3, mods: { heelsVal: 5 } },
  { id: 'crib_copier', name: 'Crib Copier', desc: 'At the start of each deal, the first card you discard to the crib is duplicated into that crib and added to your deck for the run.', cost: 7, mods: { duplicateFirstCrib: 1 } },
  { id: 'crib_battery', name: 'Crib Battery', desc: 'When your crib scores, its crib Mult is multiplied by x1.25 for each different suit in the crib.', cost: 7, mods: { cribSuitMult: 1.25 } },
  { id: 'hayloft', name: 'Hayloft', desc: 'When your crib scores, gain +1 crib Mult for every 2 cards in that crib.', cost: 7, mods: { cribPairMult: 1 } },
  { id: 'crib_spark', name: 'Crib Spark', desc: 'When your crib scores, gain +1 crib Mult for each fifteen combo inside the crib.', cost: 6, mods: { cribFifteenMult: 1 } },
  { id: 'ace_chaser', name: 'Ace Chaser', desc: 'During pegging, when an Ace you play scores a 15, 31, pair, or run, add +6 Hand Points for this deal.', cost: 4, mods: { pegHandBonus: { ranks: [1], pts: 6 } } },
  { id: 'low_rider', name: 'Low Rider', desc: 'During pegging, when an Ace, 2, or 3 you play scores a 15, 31, pair, or run, add +4 Hand Points for this deal.', cost: 4, mods: { pegHandBonus: { ranks: [1, 2, 3], pts: 4 } } },
  { id: 'coin_clip', name: 'Coin Clip', desc: 'After every deal, gain +1 coin, plus +1 more coin for each blind you have already passed.', cost: 5, mods: { coinsPerDeal: 1, coinPerBlind: 1 } },
  { id: 'riff_raff', name: 'Riff-Raff', desc: 'When a new blind begins, create up to 2 random Common Jokers in your open joker slots.', cost: 4, mods: {} },
  // meta
  { id: 'blueprint', name: 'Blueprint', desc: 'Copies the joker immediately to its right. Drag your jokers to choose what Blueprint copies.', cost: 8, mods: {} },
  // ---- Ultra (the best jokers) ----
  { id: 'obelisk', name: 'Obelisk', desc: 'Each card you play during pegging adds +2 Hand Points for this deal, whether or not that card scores.', cost: 8, mods: { playHandBonus: { pts: 2 } } },
  { id: 'the_duo', name: 'The Duo', desc: 'During hand or crib scoring, every pair you score is worth 5 points instead of the normal 2.', cost: 8, mods: { pairVal: 5 } },
  { id: 'holo_fifteen', name: 'Holo Fifteen', desc: 'During hand or crib scoring, every fifteen combo is worth 4 points instead of the normal 2.', cost: 8, mods: { fifteenVal: 4 } },
  { id: 'steel_crib', name: 'Steel Crib', desc: 'When your crib scores, gain +3 crib Mult if the crib has no Jacks, Queens, or Kings.', cost: 8, mods: { cribNoFaceMult: 3 } },
  { id: 'overclock', name: 'Overclock', desc: 'During pegging, starting with your third played card each deal, any pegging points you score are tripled.', cost: 8, mods: { pegAfterTwoMult: 3 } },
  { id: 'card_smith', name: 'Card Smith', desc: 'Each time you reach the shop, open one free Standard Pack and choose a card to add to your deck.', cost: 6, mods: { freeStandardPack: 1 } },
  { id: 'crib_diviner', name: 'Crib Diviner', desc: 'During discard, if the cards you send to the crib total 10 or more, gain a random tarot if you have room.', cost: 5, mods: { cribTenTarot: 1 } },
  { id: 'acemaker', name: '5-Maker', desc: 'Whenever you discard cards to the crib, those discarded cards become 5s before entering the crib. Their suits stay the same, so your crib is much better at making 15s.', cost: 8, mods: { cribFives: 1 } },
  { id: 'card_sharp', name: 'Card Sharp', desc: 'Once per deal, double your pegging Mult gain when you repeat a scoring play type you already made this deal.', cost: 7, mods: {} },
  { id: 'onyx_agate', name: 'Onyx Agate', desc: 'When a Club you play earns pegging points, add +2 extra Mult.', cost: 6, mods: {} },
  { id: 'arrowhead', name: 'Arrowhead', desc: 'When a Spade you play earns pegging points, add +2 Hand Points for this deal.', cost: 6, mods: { pegHandBonus: { suit: 3, pts: 2 } } },
  { id: 'bloodstone', name: 'Bloodstone', desc: 'When a Heart you play earns pegging points, it has a 1 in 2 chance to multiply that play\'s Mult gain by x1.5.', cost: 7, mods: {} },
  { id: 'rough_gem', name: 'Rough Gem', desc: 'When a Diamond you play earns pegging points, gain 2 coins immediately.', cost: 6, mods: {} },
  { id: 'stuntman', name: 'Stuntman', desc: 'Adds +10 Hand Points when your hand scores, but you are dealt 1 fewer card each deal.', cost: 7, mods: { handFlat: 10, handSize: -1 } },
  { id: 'the_trio', name: 'The Trio', desc: 'During hand scoring, multiply your Mult by x2 if the hand and starter contain Three of a Kind.', cost: 7, mods: {} },
  { id: 'the_family', name: 'The Family', desc: 'During hand scoring, multiply your Mult by x3 if the hand and starter contain Four of a Kind.', cost: 7, mods: {} },
  { id: 'baseball_card', name: 'Baseball Card', desc: 'During hand and crib scoring, each Rare Joker you own multiplies your Mult by x1.5.', cost: 8, mods: {} },
  { id: 'hologram', name: 'Hologram', desc: 'Starts at x1 Mult. Every playing card permanently added to your deck increases this joker by x0.25 Mult for the rest of the run.', cost: 7, mods: {} },
];

// Rarity tiers. Ultra are the strongest and always cost 8; rare are a notch
// up from common. Anything not listed is common. Rarity drives shop odds and
// the shop odds and rarity label.
const RARE_IDS = new Set([
  'fifteen_fanatic', 'pair_pal', 'golden_crib', 'overseer', 'shortcut', 'fibonacci',
  'nineteen', 'skunk_line', 'bull_market', 'muggins', 'counter_king', 'mugs_coin',
  'rocket', 'coin_clip', 'his_majesty', 'run_baron', 'flush_broker', 'crib_diviner', 'crib_spark', 'card_smith',
  'card_sharp', 'onyx_agate', 'arrowhead', 'bloodstone', 'rough_gem', 'stuntman', 'the_trio', 'the_family', 'hologram',
]);
const ULTRA_IDS = new Set([
  'blueprint', 'crib_copier', 'crib_battery', 'hayloft', 'obelisk', 'the_duo', 'holo_fifteen', 'steel_crib', 'overclock', 'acemaker', 'baseball_card',
]);
for (const j of JOKERS) {
  j.rarity = ULTRA_IDS.has(j.id) ? 'ultra' : RARE_IDS.has(j.id) ? 'rare' : 'common';
  if (j.rarity === 'ultra') j.cost = 8;
  else if (j.rarity === 'rare' && j.cost < 5) j.cost = 5;
}

// Tarots are one-shot consumables used during the discard phase. Card edits
// are PERMANENT — your hand is dealt from your own deck, and the deck remembers.
// `targets` = how many of your own hand cards must be selected, in order.
export const TAROTS = [
  { id: 'sun', name: 'The Sun', desc: 'Use during discard on one card in your hand. That card permanently ranks up by 1 in your deck; King wraps to Ace.', cost: 3, targets: 1 },
  { id: 'moon', name: 'The Moon', desc: 'Use during discard on one card in your hand. That card permanently ranks down by 1 in your deck; Ace wraps to King.', cost: 3, targets: 1 },
  { id: 'strength', name: 'Strength', desc: 'Use during discard on two cards in your hand. Both cards permanently rank up by 1 in your deck.', cost: 4, targets: 2 },
  { id: 'death', name: 'Death', desc: 'Use during discard on two cards in your hand. The first selected card permanently becomes an exact copy of the second.', cost: 4, targets: 2 },
  { id: 'magician', name: 'The Magician', desc: 'Use during discard on two cards in your hand. Both permanently become Lucky Cards.', cost: 4, targets: 2, enhancement: 'lucky' },
  { id: 'lovers', name: 'The Lovers', desc: 'Use during discard on one card in your hand. It permanently becomes a Wild Card that counts as every suit.', cost: 3, targets: 1, enhancement: 'wild' },
  { id: 'chariot', name: 'The Chariot', desc: 'Use during discard on one card in your hand. It permanently becomes a Steel Card that gives x1.5 Mult when placed in the crib.', cost: 4, targets: 1, enhancement: 'steel' },
  { id: 'justice', name: 'Justice', desc: 'Use during discard on one card in your hand. It permanently becomes a Glass Card: x2 Mult when scored, with a 1 in 4 chance to shatter.', cost: 4, targets: 1, enhancement: 'glass' },
  { id: 'star', name: 'The Star', desc: 'Use during discard on one card in your hand. It permanently becomes a Jack and keeps its current suit.', cost: 3, targets: 1 },
  { id: 'empress', name: 'The Empress', desc: 'Use during discard on two cards in your hand. Both permanently become Mult Cards that add +1 Mult when scored.', cost: 3, targets: 2, enhancement: 'mult' },
  { id: 'hierophant', name: 'The Hierophant', desc: 'Use during discard on two cards in your hand. Both permanently become Bonus Cards that add +2 Hand Points when scored.', cost: 3, targets: 2, enhancement: 'bonus' },
  { id: 'emperor', name: 'The Emperor', desc: 'Use during discard on two cards in your hand. Both permanently become Diamonds.', cost: 3, targets: 2 },
  { id: 'devil', name: 'The Devil', desc: 'Use during discard on two cards in your hand. Both permanently become Clubs.', cost: 3, targets: 2 },
  { id: 'tower', name: 'The Tower', desc: 'Use during discard on two cards in your hand. Both permanently become Spades.', cost: 3, targets: 2 },
  { id: 'priestess', name: 'High Priestess', desc: 'Use during discard on one card in your hand. A permanent copy of that exact card is added to your deck.', cost: 4, targets: 1 },
  { id: 'hanged_man', name: 'The Hanged Man', desc: 'Use during discard on two cards in your hand. Both are permanently removed from your deck after use.', cost: 4, targets: 2 },
  { id: 'judgement', name: 'Judgement', desc: 'Use in the shop or during discard. Gain one random joker you do not already own, if you have room.', cost: 5, targets: 0 },
  { id: 'wheel', name: 'Wheel of Fortune', desc: 'Use in the shop or during discard. Has a 1 in 4 chance to add Foil, Holographic, or Polychrome Edition to one random editionless joker.', cost: 3, targets: 0 },
  { id: 'hermit', name: 'The Hermit', desc: 'Use in the shop or during discard. Gain 5 coins immediately.', cost: 2, targets: 0 },
];

export const PACKS = [
  { id: 'buffoon', name: 'Buffoon Pack', desc: 'Pick 1 of 3 jokers.', cost: 5, kind: 'pack' },
  { id: 'ultra', name: 'Ultra Pack', desc: 'Reward-only pack. Pick 1 of 3 jokers with much higher Rare and Ultra odds, plus better Edition odds.', cost: 8, kind: 'pack', rewardOnly: true },
  { id: 'arcana', name: 'Arcana Pack', desc: 'Pick 1 of 3 tarot cards.', cost: 3, kind: 'pack' },
  { id: 'standard', name: 'Standard Pack', desc: 'Pick 1 of 3 playing cards to add to your deck. Cards can arrive with a permanent Enhancement.', cost: 3, kind: 'pack' },
];

export const JOKERS_BY_ID = Object.fromEntries(JOKERS.map(j => [j.id, j]));
export const TAROTS_BY_ID = Object.fromEntries(TAROTS.map(t => [t.id, t]));
export const PACKS_BY_ID = Object.fromEntries(PACKS.map(p => [p.id, p]));

export const STAMPS = {
  foil: { name: 'Foil Edition', desc: 'Adds +5 Hand Points when your hand scores.', chance: 0.03 },
  holographic: { name: 'Holographic Edition', desc: 'Adds +3 Mult during hand and crib scoring.', chance: 0.02 },
  polychrome: { name: 'Polychrome Edition', desc: 'Multiplies Mult by x1.5 during hand and crib scoring.', chance: 0.01 },
  negative: { name: 'Negative Edition', desc: 'Adds +1 Joker slot while this joker is owned.', chance: 0.005 },
};

function normalizeStamp(stamp) {
  return ({ blue: 'foil', green: 'foil', red: 'holographic', purple: 'polychrome', white: 'negative' })[stamp] || stamp;
}

export function jokerId(joker) {
  return typeof joker === 'string' ? joker : joker && joker.id;
}

export function normalizeJoker(joker) {
  if (typeof joker === 'string') return { id: joker, ...(joker === 'hologram' ? { hologramMult: 1 } : {}) };
  if (joker && joker.id) {
    const stamp = normalizeStamp(joker.stamp);
    const hologramMult = joker.id === 'hologram' ? Math.max(1, Number(joker.hologramMult) || 1) : null;
    return { id: joker.id, ...(stamp ? { stamp } : {}), ...(hologramMult ? { hologramMult } : {}) };
  }
  return null;
}

export function jokerDef(joker) {
  return JOKERS_BY_ID[jokerId(joker)];
}

function rollStamp() {
  return rollStampWithMultiplier(1);
}

function rollStampWithMultiplier(mult = 1) {
  const roll = Math.random();
  let mark = 0;
  for (const [stamp, meta] of Object.entries(STAMPS)) {
    mark += meta.chance * mult;
    if (roll < mark) return stamp;
  }
  return null;
}

export function jokerInstance(def, stamped = true, stampMult = 1) {
  const inst = { id: def.id };
  const stamp = stamped ? rollStampWithMultiplier(stampMult) : null;
  if (stamp) inst.stamp = stamp;
  return inst;
}

export function jokerCapacity(jokers, base = 5) {
  return base + (jokers || []).filter(j => normalizeJoker(j)?.stamp === 'negative').length;
}

export function stampText(stamp) {
  return stamp && STAMPS[stamp] ? `${STAMPS[stamp].name}: ${STAMPS[stamp].desc}` : '';
}

const VAL_KEYS = ['fifteenVal', 'pairVal', 'nobsVal', 'goVal', 'thirtyOneVal', 'heelsVal'];
const FLAG_KEYS = ['shortcut', 'nineteen'];

// Blueprint copies the joker to its right: expand the owned list into the
// list of joker ids whose mods actually apply.
export function effectiveJokerIds(jokerIds) {
  const out = [];
  for (let i = 0; i < jokerIds.length; i++) {
    const id = jokerId(jokerIds[i]);
    if (id === 'blueprint') {
      const next = jokerIds[i + 1];
      if (next && jokerId(next) !== 'blueprint') out.push(next);
    } else {
      out.push(jokerIds[i]);
    }
  }
  return out;
}

export function aggregateMods(jokerIds) {
  const m = {
    fifteenVal: 2, pairVal: 2, runBonus: 0, flushMult: 1, flushStarterMult: 1, nobsVal: 1,
    cribMult: 1, pegMult: 1, pegHighCountMult: 1, pegAfterTwoMult: 1, goVal: 1, thirtyOneVal: 2, heelsVal: 2,
    handFlat: 0, coinsPerDeal: 0, coinOnCut: 0, coinPerBlind: 0,
    rankBonuses: [], suitBonuses: [], pegHandBonuses: [], playHandBonuses: [],
    shortcut: false, nineteen: false, muggins: 0, bigHand: 0,
    starterFace: 0, bull: 0, pegFirst: 0, smallBall: 0, duplicateFirstCrib: 0,
    cribTenTarot: 0, freeStandardPack: 0, cribFives: 0,
    cribScoreMult: 1, cribPairMult: 0, cribFifteenMult: 0,
    cribFiveMult: 0, cribLeanMult: 0, cribNoFaceMult: 0, cribSuitMult: 1,
  };
  for (const id of effectiveJokerIds(jokerIds)) {
    const def = jokerDef(id);
    if (!def) continue;
    for (const [k, v] of Object.entries(def.mods)) {
      if (k === 'rankBonus') m.rankBonuses.push(v);
      else if (k === 'suitBonus') m.suitBonuses.push(v);
      else if (k === 'pegHandBonus') m.pegHandBonuses.push(v);
      else if (k === 'playHandBonus') m.playHandBonuses.push(v);
      else if (k === 'cribPairMult' || k === 'cribFifteenMult' || k === 'cribFiveMult' || k === 'cribLeanMult' || k === 'cribNoFaceMult') m[k] += v;
      else if (FLAG_KEYS.includes(k)) m[k] = m[k] || v;
      else if (k.endsWith('Mult')) m[k] *= v;
      else if (VAL_KEYS.includes(k)) m[k] = Math.max(m[k], v);
      else m[k] += v;
    }
  }
  return m;
}

const SUIT_NAMES = ['Hearts', 'Diamonds', 'Clubs', 'Spades'];
const hasSuit = (card, suit) => card && card.enhancement !== 'stone' && (card.suit === suit || card.enhancement === 'wild');
const flushIncludesStarter = (cards, starter) => {
  const suited = cards.filter(c => c.enhancement !== 'stone');
  return suited.length >= 4 && [0, 1, 2, 3].some(suit => suited.every(c => hasSuit(c, suit)) && hasSuit(starter, suit));
};

// Total a scoring breakdown under a player's mods, producing the itemized
// lines shown in the reveal. ctx = { starter, coins }.
export function buildScore(bd, mods, kind, cards, ctx) {
  const J = ' [Joker]';
  const lines = [];
  let total = 0;
  const target = ctx && ctx.target ? ctx.target : 15;
  const add = (label, pts) => { lines.push({ label, pts }); total += pts; };

  if (bd.fifteens) add(`${target}s x${bd.fifteens}${mods.fifteenVal !== 2 ? J : ''}`, bd.fifteens * mods.fifteenVal);
  if (bd.pairs) add(`Pairs ×${bd.pairs}${mods.pairVal !== 2 ? J : ''}`, bd.pairs * mods.pairVal);
  if (bd.runPoints) add(`Runs${mods.runBonus || mods.shortcut ? J : ''}`, bd.runPoints + bd.runCount * mods.runBonus);
  if (bd.flush) {
    let flushMult = mods.flushMult;
    if (mods.flushStarterMult !== 1 && flushIncludesStarter(cards, ctx.starter)) {
      flushMult *= mods.flushStarterMult;
    }
    add(`Flush${flushMult !== 1 ? J : ''}`, bd.flush * flushMult);
  }
  if (bd.nobs) add(`His Nobs${mods.nobsVal !== 1 ? J : ''}`, bd.nobs * mods.nobsVal);

  const baseZero = !bd.fifteens && !bd.pairs && !bd.runPoints && !bd.flush && !bd.nobs;

  if (kind === 'crib') {
    if (mods.cribMult > 1) {
      const boosted = Math.ceil(total * mods.cribMult);
      lines.push({ label: `Golden Crib ×${mods.cribMult}${J}`, pts: null });
      total = boosted;
    }
    return { total, lines };
  }

  for (const rb of mods.rankBonuses) {
    const n = cards.filter(c => c.enhancement !== 'stone' && rb.ranks.includes(c.rank)).length;
    if (n) add(`Rank bonus ×${n}${J}`, n * rb.pts);
  }
  for (const sb of mods.suitBonuses) {
    const n = cards.filter(c => hasSuit(c, sb.suit)).length;
    if (n) add(`${SUIT_NAMES[sb.suit]} ×${n}${J}`, n * sb.pts);
  }
  if (mods.handFlat) add('Flat bonus' + J, mods.handFlat);
  if (mods.starterFace && ctx.starter && ctx.starter.rank >= 11) add('His Majesty' + J, mods.starterFace);
  if (mods.bull) {
    const pts = Math.floor((ctx.coins || 0) / 4) * mods.bull;
    if (pts) add('Bull Market' + J, pts);
  }
  if (mods.nineteen && baseZero) add('The Nineteen!' + J, 19);
  if (mods.bigHand && total >= 12) add('Skunk Line' + J, mods.bigHand);
  if (kind === 'crib' && mods.cribMult > 1) {
    const boosted = Math.ceil(total * mods.cribMult);
    lines.push({ label: `Golden Crib ×${mods.cribMult}${J}`, pts: null });
    total = boosted;
  }

  return { total, lines };
}

export function buildScoreOrdered(bd, jokerIds, kind, cards, ctx) {
  const J = ' [Joker]';
  const lines = [];
  let total = 0;
  let fifteenVal = 2;
  let pairVal = 2;
  let nobsVal = 1;
  const target = ctx && ctx.target ? ctx.target : 15;
  const add = (label, pts) => { if (pts) { lines.push({ label, pts }); total += pts; } };

  if (bd.fifteens) add(`${target}s x${bd.fifteens}`, bd.fifteens * fifteenVal);
  if (bd.pairs) add(`Pairs ×${bd.pairs}`, bd.pairs * pairVal);
  if (bd.runPoints) add('Runs', bd.runPoints);
  if (bd.flush) add('Flush', bd.flush);
  if (bd.nobs) add('His Nobs', bd.nobs * nobsVal);

  const baseZero = !bd.fifteens && !bd.pairs && !bd.runPoints && !bd.flush && !bd.nobs;

  for (const raw of effectiveJokerIds(jokerIds)) {
    const joker = normalizeJoker(raw);
    const def = jokerDef(joker);
    if (!def) continue;
    const mods = def.mods || {};
    const cribOnly = kind === 'crib';
    if (mods.fifteenVal && bd.fifteens && mods.fifteenVal > fifteenVal) {
      add(`${def.name} fifteens${J}`, bd.fifteens * (mods.fifteenVal - fifteenVal));
      fifteenVal = mods.fifteenVal;
    }
    if (mods.pairVal && bd.pairs && mods.pairVal > pairVal) {
      add(`${def.name} pairs${J}`, bd.pairs * (mods.pairVal - pairVal));
      pairVal = mods.pairVal;
    }
    if (mods.runBonus && bd.runCount) add(`${def.name} runs${J}`, bd.runCount * mods.runBonus);
    if (mods.flushStarterMult !== 1 && mods.flushStarterMult && bd.flush && flushIncludesStarter(cards, ctx.starter)) {
      add(`${def.name} flush${J}`, bd.flush * (mods.flushStarterMult - 1));
    }
    if (mods.nobsVal && bd.nobs && mods.nobsVal > nobsVal) {
      add(`${def.name} nobs${J}`, bd.nobs * (mods.nobsVal - nobsVal));
      nobsVal = mods.nobsVal;
    }

    if (cribOnly) continue;
    if (mods.rankBonus) {
      const n = cards.filter(c => c.enhancement !== 'stone' && mods.rankBonus.ranks.includes(c.rank)).length;
      add(`${def.name} ×${n}${J}`, n * mods.rankBonus.pts);
    }
    if (mods.suitBonus) {
      const n = cards.filter(c => hasSuit(c, mods.suitBonus.suit)).length;
      add(`${def.name} ×${n}${J}`, n * mods.suitBonus.pts);
    }
    if (mods.handFlat) add(`${def.name}${J}`, mods.handFlat);
    if (kind === 'hand' && joker?.stamp === 'foil') add('Foil Edition' + J, 5);
    if (mods.starterFace && ctx.starter && ctx.starter.rank >= 11) add(`${def.name}${J}`, mods.starterFace);
    if (mods.bull) add(`${def.name}${J}`, Math.floor((ctx.coins || 0) / 4) * mods.bull);
    if (mods.nineteen && baseZero) add(`${def.name}${J}`, 19);
    if (mods.bigHand && total >= 12) add(`${def.name}${J}`, mods.bigHand);
  }

  return { total, lines };
}

function pick(arr, n, exclude) {
  const excludeIds = exclude.map(jokerId);
  const pool = arr.filter(x => !excludeIds.includes(x.id));
  const out = [];
  while (out.length < n && pool.length) {
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return out;
}

// Jokers are drawn by rarity weight so Ultras stay a rare thrill.
const RARITY_WEIGHT = { common: 70, rare: 26, ultra: 6 };
function pickJokers(n, exclude) {
  const excludeIds = (exclude || []).map(jokerId);
  const pool = JOKERS.filter(j => !excludeIds.includes(j.id));
  const out = [];
  while (out.length < n && pool.length) {
    const total = pool.reduce((s, j) => s + (RARITY_WEIGHT[j.rarity] || 1), 0);
    let r = Math.random() * total, idx = pool.length - 1;
    for (let i = 0; i < pool.length; i++) { r -= RARITY_WEIGHT[pool[i].rarity] || 1; if (r <= 0) { idx = i; break; } }
    out.push(jokerInstance(pool.splice(idx, 1)[0]));
  }
  return out;
}

function pickUltraJokers(n, exclude) {
  const excludeIds = (exclude || []).map(jokerId);
  const pool = JOKERS.filter(j => !excludeIds.includes(j.id));
  const out = [];
  while (out.length < n && pool.length) {
    const roll = Math.random() * 90;
    const preferred = roll < 30 ? 'ultra' : roll < 80 ? 'rare' : 'common';
    let candidates = pool.filter(j => j.rarity === preferred);
    if (!candidates.length) candidates = pool;
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    const idx = pool.findIndex(j => j.id === pick.id);
    out.push(jokerInstance(pool.splice(idx, 1)[0], true, 2.5));
  }
  return out;
}

export function randomJoker(ownedIds) {
  return pickJokers(1, ownedIds)[0] || null;
}

export function randomCommonJoker(ownedIds) {
  const excludeIds = (ownedIds || []).map(jokerId);
  const pool = JOKERS.filter(j => j.rarity === 'common' && !excludeIds.includes(j.id));
  if (!pool.length) return null;
  return jokerInstance(pool[Math.floor(Math.random() * pool.length)]);
}

export function randomTarot() {
  const pool = TAROTS.flatMap(t => Array(t.rare ? 1 : 6).fill(t));
  return pool[Math.floor(Math.random() * pool.length)];
}

function shopItem(def, kind) {
  const id = jokerId(def);
  const base = kind === 'joker' ? JOKERS_BY_ID[id] : def;
  const item = { kind, id: base.id, name: base.name, desc: base.desc, cost: base.cost, sold: false };
  if (base.rewardOnly) item.rewardOnly = true;
  if (kind === 'joker') {
    item.rarity = base.rarity;
    const owned = normalizeJoker(def);
    const stamp = owned?.stamp;
    if (stamp) item.stamp = stamp;
    if (owned?.hologramMult) item.hologramMult = owned.hologramMult;
  } else if (kind === 'tarot' && base.rare) item.rare = true;
  return item;
}

function wildcardItem(player, excludeJokers) {
  const roll = Math.floor(Math.random() * 2);
  if (roll === 0) {
    const joker = pickJokers(1, excludeJokers)[0];
    if (joker) return shopItem(joker, 'joker');
  }
  return shopItem(randomTarot(), 'tarot');
}

export function makeShopOffer(player, opts = {}) {
  const jokers = pickJokers(2, player.jokers);
  const tarots = [randomTarot()];
  const shopPacks = PACKS.filter(p => !p.rewardOnly);
  const packs = [
    opts.classicArcana && player && player.deckArt === 'classic'
      ? PACKS_BY_ID.arcana
      : shopPacks[Math.floor(Math.random() * shopPacks.length)],
    shopPacks[Math.floor(Math.random() * shopPacks.length)],
  ];
  return [
    ...jokers.map(j => shopItem(j, 'joker')),
    ...tarots.map(t => shopItem(t, 'tarot')),
    wildcardItem(player, player.jokers.concat(jokers.map(j => j.id))),
    ...packs.map(p => shopItem(p, 'pack')),
  ];
}

export function openPack(type, player) {
  if (type === 'buffoon') {
    return pickJokers(3, player.jokers).map(j => {
      const def = JOKERS_BY_ID[j.id];
      return { kind: 'joker', id: j.id, stamp: j.stamp, name: def.name, desc: def.desc, rarity: def.rarity };
    });
  }
  if (type === 'ultra') {
    return pickUltraJokers(3, player.jokers).map(j => {
      const def = JOKERS_BY_ID[j.id];
      return { kind: 'joker', id: j.id, stamp: j.stamp, name: def.name, desc: def.desc, rarity: def.rarity };
    });
  }
  if (type === 'arcana') {
    const out = [];
    while (out.length < 3) {
      const t = randomTarot();
      if (!out.some(x => x.id === t.id)) out.push(t);
    }
    return out.map(t => ({ kind: 'tarot', id: t.id, name: t.name, desc: t.desc, rare: !!t.rare }));
  }
  const cards = [];
  for (let i = 0; i < 3; i++) {
    const enhancement = randomCardEnhancement();
    const c = makeCard(1 + Math.floor(Math.random() * 13), Math.floor(Math.random() * 4), enhancement);
    cards.push({ kind: 'card', id: c.id, rank: c.rank, suit: c.suit, ...(enhancement ? { enhancement } : {}) });
  }
  return cards;
}
