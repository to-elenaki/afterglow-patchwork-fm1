/* SPDX-License-Identifier: GPL-3.0-only
 * AFTERGLOW v0.3 browser DSP port.
 * Algorithmically follows v0.2's afterglow_grain.h/afterglow_hybrid.h.
 * Floating-point browser rendering is NOT bit-identical to the FM-1 C build.
 */

export const PARAM_NAMES = [
  ['POSITION', 'GRAIN SIZE', 'DENSITY', 'TEXTURE', 'MOTION', 'TONE', 'SPACE'],
  ['WAVE', 'ATTACK', 'UNISON', 'DETUNE', 'DRIFT', 'TONE', 'SPACE'],
  ['WAVE / POS', 'SHIMMER', 'LAYERS', 'DETUNE', 'MOTION', 'BRIGHT', 'SPACE'],
];

export const SCENES = [
  { name: 'NEBULA', tagline: 'A cloud you can hold', description: 'Windowed grains drift across a slowly beating harmonic source.', color: '#b998ff', params: [48, 96, 90, 20, 20, 68, 108] },
  { name: 'BLOOM', tagline: 'Warmth in slow motion', description: 'Detuned saw and triangle voices open into a wide chorus.', color: '#ffa6c9', params: [68, 116, 54, 35, 21, 58, 110] },
  { name: 'HORIZON', tagline: 'Everything, all at once', description: 'Grain shimmer and analog harmonics become one enormous pad.', color: '#9ad4fc', params: [113, 65, 96, 60, 30, 105, 94] },
];

export const EXTRA_DEFAULTS = Object.freeze({
  attack: 64, release: 64, sustain: 127, velocity: 127,
  fxMix: 64, chorus: 64, feedback: 64, fxEnabled: 127,
  lfoRate: 42, lfoDepth: 0, lfoTarget: 0, lfoShape: 0,
});
const SOURCE_N = 32768;
const MAX_VOICES = 4;
const MAX_GRAINS = 3;
const REVERB_LENGTHS = [1499, 1789, 2341, 3019];
const TAU = Math.PI * 2;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function makeVoice() {
  return { note: -1, held: false, level: 0, velocity: 0, age: 0,
    ratio: 1, phase: 0, phase2: 0, sub: 0, nextGrain: 0, grains: [],
  };
}

export class AfterglowEngine {
  constructor(sampleRate = 44100) {
    this.sampleRate = sampleRate;
    this.scale = sampleRate / 44100;
    this.scene = 0;
    this.params = SCENES[0].params.slice();
    this.hold = false;
    this.extra = { ...EXTRA_DEFAULTS };
    this.lfoPhase = 0;
    this.lfoRandom = 0;
    this.order = 0;
    this.randomState = 0x6db319b7;
    this.scan = 0;
    this.master = 0.74;
    this.voices = Array.from({ length: MAX_VOICES }, makeVoice);
    this.source = this.makeSource();
    this.lowL = 0;
    this.lowR = 0;
    this.grainMix = 110;
    this.analogMix = 22;
    this.chorusL = new Float32Array(2048 * this.scale | 0);
    this.chorusR = new Float32Array(this.chorusL.length);
    this.chorusWrite = 0;
    this.chorusPhase = 0;
    this.reverbLengths = REVERB_LENGTHS.map(n => Math.max(32, Math.round(n * this.scale)));
    this.reverb = this.reverbLengths.map(n => new Float32Array(n));
    this.revIndex = [0, 0, 0, 0];
    this.revSmooth = [0, 0, 0, 0];
  }

  makeSource() {
    const data = new Float32Array(SOURCE_N);
    // Original harmonic seed and three beating fundamentals from the v0.2 C DSP.
    const root = 261.625565 / 44100;
    const detuneB = 14691 / 4294967296;
    const detuneC = -17113 / 4294967296;
    let p1 = 0, p2 = 0, p3 = 0;
    for (let i = 0; i < SOURCE_N; i++) {
      const a = Math.sin(p1), b = Math.sin(p2), c = Math.sin(p3);
      const harmonic = Math.sin(p1 * 2) / 3 + Math.sin(p2 * 3) / 5;
      data[i] = (a * 5 + b * 4 + c * 2) / 18 + harmonic / 3;
      p1 += TAU * root;
      p2 += TAU * (root + detuneB);
      p3 += TAU * (root + detuneC);
    }
    return data;
  }

  random() {
    let x = this.randomState | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.randomState = x >>> 0;
    return this.randomState / 4294967296;
  }

  setScene(index) {
    this.scene = clamp(index | 0, 0, 2);
    this.params = SCENES[this.scene].params.slice();
  }

  setParam(index, value) {
    if (index >= 0 && index < 7) this.params[index] = clamp(value | 0, 0, 127);
  }

  setExtra(name, value) {
    if (!Object.prototype.hasOwnProperty.call(EXTRA_DEFAULTS, name)) return;
    this.extra[name] = clamp(Math.round(Number(value) || 0), 0, 127);
  }

  setHold(enabled) {
    this.hold = !!enabled;
    if (!this.hold) this.allNotesOff();
  }

  noteOn(note, velocity = 105) {
    note = note | 0;
    if (note < 0 || note > 127) return;
    const existing = this.voices.find(v => v.held && v.note === note);
    const free = this.voices.find(v => v.note < 0 || (!v.held && v.level < 0.004));
    const releasing = this.voices.filter(v => !v.held).sort((a, b) => a.level - b.level)[0];
    const oldest = this.voices.reduce((a, b) => a.age < b.age ? a : b);
    const v = existing || free || releasing || oldest;
    v.note = note;
    v.held = true;
    v.velocity = clamp(velocity / 127, 0.05, 1);
    v.ratio = 2 ** ((note - 60) / 12);
    v.age = ++this.order;
    v.nextGrain = 0;
    v.grains.length = 0;
  }

  noteOff(note, force = false) {
    if (this.hold && !force) return;
    for (const v of this.voices) if (v.note === note) v.held = false;
  }

  allNotesOff() {
    for (const v of this.voices) v.held = false;
  }

  panic() {
    this.hold = false;
    for (const v of this.voices) {
      v.held = false;
      v.level = 0;
      v.grains.length = 0;
      v.note = -1;
    }
    this.reverb.forEach(line => line.fill(0));
    this.chorusL.fill(0);
    this.chorusR.fill(0);
    this.lowL = this.lowR = 0;
  }

  spawnGrain(v, length, texture, position) {
    if (v.grains.length >= MAX_GRAINS) return;
    const r = this.random();
    const jitter = texture * 96;
    const start = (position / 127 * SOURCE_N + this.scan + r * jitter) % SOURCE_N;
    const shift = (r * 2 - 1) * texture * 0.0005;
    const octave = this.scene === 2 && this.random() > 0.5 ? 2 : 1;
    v.grains.push({ pos: start, increment: v.ratio * octave * (1 + shift) / this.scale, age: 0, length });
  }

  grainSample(v, length, texture, position) {
    if (--v.nextGrain <= 0) {
      this.spawnGrain(v, length, texture, position);
      v.nextGrain = length / (1 + this.params[2] / 42);
    }
    let signal = 0;
    for (let k = v.grains.length - 1; k >= 0; k--) {
      const g = v.grains[k];
      const idx = Math.floor(g.pos) & (SOURCE_N - 1);
      const frac = g.pos - Math.floor(g.pos);
      const sample = this.source[idx] * (1 - frac) + this.source[(idx + 1) & (SOURCE_N - 1)] * frac;
      const phase = g.age / g.length;
      const tri = 1 - Math.abs(phase * 2 - 1);
      signal += sample * tri * tri;
      g.pos = (g.pos + g.increment) % SOURCE_N;
      if (++g.age >= g.length) v.grains.splice(k, 1);
    }
    return signal;
  }

  analogSample(v, shape, density, texture, motion, modulation = 0) {
    const vibrato = this.extra.lfoTarget === 2 ? modulation * 0.018 : 0;
    const hz = 261.625565 * v.ratio * (1 + vibrato);
    const drift = Math.sin(this.chorusPhase * TAU) * (motion / 127) * 0.003;
    v.phase = (v.phase + hz * (1 + drift) / this.sampleRate) % 1;
    const detune = texture * 0.000053;
    v.phase2 = (v.phase2 + hz * (1 + detune) / this.sampleRate) % 1;
    v.sub = (v.sub + hz * 0.5 / this.sampleRate) % 1;
    const wave = (phase) => {
      const saw = phase * 2 - 1;
      const triangle = 1 - Math.abs(saw) * 2;
      return triangle * (1 - shape / 127) + saw * shape / 127;
    };
    const a = wave(v.phase), b = wave(v.phase2);
    const sub = Math.sin(v.sub * TAU) * 0.125;
    return [
      (a * (192 - density) + b * density) / 256 + sub,
      (a * density + b * (192 - density)) / 256 + sub,
    ];
  }

  spatial(left, right, space) {
    const settings = this.extra;
    if (settings.fxEnabled < 64) return [left, right];
    this.chorusPhase = (this.chorusPhase + 0.13 / this.sampleRate) % 1;
    const tri = this.chorusPhase < 0.5 ? this.chorusPhase * 2 : 2 - this.chorusPhase * 2;
    const len = this.chorusL.length;
    const dL = Math.round((320 + tri * 91) * this.scale);
    const dR = Math.round((432 + (1 - tri) * 103) * this.scale);
    const tapL = this.chorusL[(this.chorusWrite - dL + len) % len];
    const tapR = this.chorusR[(this.chorusWrite - dR + len) % len];
    this.chorusL[this.chorusWrite] = left;
    this.chorusR[this.chorusWrite] = right;
    this.chorusWrite = (this.chorusWrite + 1) % len;
    const chorusMix = clamp([60, 70, 45][this.scene] / 256 * settings.chorus / 64, 0, 0.76);
    let outL = left * (1 - chorusMix) + tapL * chorusMix;
    let outR = right * (1 - chorusMix) + tapR * chorusMix;

    const mono = (left + right) * 0.25;
    const tap = this.reverb.map((line, i) => line[this.revIndex[i]]);
    for (let i = 0; i < 4; i++) this.revSmooth[i] += (tap[i] - this.revSmooth[i]) * 0.125;
    const a = this.revSmooth;
    const feedback = clamp((101 + space / 16) / 128 * (0.80 + settings.feedback / 320), 0.15, 0.965);
    const feedbacks = [
      (a[0] + a[1] + a[2] + a[3]) * 0.25,
      (a[0] - a[1] + a[2] - a[3]) * 0.25,
      (a[0] + a[1] - a[2] - a[3]) * 0.25,
      (a[0] - a[1] - a[2] + a[3]) * 0.25,
    ];
    for (let i = 0; i < 4; i++) {
      const value = clamp(mono + feedbacks[i] * feedback, -1, 1);
      this.reverb[i][this.revIndex[i]] = value;
      this.revIndex[i] = (this.revIndex[i] + 1) % this.reverbLengths[i];
    }
    const fxGain = settings.fxMix / 64;
    outL += (tap[0] + tap[2]) * 0.5 * space / 127 * fxGain;
    outR += (tap[1] + tap[3]) * 0.5 * space / 127 * fxGain;
    return [outL, outR];
  }

  render(left, right) {
    const p = this.params;
    const length = Math.round((2646 + p[1] * 105) * this.scale);
    const position = p[0], density = p[2], texture = p[3], motion = p[4], tone = p[5], space = p[6];
    const targetGrain = [110, 18, 60][this.scene];
    const targetAnalog = [22, 110, 106][this.scene];
    const cutoff = 1 - (1 - clamp((1100 + tone * 197) / 32768, 0.001, 0.92)) ** (1 / this.scale);
    const attack = (11 + Math.floor(p[1] / 38));
    const attackCoef = (this.scene === 1 ? 1 / (2 ** attack) : this.scene === 2 ? 1 / 4096 : 1 / 2048) * 2 ** ((64 - this.extra.attack) / 19);
    const releaseCoef = 1 / (32768 * this.scale) * 2 ** ((64 - this.extra.release) / 19);
    const velocityScale = this.extra.velocity / 127;
    const sustainScale = this.extra.sustain / 127;
    for (let i = 0; i < left.length; i++) {
      const lfoRate = 0.05 * 2 ** (this.extra.lfoRate / 15.8);
      this.lfoPhase += lfoRate / this.sampleRate;
      if (this.lfoPhase >= 1) {
        this.lfoPhase -= 1;
        this.lfoRandom = this.random() * 2 - 1;
      }
      const shape = this.extra.lfoShape >> 5;
      const lfoRaw = shape === 0 ? Math.sin(this.lfoPhase * TAU)
        : shape === 1 ? 1 - 4 * Math.abs(this.lfoPhase - 0.5)
        : shape === 2 ? this.lfoPhase * 2 - 1 : this.lfoRandom;
      const modulation = lfoRaw * this.extra.lfoDepth / 127;
      const modTone = this.extra.lfoTarget === 0 ? modulation * 0.30 : 0;
      const modMotion = this.extra.lfoTarget === 1 ? modulation * 64 : 0;
      const dynamicCutoff = clamp(cutoff * (1 + modTone), 0.001, 0.95);
      this.grainMix += (targetGrain - this.grainMix) * 0.02;
      this.analogMix += (targetAnalog - this.analogMix) * 0.02;
      let dryL = 0, dryR = 0;
      for (const v of this.voices) {
        const target = v.held ? v.velocity * (0.6 + velocityScale * 0.4) * sustainScale : 0;
        const coefficient = target > v.level ? attackCoef : releaseCoef;
        v.level += (target - v.level) * coefficient;
        if (v.level < 0.00004 && !v.held) {
          v.level = 0;
          v.note = -1;
          v.grains.length = 0;
          continue;
        }
        const gr = this.grainSample(v, length, texture, position);
        const [al, ar] = this.analogSample(v, position, density, texture, motion + modMotion, modulation);
        dryL += (gr * this.grainMix + al * this.analogMix) / 256 * v.level;
        dryR += (gr * this.grainMix + ar * this.analogMix) / 256 * v.level;
      }
      this.lowL += (dryL - this.lowL) * dynamicCutoff;
      this.lowR += (dryR - this.lowR) * dynamicCutoff;
      const [wetL, wetR] = this.spatial(this.lowL, this.lowR, space);
      const mono = (wetL + wetR) * 0.5;
      const width = this.extra.fxEnabled < 64 ? 1 : (this.extra.fxMix / 64);
      left[i] = Math.tanh((mono + (wetL - mono) * width) * 1.5) * this.master;
      right[i] = Math.tanh((mono + (wetR - mono) * width) * 1.5) * this.master;
      this.scan = (this.scan + motion * 3 / 65536 / this.scale) % SOURCE_N;
    }
  }
}
