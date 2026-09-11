/* Gremlin Siege sound: every effect and the soundtrack are synthesized with ZzFX / ZzFXM, so there are no audio files.
   Needs /vendor/zzfx.js loaded first. Browsers only let audio start after a tap, so call SFX.unlock() from a click handler. */
const SFX = (() => {
  const state = { on: true, music: true, ready: false, gain: null, musicGain: null, musicSrc: null, musicBuf: null, last: {} };
  try { state.on = localStorage.getItem('tk-tr-sfx') !== '0'; state.music = localStorage.getItem('tk-tr-music') !== '0'; } catch (e) {}

  // ZzFX parameters: volume, randomness, frequency, attack, sustain, release, shape, shapeCurve, slide, deltaSlide,
  // pitchJump, pitchJumpTime, repeatTime, noise, modulation, bitCrush, delay, sustainVolume, decay, tremolo
  const SOUNDS = {
    arrow:  { p: [.5, .1, 900, , .01, .06, 4, 1.6, -22, , , , , , , , , .6, .02], gap: .08 },
    turret: { p: [.3, .15, 1400, , .01, .03, 4, 1.2, -30, , , , , , , , , .5, .01], gap: .06 },
    cannon: { p: [.9, .1, 140, .01, .06, .3, 4, 2, -6, , , , , 1, , , .05, .7, .05], gap: .12 },
    boom:   { p: [.8, .1, 90, .02, .1, .4, 4, 1.8, -3, , , , , 1.4, , , .08, .7, .08], gap: .1 },
    kill:   { p: [.6, .05, 1046, , .04, .14, , 1.8, , , 523, .06, , , , , , .5, .02], gap: .12 },
    bite:   { p: [1.1, , 80, .02, .12, .45, 2, 1.3, -4, , , , , .8, , , , .8, .1], gap: .25 },
    alarm:  { p: [.6, , 660, .01, .12, .1, 1, 1, , , -220, .1, .22, , , , , .7, .02], gap: .25 },
    place:  { p: [.8, , 200, .01, .06, .18, 1, 1.6, , , , , , .4, , , , .8, .04], gap: .1 },
    empty:  { p: [.7, , 320, .01, .03, .2, 3, 1, -12, , , , , .6, , , .04, .6, .05], gap: .2 },
    low:    { p: [.5, , 1500, , .02, .05, 1, 1, , , , , .1, , , , , .6, .01], gap: .3 },
    right:  { p: [.9, , 523, .01, .12, .25, , 1.6, , , 262, .07, , , , , , .7, .03], gap: .2 },
    wrong:  { p: [1, , 160, .01, .12, .25, 2, 1, -2, , , , , , .6, , , .8, .05], gap: .2 },
    answer: { p: [.35, .1, 700, , .03, .06, 1, 1.5, , , , , , , , , , .5, .01], gap: .08 },
    quiz:   { p: [.7, , 784, .01, .08, .2, , 1.5, , , 196, .06, , , , , , .6, .03], gap: .5 },
    tick:   { p: [.7, , 880, .01, .05, .08, 1, 1, , , , , , , , , , .7, .02], gap: .3 },
    go:     { p: [.9, , 1320, .01, .1, .2, 1, 1.2, , , , , , , , , , .8, .03], gap: .3 },
    wave:   { p: [.9, , 220, .05, .25, .3, 3, 1, , , , , , , , , .1, .8, .05], gap: .5 },
    clear:  { p: [.9, , 440, .01, .15, .3, , 1.5, , , 220, .1, , , , , , .7, .04], gap: .5 },
    win:    { p: [1, , 523, .02, .3, .5, , 1.6, , , 262, .12, , , , , .1, .8, .05], gap: 1 },
    lose:   { p: [1, , 300, .05, .3, .6, 2, 1, -6, , , , , .3, , , .1, .8, .1], gap: 1 },
    pause:  { p: [.6, , 600, .01, .04, .1, 1, 1, -4, , , , , , , , , .6, .02], gap: .2 },
  };

  function unlock() {
    try { if (zzfxX.state !== 'running') zzfxX.resume(); } catch (e) { return; }
    if (state.ready) return;
    state.ready = true;
    state.gain = zzfxX.createGain(); state.gain.gain.value = state.on ? 1 : 0; state.gain.connect(zzfxX.destination);
    state.musicGain = zzfxX.createGain(); state.musicGain.gain.value = 0; state.musicGain.connect(zzfxX.destination);
  }
  function play(name, opts) {
    if (!state.on || !state.ready) return;
    const def = SOUNDS[name]; if (!def) return;
    const now = performance.now() / 1000; if (now - (state.last[name] || 0) < def.gap) return; state.last[name] = now;
    const params = [...def.p]; if (opts && opts.pitch) params[2] = (params[2] || 220) * opts.pitch; if (opts && opts.vol) params[0] = (params[0] || 1) * opts.vol;
    try {
      const data = zzfxG(...params); const buf = zzfxX.createBuffer(1, data.length, zzfxR); buf.getChannelData(0).set(data);
      const src = zzfxX.createBufferSource(); src.buffer = buf; src.connect(state.gain); src.start();
    } catch (e) {}
  }
  function setOn(on) { state.on = on; try { localStorage.setItem('tk-tr-sfx', on ? '1' : '0'); } catch (e) {} if (state.gain) state.gain.gain.value = on ? 1 : 0; }
  function setMusic(on) { state.music = on; try { localStorage.setItem('tk-tr-music', on ? '1' : '0'); } catch (e) {} if (state.musicGain) state.musicGain.gain.setTargetAtTime(on && state.musicSrc ? 0.3 : 0, zzfxX.currentTime, 0.2); }

  // ------------------------------------------------------------ the soundtrack: a cheerful four-chord loop, written here, not sampled
  function song() {
    const inst = [
      [.7, 0, 110, , .12, .14, 1, 1.2, , , , , , , , , , .7, .04],          // 0 bass (triangle), note 12 = A2
      [.45, 0, 220, .01, .1, .12, 2, 1.4, , , , , , , , .08, , .6, .04],    // 1 lead (saw), note 12 = A3
      [.3, 0, 440, , .04, .1, 0, 1, , , , , , , , , , .5, .02],             // 2 pluck (sine), note 12 = A4
      [.9, 0, 150, , .02, .1, 0, 1.5, -30, , , , , , , , , .8, .03],        // 3 kick
      [.35, 0, 6000, , .01, .04, 4, 1.2, , , , , , 1.5, , , , .5, .01],     // 4 hat (noise)
      [.6, 0, 400, , .03, .12, 4, 1.4, -6, , , , , 1, , , , .6, .03],       // 5 snare (noise)
    ];
    // Chords C, G, Am, F. Bass in the 110 Hz scale, pluck in the 440 Hz scale, lead in the 220 Hz scale.
    const chords = [{ bass: [15, 27], arp: [15, 19, 22] }, { bass: [10, 22], arp: [17, 22, 26] }, { bass: [12, 24], arp: [12, 15, 19] }, { bass: [8, 20], arp: [15, 20, 24] }];
    const melodies = [
      [[19, 0, 22, 0, 27, 0, 22, 0, 19, 0, 17, 0, 15, 0, 0, 0], [17, 0, 22, 0, 26, 0, 29, 0, 26, 0, 22, 0, 17, 0, 0, 0], [24, 0, 27, 0, 31, 0, 27, 0, 24, 0, 22, 0, 19, 0, 0, 0], [20, 0, 24, 0, 27, 0, 24, 0, 22, 0, 20, 0, 19, 0, 17, 0]],
      [[27, 0, 0, 26, 27, 0, 22, 0, 19, 0, 22, 0, 27, 0, 0, 0], [29, 0, 0, 27, 26, 0, 22, 0, 17, 0, 22, 0, 26, 0, 0, 0], [31, 0, 0, 29, 27, 0, 24, 0, 19, 0, 24, 0, 27, 0, 0, 0], [20, 0, 24, 0, 27, 0, 29, 0, 31, 0, 29, 0, 27, 0, 26, 0]],
    ];
    const patterns = melodies.map(mel => {
      const bass = [0, 0], lead = [1, 0], arp = [2, .4], kick = [3, 0], hat = [4, -.4], snare = [5, .2];
      chords.forEach((c, bi) => {
        for (let i = 0; i < 16; i++) {
          bass.push(i % 4 === 0 ? c.bass[0] : i % 4 === 2 ? c.bass[1] : 0);
          lead.push(mel[bi][i]);
          arp.push(i % 2 === 0 ? c.arp[(i / 2) % 3] : 0);
          kick.push(i % 4 === 0 ? 12 : 0);
          hat.push(i % 2 === 1 ? 12 : 0);
          snare.push(i === 4 || i === 12 ? 12 : i === 15 && bi === 3 ? 12 : 0);
        }
      });
      return [bass, lead, arp, kick, hat, snare];
    });
    return [inst, patterns, [0, 0, 1, 0, 1, 1], 132];
  }
  function startMusic() {
    if (!state.ready || state.musicSrc) return;
    if (!state.musicBuf) {
      try { const [l, r] = zzfxM(...song()); const buf = zzfxX.createBuffer(2, l.length, zzfxR); buf.getChannelData(0).set(l); buf.getChannelData(1).set(r); state.musicBuf = buf; } catch (e) { return; }
    }
    const src = zzfxX.createBufferSource(); src.buffer = state.musicBuf; src.loop = true; src.connect(state.musicGain); src.start(); state.musicSrc = src;
    state.musicGain.gain.setTargetAtTime(state.music ? 0.3 : 0, zzfxX.currentTime, 0.5);
  }
  function stopMusic() { if (!state.musicSrc) return; const src = state.musicSrc; state.musicSrc = null; state.musicGain.gain.setTargetAtTime(0, zzfxX.currentTime, 0.4); setTimeout(() => { try { src.stop(); } catch (e) {} }, 1500); }
  return { unlock, play, setOn, setMusic, startMusic, stopMusic, get on() { return state.on; }, get music() { return state.music; } };
})();
