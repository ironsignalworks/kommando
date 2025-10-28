(() => {
  'use strict';

  const AudioCtor = window.AudioContext || window.webkitAudioContext;

  const fallback = {
    supported: !!AudioCtor,
    resume() { return Promise.resolve(false); },
    play() {},
    startLoop() {},
    stopLoop() {},
    playIntro() {},
      this.bufferPromises = new Map();
    playDeployment() {},
    playSanityLow() {},
    playGameOver() {},
    playVictory() {},
    startBackground() {},
    stopBackground() {},
    configureFiles() {},
  };

  // File names map (override via window.KomAudioFiles before this script loads)
  const DEFAULT_FILE_MAP = {
    intro: 'audio/intro.mp3',
    deployment: 'audio/deployment.mp3',
    background: 'audio/background_loop.mp3',
    sanity: 'audio/sanity_low.mp3',
    gameover: 'audio/gameover.mp3',
    victory: 'audio/victory.mp3',
  };

  const fetchAudio = (typeof fetch === 'function') ? fetch : null;

  if (!AudioCtor) {
    window.KomAudio = fallback;
    return;
  }

  function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
  }

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
    for (let i = 0; i < data.length; i++) {
      data[i] *= gain;
    }
  }

  function saturate(data, drive) {
    if (!drive) return;
    const k = drive;
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.tanh(data[i] * k);
    }
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

  function buildIntro(data, sampleRate, channelIndex) {
    const len = data.length;
    let phaseMain = 0;
    let phaseSub = 0;
    let phaseShimmer = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sampleRate;
      const sweepFreq = 110 + 80 * Math.pow(t, 1.1);
      phaseMain += (2 * Math.PI * sweepFreq) / sampleRate;
      const subFreq = 45 + 14 * Math.sin(t * 2 * Math.PI * 0.25 + channelIndex * 0.2);
      phaseSub += (2 * Math.PI * subFreq) / sampleRate;
      const shimmerFreq = 420 + 60 * Math.sin(t * 2 * Math.PI * 0.6);
      phaseShimmer += (2 * Math.PI * shimmerFreq) / sampleRate;

      const envUp = Math.min(1, t / 0.35);
      const envDown = Math.pow(Math.max(0, 1 - t / 2.6), 1.4);
      const env = envUp * envDown;

      let sample = 0.58 * Math.sin(phaseMain);
      sample += 0.3 * Math.sin(phaseSub);
      sample += 0.18 * Math.sin(phaseShimmer + channelIndex * 0.3) * (0.7 + 0.3 * Math.sin(t * 2 * Math.PI * 0.5));
      sample += 0.1 * Math.sin(phaseMain * 2) * envUp;
      data[i] = sample * env;
    }
  }

  function buildDeployment(data, sampleRate, channelIndex) {
    const hits = [0.0, 0.35, 0.7, 1.15];
    hits.forEach((start, idx) => {
      const base = 170 + idx * 24;
      addBlip(data, sampleRate, {
        start,
        dur: 0.22,
        freq: (ratio) => base * (1 + 0.18 * (1 - ratio)) * (channelIndex ? 0.98 : 1.02),
        amp: 0.58,
        envPower: 1.15,
        harmonics: [0.35],
      });
      addBlip(data, sampleRate, {
        start: start + 0.08,
        dur: 0.28,
        freq: base / 2,
        amp: 0.26,
        envPower: 1.2,
      });
    });

    let noisePhase = 0;
    for (let i = 0; i < data.length; i++) {
      const t = i / sampleRate;
      noisePhase += (2 * Math.PI * 0.5) / sampleRate;
      const pulse = (Math.sin(noisePhase) + 1) * 0.5;
      const grit = (pseudoRandom(i, 3 + channelIndex * 11) - 0.5) * 0.22 * pulse;
      data[i] += grit;
      const bed = 0.08 * Math.sin(2 * Math.PI * 52 * t) * (0.4 + 0.6 * pulse);
      data[i] += bed;
    }
  }

  function buildBackground(data, sampleRate, channelIndex) {
    const len = data.length;
    let phaseLow = 0;
    let phaseMid = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sampleRate;
      const drift = 1 + 0.03 * Math.sin(t * 2 * Math.PI * 0.08 + channelIndex * 0.17);
      const base = 55 * drift * (channelIndex ? 0.997 : 1.003);
      phaseLow += (2 * Math.PI * base) / sampleRate;
      const midFreq = base * 2.02 + 12 * Math.sin(t * 2 * Math.PI * 0.18);
      phaseMid += (2 * Math.PI * midFreq) / sampleRate;
      const low = 0.5 * Math.sin(phaseLow);
      const mid = 0.3 * Math.sin(phaseMid);
      const noise = (pseudoRandom(i, channelIndex * 21) - 0.5) * 0.2;
      const pulse = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI * 0.5);
      data[i] = low + mid + noise * (0.4 + 0.6 * pulse);
    }
  }

  function buildSanity(data, sampleRate, channelIndex) {
    const pulses = [0.0, 0.58, 1.16];
    pulses.forEach((start, idx) => {
      const base = 420 - idx * 30;
      addBlip(data, sampleRate, {
        start,
        dur: 0.28,
        freq: (ratio) => base * (1 - 0.22 * ratio),
        amp: 0.62,
        envPower: 1.35,
        phaseOffset: channelIndex * 0.2,
        harmonics: [0.2],
      });
      addBlip(data, sampleRate, {
        start: start + 0.12,
        dur: 0.36,
        freq: 90,
        amp: 0.24,
        envPower: 1.1,
      });
    });

    for (let i = 0; i < data.length; i++) {
      const t = i / sampleRate;
      const trem = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI * 6);
      const grit = (pseudoRandom(i, 7 + channelIndex * 19) - 0.5) * 0.16 * trem;
      data[i] += grit;
    }
  }

  function buildGameOver(data, sampleRate, channelIndex) {
    let phase = 0;
    for (let i = 0; i < data.length; i++) {
      const t = i / sampleRate;
      const sweep = 160 - 120 * (t / 3.3);
      const freq = clamp(sweep, 32, 220);
      phase += (2 * Math.PI * freq) / sampleRate;
      const env = Math.pow(Math.max(0, 1 - t / 3.3), 1.3);
      let sample = 0.6 * Math.sin(phase);
      sample += 0.25 * Math.sin(phase * 0.5 + channelIndex * 0.4);
      const rumble = (pseudoRandom(i, 31 + channelIndex * 9) - 0.5) * 0.35 * env;
      data[i] = sample * env + rumble;
    }
  }

  function buildVictory(data, sampleRate, channelIndex) {
    const tones = [
      { start: 0.0, dur: 0.45, freq: 196, amp: 0.42 },
      { start: 0.22, dur: 0.55, freq: 247, amp: 0.4 },
      { start: 0.45, dur: 0.7, freq: 294, amp: 0.46 },
      { start: 0.9, dur: 0.9, freq: 392, amp: 0.48 },
      { start: 1.4, dur: 1.1, freq: 523, amp: 0.42 },
    ];
    tones.forEach((tone, idx) => {
      addBlip(data, sampleRate, {
        start: tone.start,
        dur: tone.dur,
        freq: (ratio) => tone.freq * (1 + 0.015 * Math.sin(ratio * Math.PI * 6 + channelIndex * 0.5)),
        amp: tone.amp,
        envPower: 1.05,
        harmonics: idx % 2 === 0 ? [0.18, 0.06] : [0.12],
        phaseOffset: channelIndex * 0.15,
      });
    });

    for (let i = 0; i < data.length; i++) {
      const t = i / sampleRate;
      const shimmer = Math.sin(2 * Math.PI * (680 + channelIndex * 12) * t);
      const env = Math.pow(Math.max(0, 1 - t / 3.2), 1.6);
      const spark = (pseudoRandom(i, 101 + channelIndex * 3) - 0.5) * 0.18 * env;
      data[i] += shimmer * env * 0.08 + spark;
    }
  }

  const SOUND_SPECS = {
    intro: { duration: 2.7, edgeFade: 0.03, target: 0.82, builder: buildIntro },
    deployment: { duration: 2.0, edgeFade: 0.02, target: 0.86, builder: buildDeployment },
    background: { duration: 8.0, edgeFade: 0.05, target: 0.52, loop: true, builder: buildBackground },
    sanity: { duration: 1.8, edgeFade: 0.025, target: 0.88, builder: buildSanity },
    gameover: { duration: 3.4, edgeFade: 0.04, target: 0.85, builder: buildGameOver },
    victory: { duration: 3.2, edgeFade: 0.03, target: 0.9, builder: buildVictory },
  };

  class AudioManager {
    constructor() {
      this.ctx = null;
      this.master = null;
      this.ready = false;
      this.pending = [];
      this.buffers = new Map();          // procedurally generated buffers
      this.fileBuffers = new Map();      // decoded external buffers or pending promises
      this.loops = new Map();
      this.loopIntents = Object.create(null);
      this.pendingLoops = new Set();
      this.bufferPromises = new Map();
      this.masterVolume = 0.38;
      this.lastSanityAt = 0;
      this.sanityCooldown = 2.2;
      this.files = { ...DEFAULT_FILE_MAP };
      this.loopSeed = 0;
      this.userActivated = false;
      this._applyFileOverrides(window.KomAudioFiles);
      this._bindUnlock();
    }

    _ensureStores() {
      if (!(this.buffers instanceof Map)) this.buffers = new Map();
      if (!(this.fileBuffers instanceof Map)) this.fileBuffers = new Map();
      if (!(this.loops instanceof Map)) this.loops = new Map();
      if (!(this.pendingLoops instanceof Set)) this.pendingLoops = new Set();
      if (!(this.bufferPromises instanceof Map)) this.bufferPromises = new Map();
      if (!this.loopIntents || typeof this.loopIntents !== 'object') this.loopIntents = Object.create(null);
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
        source.loop = wantsLoop;
        if (opts.loop && spec?.loop === false) source.loop = true;
        const gainNode = ctx.createGain();
        const level = opts.gain ?? spec.gain ?? 1;
        gainNode.gain.value = level;
        source.connect(gainNode).connect(this.master);

        if (opts.fadeIn) {
          gainNode.gain.setValueAtTime(0, ctx.currentTime);
          gainNode.gain.linearRampToValueAtTime(level, ctx.currentTime + opts.fadeIn);
        }

        if (source.loop) {
          const intent = opts._intent ?? null;
          const storedIntent = this.loopIntents ? this.loopIntents[name] : undefined;
          if (intent && storedIntent !== intent) {
            if (intent) this.pendingLoops.delete(name);
            source.disconnect();
            return;
          }
          if (this.loops.has(name)) {
            if (intent) this.pendingLoops.delete(name);
            source.disconnect();
            return;
          }
          source.start(0, opts.offset ?? 0);
          this.loops.set(name, { source, gain: gainNode });
          if (intent) {
            this.pendingLoops.delete(name);
            if (this.loopIntents) this.loopIntents[name] = intent;
          }
        } else {
          const release = opts.fadeOut ?? 0;
          if (release > 0) {
            const end = ctx.currentTime + buffer.duration;
            gainNode.gain.setValueAtTime(level, Math.max(ctx.currentTime, end - release));
            gainNode.gain.linearRampToValueAtTime(0.0001, end);
          }
          try {
            source.start();
          } catch (startErr) {
            console.warn(`KomAudio: failed to start '${name}'`, startErr);
            gainNode.disconnect();
            return;
          }
          source.onended = () => {
            gainNode.disconnect();
          };
        }
      }).catch((err) => {
        console.error(`KomAudio: failed to play '${name}'`, err);
      });
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

    playIntro() {
      this.play('intro', { fadeOut: 0.4 });
    }

    playDeployment() {
      this.play('deployment', { fadeOut: 0.3 });
    }

    startBackground() {
      this._ensureStores();
      if (this.loops.has('background') || this.pendingLoops.has('background')) {
        return;
      }
      const intent = ++this.loopSeed;
      this.pendingLoops.add('background');
      if (this.loopIntents) this.loopIntents.background = intent;
      this.play('background', { loop: true, gain: 0.65, fadeIn: 1.4, _intent: intent });
    }

    stopBackground() {
      this.stopLoop('background');
    }

    playSanityLow() {
      const ctx = this.ensureContext();
      if (!ctx) return;
      const now = ctx.currentTime;
      if (now - this.lastSanityAt < this.sanityCooldown) return;
      this.lastSanityAt = now;
      this.play('sanity', { fadeOut: 0.2 });
    }

    playGameOver() {
      this.stopBackground();
      this.play('gameover', { fadeOut: 0.5 });
    }

    playVictory() {
      this.stopBackground();
      this.play('victory', { fadeOut: 0.6 });
    }
  }

  window.KomAudio = new AudioManager();
})();
