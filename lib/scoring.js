import { cardValue } from './cards.js?v=3';

// Scores a kept hand (any size) plus starter. Returns raw counts so joker
// modifiers can reprice each category before totalling.
// `starter` may be null (bot discard heuristics evaluate the kept 4 alone)
export function scoreBreakdown(hand, starter, isCrib, opts = {}) {
  const all = (starter ? hand.concat([starter]) : hand).filter(c => c.enhancement !== 'stone');
  const n = all.length;
  const target = opts.target || 15;

  let fifteens = 0;
  for (let m = 1; m < (1 << n); m++) {
    let sum = 0, bits = 0;
    for (let i = 0; i < n; i++) {
      if (m & (1 << i)) { sum += cardValue(all[i]); bits++; }
    }
    if (bits >= 2 && sum === target) fifteens++;
  }

  let pairs = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (all[i].rank === all[j].rank) pairs++;
    }
  }

  const counts = new Array(14).fill(0);
  for (const c of all) counts[c.rank]++;
  let runPoints = 0, runCount = 0;
  let r = 1;
  while (r <= 13) {
    if (!counts[r]) { r++; continue; }
    let len = 0, mult = 1, last = r;
    while (r <= 13) {
      if (counts[r]) { len++; mult *= counts[r]; last = r; r++; }
      // Shortcut joker: a run may hop over a single missing rank (3·5·7)
      else if (opts.shortcut && r + 1 <= 13 && counts[r + 1] && r - last === 1) { r++; }
      else break;
    }
    if (len >= 3) { runPoints += len * mult; runCount += mult; }
  }

  let flush = 0;
  const suitedHand = hand.filter(c => c.enhancement !== 'stone');
  for (let suit = 0; suit < 4; suit++) {
    if (suitedHand.length < 4 || !suitedHand.every(c => c.suit === suit || c.enhancement === 'wild')) continue;
    const starterMatches = starter && starter.enhancement !== 'stone' && (starter.suit === suit || starter.enhancement === 'wild');
    if (isCrib) {
      if (starterMatches) flush = Math.max(flush, suitedHand.length + 1);
    } else {
      flush = Math.max(flush, suitedHand.length + (starterMatches ? 1 : 0));
    }
  }

  let nobs = 0;
  if (starter) {
    for (const c of hand) {
      if (c.enhancement !== 'stone' && c.rank === 11 && (c.suit === starter.suit || c.enhancement === 'wild')) nobs++;
    }
  }

  return { fifteens, pairs, runPoints, runCount, flush, nobs };
}

// Pegging: events triggered by the newest card on the stack at the given count.
export function pegEvents(stack, count, opts = {}) {
  const events = [];
  const target = opts.target || 15;
  const top = stack[stack.length - 1];
  if (!top || top.enhancement === 'stone') return events;
  if (count === target) events.push({ type: 'fifteen', pts: 2, target });

  let k = 1;
  for (let i = stack.length - 2; i >= 0; i--) {
    if (stack[i].enhancement !== 'stone' && stack[i].rank === top.rank) k++; else break;
  }
  if (k >= 2) events.push({ type: 'pair', pts: k * (k - 1), size: k });

  for (let len = stack.length; len >= 3; len--) {
    const cards = stack.slice(stack.length - len);
    if (cards.some(c => c.enhancement === 'stone')) continue;
    const tail = cards.map(c => c.rank);
    const uniq = new Set(tail);
    if (uniq.size !== len) continue;
    if (Math.max(...tail) - Math.min(...tail) === len - 1) {
      events.push({ type: 'run', pts: len, size: len });
      break;
    }
  }

  if (count === 31) events.push({ type: 'thirtyone', pts: 2 });
  return events;
}
