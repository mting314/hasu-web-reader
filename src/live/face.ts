/**
 * Faces for the Fes×LIVE viewer: expression crossfades and lip sync from the recording, plus the
 * client-side auto blink the game adds itself (Inspix AutoBlink: 0.1 s close, 0.1 s open).
 *
 * Data: <live>/expressions.json and <live>/lip/chunk_NNNN.bin (scripts/alst_export.py --faces),
 * face/<costume>_face.json (scripts/export_live_face.py). The rig mirrors the character's expression
 * AnimatorController: a Face layer (direct blend over expression keys; each key a pose or a blink
 * blend) and an overriding Mouth layer (per key, a direct blend of six mouth clips weighted by the
 * lip-sync values).
 */
import * as THREE from "three";

export interface FaceJson {
  character: string;
  costume: string;
  expressions: { index: number; key: string; label: string; ableBlink: boolean; enable: boolean }[];
  face: Record<string, { open: Record<string, number>; blink: Record<string, number> | null }>;
  mouth: Record<string, { params: string[]; clips: Record<string, number>[] }>;
}

export interface ExpressionTrack {
  t: number[];
  next: number[];
  last: number[];
  w: number[];
  switch: boolean[];
}

/** Lip-sync values in LipSyncData order: A, I, U, E, O, Close. */
export type Mouth = [number, number, number, number, number, number];
const LIP_PARAM: Record<string, number> = { lip_a: 0, lip_i: 1, lip_u: 2, lip_e: 3, lip_o: 4, lip_close: 5 };
const REST_MOUTH: Mouth = [0, 0, 0, 0, 0, 1];

interface LipTrack {
  times: Float32Array;
  values: Uint8Array;
}

/** lip/chunk_NNNN.bin loader, same caching scheme as the motion chunks. */
export class LipStore {
  private cache = new Map<number, Promise<void>>();
  private ready = new Map<number, Map<number, LipTrack>>();

  constructor(private base: string, private chunkSeconds: number) {}

  private load(i: number) {
    if (i < 0 || this.cache.has(i)) return;
    const name = `chunk_${String(i).padStart(4, "0")}.bin`;
    this.cache.set(
      i,
      fetch(`${this.base}/lip/${name}`)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((buf) => {
          const dv = new DataView(buf);
          const members = dv.getUint16(6, true);
          let o = 8;
          const out = new Map<number, LipTrack>();
          for (let m = 0; m < members; m++) {
            const cid = dv.getUint16(o, true);
            const n = dv.getUint32(o + 4, true);
            o += 8;
            const times = new Float32Array(buf.slice(o, o + n * 4));
            o += n * 4;
            const values = new Uint8Array(buf.slice(o, o + n * 6));
            o += n * 6;
            o = (o + 3) & ~3;
            out.set(cid, { times, values });
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

  sample(cid: number, t: number): Mouth {
    const tr = this.ready.get(Math.floor(t / this.chunkSeconds))?.get(cid);
    if (!tr || tr.times.length === 0) return REST_MOUTH;
    let lo = 0;
    let hi = tr.times.length - 1;
    if (t <= tr.times[0]) hi = 0;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (tr.times[mid] <= t) lo = mid;
      else hi = mid;
    }
    const span = tr.times[hi] - tr.times[lo];
    const k = span > 0 && span < 0.2 ? Math.min(1, Math.max(0, (t - tr.times[lo]) / span)) : 0;
    const out = [0, 0, 0, 0, 0, 0] as Mouth;
    for (let c = 0; c < 6; c++) {
      out[c] = (tr.values[lo * 6 + c] * (1 - k) + tr.values[hi * 6 + c] * k) / 255;
    }
    return out;
  }
}

/** Expression crossfade at time t: { next, last, w } (weight of next). */
export function expressionAt(tr: ExpressionTrack | undefined, t: number): { next: number; last: number; w: number } {
  if (!tr || tr.t.length === 0 || t < tr.t[0]) return { next: 0, last: 0, w: 1 };
  let lo = 0;
  let hi = tr.t.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (tr.t[mid] <= t) lo = mid;
    else hi = mid;
  }
  if (tr.t[hi] <= t) lo = hi;
  let w = tr.w[lo];
  const n = lo + 1;
  // interpolate the weight ramp between consecutive updates of the same crossfade
  if (n < tr.t.length && tr.next[n] === tr.next[lo] && tr.last[n] === tr.last[lo] && tr.t[n] - tr.t[lo] < 1) {
    const k = (t - tr.t[lo]) / (tr.t[n] - tr.t[lo]);
    w = tr.w[lo] + (tr.w[n] - tr.w[lo]) * Math.min(1, Math.max(0, k));
  }
  return { next: tr.next[lo], last: tr.last[lo], w: Math.min(1, Math.max(0, w)) };
}

/** Deterministic auto blink: one blink every ~2.5-5.5 s, 0.1 s close + 0.1 s open. */
export function blinkAt(seed: number, t: number): number {
  const hash = (n: number) => {
    let x = (Math.imul(n ^ (seed * 0x9e3779b1), 0x85ebca6b) ^ (n >>> 13)) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0xc2b2ae35) >>> 0;
    return (x ^ (x >>> 16)) / 4294967296;
  };
  const SLOT = 4; // seconds; one blink somewhere in each slot
  const i = Math.floor(t / SLOT);
  for (const j of [i, i - 1]) {
    const start = j * SLOT + hash(j) * (SLOT - 0.3);
    const d = t - start;
    if (d >= 0 && d < 0.2) return d < 0.1 ? d / 0.1 : 1 - (d - 0.1) / 0.1;
  }
  return 0;
}

export class FaceRig {
  private targets = new Map<string, [THREE.Mesh, number][]>();
  private mouthShapes = new Set<string>();
  private touched: [THREE.Mesh, number][] = [];

  constructor(readonly face: FaceJson, model: THREE.Object3D) {
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.morphTargetDictionary || !m.morphTargetInfluences) return;
      for (const [name, i] of Object.entries(m.morphTargetDictionary)) {
        if (!this.targets.has(name)) this.targets.set(name, []);
        this.targets.get(name)!.push([m, i]);
      }
    });
    for (const k of Object.values(face.mouth)) for (const c of k.clips) for (const s of Object.keys(c)) this.mouthShapes.add(s);
    const used = new Set<string>(this.mouthShapes);
    for (const f of Object.values(face.face)) for (const p of [f.open, f.blink ?? {}]) for (const s of Object.keys(p)) used.add(s);
    for (const s of used) for (const tm of this.targets.get(s) ?? []) this.touched.push(tm);
  }

  get hasMorphs(): boolean {
    return this.targets.size > 0;
  }

  private keyFor(index: number): string {
    const e = this.face.expressions[index];
    const key = e && e.enable ? e.key : "expression_normal";
    return this.face.face[key] ? key : "expression_normal";
  }

  apply(expr: { next: number; last: number; w: number }, mouth: Mouth, blink: number) {
    const params = new Map<string, number>();
    const add = (k: string, w: number) => params.set(k, (params.get(k) ?? 0) + w);
    add(this.keyFor(expr.next), expr.w);
    if (expr.w < 1) add(this.keyFor(expr.last), 1 - expr.w);
    const dominant = this.face.expressions[expr.w >= 0.5 ? expr.next : expr.last];
    const b = dominant?.ableBlink === false ? 0 : blink;

    const faceAcc = new Map<string, number>();
    const mouthAcc = new Map<string, number>();
    for (const [key, w] of params) {
      if (w <= 0) continue;
      const f = this.face.face[key];
      if (f) {
        const shapes = new Set([...Object.keys(f.open), ...Object.keys(f.blink ?? {})]);
        for (const s of shapes) {
          const open = f.open[s] ?? 0;
          const v = f.blink ? open + ((f.blink[s] ?? 0) - open) * b : open;
          faceAcc.set(s, (faceAcc.get(s) ?? 0) + w * v);
        }
      }
      const m = this.face.mouth[key];
      if (m) {
        m.params.forEach((p, i) => {
          const lw = mouth[LIP_PARAM[p] ?? 5];
          if (lw <= 0) return;
          for (const [s, v] of Object.entries(m.clips[i])) mouthAcc.set(s, (mouthAcc.get(s) ?? 0) + w * lw * v);
        });
      }
    }
    for (const [mesh, i] of this.touched) mesh.morphTargetInfluences![i] = 0;
    for (const [s, v] of faceAcc) {
      if (this.mouthShapes.has(s)) continue; // the Mouth layer overrides these
      for (const [mesh, i] of this.targets.get(s) ?? []) mesh.morphTargetInfluences![i] = Math.min(1.5, Math.max(0, v / 100));
    }
    for (const [s, v] of mouthAcc) {
      for (const [mesh, i] of this.targets.get(s) ?? []) mesh.morphTargetInfluences![i] = Math.min(1.5, Math.max(0, v / 100));
    }
  }
}
