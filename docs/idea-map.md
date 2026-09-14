# Idea Map — room mode

`/idea-map` is the mind-map editor on its own (a 200-idea sample to play with). `/idea-map?host=1`
opens a room on the big screen; phones scan the QR, which opens `/j/CODE` and lands on `?join=CODE`.

The page runs on the aha-room SDK (`public/js/aha-room.js`, design note at `/sdk`). It never
touches a socket, a room code, a QR or a join URL.

## Who does what

- **The big screen owns the map.** It starts with one idea in the centre ("Our idea map"): select
  it and Rename it to the question. Everything the editor can do alone (add, rename, move, merge,
  delete, undo, explore mode, paging) still works on the big screen while the room is open.
- **Phones send intent.** A phone sees the same map (pan, pinch, tap to open branches), taps a
  branch to pick where its idea goes, types it, and sends. It can also like an idea. Phones never
  move, rename or delete anything; a drag on a phone pans.
- **The map is the shared state.** The host replicates the tree as a small document; what is
  open, paged or selected is each screen's own. A phone that joins late or reloads gets the
  current map in its welcome snapshot.

## What the page sends

Phone → host (`id` is stamped by the relay):

| t      | fields                                | meaning |
|--------|---------------------------------------|---------|
| `add`  | `to` parent id, `label` text (≤ 80)    | a new idea under that branch (an unknown `to` lands on the centre) |
| `like` | `n` node id                            | toggles this phone's like on that idea (not the centre) |

Host → one phone, in reply:

| t       | fields | meaning |
|---------|--------|---------|
| `added` | `id`   | the idea is on the map; the phone selects it and scrolls to it when the document arrives |
| `err`   | `why`  | refused (one idea per 0.6 s per phone; the map is full at 350 ideas); the text comes back into the box |

Host → phones, the document: `{ map }` where `map` is rows `[id, parentId, label, likes, mergedCount]`
in tree order, the centre first. About 30 bytes a row, so a 350-idea map stays near 10 KB, under the
SDK's 16 KB document limit. It is sent only when the rows changed.

## On the big screen

An idea from a phone opens the branch it landed in, pages to it, flares for a moment, and shows a toast
with the contributor's name; the view eases out so the whole map stays on screen. The selected idea's
bar shows who contributed it. Likes show as `♥ n` after the label.

A reloaded big screen reclaims its room code and its map (both kept in the tab's session storage), so
phones already in the room just reconnect. If another page took the code meanwhile, a fresh room is
minted.
