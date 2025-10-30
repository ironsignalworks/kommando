// audio.js — robust, overlap-safe audio for KOMMANDO
(() => {
  'use strict';

  // --- Singleton guard: never create more than one instance ---
  if (window.KomAudio && window.KomAudio.__alive) return;

  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  const GMap = globalThis.Map;
  const GSet = globalThis.Set;

  // ---------- Fallback (no WebAudio) ----------
  const fallback = {
    supported: !!AudioCtor,
    ctx: null,

    __alive: true,
    ready: true,
    userActivated: true,

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
      try { this.loops.clear(); } catch(e){}
      try { this.pendingLoops.clear(); } catch(e){}
      this.loopIntents = Object.create(null);
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
    stopOneShots() {},

    // Files mapping (noop here but kept for API parity)
    files: {},
    configureFiles(map){
      // Merge defaults with overrides; accept global window.KomAudioFiles if map not provided
      const DEFAULT_FILE_MAP = {
        intro: 'audio/intro.mp3',
        deployment: 'audio/deployment.mp3',
        background: 'audio/background_loop.mp3',
        sanity: 'audio/sanity_low.mp3',
        gameover: 'audio/gameover.mp3',
        victory:  'audio/victory.mp3',
        pickup:      'audio/sfx/pickup.mp3',
        heal:        'audio/sfx/heal.mp3',
        mine:        'audio/sfx/mine.mp3',
        sanity_tick: 'audio/sfx/sanity_tick.mp3',
        levelup:     'audio/sfx/levelup.mp3',
      };
      const globalMap = (typeof window !== 'undefined' && window.KomAudioFiles && typeof window.KomAudioFiles === 'object')
        ? window.KomAudioFiles
        : null;
      const src = (map && typeof map === 'object') ? map : globalMap;
      this.files = { ...DEFAULT_FILE_MAP };
      if (src){
        for (const [k,v] of Object.entries(src)){
          if (v === null || v === false) delete this.files[k];
          else if (typeof v === 'string' && v.trim()) this.files[k] = v.trim();
        }
      }
    },

    // SFX no-ops
    playPickup() {},
    playHeal() {},
    playMine() {},
    playSanityTick() {},
    playLevelUp() {},
    armAutoBackground() {},
  };

  if (!AudioCtor) { window.KomAudio = fallback; return; }

  // ---------- DSP helpers ----------
  const clamp = (v,min,max)=> v<min?min : v>max?max : v;
  function edgeFade(data, sampleRate, seconds) {
    if (!seconds) return;
    const fadeSamples = Math.min(Math.floor(seconds * sampleRate), Math.floor(data.length / 2));
    for (let i = 0; i < fadeSamples; i++) {
      const k = i / fadeSamples;
      data[i] *= k;
      data[data.length - 1 - i] *= k;
    }
  }
  const rnd = (i,seed)=> {
    const x = Math.sin((i + seed * 13.37) * 12.9898) * 43758.5453;
    return x - Math.floor(x);
  };

  // ---------- Procedural builders ----------
  function addBlip(d, sr, {start=0,dur=0.2,freq=440,amp=0.5,envPower=1.6,harmonics=[]}){
    const s0 = Math.floor(start*sr), s1 = Math.min(d.length, s0 + Math.floor(dur*sr));
    for (let i=s0; i<s1; i++){
      const t = (i - s0)/sr;
      const f = typeof freq === 'function' ? freq(t) : freq;
      const env = Math.pow(Math.max(0, 1 - t / dur), envPower);
      let v = Math.sin(2*Math.PI*f*t);
      for (const h of harmonics) v += h * Math.sin(2*Math.PI*f*2*t);
      d[i] += amp * env * v;
    }
  }
  function finalizeChannel(channelData, sr, spec){
    edgeFade(channelData, sr, spec.edgeFade || 0);
    const t = spec.target ?? 0.9;
    let peak = 0; for (let i=0;i<channelData.length;i++) peak = Math.max(peak, Math.abs(channelData[i]));
    const g = peak ? (t/peak) : 1;
    for (let i=0;i<channelData.length;i++) channelData[i] *= g;
  }

  function buildBackground(d, sr, ch){
    // dark pulse + noise bed
    let pL=0, pM=0;
    for (let i=0;i<d.length;i++){
      pL += (2*Math.PI*0.42)/sr;
      pM += (2*Math.PI*0.88)/sr;
      const low = 0.45*Math.sin(pL);
      const mid = 0.3*Math.sin(pM);
      const n = (rnd(i, 7+ch) - 0.5) * 0.22;
      d[i] = low + mid + n*(0.4 + 0.6*(0.5+0.5*Math.sin(i/sr*2*Math.PI*0.5)));
    }
  }
  function buildSanity(d, sr, ch){
    [0.0,0.6,1.2].forEach((start, idx)=>{
      const base = 420 - idx*30;
      addBlip(d,sr,{start,dur:0.28,freq:(r)=>base*(1-0.22*r),amp:0.42,envPower:1.45,harmonics:[0.2]});
    });
  }
  function buildGameOver(d, sr, ch){
    addBlip(d,sr,{start:0,dur:0.45,freq:(r)=>180*(1+0.2*r),amp:0.7,envPower:1.8,harmonics:[0.25,0.12]});
    addBlip(d,sr,{start:0.36,dur:0.8,freq:(r)=>110*(1-0.4*r),amp:0.6,envPower:1.3});
  }
  function buildVictory(d, sr, ch){
    addBlip(d,sr,{start:0,dur:0.30,freq:(r)=>220+880*r,amp:0.6,envPower:1.5,harmonics:[0.2]});
    addBlip(d,sr,{start:0.18,dur:0.35,freq:(r)=>330+660*r,amp:0.5,envPower:1.4});
  }
  function buildPickup(d,sr,ch){ addBlip(d,sr,{start:0,dur:0.14,freq:880,amp:0.5}); }
  function buildHeal(d,sr,ch){ addBlip(d,sr,{start:0,dur:0.18,freq:520,amp:0.45}); }
  function buildMine(d,sr,ch){ addBlip(d,sr,{start:0,dur:0.20,freq:160,amp:0.55,harmonics:[0.2]}); }
  function buildSanityTick(d,sr,ch){
    addBlip(d,sr,{start:0,dur:0.06,freq:880,amp:0.35,harmonics:[0.1]});
    addBlip(d,sr,{start:0.05,dur:0.05,freq:660,amp:0.28});
  }

  const SOUND_SPECS = {
    intro:      { duration: 3.0, edgeFade: 0.03, target: 0.90, builder: buildBackground },
    deployment: { duration: 0.8, edgeFade: 0.02, target: 0.90, builder: buildPickup },
    background: { duration: 6.0, edgeFade: 0.02, target: 0.90, builder: buildBackground },
    sanity:     { duration: 1.8, edgeFade: 0.025, target: 0.88, builder: buildSanity },
    gameover:   { duration: 3.4, edgeFade: 0.04, target: 0.85, builder: buildGameOver },
    victory:    { duration: 3.2, edgeFade: 0.03, target: 0.90, builder: buildVictory },
    pickup:     { duration: 0.28, edgeFade: 0.01, target: 0.90, builder: buildPickup },
    heal:       { duration: 0.30, edgeFade: 0.01, target: 0.90, builder: buildHeal },
    mine:       { duration: 0.30, edgeFade: 0.01, target: 0.90, builder: buildMine },
    sanity_tick:{ duration: 0.18, edgeFade: 0.01, target: 0.90, builder: buildSanityTick },
    levelup:    { duration: 0.40, edgeFade: 0.01, target: 0.90, builder: buildPickup },
  };

  const DEFAULT_FILE_MAP = {
    intro: 'audio/intro.mp3',
    deployment: 'audio/deployment.mp3',
    background: 'audio/background_loop.mp3',
    sanity: 'audio/sanity_low.mp3',
    gameover: 'audio/gameover.mp3',   // optional: procedural fallback if missing
    victory:  'audio/victory.mp3',    // optional: procedural fallback if missing
    pickup:      'audio/sfx/pickup.mp3',
    heal:        'audio/sfx/heal.mp3',
    mine:        'audio/sfx/mine.mp3',
    sanity_tick: 'audio/sfx/sanity_tick.mp3',
    levelup:     'audio/sfx/levelup.mp3',
  };

  // ---------- Core engine ----------
  const A = {
    __alive: true,
    supported: true,
    ctx: null,
    ready: false,
    userActivated: false,

    files: {...DEFAULT_FILE_MAP},
    buffers: new GMap(),        // procedural buffers
    fileBuffers: new GMap(),    // decoded file buffers
    bufferPromises: new GMap(),

    loops: new GMap(),
    pendingLoops: new GSet(),
    loopIntents: Object.create(null),
    loopSeed: 0,

    oneShots: new Set(),
    lastSanityAt: 0,
    sanityCooldown: 0.08,

    _autoBgOpts: null,

    configureFiles(map){
      this._ensureStores();
      // Start with defaults
      this.files = {...DEFAULT_FILE_MAP};
      // Prefer explicit object param; otherwise, look for global window.KomAudioFiles (as used by index.html)
      const globalMap = (typeof window !== 'undefined' && window.KomAudioFiles && typeof window.KomAudioFiles === 'object')
        ? window.KomAudioFiles
        : null;
      const src = (map && typeof map === 'object') ? map : globalMap;

      if (src){
        for (const [k,v] of Object.entries(src)){
          if (v === null || v === false) delete this.files[k];
          else if (typeof v === 'string' && v.trim()) this.files[k] = v.trim();
        }
      }
      // Clear any previously decoded file buffers so changes take effect immediately
      this.fileBuffers.clear();
      this.bufferPromises.clear();
    },

    _ensureStores(){
      if (!(this.buffers instanceof GMap)) this.buffers = new GMap();
      if (!(this.fileBuffers instanceof GMap)) this.fileBuffers = new GMap();
      if (!(this.loops instanceof GMap)) this.loops = new GMap();
      if (!(this.pendingLoops instanceof GSet)) this.pendingLoops = new GSet();
      if (!(this.bufferPromises instanceof GMap)) this.bufferPromises = new GMap();
      if (!this.loopIntents || typeof this.loopIntents !== 'object') this.loopIntents = Object.create(null);
      if (!(this.oneShots instanceof Set)) this.oneShots = new Set();
    },

    ensureContext(forceCreate=false){
      if (!this.ctx && (forceCreate || this.userActivated)) {
        this.ctx = new AudioCtor();
      }
      if (this.ctx && this.ctx.state === 'suspended') {
        try { this.ctx.resume(); } catch(e){}
      }
      this.ready = !!this.ctx && this.ctx.state === 'running';
      return this.ctx;
    },

    resume(onGesture=false){
      if (!this.userActivated && onGesture) this.userActivated = true;
      const ctx = this.ensureContext(true);
      if (!ctx) return Promise.resolve(false);
      return ctx.resume().then(()=>{
        this.ready = (ctx.state === 'running');
        // auto-start background if armed
        if (this._autoBgOpts) { this.startBackground(this._autoBgOpts); this._autoBgOpts = null; }
        return this.ready;
      }).catch(()=>false);
    },

    _bindUnlock(){
      const unlock = () => {
        if (this.userActivated) return;
        this.userActivated = true;
        this.resume(true);
        if (this._autoBgOpts) { this.startBackground(this._autoBgOpts); this._autoBgOpts = null; }
      };
      const opts = { once: true, passive: true };
      ['pointerdown','mousedown','touchstart','keydown'].forEach(ev=>{
        window.addEventListener(ev, unlock, opts);
        document.addEventListener(ev, unlock, opts);
      });
    },

    generateBuffer(name){
      const spec = SOUND_SPECS[name];
      if (!spec) return null;
      const ctx = this.ensureContext(true);
      if (!ctx) return null;
      const len = Math.max(1, Math.floor(spec.duration * ctx.sampleRate));
      const chs = 2;
      const buffer = ctx.createBuffer(chs, len, ctx.sampleRate);
      for (let ch=0; ch<chs; ch++){
        const d = buffer.getChannelData(ch);
        spec.builder(d, ctx.sampleRate, ch);
        finalizeChannel(d, ctx.sampleRate, spec);
      }
      this.buffers.set(name, buffer);
      return buffer;
    },

    obtainBuffer(name){
      this._ensureStores();
      const filePath = this.files[name];
      if (filePath){
        const key = `file:${filePath}`;
        if (this.fileBuffers.has(key)) return this.fileBuffers.get(key);
        if (this.bufferPromises.has(key)) return this.bufferPromises.get(key);

        const ctx = this.ensureContext(true);
        if (!ctx) return null;

        const loading = fetch(filePath)
          .then(r=>{ if(!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
          .then(ab=>ctx.decodeAudioData(ab))
          .then(buf=>{ this.fileBuffers.set(key, buf); this.bufferPromises.delete(key); return buf; })
          .catch(err=>{
            console.warn(`KomAudio: fallback to procedural '${name}'`, err);
            this.bufferPromises.delete(key);
            this.fileBuffers.delete(key);
            delete this.files[name];
            return this.generateBuffer(name);
          });
        this.bufferPromises.set(key, loading);
        return loading;
      }
      if (this.buffers.has(name)) return this.buffers.get(name);
      return this.generateBuffer(name);
    },

    play(name, {
      loop=false, gain=1, fadeIn=0.0, fadeOut=0.0, startAt=null, _intent=null
    } = {}){
      this._ensureStores();
      let pending;
      try { pending = this.obtainBuffer(name); } catch(e){ console.error(`KomAudio: failed '${name}'`, e); return; }
      const asPromise = (pending && typeof pending.then === 'function') ? pending : Promise.resolve(pending);
      asPromise.then((buffer)=>{
        if (!buffer) return;
        const ctx = this.ensureContext(true); if (!ctx) return;

        // If this was an intended background loop and intent changed, skip
        if (name === 'background' && _intent && this.loopIntents.background && _intent !== this.loopIntents.background) return;

        const src = ctx.createBufferSource(); src.buffer = buffer; src.loop = loop;
        const g = ctx.createGain(); g.gain.value = 0; // fade in
        src.connect(g).connect(ctx.destination);

        const now = ctx.currentTime;
        const t0 = startAt ?? (now + 0.01);
        const t1 = t0 + (fadeIn || 0.001);
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(gain, t1);

        const handle = { src, g, name, loop, node: src, gainNode: g, startAt:t0, gain };
        src.onended = () => {
          if (loop){
            // handled as loop, ignore natural end
          } else {
            this.oneShots.delete(handle);
          }
        };

        try { src.start(t0); } catch(e){ console.warn('audio start failed', e); }

        if (loop){
          this.pendingLoops.delete(name);
          this.loops.set(name, handle);
        } else {
          this.oneShots.add(handle);
          if (fadeOut){
            const tout = t0 + Math.max(0.05, (src.buffer?.duration || 0) - Math.min(fadeOut, 0.5));
            g.gain.setValueAtTime(gain, tout);
            g.gain.linearRampToValueAtTime(0, tout + Math.min(fadeOut, 0.5));
          }
        }
      });
    },

    stopLoop(name, { fade=true } = {}){
      if (!this.loops.has(name)) return;
      const h = this.loops.get(name);
      this.loops.delete(name);
      try {
        const ctx = this.ensureContext();
        const now = ctx ? ctx.currentTime : 0;
        if (fade && h.gainNode){
          h.gainNode.gain.cancelScheduledValues(now);
          h.gainNode.gain.setValueAtTime(h.gainNode.gain.value, now);
          h.gainNode.gain.linearRampToValueAtTime(0, now + 0.25);
          setTimeout(()=>{ try{ h.src.stop(0); }catch(e){} }, 260);
        } else {
          h.src.stop(0);
        }
      } catch(e){}
      if (this.loopIntents) delete this.loopIntents[name];
    },

    stopOneShots({ fade=false } = {}){
      for (const s of Array.from(this.oneShots)){
        try {
          if (fade && s.gainNode){
            const ctx = this.ensureContext();
            const now = ctx ? ctx.currentTime : 0;
            s.gainNode.gain.cancelScheduledValues(now);
            s.gainNode.gain.setValueAtTime(s.gainNode.gain.value, now);
            s.gainNode.gain.linearRampToValueAtTime(0, now + 0.2);
            setTimeout(()=>{ try{s.src.stop(0);}catch(e){}; this.oneShots.delete(s); }, 220);
          } else {
            s.src.stop(0); this.oneShots.delete(s);
          }
        } catch(e){ this.oneShots.delete(s); }
      }
    },

    hardStopAll({ immediate=false } = {}){
      // stop loops
      for (const [k,h] of Array.from(this.loops.entries())){
        try {
          if (immediate) { h.src.stop(0); } else { this.stopLoop(k, { fade:true }); }
        } catch(e){}
      }
      this.loops.clear();
      try { this.pendingLoops.clear(); } catch(e){}
      this.loopIntents = Object.create(null);

      // stop shots
      this.stopOneShots({ fade: !immediate });
    },

    // ---------- Public cues ----------
    playIntro(){ this.play('intro', { fadeOut:0.4 }); },
    playDeployment(){ this.play('deployment', { fadeOut:0.1 }); },
    playPickup(){ this.play('pickup'); },
    playHeal(){ this.play('heal'); },
    playMine(){ this.play('mine'); },
    playSanityLow(){
      const ctx = this.ensureContext();
      const now = ctx ? ctx.currentTime : 0;
      if (now - this.lastSanityAt < this.sanityCooldown) return;
      this.lastSanityAt = now;
      this.play('sanity', { fadeOut:0.2 });
    },
    playSanityTick(){ this.play('sanity_tick'); },
    playLevelUp(){ this.play('levelup'); },

    playGameOver(){
      const ctx = this.ensureContext(true);
      this.hardStopAll({ immediate:true });
      const t = ctx ? ctx.currentTime + 0.01 : 0;
      this.play('gameover', { fadeOut: 0.5, startAt: t });
    },
    playVictory(){
      const ctx = this.ensureContext(true);
      this.hardStopAll({ immediate:true });
      const t = ctx ? ctx.currentTime + 0.01 : 0;
      this.play('victory', { fadeOut: 0.5, startAt: t });
    },

    startBackground(opts = {}){
      this._ensureStores();
      const ctx = this.ctx;
      const notReady = !this.userActivated || !ctx || ctx.state !== 'running';
      if (notReady){
        // remember intent and options
        if (!this.pendingLoops.has('background') && !this.loops.has('background')) {
          this.pendingLoops.add('background');
          this.loopIntents.background = ++this.loopSeed;
        }
        this._autoBgOpts = opts || this._autoBgOpts || {};
        return;
      }

      // fade out any lingering shots (like gameover/victory) before bg starts
      this.stopOneShots({ fade:true });

      if (this.loops.has('background') || this.pendingLoops.has('background')) return;

      const intent = ++this.loopSeed;
      this.pendingLoops.add('background');
      this.loopIntents.background = intent;

      const gain = opts.gain ?? 0.65;
      const fadeIn = opts.fadeIn ?? 1.0;
      this.play('background', { loop:true, gain, fadeIn, _intent:intent });
    },

    stopBackground({ fade=true } = {}){
      this.stopLoop('background', { fade });
      if (this.loopIntents) delete this.loopIntents.background;
    },

    armAutoBackground(opts = {}){
      // will start immediately on first user gesture
      this._autoBgOpts = { ...opts };
    },
  };

  // Initialize file map with global overrides if present (so audio works even if
  // configureFiles() is never called explicitly)
  try { A.configureFiles(); } catch(e){}

  window.KomAudio = A;
  A._bindUnlock();
})();
