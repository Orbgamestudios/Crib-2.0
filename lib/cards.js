export const SUITS = ['H', 'D', 'C', 'S'];
export const RANK_NAMES = [null, 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

export const CARD_ENHANCEMENTS = {
  bonus: { name: 'Bonus Card', desc: '+2 Hand Points during hand or crib scoring.' },
  mult: { name: 'Mult Card', desc: '+1 Mult during hand or crib scoring.' },
  wild: { name: 'Wild Card', desc: 'Counts as every suit at the same time.' },
  glass: { name: 'Glass Card', desc: 'x2 Mult when scored, with a 1 in 4 chance to shatter after scoring.' },
  steel: { name: 'Steel Card', desc: 'x1.5 Mult when this card is placed in the crib.' },
  stone: { name: 'Stone Card', desc: '+4 Hand Points when scored, but has no rank, suit, or pegging value.' },
  gold: { name: 'Gold Card', desc: 'Gain 3 coins if this card is held in your hand during scoring.' },
  lucky: { name: 'Lucky Card', desc: 'When scored: 1 in 5 chance for +10 Mult and a separate 1 in 15 chance for 20 coins.' },
};

let nextId = 1;

export function makeCard(rank, suit, enhancement = null) {
  return { id: 'c' + (nextId++), rank, suit, ...(enhancement ? { enhancement } : {}) };
}

export function makeDeck() {
  const deck = [];
  for (let s = 0; s < 4; s++) {
    for (let r = 1; r <= 13; r++) {
      deck.push(makeCard(r, s));
    }
  }
  return deck;
}

export function sortedDeck(deck) {
  return deck.slice().sort((a, b) => a.suit - b.suit || a.rank - b.rank);
}

export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function cardValue(cardOrRank) {
  if (typeof cardOrRank === 'object') {
    if (cardOrRank.enhancement === 'stone') return 0;
    return Math.min(cardOrRank.rank, 10);
  }
  return Math.min(cardOrRank, 10);
}

export function cardName(card) {
  return RANK_NAMES[card.rank] + SUITS[card.suit];
}

export function randomCardEnhancement() {
  if (Math.random() >= 0.4) return null;
  const pool = ['bonus', 'bonus', 'mult', 'mult', 'wild', 'wild', 'steel', 'gold', 'lucky', 'glass', 'stone'];
  return pool[Math.floor(Math.random() * pool.length)];
}
