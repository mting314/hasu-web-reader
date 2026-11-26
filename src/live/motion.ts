/**
 * Fes×LIVE motion chunks (written by scripts/alst_export.py): loading, caching and sampling.
 *
 * chunk_NNNN.bin, little-endian:
 *   "LLM1", u16 version, u16 members, f32 start, f32 end
 *   per member: u16 character id, u16 reserved, u32 n,
 *               f32 time[n], f32 pos[n*3], f32 rot[n*4], i16 muscles[n*95] (x1000), pad to 4 bytes
 */
import { qslerp, type Quat, type Vec3 } from "./humanoid";

export interface LiveIndex {
  format: string;
  title: string;
  video: string;
  liveStart: string;
  duration: number;
  chunkSeconds: number;
  fps: number;
  stageCentre: Vec3;
  members: {
    characterId: number;
    name: string;
    costumes: { from: number; costume: string }[];
    /** Capture space -> stage slot, per costume period (scripts/live_formation.py). */
    offsets?: { from: number; dx: number; dz: number }[];
    /** On-stage state changes (VisibleCommunicator), video time. */
    visibility?: { t: number; visible: boolean }[];
    frames: number;
  }[];
  timelines: { start: number; timeline: string }[];
  chunks: { file: string; start: number; end: number }[];
}

export interface MemberTrack {
  times: Float32Array;
  pos: Float32Array;
  rot: Float32Array;
  muscles: Int16Array;
}

export type Chunk = Map<number, MemberTrack>;

export const MUSCLE_COUNT = 95;

export function parseChunk(buf: ArrayBuffer): Chunk {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== "LLM1") throw new Error(`not a motion chunk (${magic})`);
  const members = dv.getUint16(6, true);
  let o = 16;
  const out: Chunk = new Map();
  for (let m = 0; m < members; m++) {
    const cid = dv.getUint16(o, true);
    const n = dv.getUint32(o + 4, true);
    o += 8;
    const times = new Float32Array(buf.slice(o, o + n * 4));
    o += n * 4;
    const pos = new Float32Array(buf.slice(o, o + n * 12));
    o += n * 12;
    const rot = new Float32Array(buf.slice(o, o + n * 16));
    o += n * 16;
    const muscles = new Int16Array(buf.slice(o, o + n * MUSCLE_COUNT * 2));
    o += n * MUSCLE_COUNT * 2;
    o = (o + 3) & ~3;
    out.set(cid, { times, pos, rot, muscles });
  }
  return out;
}

export interface Sample {
  pos: Vec3;
  rot: Quat;
  muscles: Float32Array;
}

/** Interpolated state of one member at time t (seconds), or null outside the track. */
export function sampleTrack(tr: MemberTrack, t: number, out?: Float32Array): Sample | null {
  const n = tr.times.length;
  if (n === 0 || t < tr.times[0] - 0.2 || t > tr.times[n - 1] + 0.2) return null;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (tr.times[mid] <= t) lo = mid;
    else hi = mid;
  }
  const t0 = tr.times[lo];
  const t1 = tr.times[hi];
  const k = hi === lo || t1 <= t0 ? 0 : Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
  const p = (i: number, c: number) => tr.pos[i * 3 + c];
  const pos: Vec3 = [0, 1, 2].map((c) => p(lo, c) + (p(hi, c) - p(lo, c)) * k) as Vec3;
  const q = (i: number): Quat => [tr.rot[i * 4], tr.rot[i * 4 + 1], tr.rot[i * 4 + 2], tr.rot[i * 4 + 3]];
  const rot = qslerp(q(lo), q(hi), k);
  const muscles = out ?? new Float32Array(MUSCLE_COUNT);
  const a = lo * MUSCLE_COUNT;
  const b = hi * MUSCLE_COUNT;
  for (let i = 0; i < MUSCLE_COUNT; i++) {
    muscles[i] = (tr.muscles[a + i] + (tr.muscles[b + i] - tr.muscles[a + i]) * k) / 1000;
  }
  return { pos, rot, muscles };
}

/** How long a failed chunk fetch is remembered before it may be retried. */
export const RETRY_MS = 3000;

/** Loads chunks on demand and keeps a small cache around the playhead. */
export class ChunkStore {
  private cache = new Map<number, Promise<Chunk>>();
  private ready = new Map<number, Chunk>();

  constructor(private base: string, readonly index: LiveIndex) {}

  chunkAt(t: number): number {
    return Math.max(0, Math.floor(t / this.index.chunkSeconds));
  }

  private load(i: number): Promise<Chunk> | null {
    const meta = this.index.chunks.find((c) => Math.round(c.start / this.index.chunkSeconds) === i);
    if (!meta) return null;
    if (!this.cache.has(i)) {
      const p = fetch(`${this.base}/${meta.file}`)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status} for ${meta.file}`);
          return r.arrayBuffer();
        })
        .then((buf) => {
          const c = parseChunk(buf);
          this.ready.set(i, c);
          return c;
        });
      // a failed fetch is forgotten after a few seconds so a later prefetch retries it
      p.catch((e) => {
        console.warn(`[live] motion chunk ${i}:`, e);
        setTimeout(() => this.cache.get(i) === p && this.cache.delete(i), RETRY_MS);
      });
      this.cache.set(i, p);
    }
    return this.cache.get(i)!;
  }

  /** Make sure the chunks around t are loading; drop far-away ones. */
  prefetch(t: number) {
    const i = this.chunkAt(t);
    for (const j of [i, i + 1, i - 1]) this.load(j);
    for (const j of [...this.ready.keys()]) {
      if (Math.abs(j - i) > 3) {
        this.ready.delete(j);
        this.cache.delete(j);
      }
    }
  }

  /** Track for a member at time t if its chunk is loaded (neighbouring chunk near the edges). */
  sample(cid: number, t: number, out?: Float32Array): Sample | null {
    const i = this.chunkAt(t);
    for (const j of [i, i - 1, i + 1]) {
      const tr = this.ready.get(j)?.get(cid);
      if (tr) {
        const s = sampleTrack(tr, t, out);
        if (s) return s;
      }
    }
    return null;
  }

  isReady(t: number): boolean {
    return this.ready.has(this.chunkAt(t));
  }
}
