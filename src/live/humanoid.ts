/**
 * Unity humanoid muscles -> bone rotations, in the browser.
 *
 * A per-frame port of HumanoidBaker.bake in scripts/unity_assets.py (main checkout), driven by the
 * <costume>_avatar.json files from scripts/export_live_avatar.py. Everything here is in Unity
 * space (left-handed); convert with toGltfT/toGltfQ before writing to three.js nodes.
 *
 * Quaternions are [x, y, z, w].
 */

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export interface AvatarJson {
  costume: string;
  model: string;
  scale: number;
  hips: number;
  nodes: { name: string; parent: number; t: Vec3; r: Quat; axes: number }[];
  axes: { pre: Quat; post: Quat; sgn: Vec3; min: Vec3; max: Vec3 }[];
  muscles: ([number, number] | null)[];
  bones: Record<string, number>;
  mass: Record<string, number>;
  segments: [string, string][];
  /** Helper bones carried by the motion packet, in packet order. */
  subBones?: { move: string[]; rotate: string[] };
}

export const qmul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
export const qconj = (a: Quat): Quat => [-a[0], -a[1], -a[2], a[3]];
export const qnorm = (a: Quat): Quat => {
  const n = Math.hypot(a[0], a[1], a[2], a[3]) || 1;
  return [a[0] / n, a[1] / n, a[2] / n, a[3] / n];
};
export const qrot = (q: Quat, v: Vec3): Vec3 => {
  const r = qmul(qmul(q, [v[0], v[1], v[2], 0]), qconj(q));
  return [r[0], r[1], r[2]];
};
export function qslerp(a: Quat, b: Quat, t: number): Quat {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = d < 0 ? -1 : 1;
  d *= s;
  if (d > 0.9995) {
    return qnorm([a[0] + (s * b[0] - a[0]) * t, a[1] + (s * b[1] - a[1]) * t, a[2] + (s * b[2] - a[2]) * t,
      a[3] + (s * b[3] - a[3]) * t]);
  }
  const th = Math.acos(d);
  const k0 = Math.sin((1 - t) * th) / Math.sin(th);
  const k1 = (s * Math.sin(t * th)) / Math.sin(th);
  return [a[0] * k0 + b[0] * k1, a[1] * k0 + b[1] * k1, a[2] * k0 + b[2] * k1, a[3] * k0 + b[3] * k1];
}

/** Unity (left-handed) -> glTF/three.js, the same convention as the costume GLBs. */
export const toGltfT = (t: Vec3): Vec3 => [-t[0], t[1], t[2]];
export const toGltfQ = (q: Quat): Quat => [q[0], -q[1], -q[2], q[3]];

function matToQuat(c0: Vec3, c1: Vec3, c2: Vec3): Quat {
  // columns c0, c1, c2 (right, up, forward), as unity_assets.mat_to_quat
  const m00 = c0[0], m10 = c0[1], m20 = c0[2];
  const m01 = c1[0], m11 = c1[1], m21 = c1[2];
  const m02 = c2[0], m12 = c2[1], m22 = c2[2];
  const t = m00 + m11 + m22;
  if (t > 0) {
    const s = Math.sqrt(t + 1) * 2;
    return qnorm([(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s]);
  }
  if (m00 >= m11 && m00 >= m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return qnorm([0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]);
  }
  if (m11 >= m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return qnorm([(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s]);
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return qnorm([(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s]);
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: Vec3): Vec3 => scale(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));

export interface Pose {
  /** Local rotation per human skeleton node (Unity space). The hips entry is the hips rotation. */
  localR: Quat[];
  /** Hips local translation (Unity space, relative to the costume root). */
  hipsT: Vec3;
}

export class HumanoidSolver {
  readonly av: AvatarJson;
  private driven: { node: number; chans: [number, number][] }[] = [];
  private zeroed: Set<number>;
  /** Human nodes whose transforms are forced to identity (the hips' ancestors). */
  readonly hipsAncestors: ReadonlySet<number>;
  private massBones: { b: number; child: number | null; m: number }[] = [];

  constructor(av: AvatarJson) {
    this.av = av;
    const byNode = new Map<number, [number, number][]>();
    av.muscles.forEach((m, i) => {
      if (!m) return;
      const [node, axis] = m;
      if (av.nodes[node].axes < 0) return;
      if (!byNode.has(node)) byNode.set(node, []);
      byNode.get(node)!.push([i, axis]);
    });
    this.driven = [...byNode.entries()].map(([node, chans]) => ({ node, chans }));
    // the hips and every ancestor are posed at the origin when measuring the body frame
    this.zeroed = new Set([av.hips]);
    for (let p = av.nodes[av.hips].parent; p >= 0; p = av.nodes[p].parent) this.zeroed.add(p);
    this.hipsAncestors = new Set([...this.zeroed].filter((i) => i !== av.hips));
    const childOf = new Map(av.segments);
    for (const [b, node] of Object.entries(av.bones)) {
      const m = av.mass[b] ?? 0;
      if (m <= 0) continue;
      const c = childOf.get(b);
      this.massBones.push({ b: node, child: c !== undefined && av.bones[c] !== undefined ? av.bones[c] : null, m });
    }
  }

  private unproject(axesIndex: number, m: Vec3): Quat {
    const ax = this.av.axes[axesIndex];
    const h = [0, 1, 2].map((k) => {
      const ang = m[k] >= 0 ? m[k] * ax.max[k] : -m[k] * ax.min[k];
      return Math.tan(0.5 * ang * ax.sgn[k]);
    });
    const [x, y, z] = h;
    const zyroll = qnorm([x, y + x * z, z - x * y, 1]);
    return qnorm(qmul(qmul(ax.pre, zyroll), qconj(ax.post)));
  }

  /** muscles: 95 values in Unity HumanTrait order. rootT: body position (m), rootQ: body rotation. */
  solve(muscles: ArrayLike<number>, rootT: Vec3, rootQ: Quat): Pose {
    const av = this.av;
    const n = av.nodes.length;
    const localR: Quat[] = av.nodes.map((nd) => nd.r);
    for (const { node, chans } of this.driven) {
      const m: Vec3 = [0, 0, 0];
      for (const [i, axis] of chans) m[axis] = muscles[i];
      localR[node] = this.unproject(av.nodes[node].axes, m);
    }

    // global pose with the hips (and ancestors) at the origin
    const gt: Vec3[] = new Array(n);
    const gr: Quat[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const nd = av.nodes[i];
      const zero = this.zeroed.has(i);
      const lt: Vec3 = zero ? [0, 0, 0] : nd.t;
      const lr: Quat = zero ? [0, 0, 0, 1] : localR[i];
      if (nd.parent < 0) {
        gt[i] = lt;
        gr[i] = lr;
      } else {
        gt[i] = add(gt[nd.parent], qrot(gr[nd.parent], lt));
        gr[i] = qmul(gr[nd.parent], lr);
      }
    }

    // Unity's body frame: mass-weighted segment midpoints + hips/shoulders orientation
    let num: Vec3 = [0, 0, 0];
    let den = 0;
    for (const { b, child, m } of this.massBones) {
      const p = child !== null ? scale(add(gt[b], gt[child]), 0.5) : gt[b];
      num = add(num, scale(p, m));
      den += m;
    }
    const com = scale(num, 1 / den);
    const B = av.bones;
    const up0 = sub(scale(add(gt[B.LeftUpperArm], gt[B.RightUpperArm]), 0.5),
      scale(add(gt[B.LeftUpperLeg], gt[B.RightUpperLeg]), 0.5));
    let right = add(sub(gt[B.RightUpperLeg], gt[B.LeftUpperLeg]), sub(gt[B.RightUpperArm], gt[B.LeftUpperArm]));
    const up = normalize(up0);
    const fwd = normalize(cross(right, up));
    right = cross(up, fwd);
    const qb = matToQuat(right, up, fwd);

    const hq = qmul(rootQ, qconj(qb));
    localR[av.hips] = hq;
    return { localR, hipsT: sub(rootT, qrot(hq, com)) };
  }


  /** World positions (Unity space) of every human skeleton node for a solved pose. */
  globalPositions(pose: Pose): Vec3[] {
    const av = this.av;
    const gt: Vec3[] = new Array(av.nodes.length);
    const gr: Quat[] = new Array(av.nodes.length);
    for (let i = 0; i < av.nodes.length; i++) {
      const nd = av.nodes[i];
      let lt: Vec3 = nd.t;
      let lr: Quat = pose.localR[i];
      if (i === av.hips) lt = pose.hipsT;
      else if (this.zeroed.has(i)) {
        lt = [0, 0, 0];
        lr = [0, 0, 0, 1];
      }
      if (nd.parent < 0) {
        gt[i] = lt;
        gr[i] = lr;
      } else {
        gt[i] = add(gt[nd.parent], qrot(gr[nd.parent], lt));
        gr[i] = qmul(gr[nd.parent], lr);
      }
    }
    return gt;
  }
}
