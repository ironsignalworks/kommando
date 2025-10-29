(() => {
  'use strict';

  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  const GMap = globalThis.Map;
  const GSet = globalThis.Set;

  // ---------- Fallback (no WebAudio) ----------
  const fallback = {
    supported: !!AudioCtor,
    ctx: null,

    resume() { return Promise.resolve(false); },
    play() {},
    startLoop() {},
    stopLoop() {},
    playIntro() {},
    playDeployment() {},
    playSanityLow() {},

    _ensureStores(){
      if (!this.loops) this.loops = new Map();
      if (!this.pendingLoops) this.pendingLoops = new Map();
      if (!this.oneShots) this.oneShots = new Set();
      if (!this.loopIntents) this.loopIntents = Object.create(null);
    },

    hardStopAll(opts = {}) {
      this._ensureStores();
      const fade = opts.fade ?? (opts.immediate ? 0 : 0.12);
      const ctx = this.ctx;

      try {
        for (const [, handle] of this.loops) {
          try {
            if (fade > 0 && ctx && handle?.gain && handle?.source) {
              handle.gain.gain.cancelScheduledValues(ctx.currentTime);
              handle.gain.gain.setValueAtTime(handle.gain.gain.value, ctx.currentTime);
              handle.gain.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + fade);
              handle.source.stop(ctx.currentTime + fade + 0.02);
            } else if (handle?.source) {
              handle.source.stop();
            }
          } catch(e){}
        }
      } finally {
        this.loops.clear();
        try { this.pendingLoops.clear(); } catch(e){}
        this.loopIntents = Object.create(null);
      }

      try {
        for (const s of Array.from(this.oneShots || [])) {
          try { s.stop(0); } catch(e){}
          this.oneShots.delete(s);
        }
      } catch(e){}
    },

    playGameOver() {},
    playVictory() {},
    startBackground() {},
    stopBackground() {},
    configureFiles() {},
    armAutoBackground() {},

    // SFX no-ops
    playPickup() {},
    playHeal() {},
    playMine() {},
    playSanityTick() {},
    playLevelUp() {}
  };

  // ---------- File map (can be overridden before load via window.KomAudioFiles) ----------
  const DEFAULT_FILE_MAP = {
    intro: 'audio/intro.mp3',
    deployment: 'audio/deployment.mp3',
    background: 'audio/background_loop.mp3',
    sanity: 'audio/sanity_low.mp3',
    gameover: 'audio/gameover.mp3',
    victory: 'audio/victory.mp3',
    // SFX (optional overrides; otherwise procedural)
    pickup:      'audio/sfx/pickup.mp3',
    heal:        'audio/sfx/heal.mp3',
    mine:        'audio/sfx/mine.mp3',
    sanity_tick: 'audio/sfx/sanity-tick.mp3',
    levelup:     'audio/sfx/levelup.mp3'
  };

  const fetchAudio = (typeof fetch === 'function') ? fetch : null;

  if (!AudioCtor) {
    window.KomAudio = fallback;
    return;
  }

  // ---------- DSP helpers ----------
  function clamp(v, min, max) { return v < min ? min : v > max ? max : v; }
  function pseudoRandom(i, seed) {
    const x = Math.sin((i + seed * 13.37) * 12.9898) * 43758.5453;
    return x - Math.floor(x);
  }
  function edgeFade(data, sampleRate, seconds) {
    if (!seconds) return;
    const fadeSamples = Math.min(Math.floor(seconds * sampleRate), Math.floor(data.length / 2));
    for (let i = 0; i < fadeSamples; i++) {
      const factor = i / fadeSamples;
      data[i] *= factor;
      data[data.length - 1 - i] *= factor;
    }
  }
  function normalize(data, target) {
    if (!target) return;
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      const abs = Math.abs(data[i]);
      if (abs > peak) peak = abs;
    }
    if (peak <= 0) return;
    const gain = target / peak;
    for (let i = 0; i < data.length; i++) data[i] *= gain;
  }
  function saturate(data, drive) {
    if (!drive) return;
    const k = drive;
    for (let i = 0; i < data.length; i++) data[i] = Math.tanh(data[i] * k);
  }
  function finalizeChannel(data, sampleRate, spec) {
    if (!spec) return;
    edgeFade(data, sampleRate, spec.edgeFade ?? 0.02);
    if (spec.saturate) saturate(data, spec.saturate);
    normalize(data, spec.target ?? 0.85);
  }
  function addBlip(data, sampleRate, opts) {
    const startIndex = Math.max(0, Math.floor(opts.start * sampleRate));
    const endIndex = Math.min(data.length, Math.floor((opts.start + opts.dur) * sampleRate));
    if (endIndex <= startIndex) return;
    let phase = opts.phase || 0;
    const amp = opts.amp ?? 0.5;
    const envPower = opts.envPower ?? 1.4;
    for (let i = startIndex; i < endIndex; i++) {
      const ratio = (i - startIndex) / (endIndex - startIndex);
      const freq = typeof opts.freq === 'function' ? opts.freq(ratio) : opts.freq;
      phase += (2 * Math.PI * freq) / sampleRate;
      let wave = Math.sin(phase + (opts.phaseOffset || 0));
      if (opts.harmonics) {
        let mult = 2;
        for (const level of opts.harmonics) {
          wave += Math.sin(phase * mult) * level;
          mult++;
        }
      }
      const env = Math.pow(Math.sin(Math.PI * clamp(ratio, 0, 1)), envPower);
      data[i] += wave * amp * env;
    }
  }

  // ---------- Procedural builders ----------
  function buildIntro(d, sr, ch) {
    const len = d.length;
    let phaseMain = 0, phaseSub = 0, phaseShimmer = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const sweepFreq = 110 + 80 * Math.pow(t, 1.1);
      phaseMain += (2 * Math.PI * sweepFreq) / sr;
      const subFreq = 45 + 14 * Math.sin(t * 2 * Math.PI * 0.25 + ch * 0.2);
      phaseSub += (2 * Math.PI * subFreq) / sr;
      const shimmerFreq = 420 + 60 * Math.sin(t * 2 * Math.PI * 0.6);
      phaseShimmer += (2 * Math.PI * shimmerFreq) / sr;

      const envUp = Math.min(1, t / 0.35);
      const envDown = Math.pow(Math.max(0, 1 - t / 2.6), 1.4);
      const env = envUp * envDown;

      let sample = 0.58 * Math.sin(phaseMain);
      sample += 0.3 * Math.sin(phaseSub);
      sample += 0.18 * Math.sin(phaseShimmer + ch * 0.3) * (0.7 + 0.3 * Math.sin(t * 2 * Math.PI * 0.5));
      sample += 0.1 * Math.sin(phaseMain * 2) * envUp;
      d[i] = sample * env;
    }
  }

  function buildDeployment(d, sr, ch) {
    const hits = [0.0, 0.35, 0.7, 1.15];
    hits.forEach((start, idx) => {
      const base = 170 + idx * 24;
      addBlip(d, sr, {
        start, dur: 0.22,
        freq: (r) => base * (1 + 0.18 * (1 - r)) * (ch ? 0.98 : 1.02),
        amp: 0.58, envPower: 1.15, harmonics: [0.35],
      });
      addBlip(d, sr, { start: start + 0.08, dur: 0.28, freq: base / 2, amp: 0.26, envPower: 1.2 });
    });

    let noisePhase = 0;
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      noisePhase += (2 * Math.PI * 0.5) / sr;
      const pulse = (Math.sin(noisePhase) + 1) * 0.5;
      const grit = (pseudoRandom(i, 3 + ch * 11) - 0.5) * 0.22 * pulse;
      d[i] += grit;
      const bed = 0.08 * Math.sin(2 * Math.PI * 52 * t) * (0.4 + 0.6 * pulse);
      d[i] += bed;
    }
  }

  function buildBackground(d, sr, ch) {
    const len = d.length;
    let phaseLow = 0, phaseMid = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const drift = 1 + 0.03 * Math.sin(t * 2 * Math.PI * 0.08 + ch * 0.17);
      const base = 55 * drift * (ch ? 0.997 : 1.003);
      phaseLow += (2 * Math.PI * base) / sr;
      const midFreq = base * 2.02 + 12 * Math.sin(t * 2 * Math.PI * 0.18);
      phaseMid += (2 * Math.PI * midFreq) / sr;
      const low = 0.5 * Math.sin(phaseLow);
      const mid = 0.3 * Math.sin(phaseMid);
      const noise = (pseudoRandom(i, ch * 21) - 0.5) * 0.2;
      const pulse = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI * 0.5);
      d[i] = low + mid + noise * (0.4 + 0.6 * pulse);
    }
  }

  function buildSanity(d, sr, ch) {
    const pulses = [0.0, 0.58, 1.16];
    pulses.forEach((start, idx) => {
      const base = 420 - idx * 30;
      addBlip(d, sr, {
        start, dur: 0.28, freq: (r) => base * (1 - 0.22 * r),
        amp: 0.62, envPower: 1.35, phaseOffset: ch * 0.2, harmonics: [0.2],
      });
      addBlip(d, sr, { start: start + 0.12, dur: 0.36, freq: 90, amp: 0.24, envPower: 1.1 });
    });

    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      const trem = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI * 6);
      const grit = (pseudoRandom(i, 7 + ch * 19) - 0.5) * 0.16 * trem;
      d[i] += grit;
    }
  }

  function buildGameOver(d, sr, ch) {
    let phase = 0;
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      const sweep = 160 - 120 * (t / 3.3);
      const freq = clamp(sweep, 32, 220);
      phase += (2 * Math.PI * freq) / sr;
      const env = Math.pow(Math.max(0, 1 - t / 3.3), 1.3);
      let sample = 0.6 * Math.sin(phase);
      sample += 0.25 * Math.sin(phase * 0.5 + ch * 0.4);
      const rumble = (pseudoRandom(i, 31 + ch * 9) - 0.5) * 0.35 * env;
      d[i] = sample * env + rumble;
    }
  }

  function buildVictory(d, sr, ch) {
    const tones = [
      { start: 0.0, dur: 0.45, freq: 196, amp: 0.42 },
      { start: 0.22, dur: 0.55, freq: 247, amp: 0.4 },
      { start: 0.45, dur: 0.7,  freq: 294, amp: 0.46 },
      { start: 0.9,  dur: 0.9,  freq: 392, amp: 0.48 },
      { start: 1.4,  dur: 1.1,  freq: 523, amp: 0.42 },
    ];
    tones.forEach((tone, idx) => {
      addBlip(d, sr, {
        start: tone.start, dur: tone.dur,
        freq: (r) => tone.freq * (1 + 0.015 * Math.sin(r * Math.PI * 6 + ch * 0.5)),
        amp: tone.amp, envPower: 1.05,
        harmonics: idx % 2 === 0 ? [0.18, 0.06] : [0.12],
        phaseOffset: ch * 0.15,
      });
    });

    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      const shimmer = Math.sin(2 * Math.PI * (680 + ch * 12) * t);
      const env = Math.pow(Math.max(0, 1 - t / 3.2), 1.6);
      const spark = (pseudoRandom(i, 101 + ch * 3) - 0.5) * 0.18 * env;
      d[i] += shimmer * env * 0.08 + spark;
    }
  }

  // ---- Lightweight SFX builders (these were missing before) ----
  function buildPickup(d, sr, ch){
    const tones = [
      { start:0.00, dur:0.10, f0:660, f1:880, amp:0.5 },
      { start:0.11, dur:0.10, f0:990, f1:1320, amp:0.45 },
    ];
    tones.forEach(t=>{
      addBlip(d, sr, {
        start:t.start, dur:t.dur, amp:t.amp,
        freq:(r)=> t.f0 + (t.f1 - t.f0) * r,
        envPower:1.2, harmonics:[0.15]
      });
    });
  }

  function buildHeal(d, sr, ch){
    const tones=[
      { start:0.00, dur:0.14, f0:420, f1:560, amp:0.42 },
      { start:0.10, dur:0.18, f0:560, f1:700, amp:0.38 },
    ];
    tones.forEach(t=>{
      addBlip(d, sr, {
        start:t.start, dur:t.dur, amp:t.amp,
        freq:(r)=> t.f0 + (t.f1 - t.f0) * r,
        envPower:1.3, harmonics:[0.1]
      });
    });
  }

  function buildMine(d, sr, ch){
    addBlip(d, sr, { start:0.00, dur:0.35, freq:(r)=> 200*(1-r)+60, amp:0.7, envPower:1.2, harmonics:[0.25,0.12] });
    for(let i=0;i<d.length;i++){
      const t = i / sr;
      const env = Math.pow(Math.max(0, 1 - t/0.45), 1.1);
      const noise = (pseudoRandom(i, 77 + ch*3)-0.5) * 0.9 * env;
      d[i] += noise;
    }
  }

  function buildSanityTick(d, sr, ch){
    addBlip(d, sr, { start:0.00, dur:0.06, freq:880, amp:0.35, envPower:1.6, harmonics:[0.1] });
    addBlip(d, sr, { start:0.05, dur:0.05, freq:660, amp:0.28, envPower:1.5 });
  }

  // NEW: LevelUp / Door-cross SFX
  function buildLevelUp(d, sr, ch) {
    addBlip(d, sr, { start: 0.00, dur: 0.18, freq: (r) => 220 + 880 * r, amp: 0.5, envPower: 1.3, harmonics: [0.18, 0.08] });
    addBlip(d, sr, { start: 0.04, dur: 0.08, freq: 150, amp: 0.35, envPower: 1.8 });
    addBlip(d, sr, { start: 0.12, dur: 0.20, freq: (r) => 880 + 220 * Math.sin(r * Math.PI), amp: 0.38, envPower: 1.2, harmonics: [0.15] });
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      const env = Math.pow(Math.max(0, 1 - t / 0.35), 1.5);
      const spark = (pseudoRandom(i, 333 + ch) - 0.5) * 0.08 * env;
      d[i] += spark;
    }
  }

  // ---------- Spec map ----------
  const SOUND_SPECS = {
    intro:       { duration: 2.7, edgeFade: 0.03, target: 0.82, builder: buildIntro },
    deployment:  { duration: 2.0, edgeFade: 0.02, target: 0.86, builder: buildDeployment },
    background:  { duration: 8.0, edgeFade: 0.05, target: 0.52, loop: true, builder: buildBackground },
    sanity:      { duration: 1.8, edgeFade: 0.025, target: 0.88, builder: buildSanity },
    gameover:    { duration: 3.4, edgeFade: 0.04, target: 0.85, builder: buildGameOver },
    victory:     { duration: 3.2, edgeFade: 0.03, target: 0.90, builder: buildVictory },
    pickup:      { duration: 0.28, edgeFade: 0.01, target: 0.90, builder: buildPickup },
    heal:        { duration: 0.30, edgeFade: 0.01, target: 0.90, builder: buildHeal },
    mine:        { duration: 0.50, edgeFade: 0.02, target: 0.90, builder: buildMine },
    sanity_tick: { duration: 0.12, edgeFade: 0.01, target: 0.90, builder: buildSanityTick },
    levelup:     { duration: 0.40, edgeFade: 0.02, target: 0.90, builder: buildLevelUp }
  };

  // ---------- Audio Manager ----------
  class AudioManager {
    constructor() {
      this.ctx = null;
      this.master = null;
      this.ready = false;
      this.pending = [];
      this.buffers = new GMap();
      this.fileBuffers = new GMap();
      this.loops = new GMap();
      this.loopIntents = Object.create(null);
      this.oneShots = new Set();           // {source, gain}
      this.pendingLoops = new GSet();
      this.bufferPromises = new GMap();
      this.masterVolume = 0.38;
      this.lastSanityAt = 0;
      this.sanityCooldown = 2.2;
      this.files = { ...DEFAULT_FILE_MAP };
      this.loopSeed = 0;
      this.userActivated = false;
      this._autoBgOpts = null;             // optional arming for first-gesture bg

      this._applyFileOverrides(window.KomAudioFiles);
      this._bindUnlock();
    }

    _ensureStores() {
      if (!(this.buffers instanceof GMap)) this.buffers = new GMap();
      if (!(this.fileBuffers instanceof GMap)) this.fileBuffers = new GMap();
      if (!(this.loops instanceof GMap)) this.loops = new GMap();
      if (!(this.pendingLoops instanceof GSet)) this.pendingLoops = new GSet();
      if (!(this.bufferPromises instanceof GMap)) this.bufferPromises = new GMap();
      if (!this.loopIntents || typeof this.loopIntents !== 'object') this.loopIntents = Object.create(null);
      if (!(this.oneShots instanceof Set)) this.oneShots = new Set();
    }

    _applyFileOverrides(map) {
      if (!map || typeof map !== 'object') return;
      for (const [key, value] of Object.entries(map)) {
        if (!SOUND_SPECS[key]) continue;
        if (typeof value === 'string' && value.trim()) {
          this.files[key] = value.trim();
        } else if (value === null || value === false) {
          delete this.files[key];
        }
      }
    }

    configureFiles(map) {
      this._ensureStores();
      this.files = { ...DEFAULT_FILE_MAP };
      this._applyFileOverrides(map);
      this.fileBuffers.clear();
      this.bufferPromises.clear();
    }

    _bindUnlock() {
      const unlock = () => {
        if (this.userActivated) return;
        this.userActivated = true;
        this.resume(true);
        // If armed, start bg immediately on first gesture
        if (this._autoBgOpts) {
          this.startBackground(this._autoBgOpts);
          this._autoBgOpts = null;
        }
      };
      if (!this.ready) {
        console.info('KomAudio: waiting for first user interaction to enable audio playback.');
      }
      const opts = { once: true, passive: true };
      window.addEventListener('pointerdown', unlock, opts);
      window.addEventListener('mousedown', unlock, opts);
      window.addEventListener('touchstart', unlock, opts);
      window.addEventListener('keydown', unlock, { once: true });
      document.addEventListener('pointerdown', unlock, opts);
      document.addEventListener('mousedown', unlock, opts);
      document.addEventListener('touchstart', unlock, opts);
    }

    ensureContext(force = false) {
      this._ensureStores();
      if (!this.ctx) {
        if (!force) return null;
        this.ctx = new AudioCtor();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.masterVolume;
        this.master.connect(this.ctx.destination);
        this.ctx.onstatechange = () => {
          if (this.ctx.state === 'running') {
            this.ready = true;
            this._flushPending();
          }
        };
      }
      return this.ctx;
    }

    resume(force = false) {
      this._ensureStores();
      if (force) this.userActivated = true;
      const ctx = this.ensureContext(force || this.userActivated);
      if (!ctx) return Promise.resolve(false);
      const tryResume = ctx.state === 'suspended';
      const onSuccess = () => {
        this.ready = ctx.state === 'running';
        if (this.ready) this._flushPending();
        return this.ready;
      };
      if (tryResume) {
        return ctx.resume().then(onSuccess).catch(() => false);
      }
      return Promise.resolve(onSuccess());
    }

    _flushPending() {
      const queue = this.pending.splice(0);
      queue.forEach((fn) => fn());
    }

    whenReady(fn) {
      this._ensureStores();
      const ctx = this.ensureContext();
      if (ctx && this.ready && ctx.state === 'running') {
        fn();
      } else {
        this.pending.push(fn);
      }
    }

    generateBuffer(name) {
      this._ensureStores();
      if (this.buffers.has(name)) return this.buffers.get(name);
      const spec = SOUND_SPECS[name];
      if (!spec) return null;
      const ctx = this.ensureContext();
      if (!ctx) return null;
      const frameCount = Math.max(1, Math.floor(spec.duration * ctx.sampleRate));
      const buffer = ctx.createBuffer(2, frameCount, ctx.sampleRate);
      for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        const channelData = buffer.getChannelData(ch);
        spec.builder(channelData, ctx.sampleRate, ch, buffer.numberOfChannels);
        finalizeChannel(channelData, ctx.sampleRate, spec);
      }
      this.buffers.set(name, buffer);
      return buffer;
    }

    obtainBuffer(name) {
      this._ensureStores();
      if (!this.fileBuffers || typeof this.fileBuffers.has !== 'function') {
        this.fileBuffers = new GMap();
      }

      const filePath = this.files[name];
      if (filePath) {
        const key = filePath;
        if (this.fileBuffers.has(key)) {
          return Promise.resolve(this.fileBuffers.get(key));
        }
        if (this.bufferPromises.has(key)) {
          return this.bufferPromises.get(key);
        }
        if (!fetchAudio) {
          console.warn(`KomAudio: fetch API unavailable, skipping file load for '${name}'`);
          delete this.files[name];
          return Promise.resolve(this.generateBuffer(name));
        }
        const ctx = this.ensureContext();
        if (!ctx) return Promise.resolve(null);
        const loading = fetchAudio(filePath)
          .then((res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.arrayBuffer();
          })
          .then((data) => ctx.decodeAudioData(data))
          .then((buffer) => {
            this.fileBuffers.set(key, buffer);
            this.bufferPromises.delete(key);
            return buffer;
          })
          .catch((err) => {
            console.warn(`KomAudio: falling back to procedural audio for '${name}'`, err);
            this.bufferPromises.delete(key);
            this.fileBuffers.delete(key);
            delete this.files[name];
            return this.generateBuffer(name);
          });
        this.bufferPromises.set(key, loading);
        return loading;
      }
      return Promise.resolve(this.generateBuffer(name));
    }

    play(name, opts = {}) {
      this._ensureStores();
      const payload = { ...opts };
      this.whenReady(() => this._playNow(name, payload));
      if (this.userActivated) {
        this.resume();
      }
    }

    _playNow(name, opts) {
      this._ensureStores();
      let pending;
      try {
        pending = this.obtainBuffer(name);
      } catch (err) {
        console.error(`KomAudio: failed to queue '${name}'`, err);
        return;
      }
      if (!pending || typeof pending.then !== 'function') {
        pending = Promise.resolve(pending);
      }
      pending.then((buffer) => {
        if (!buffer) return;
        const ctx = this.ensureContext();
        if (!ctx) return;
        const spec = SOUND_SPECS[name] || {};
        const source = ctx.createBufferSource();
        source.buffer = buffer;

        const wantsLoop = opts.loop ?? spec.loop ?? false;
        source.loop = wantsLoop || false;
        if (opts.loop && spec?.loop === false) source.loop = true;

        const gainNode = ctx.createGain();
        const level = opts.gain ?? spec.gain ?? 1;
        gainNode.gain.value = level;
        source.connect(gainNode).connect(this.master);

        if (opts.fadeIn) {
          gainNode.gain.setValueAtTime(0, ctx.currentTime);
          gainNode.gain.linearRampToValueAtTime(level, ctx.currentTime + opts.fadeIn);
        }

        const startAt = (typeof opts.startAt === 'number') ? opts.startAt : 0;

        if (source.loop) {
          // ---- LOOP PATH
          const intent = opts._intent ?? null;
          const storedIntent = this.loopIntents ? this.loopIntents[name] : undefined;

          if (intent && storedIntent !== intent) {
            source.disconnect();
            return;
          }
          if (this.loops.has(name)) {
            source.disconnect();
            return;
          }

          source.start(startAt, opts.offset ?? 0);
          this.loops.set(name, { source, gain: gainNode });

          if (intent) {
            this.pendingLoops.delete(name);
            if (this.loopIntents) this.loopIntents[name] = intent;
          }
        } else {
          // ---- ONE-SHOT PATH
          const handle = { source, gain: gainNode };
          const release = opts.fadeOut ?? 0;

          if (release > 0) {
            const end = (startAt || ctx.currentTime) + buffer.duration;
            gainNode.gain.setValueAtTime(level, Math.max(startAt || ctx.currentTime, end - release));
            gainNode.gain.linearRampToValueAtTime(0.0001, end);
          }

          try {
            this.oneShots.add(handle);
            if (startAt > 0) source.start(startAt);
            else source.start();
          } catch (startErr) {
            console.warn(`KomAudio: failed to start '${name}'`, startErr);
            gainNode.disconnect();
            return;
          }

          source.onended = () => {
            try { this.oneShots.delete(handle); } catch(e){}
            gainNode.disconnect();
          };
        }
      }).catch((err) => {
        console.error(`KomAudio: failed to play '${name}'`, err);
      });
    }

    stopOneShots(opts = {}) {
      const fade = opts.fade ?? (opts.immediate ? 0 : 0.25);
      const ctx = this.ctx;
      for (const handle of Array.from(this.oneShots)) {
        try {
          if (fade > 0 && ctx && handle?.gain && handle?.source) {
            handle.gain.gain.cancelScheduledValues(ctx.currentTime);
            handle.gain.gain.setValueAtTime(handle.gain.gain.value, ctx.currentTime);
            handle.gain.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + fade);
            handle.source.stop(ctx.currentTime + fade + 0.02);
          } else if (handle?.source) {
            handle.source.stop();
          }
        } catch(e){}
        this.oneShots.delete(handle);
      }
    }

    hardStopAll(opts = {}) {
      const fade = opts.fade ?? (opts.immediate ? 0 : 0.12);
      const ctx = this.ctx;
      for (const [name, handle] of Array.from(this.loops)) {
        try {
          if (fade > 0 && ctx && handle?.gain && handle?.source) {
            handle.gain.gain.cancelScheduledValues(ctx.currentTime);
            handle.gain.gain.setValueAtTime(handle.gain.gain.value, ctx.currentTime);
            handle.gain.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + fade);
            handle.source.stop(ctx.currentTime + fade + 0.02);
          } else if (handle?.source) {
            handle.source.stop();
          }
        } catch(e){}
        this.loops.delete(name);
      }
      this.pendingLoops.clear?.();
      this.loopIntents = Object.create(null);
      this.stopOneShots({ fade });
    }

    stopLoop(name, opts = {}) {
      this._ensureStores();
      this.pendingLoops.delete(name);
      if (this.loopIntents) delete this.loopIntents[name];
      const handle = this.loops.get(name);
      if (!handle) return;
      this.loops.delete(name);
      const fade = opts.fade ?? (opts.immediate ? 0 : 0.6);
      if (fade > 0 && this.ctx) {
        handle.gain.gain.cancelScheduledValues(this.ctx.currentTime);
        handle.gain.gain.setValueAtTime(handle.gain.gain.value, this.ctx.currentTime);
        handle.gain.gain.linearRampToValueAtTime(0.0001, this.ctx.currentTime + fade);
        handle.source.stop(this.ctx.currentTime + fade + 0.05);
      } else {
        handle.source.stop();
      }
    }

    stopBackground(opts = {}) {
      this.stopLoop('background', opts);
      if (this.loopIntents) delete this.loopIntents.background;
    }

    startBackground(opts = {}) {
      this._ensureStores();
      // fade out any lingering one-shots like gameover/victory before bg starts
      this.stopOneShots({ fade: 0.25 });

      if (this.loops.has('background') || this.pendingLoops.has('background')) return;

      const intent = ++this.loopSeed;
      this.pendingLoops.add('background');
      if (this.loopIntents) this.loopIntents.background = intent;

      const gain   = opts.gain   ?? 0.65;
      const fadeIn = opts.fadeIn ?? 1.4;

      this.play('background', { loop: true, gain, fadeIn, _intent: intent });
    }

    // (Optional) Arm bg to start on first user gesture
    armAutoBackground(opts = {}) {
      this._autoBgOpts = opts || {};
      if (this.ready && this.ensureContext()) {
        this.startBackground(this._autoBgOpts);
        this._autoBgOpts = null;
      }
    }

    playIntro()       { this.play('intro',      { fadeOut: 0.4 }); }
    playDeployment()  { this.play('deployment', { fadeOut: 0.3 }); }

    playSanityLow() {
      const ctx = this.ensureContext();
      if (!ctx) return;
      const now = ctx.currentTime;
      if (now - this.lastSanityAt < this.sanityCooldown) return;
      this.lastSanityAt = now;
      this.play('sanity', { fadeOut: 0.2 });
    }

    playGameOver() {
      const ctx = this.ensureContext(true);
      this.hardStopAll({ immediate: true });
      const t = ctx ? ctx.currentTime + 0.01 : 0;
      this.play('gameover', { fadeOut: 0.5, startAt: t });
    }

    playVictory() {
      const ctx = this.ensureContext(true);
      this.hardStopAll({ immediate: true });
      const t = ctx ? ctx.currentTime + 0.01 : 0;
      this.play('victory', { fadeOut: 0.6, startAt: t });
    }

    // ---- SFX API ----
    playPickup()    { this.play('pickup'); }
    playHeal()      { this.play('heal'); }
    playMine()      { this.play('mine', { fadeOut: 0.12 }); }
    playSanityTick(){ this.play('sanity_tick'); }
    playLevelUp()   { this.play('levelup'); }
  }

  window.KomAudio = new AudioManager();
})();

