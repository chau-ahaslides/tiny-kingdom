# Gremlin Siege — integration notes

The tower-defence quiz game lives at `/tower-raid` (presenter: `/tower-raid?host`, phones: `/tr/CODE`).
It is split into plain scripts, loaded in this order by `public/tower-raid.html`:

| File | What it holds |
|---|---|
| `js/tr-config.js` | All settings with defaults, the override rules, the `GremlinSiege` API object and event fan-out |
| `js/tr-sim.js` | The rules only (no DOM): waves, quiz, guns, ammo, streaks, God Mode. Also runs in node for `npm test` |
| `vendor/zzfx.js`, `js/tr-audio.js` | Synthesized sound effects and the soundtrack (no audio files) |
| `js/tr-view.js` | The three.js board shared by the big screen and phones |
| `js/tr-game.js` | Host and phone controllers, the room link, the API methods |

## Changing settings

Every setting has a default in `TR_DEFAULTS` (top of `tr-config.js`). Override any subset, later wins:

1. **Embedding page** — before the game scripts:
   ```html
   <script>
     window.TR_CONFIG = {
       text: { title: 'Guard the Focus Keep', tower: 'Focus Keep', enemy: 'troll', enemies: 'trolls' },
       theme: { sky: '#1b2430', grass: '#2f6b4a', blue: '#7aa7ff', font: 'Nunito, sans-serif' },
       sound: { effects: true, music: false, volume: 0.8 },
       player: { name: 'Chau', onboarding: false },
       host: { partySize: 8, autoStart: true, joinBase: 'https://play.example.com' },
       rules: { quizTime: 20, placeTime: 6, towerHp: 12, godStreak: 5 },
       quiz: [['2 + 2?', ['3', '4', '5', '22'], 1], /* … */],
       onEvent: (name, data) => console.log(name, data),
     };
   </script>
   ```
2. **URL parameters** — `name`, `bots`, `sound=0`, `music=0`, `title`, `tower`, `enemy`, `theme=dark` or `theme={json}`, `rules={json}`.
3. **At runtime** — `GremlinSiege.configure({ … })` before hosting or joining.

Explicit settings from 1 or 2 beat toggles the user made earlier in that browser (sound and music are remembered per device otherwise).

## Driving the game

```js
GremlinSiege.host();                 // open a room on this screen (same as ?host)
GremlinSiege.join('AB12', 'Chau');   // join as a phone (same as /tr/AB12?name=Chau)
GremlinSiege.start();                // start the siege from the lobby
GremlinSiege.pause(true | false);    // or no argument to toggle
GremlinSiege.nextWave();             // skip the between-wave countdown
GremlinSiege.end();                  // end early, results shown
GremlinSiege.setPartySize(10);       // bots fill the empty seats
GremlinSiege.sound.effects(false); GremlinSiege.sound.music(false);
GremlinSiege.state();                // { code, phase, wave, tower, quizLeft, placeLeft, guns, players, paused }
```

## Listening

```js
GremlinSiege.on((name, data) => { /* … */ });
window.addEventListener('gremlinsiege', e => e.detail /* { name, data } */);
// in a parent frame:
window.addEventListener('message', e => { if (e.data && e.data.type === 'gremlinsiege') … });
```

Host events: `ready`, `room` (code, joinUrl), `join`, `leave`, `start`, `wave`, `answer` (id, name, option, result, streak), `placed`, `god`, `gunDown`, `bite`, `waveEnd` (board), `pause`, `over` (won, survived, board).
Phone events: `ready`, `joined`, `welcome`, `quiz`, `answered`, `placedOwn`, `over`.

## Pace of a wave

`quizTime` seconds to answer while the gremlins already march, then `placeTime` seconds to drag the gun into place (a gun not placed in time is lost), then `between` seconds to watch. Then the next wave starts on the clock, whatever is left of this one, so hordes overlap. After the last wave the road has to clear for the win. All three durations are rules and can be overridden.

## Balance

`npm test` runs the rules in node. The scratch script `tune4.mjs` (see the session notes) plays whole games with bots at a given accuracy; the target is that a half-right room holds about 2 to 3 waves.
