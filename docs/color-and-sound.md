# Color & Sound — room mode

`/color-and-sound` is the solo painting toy. `/color-and-sound?host=1` opens a room on the big
screen; phones scan the QR (`/cs/CODE`, which redirects to `?join=CODE`) and paint on that screen.

It reuses the `Room` Durable Object relay in `src/worker.js` unchanged: one host socket
(`/ws/CODE?role=host`), any number of player sockets (`?role=player&name=&token=`). Players'
messages go to the host; the host's go to every player, or to one with `to`.

## Who does what

- **Phones are brushes.** They send raw pointer input and their brush settings. They do not
  hold the painting.
- **The host paints and plays.** Every stroke, from its own mouse or from a phone, runs through
  the same engine on the big screen, which is also the room's speaker. Phones have their own
  notes off by default (a Sound toggle turns them on).
- **The picture is the shared state.** The host sends back a JPEG of the sheet. There is no
  stroke log to keep in sync and nothing to replay: a phone that joins late, reloads, or
  reconnects gets the latest frame and is current.

## Messages

Phone → host (`id` is added by the relay):

| t   | fields | when |
|-----|--------|------|
| `d` | `s` stroke id, `b` brush (`wash`/`sable`), `z` size (`S`/`M`/`L`), `c` colour index or −1 for Mix, `r` real pressure, `p` first point | finger down |
| `s` | `s`, `p` array of points, `r` | every 50 ms while moving |
| `u` | `s` | finger up |

A point is `[u, v, pressure, ms]`: sheet position quantised to 1/10000, pressure 0–100, and
milliseconds since the stroke started, so the host can recover stroke speed from a batch.
Sub-pixel moves are dropped before sending. Roughly 15 messages a second and 15 bytes a point
per active painter, whatever the phone's frame rate.

Host → phones:

| t   | fields | when |
|-----|--------|------|
| `m` | `ar` sheet aspect ratio, `pal` palette, `sc` scale index, `cfg` tuning | on join, palette/scale/tuning change, host resize |
| `f` | `d` JPEG data URL, 640 px on the long side, quality 0.55 | on join (latest cached frame), then whenever the sheet changed, at most every 0.7 s + 30 ms per phone, capped at 2.5 s |

## Why an image rather than a stroke log

Every mark keeps blooming for seconds after the finger lifts, the rendering is randomised, and
brush sizes are relative to the screen, so two devices replaying the same strokes would never
produce the same picture anyway. Replay cost also grows with every stroke ever made, while a
frame is a fixed ~40–60 KB no matter how long the room has been painting. Undo, Clear and New
hues on the host need no protocol: the next frame simply shows the result.

Phones keep the frame off their sheet while their own stroke is in flight (and for 300 ms after
the lift), because the host's picture is a beat behind the finger and would wipe the stroke's
tail. Their local rendering of the stroke stands in until the next frame includes it.

## Host-side bookkeeping

- One painter record per hand (`painters`): brush, in-flight stroke, speed, last point, name.
  The engine's `down/move/up` take the painter, so any number of strokes can be in flight.
- A phone that disappears mid-stroke never sends `u`; strokes with no input for 3 s are lifted.
- Undo snapshots (full-canvas copies) are throttled to one per 300 ms, since a room full of
  painters starts strokes constantly.
- Names float over remote strokes on the big screen and fade 1.4 s after the lift.
