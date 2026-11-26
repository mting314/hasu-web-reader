/**
 * Helper ("sub") bones for the Fes×LIVE viewer. The motion packet carries the local transforms of
 * the costume's twist/bend helper bones (SubBoneReference: 16 positions, 26 rotations), computed on
 * the performer's side; applying them fixes elbow/wrist/knee deformation.
 *
 * sub/chunk_NNNN.bin (scripts/alst_export.py --subbones), little-endian: "LLS1", u16 version,
 * u16 members; per member: u16 id, u16 reserved, u32 n, f32 time[n], i16 pos[n][16][3] (0.1 mm),
 * i16 rot[n][26][4] (x32767), padding to 4. Unity local space.
 */
export const SUB_MOVE = 16;
export const SUB_ROTATE = 26;

interface SubTrack {
  times: Float32Array;
  pos: Int16Array;
  rot: Int16Array;
}

export interface SubSample {
  pos: Float32Array; // 16 * 3, meters
  rot: Float32Array; // 26 * 4, normalized
}

export class SubBoneStore {
  private cache = new Map<number, Promise<void>>();
  private ready = new Map<number, Map<number, SubTrack>>();
  private out: SubSample = { pos: new Float32Array(SUB_MOVE * 3), rot: new Float32Array(SUB_ROTATE * 4) };

  constructor(private base: string, private chunkSeconds: number) {}

  private load(i: number) {
    if (i < 0 || this.cache.has(i)) return;
    const name = `chunk_${String(i).padStart(4, "0")}.bin`;
    this.cache.set(
      i,
      fetch(`${this.base}/sub/${name}`)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((buf) => {
          const dv = new DataView(buf);
          const members = dv.getUint16(6, true);
          let o = 8;
          const out = new Map<number, SubTrack>();
          for (let m = 0; m < members; m++) {
            const cid = dv.getUint16(o, true);
            const n = dv.getUint32(o + 4, true);
            o += 8;
            const times = new Float32Array(buf.slice(o, o + n * 4));
            o += n * 4;
            const pos = new Int16Array(buf.slice(o, o + n * SUB_MOVE * 3 * 2));
            o += n * SUB_MOVE * 3 * 2;
            const rot = new Int16Array(buf.slice(o, o + n * SUB_ROTATE * 4 * 2));
            o += n * SUB_ROTATE * 4 * 2;
            o = (o + 3) & ~3;
            out.set(cid, { times, pos, rot });
          }
          this.ready.set(i, out);
        })
        .catch(() => undefined),
    );
  }

  prefetch(t: number) {
    const i = Math.floor(t / this.chunkSeconds);
    for (const j of [i, i + 1, i - 1]) this.load(j);
    for (const j of [...this.ready.keys()]) if (Math.abs(j - i) > 3) {
      this.ready.delete(j);
      this.cache.delete(j);
    }
  }

  /** Interpolated helper-bone transforms (reused buffer), or null if not loaded. */
  sample(cid: number, t: number): SubSample | null {
    const i = Math.floor(t / this.chunkSeconds);
    const tr = this.ready.get(i)?.get(cid);
    if (!tr || tr.times.length === 0) return null;
    let lo = 0;
    let hi = tr.times.length - 1;
    if (t <= tr.times[0]) hi = 0;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (tr.times[mid] <= t) lo = mid;
      else hi = mid;
    }
    const span = tr.times[hi] - tr.times[lo];
    const k = span > 0 ? Math.min(1, Math.max(0, (t - tr.times[lo]) / span)) : 0;
    const { pos, rot } = this.out;
    for (let c = 0; c < SUB_MOVE * 3; c++) {
      const a = tr.pos[lo * SUB_MOVE * 3 + c];
      pos[c] = (a + (tr.pos[hi * SUB_MOVE * 3 + c] - a) * k) / 10000;
    }
    for (let b = 0; b < SUB_ROTATE; b++) {
      const ao = (lo * SUB_ROTATE + b) * 4;
      const bo = (hi * SUB_ROTATE + b) * 4;
      const dot = tr.rot[ao] * tr.rot[bo] + tr.rot[ao + 1] * tr.rot[bo + 1] + tr.rot[ao + 2] * tr.rot[bo + 2] + tr.rot[ao + 3] * tr.rot[bo + 3];
      const s = dot < 0 ? -1 : 1;
      let n = 0;
      for (let c = 0; c < 4; c++) {
        const v = tr.rot[ao + c] * (1 - k) + s * tr.rot[bo + c] * k;
        rot[b * 4 + c] = v;
        n += v * v;
      }
      n = Math.sqrt(n) || 1;
      for (let c = 0; c < 4; c++) rot[b * 4 + c] /= n;
    }
    return this.out;
  }
}
