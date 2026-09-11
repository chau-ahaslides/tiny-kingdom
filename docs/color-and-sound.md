# Color & Sound — room mode

`/color-and-sound` is the solo painting toy. `/color-and-sound?host=1` opens a room on the big
screen; phones scan the QR, which opens `/j/CODE` and lands on `?join=CODE`.

The page runs on the aha-room SDK (`public/js/aha-room.js`, design note at `/sdk`). It never
touches a socket, a room code, a QR or localStorage: the SDK mints the room through the rooms
directory in the worker, draws the lobby card, keeps identity and reconnects, replicates the
document, and sends the sheet back as a picture.

## Who does what

- **Phones are brushes.** They send raw pointer input and their brush settings through the SDK's
  input helper. They do not hold the painting.
- **The host paints and plays.** Every stroke, from its own mouse or from a phone, runs through
  the same engine on the big screen, which is also the room's speaker. Phones have their own
  notes off by default (a Sound toggle turns them on).
- **The picture is the shared state.** The host's `room.frame(paint, …)` sends a WebP (JPEG
  fallback) of the sheet. There is no stroke log to keep in sync and nothing to replay: a phone
  that joins late, reloads, or reconnects gets the latest frame and is current.

## What the page sends

Phone → host, as ordinary game messages (`id` is stamped by the relay):

| t   | fields | when |
|-----|--------|------|
| `d` | `s` stroke id, `b` brush (`wash`/`sable`), `z` size (`S`/`M`/`L`), `c` colour index or −1 for Mix, `r` real pressure, `k` brush scale = 1/zoom, `p` first point ×10000 | finger down |
| `s` | `s`, `pts` array of `[u, v, pressure, ms]` ×`q`, `q` = 10000 | every 50 ms while moving (the input helper) |
| `u` | `s` | finger up |

Host → phones, through the SDK:

- the document: `{ ar, pal, sc, cfg }` (sheet aspect, palette, scale, tuning), plus the SDK's
  `_players` presence slice;
- frames: 1280 px on the long side, WebP quality 0.6, only when the sheet changed, every 0.7 s
  plus 30 ms per phone, capped at 2.5 s; `frames.now()` after Undo and Clear.

## The phone's view: a window onto the sheet

The phone's whole screen is painting area. The sheet keeps the big screen's shape and is sized so
that at 1× it covers the screen: a portrait phone sees a tall slice of the landscape sheet, centred
to start, never a letterboxed strip. Pinch to zoom (1× to 8×) and move two fingers to pan; the
screen never leaves the sheet. A `3.0×`-style button in the dock returns to 1×, centred.

The brush keeps its size on the screen, so zooming in paints finer: the stroke's `d` message
carries `k = 1/zoom` and the host multiplies its brush radius by it. A lone finger waits 120 ms
before it starts a stroke, in case a second finger is on its way; a second finger during a stroke
lifts it and starts the gesture. The big screen never zooms.

Because phones now look at a slice, the host sends its picture at 1280 px on the long side (WebP,
quality 0.6, about 25 KB) instead of 640 px; the phone's own stroke is rendered locally at the
sheet's full resolution either way.

## Why an image rather than a stroke log

Every mark keeps blooming for seconds after the finger lifts, the rendering is randomised, and
brush sizes are relative to the screen, so two devices replaying the same strokes would never
produce the same picture anyway. Replay cost also grows with every stroke ever made, while a
frame is about 8 KB (WebP) or 13 KB (JPEG) no matter how long the room has painted, measured on a
busy sheet. Undo, Clear and New hues on the host need no protocol: the next frame shows the result.

Phones keep the frame off their sheet while their own stroke is in flight (and for 300 ms after
the lift) via `me.frames({ hold })`, because the host's picture is a beat behind the finger and
would wipe the stroke's tail. Their local rendering of the stroke stands in until the next frame
includes it.

## Host-side bookkeeping

- One painter record per hand (`painters`): brush, in-flight stroke, speed, last point, name.
  The engine's `down/move/up` take the painter, so any number of strokes can be in flight.
- A phone that disappears mid-stroke never sends `u`; strokes with no input for 3 s are lifted.
- Undo snapshots (full-canvas copies) are throttled to one per 300 ms, since a room full of
  painters starts strokes constantly.
- Names float over remote strokes on the big screen and fade 1.4 s after the lift.
