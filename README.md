# Crib

Online multiplayer cribbage (2–6 players) with Balatro-style jokers, tarot
cards, and escalating blinds. Vanilla JS, no build step. Playable two ways:

- **Node server** (`npm start`) — lobby with open-table listing over WebSockets.
- **GitHub Pages / any static host** — fully peer-to-peer (WebRTC via PeerJS):
  one player hosts and shares a 5-letter code, the game engine runs in the
  host's browser tab. Live at https://orbgamestudios.github.io/Crib/

Installable as a PWA on iPhone/Android (Add to Home Screen).

## Run locally

```
npm install
npm start          # http://localhost:3000
```

`npm test` runs a headless smoke test: bots play full matches (2/3/5 players)
to game over through the real server.

## Solo mode

**Play Solo vs The House** from the lobby: a bot opponent that discards on
hand-evaluation heuristics and pegs greedily. The House is exempt from blind
checks — your run lasts exactly as long as you keep beating the blinds, and
the end screen tells you how far you got. On the static/PWA build solo runs
entirely in your browser, no connection needed.

## How a match works

- Play happens in **rounds**. Each round the deal goes around the table —
  every active player deals (and gets the crib) **once with 3+ players,
  twice with 2 players** (4 deals).
- Each deal: discard to the crib, cut the starter, peg to 31, then hands are
  counted **one at a time** — left of the dealer first, dealer last, then the
  crib — with the full breakdown (and joker effects) shown to everyone.
- At the end of the round comes the **blind check**: anyone whose points for
  that round are below the blind is **eliminated** and spectates. If nobody
  beats the blind, the top scorer survives. Last player standing wins.
- **Blinds scale** with player count and deals per round, and grow
  **exponentially** by round: ~50% of an average round's score in round 1,
  ~90% by round 3, ~2× by round 6, ~4.5× by round 9. Build a joker engine or
  die.

### Deal sizes

2 players — 6 cards, discard 2; 3 — 5 cards, discard 1 plus a deck card to
the crib; 4 — 5 cards, discard 1; 5–6 — 5 cards, discard 1 (oversized crib).

## Your deck is yours

Every player owns a personal deck (starts as a standard 52) and is dealt
from it each deal — and the deck **remembers**. Tarot edits to cards are
permanent, packs and tarots can add cards, The Hanged Man destroys them.
The **Deck** button shows your full deck, grouped by suit, any time.

## Jokers, tarots & booster packs

- After each deal everyone earns **coins** (3 + 1 per 5 points that deal) and
  a personal **shop** opens: 2 jokers + 1 tarot + 2 shiny **booster packs**,
  reroll for 2. Your jokers and tarots sit as card tiles next to your hand.
- **Jokers** (max 5, ~34 designs, each with its own hand-drawn icon) are
  passive and warp scoring: repricers (Fifteen Fanatic, Pair Pal, Golden
  Crib), per-card bonuses Balatro-style (Even Steven, Odd Todd, Fibonacci,
  Walkie Talkie, Scary Face, the four suit jokers), cribbage-native oddities
  (The Nineteen — a zero hand scores 19; Muggins — feed on opponents' weak
  hands; Skunk Line, His Majesty, Shortcut — runs that hop a gap), pegging
  tech (Counter King, Pony Express, Small Ball, 31 Salute), economy (Rocket,
  Cutpurse, Mug's Coin, Bull Market) and Blueprint, which copies its
  right-hand neighbour.
- **Tarots** (max 3, 16 designs) are one-shot consumables used **before you
  discard**: rank up/down (Sun, Moon, Strength), transforms (Death, Justice,
  Star), suit painting (Lovers, Empress/Emperor/Devil/Tower), deck surgery
  (High Priestess adds a copy, Hanged Man destroys 2), Judgement (random
  joker), Wheel of Fortune (redraw), The Hermit (coins).
- **Booster packs** (animated holo sheen): Buffoon (pick 1 of 3 jokers),
  Arcana (1 of 3 tarots), Standard (1 of 3 playing cards added permanently
  to your deck). Opening is a pick-or-skip choice.

## Table rules of the UI

- You sit at the bottom; opponents arc around the table and you only ever see
  the backs of their cards (played pegging cards are face up).
- Your jokers and tarots live on your screen; opponents' joker lists are
  public on hover/tap, like Balatro's joker row.
- Cards lift and wobble on hover (or tap-select on phones); deals are
  shuffled and flown out of the deck, discards glide face-down into the crib,
  played cards fly to the count pile, finished counts sweep off the table,
  and every score pops off the seat that earned it.
- The felt background is a slowly drifting suit lattice; when it's your
  move it warms in colour and flows faster.
- State is re-broadcast every 2.5s (lobby and game), and the ⟳ button in the
  top bar forces a refresh; "Update app" in the lobby clears the PWA cache.
- Disconnected players are auto-played after a grace period and can rejoin
  with the same name to reclaim their seat. In P2P mode the game lives in the
  host's tab — if the host leaves, the table closes.

## Layout

```
server.js        Node entry: HTTP static + WebSocket rooms/lobby
index.html       app shell (PWA meta, manifest, PeerJS CDN)
client.js        UI, rendering, animations, dual transport (ws / p2p)
icons.js         hand-drawn SVG icons for every joker and tarot
net/host.js      in-browser authoritative host for P2P (GitHub Pages) mode
lib/cards.js     deck + card helpers (shared Node/browser ES modules)
lib/scoring.js   hand scoring breakdown + pegging events
lib/jokers.js    joker/tarot definitions, modifier aggregation, shop offers
lib/game.js      game state machine: deals, rounds, blinds, elimination
sw.js            service worker (offline app shell for the PWA)
manifest.webmanifest, icons/   PWA assets
test/smoke.js    headless bot matches over real websockets
```

## GitHub Pages notes

Pages serves this repo's root statically. There is no server, so there is no
global room list — tables are joined by the host's 5-letter code. The host's
browser is authoritative; everyone else connects to it over WebRTC (PeerJS's
free public broker handles signalling). The exact same client served by
`server.js` auto-detects which transport to use.
