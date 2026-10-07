// Tiny offline synthesiser. ProductClips ships with its own score: tracks are
// composed per reel so the drop lands exactly on the reveal, the build-up rises
// into the recap and the outro breathes under the end card. Everything is
// generated here (no samples), so the audio is wholly owned and royalty-free.
// User-supplied library tracks are also supported (see pipeline/music.ts).

export const SR = 48000;

export type Mood = {
  id: string;
  title: string;
  bpm: number;
  energy: number;
  root: number; // MIDI note of the key centre
  minor: boolean;
  progression: number[][]; // chords as scale-degree triads (0-based degrees)
  kick: "four" | "half" | "broken";
  hats: "8th" | "16th" | "offbeat" | "none";
  lead: "pluck" | "bell" | "none";
  pad: "warm" | "airy" | "glass";
  bass: "sub" | "pulse" | "round";
  swing: number;
  brightness: number; // 0..1 low-pass openness
};

export const MOODS: Mood[] = [
  { id: "airy-minimal", title: "Glasshouse", bpm: 100, energy: 2, root: 57, minor: false, progression: [[0, 2, 4], [5, 0, 2], [3, 5, 0], [4, 6, 1]], kick: "half", hats: "offbeat", lead: "bell", pad: "airy", bass: "round", swing: 0, brightness: 0.55 },
  { id: "luxe-noir", title: "Velvet Hour", bpm: 92, energy: 2, root: 50, minor: true, progression: [[0, 2, 4], [5, 0, 2], [3, 5, 0], [4, 6, 1]], kick: "half", hats: "8th", lead: "bell", pad: "warm", bass: "sub", swing: 0.08, brightness: 0.4 },
  { id: "warm-organic", title: "Sunday Market", bpm: 108, energy: 3, root: 55, minor: false, progression: [[0, 2, 4], [3, 5, 0], [5, 0, 2], [4, 6, 1]], kick: "broken", hats: "8th", lead: "pluck", pad: "warm", bass: "round", swing: 0.12, brightness: 0.6 },
  { id: "clean-pulse", title: "Lab Light", bpm: 112, energy: 3, root: 52, minor: false, progression: [[0, 2, 4], [4, 6, 1], [5, 0, 2], [3, 5, 0]], kick: "four", hats: "16th", lead: "pluck", pad: "glass", bass: "pulse", swing: 0, brightness: 0.75 },
  { id: "tech-drive", title: "Night Circuit", bpm: 122, energy: 4, root: 45, minor: true, progression: [[0, 2, 4], [5, 0, 2], [6, 1, 3], [4, 6, 1]], kick: "four", hats: "16th", lead: "pluck", pad: "glass", bass: "pulse", swing: 0, brightness: 0.8 },
  { id: "bold-pop", title: "Big Mood", bpm: 126, energy: 5, root: 53, minor: false, progression: [[0, 2, 4], [4, 6, 1], [5, 0, 2], [3, 5, 0]], kick: "four", hats: "16th", lead: "pluck", pad: "warm", bass: "pulse", swing: 0.05, brightness: 0.9 },
];

/** Section markers in beats, from the storyboard. */
export type Arrangement = { revealBeat: number; recapBeat: number; ctaBeat: number; totalBeats: number };

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

// Deterministic PRNG so the same storyboard always produces the same audio.
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; };
}

class Bus {
  l: Float32Array; r: Float32Array;
  constructor(n: number) { this.l = new Float32Array(n); this.r = new Float32Array(n); }
  add(start: number, buf: Float32Array, gain = 1, pan = 0) {
    const gl = gain * Math.cos((pan + 1) * Math.PI / 4), gr = gain * Math.sin((pan + 1) * Math.PI / 4);
    const s0 = Math.max(0, start);
    for (let i = s0; i < Math.min(this.l.length, start + buf.length); i++) {
      this.l[i] += buf[i - start] * gl;
      this.r[i] += buf[i - start] * gr;
    }
  }
}

// ---------- voices ----------
function kick(punch = 1) {
  const n = Math.floor(SR * 0.45), out = new Float32Array(n), r = rng(41);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = 48 + 110 * Math.exp(-t * 28) * punch;
    ph += (2 * Math.PI * f) / SR;
    out[i] = Math.sin(ph) * Math.exp(-t * 7) * 0.95 + (i < 120 ? (r() * 2 - 1) * 0.25 * (1 - i / 120) : 0);
  }
  return out;
}
function noiseHit(len: number, decay: number, hp: number, seed: number) {
  const n = Math.floor(SR * len), out = new Float32Array(n), r = rng(seed);
  let prev = 0, prevOut = 0;
  const a = hp; // one-pole high-pass coefficient
  for (let i = 0; i < n; i++) {
    const x = r() * 2 - 1;
    prevOut = a * (prevOut + x - prev); prev = x;
    out[i] = prevOut * Math.exp(-(i / SR) * decay);
  }
  return out;
}
const hat = (open = false, seed = 7) => noiseHit(open ? 0.22 : 0.05, open ? 14 : 70, 0.96, seed);
function clap(seed = 11) {
  const base = noiseHit(0.25, 18, 0.85, seed);
  const out = new Float32Array(base.length);
  for (const d of [0, 0.011, 0.022]) { const off = Math.floor(d * SR); for (let i = off; i < out.length; i++) out[i] += base[i - off] * 0.6; }
  return out;
}
function tone(freq: number, len: number, opts: { wave?: "sine" | "saw" | "tri" | "square"; attack?: number; decay?: number; sustain?: number; release?: number; detune?: number; voices?: number; lp?: number; vib?: number }) {
  const n = Math.floor(SR * len), out = new Float32Array(n);
  const { wave = "sine", attack = 0.005, decay = 0.2, sustain = 0.6, release = 0.1, detune = 0, voices = 1, lp = 1, vib = 0 } = opts;
  const phases = new Array(voices).fill(0).map((_, i) => i * 0.37);
  let lpState = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let s = 0;
    for (let v = 0; v < voices; v++) {
      const dt = voices > 1 ? (v / (voices - 1) - 0.5) * detune : 0;
      const f = freq * Math.pow(2, dt / 12) * (1 + vib * Math.sin(2 * Math.PI * 5 * t));
      phases[v] = (phases[v] + f / SR) % 1;
      const p = phases[v];
      s += wave === "sine" ? Math.sin(2 * Math.PI * p) : wave === "saw" ? 2 * p - 1 : wave === "square" ? (p < 0.5 ? 1 : -1) : 1 - 4 * Math.abs(p - 0.5);
    }
    s /= voices;
    lpState += lp * (s - lpState);
    let env: number;
    if (t < attack) env = t / attack;
    else if (t < attack + decay) env = 1 - (1 - sustain) * ((t - attack) / decay);
    else env = sustain;
    const relStart = len - release;
    if (t > relStart) env *= Math.max(0, 1 - (t - relStart) / release);
    out[i] = lpState * env;
  }
  return out;
}

// ---------- composer ----------
export function compose(mood: Mood, arr: Arrangement, seed = 1): { l: Float32Array; r: Float32Array } {
  const spb = 60 / mood.bpm;
  const totalSec = arr.totalBeats * spb + 2;
  const n = Math.ceil(totalSec * SR);
  const bus = new Bus(n);
  const scale = mood.minor ? MINOR : MAJOR;
  const deg = (d: number, oct = 0) => mood.root + scale[((d % 7) + 7) % 7] + 12 * (Math.floor(d / 7) + oct);
  const at = (beat: number) => Math.floor(beat * spb * SR);
  const r = rng(seed * 9973 + mood.bpm);

  const K = kick(mood.energy >= 4 ? 1.2 : 1), CL = clap(), HC = hat(false), HO = hat(true);
  const swingOff = (i: number) => (i % 2 === 1 ? mood.swing * 0.5 : 0);

  // Section intensity per beat: intro (pre-reveal) is filtered and sparse,
  // the body is full, a 4-beat build rises into the recap, the outro thins out.
  const section = (b: number) => b < arr.revealBeat ? "intro" : b >= arr.ctaBeat ? "outro" : b >= arr.recapBeat ? "peak" : b >= arr.recapBeat - 4 ? "build" : "body";

  for (let b = 0; b < arr.totalBeats + 1; b++) {
    const sec = section(b);
    const inBar = b % 4;
    const chord = mood.progression[Math.floor(b / 4) % mood.progression.length];
    // --- drums ---
    const drums = sec !== "intro" || b >= arr.revealBeat - 2;
    if (drums && sec !== "outro") {
      const kickHere = mood.kick === "four" || (mood.kick === "half" && (inBar === 0 || inBar === 2)) || (mood.kick === "broken" && (inBar === 0 || inBar === 2));
      if (kickHere) bus.add(at(b), K, sec === "intro" ? 0.45 : 0.9);
      if (mood.kick === "broken" && inBar === 2) bus.add(at(b + 0.75), K, 0.55);
      if (sec !== "intro" && (inBar === 1 || inBar === 3)) bus.add(at(b), CL, 0.38, 0.05);
      const sub = mood.hats === "16th" ? 4 : mood.hats === "8th" ? 2 : mood.hats === "offbeat" ? 2 : 0;
      for (let i = 0; i < sub; i++) {
        if (mood.hats === "offbeat" && i === 0) continue;
        const open = mood.hats === "offbeat" || (sub === 4 && i === 2);
        const vel = (i === 0 ? 0.16 : 0.1 + r() * 0.05) * (sec === "peak" ? 1.3 : 1);
        bus.add(at(b + i / sub + swingOff(i) / sub), open ? HO : HC, vel, 0.3);
      }
    } else if (sec === "outro" && inBar === 0 && b < arr.ctaBeat + 5) {
      bus.add(at(b), K, 0.5);
    }
    if (sec === "intro" && b < arr.revealBeat) bus.add(at(b), HC, 0.12, -0.2); // ticking clock in the hook
    // --- bass ---
    if (sec !== "intro") {
      const root = deg(chord[0], -2);
      if (mood.bass === "pulse") {
        for (let i = 0; i < 2; i++) bus.add(at(b + i / 2 + 0.0), tone(mtof(root), spb / 2 * 0.9, { wave: "saw", lp: 0.06 * (0.6 + mood.brightness), attack: 0.004, decay: 0.12, sustain: 0.5, release: 0.04 }), i ? 0.22 : 0.3);
      } else if (inBar === 0 || (mood.bass === "round" && inBar === 2)) {
        const len = mood.bass === "sub" ? spb * 4 : spb * 2;
        bus.add(at(b), tone(mtof(root), len * 0.95, { wave: mood.bass === "sub" ? "sine" : "tri", attack: 0.01, decay: 0.4, sustain: 0.7, release: 0.2 }), 0.42);
      }
    }
    // --- pad (one per bar) ---
    if (inBar === 0) {
      const padGain = sec === "intro" ? 0.07 : sec === "outro" ? 0.11 : 0.085;
      const lp = (mood.pad === "glass" ? 0.08 : mood.pad === "airy" ? 0.05 : 0.03) * (sec === "intro" ? 0.5 : 1) * (0.5 + mood.brightness);
      for (const d of chord) {
        bus.add(at(b), tone(mtof(deg(d, 0)), spb * 4 + 0.3, { wave: "saw", voices: 3, detune: 0.18, attack: 0.25, decay: 0.8, sustain: 0.75, release: 0.6, lp }), padGain, (d % 3) * 0.3 - 0.3);
      }
    }
    // --- lead arp ---
    if (mood.lead !== "none" && (sec === "body" || sec === "peak" || sec === "build")) {
      const steps = mood.energy >= 4 || sec === "peak" ? 4 : 2;
      for (let i = 0; i < steps; i++) {
        const note = deg(chord[(b * steps + i) % 3] + (i === steps - 1 ? 7 : 0), 1);
        const len = spb / steps;
        const v = mood.lead === "bell"
          ? tone(mtof(note), len * 3, { wave: "sine", attack: 0.002, decay: 0.5, sustain: 0.1, release: 0.3 })
          : tone(mtof(note), len * 0.9, { wave: "square", attack: 0.002, decay: len * 0.6, sustain: 0.05, release: 0.03, lp: 0.12 * (0.5 + mood.brightness) });
        bus.add(at(b + i / steps), v, mood.lead === "bell" ? 0.07 : 0.06, (i % 2 ? 0.35 : -0.35));
      }
    }
  }
  // --- build riser into the recap ---
  const riserLen = 4 * spb;
  bus.add(at(arr.recapBeat) - Math.floor(riserLen * SR), sfx("riser", riserLen), 0.18);
  // Hook: a short filtered riser into the reveal drop
  const hookRiser = Math.min(arr.revealBeat, 4) * spb;
  bus.add(at(arr.revealBeat) - Math.floor(hookRiser * SR), sfx("riser", hookRiser), 0.12);

  // gentle soft-clip glue
  for (let i = 0; i < n; i++) { bus.l[i] = Math.tanh(bus.l[i] * 1.1) * 0.9; bus.r[i] = Math.tanh(bus.r[i] * 1.1) * 0.9; }
  return bus;
}

// ---------- SFX ----------
export const SFX_NAMES = ["chime", "whoosh", "pop", "impact", "click", "riser", "switch", "sparkle", "shutter"] as const;
export type SfxName = (typeof SFX_NAMES)[number];

export function sfx(name: SfxName, len?: number): Float32Array {
  switch (name) {
    case "chime": {
      const L = len ?? 1.4, out = new Float32Array(Math.floor(SR * L));
      for (const [f, a] of [[1318.5, 0.5], [1975.5, 0.3], [2637, 0.18], [3951, 0.08]]) {
        const t = tone(f, L, { wave: "sine", attack: 0.002, decay: L * 0.9, sustain: 0, release: 0.05 });
        for (let i = 0; i < out.length; i++) out[i] += t[i] * a;
      }
      return out;
    }
    case "whoosh": {
      const L = len ?? 0.45, n = Math.floor(SR * L), out = new Float32Array(n), r = rng(3);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n, env = Math.sin(Math.PI * Math.pow(t, 0.7));
        const cut = 0.02 + 0.35 * Math.sin(Math.PI * t);
        lp += cut * ((r() * 2 - 1) - lp);
        out[i] = lp * env * 1.6;
      }
      return out;
    }
    case "pop": {
      const L = len ?? 0.14, n = Math.floor(SR * L), out = new Float32Array(n);
      let ph = 0;
      for (let i = 0; i < n; i++) { const t = i / SR; ph += 2 * Math.PI * (900 * Math.exp(-t * 30) + 300) / SR; out[i] = Math.sin(ph) * Math.exp(-t * 32); }
      return out;
    }
    case "impact": {
      const k = kick(1.6), nz = noiseHit(0.6, 6, 0.5, 5), n = Math.floor(SR * (len ?? 0.9)), out = new Float32Array(n);
      const boom = tone(42, 0.9, { wave: "sine", attack: 0.002, decay: 0.85, sustain: 0, release: 0.05 });
      for (let i = 0; i < n; i++) out[i] = (k[i] ?? 0) * 0.8 + (nz[i] ?? 0) * 0.25 + (boom[i] ?? 0) * 0.6;
      return out;
    }
    case "click": return noiseHit(len ?? 0.03, 160, 0.7, 13);
    case "riser": {
      const L = len ?? 1.6, n = Math.floor(SR * L), out = new Float32Array(n), r = rng(17);
      let ph = 0, lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        ph += 2 * Math.PI * (200 + 1400 * t * t) / SR;
        lp += (0.02 + 0.5 * t * t) * ((r() * 2 - 1) - lp);
        out[i] = (lp * 0.9 + Math.sin(ph) * 0.25) * Math.pow(t, 1.6);
      }
      return out;
    }
    case "switch": {
      const a = noiseHit(0.02, 200, 0.6, 21), b = noiseHit(0.03, 150, 0.8, 23), out = new Float32Array(Math.floor(SR * 0.12));
      out.set(a, 0); for (let i = 0; i < b.length; i++) out[Math.floor(SR * 0.06) + i] += b[i] * 0.8;
      return out;
    }
    case "sparkle": {
      const L = len ?? 0.8, out = new Float32Array(Math.floor(SR * L)), r = rng(29);
      for (let k = 0; k < 7; k++) {
        const t = tone(2000 + r() * 3000, 0.25, { wave: "sine", attack: 0.002, decay: 0.24, sustain: 0, release: 0.01 });
        const off = Math.floor(SR * k * 0.07);
        for (let i = 0; i < t.length && off + i < out.length; i++) out[off + i] += t[i] * 0.25;
      }
      return out;
    }
    case "shutter": {
      const a = noiseHit(0.05, 90, 0.5, 31), b = noiseHit(0.06, 70, 0.5, 37), out = new Float32Array(Math.floor(SR * 0.2));
      out.set(a, 0); for (let i = 0; i < b.length; i++) out[Math.floor(SR * 0.09) + i] += b[i];
      return out;
    }
  }
}

// ---------- WAV ----------
export function encodeWav(l: Float32Array, r?: Float32Array): Buffer {
  const ch = r ? 2 : 1, n = l.length;
  const buf = Buffer.alloc(44 + n * ch * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * ch * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(ch, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * ch * 2, 28); buf.writeUInt16LE(ch * 2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * ch * 2, 40);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(l[i]), r ? Math.abs(r[i]) : 0);
  const g = peak > 0.98 ? 0.98 / peak : 1;
  let o = 44;
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, l[i] * g)) * 32767), o); o += 2;
    if (r) { buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, r[i] * g)) * 32767), o); o += 2; }
  }
  return buf;
}
