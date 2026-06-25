# Work Done

## Multiplayer Lobby and Joining

- Added static/GitHub Pages lobby discovery for P2P tables.
- Added MQTT relay joining so open-table joins do not depend only on PeerJS/WebRTC.
- Kept the relay alive after the host starts a game so guests continue receiving game state.
- Bumped PWA/client cache versions as fixes shipped.

## Shop Changes

- Changed shop offers to:
  - 2 jokers on the top row.
  - 1 tarot plus 1 wildcard joker/tarot/playing-card offer on the second row.
  - 2 random booster packs on the bottom row.
- Redesigned shop items as card-style tiles.
- Removed buy buttons from shop tiles.
- Added two-click purchase behavior:
  - First click selects and shows the description.
  - Second click buys the item.
- Added direct playing-card shop purchases that permanently add the card to your deck.

## Cards and Interaction

- Enlarged hand cards.
- Added fanned hand layout.
- Added tap-once/tap-again pegging interaction.
- Added pointer-based card dragging for mouse/touch.
- Added drag-to-crib for discards.
- Added drag-to-peg-pile for pegging.
- Added pegging score previews with highlighted scoring cards and `+points` badges.
- Removed info buttons from regular playing cards.

## Jokers and Tarots

- Made owned joker/tarot tiles open descriptions when clicked.
- Removed info buttons from owned joker/tarot tiles.
- Added persistent joker drag reordering.
- Refreshed joker/tarot SVG icon styling with a richer shared illustrated backdrop.

## Match UI

- Added coin gain pop effects when coins increase.
- Simplified opponent displays to name-only plaques to reduce clutter.
- Kept central pile/table state visible for gameplay context.

## Verification

- Ran JavaScript syntax checks on changed files.
- Ran focused logic checks for shop offer layout, direct card buying, and joker reorder.
- Ran the full smoke test: `node test\smoke.js`.

## Recent Commits

- `0a88c4d` - Fix static lobby discovery
- `94494ba` - Add relay join path for static lobbies
- `abbb192` - Keep relay alive after game start
- `8bb164a` - Improve shop and card interactions
- `8f0f249` - Refine card drag and info UI
- `5e835fc` - Redesign shop cards and simplify opponents
