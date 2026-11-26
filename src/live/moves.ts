/**
 * Spin / turn / walk markers for the Fes×LIVE choreo viewer: the move list written by
 * scripts/live_moves.py (moves.json next to index.json), cue wording, and floor arrows.
 *
 * Positions in moves.json are the viewer's three.js stage space ([x, z], formation offset
 * included). Headings are degrees in the stage frame: 0 = facing the audience, + = towards stage
 * right; a positive turn is clockwise seen from above = a turn to the performer's right.
 * "Stage left/right" are the performer's left/right when she faces the audience (stage left is
 * the audience's right).
 */
import * as THREE from "three";
import { MEMBER_COLORS, type LiveStage } from "./LiveStage";

export type MoveKind = "spin" | "turn" | "walk";

export interface MoveEvent {
  id: string;
  kind: MoveKind;
  /** Video seconds. */
  start: number;
  end: number;
  /** Timeline label of the song it falls in (null in talk/MC parts). */
  song: string | null;
  facingFrom: number;
  facingTo: number;
  /** Where the move starts, [x, z] in three.js stage space. */
  at: [number, number];
  /** spin/turn: signed degrees, + = clockwise seen from above. */
  degrees?: number;
  clockwise?: boolean;
  side?: "left" | "right";
  /** walk: */
  from?: [number, number];
  to?: [number, number];
  distance?: number;
  heading?: number;
  direction?: string;
  relFacing?: "forwards" | "backwards" | "sideways";
}

export interface MovesFile {
  format: string;
  params: Record<string, number>;
  /** Character id -> events, sorted by start. */
  members: Record<string, MoveEvent[]>;
}

/** Seconds of warning before a move: you can't look at the screen once you're spinning. */
export const LEAD_SECONDS = 1.5;

/** moves.json for a live, or null when it's missing or unreadable (cues then stay off). */
export async function loadMoves(liveBase: string): Promise<MovesFile | null> {
  try {
    const r = await fetch(`${liveBase}/moves.json`);
    if (!r.ok) return null;
    const j = (await r.json()) as MovesFile;
    if (!j || typeof j.format !== "string" || !j.format.startsWith("live-moves/") || typeof j.members !== "object") return null;
    return j;
  } catch {
    return null;
  }
}

/**
 * Lead time in video seconds. At faster rates it's stretched so the warning still comes
 * LEAD_SECONDS of wall time ahead; slow-mo keeps it in song time (more warning, not less).
 */
export const leadFor = (rate: number) => LEAD_SECONDS * Math.max(1, rate);

/** Moves announced or under way at t (at most two, earliest first). */
export function activeMoves(events: MoveEvent[] | undefined, t: number, lead: number): MoveEvent[] {
  if (!events) return [];
  const out: MoveEvent[] = [];
  for (const e of events) {
    if (e.start - lead > t) break;
    if (t < e.end) out.push(e);
  }
  return out.slice(0, 2);
}

/**
 * Who the cues are for: the followed member, else the only member on stage that isn't hidden
 * (e.g. when soloing one), else nobody.
 */
export function cueMemberFor(follow: number | null, onStage: Set<number>, hidden: number[]): number | null {
  if (follow !== null) return follow;
  const shown = [...onStage].filter((c) => !hidden.includes(c));
  return shown.length === 1 ? shown[0] : null;
}

/** "a full turn", "1¼ turns" … from degrees. */
function turnsText(deg: number): string {
  const q = Math.max(1, Math.round(Math.abs(deg) / 90));
  if (q === 1) return "a quarter turn";
  if (q === 2) return "a half turn";
  if (q === 3) return "a ¾ turn";
  if (q === 4) return "a full turn";
  const whole = Math.floor(q / 4);
  const frac = ["", "¼", "½", "¾"][q % 4];
  return `${whole}${frac} turns`;
}

export interface Cue {
  /** "Spin to your right", "Walk downstage left 2 m". */
  title: string;
  /** Second line: size of the move, where it goes. */
  detail: string;
  /** Glyph as it appears on screen (follows the mirror). */
  glyph: string;
  /** Seconds until it starts (> 0 during the lead-in), negative once under way. */
  until: number;
  /** 0..1 progress through the lead-in, then through the move. */
  progress: number;
}

/**
 * Cue wording for a move at time t. The words always name the real move ("your right" is the
 * dancer's right): with Mirror on you copy the screen like a studio mirror, which already puts
 * you on the real side. Only the glyph follows the picture, so it matches the mirrored figure.
 */
export function describeMove(e: MoveEvent, t: number, lead: number, mirror: boolean): Cue {
  const until = e.start - t;
  const progress = until > 0 ? 1 - until / lead : Math.min(1, (t - e.start) / Math.max(0.05, e.end - e.start));
  const notes: string[] = [];
  let title: string;
  let glyph: string;
  if (e.kind === "walk") {
    const dir = e.direction ?? "";
    const m = Math.max(0.5, Math.round((e.distance ?? 0) * 2) / 2);
    const verb = e.relFacing === "backwards" ? "Back up" : e.relFacing === "sideways" ? "Side-step" : "Walk";
    title = `${verb} ${dir} ${m} m`;
    const toward = [/downstage/.test(dir) ? "towards" : /upstage/.test(dir) ? "away from" : "", "the audience"];
    // stage left = the performer's left = the audience's right
    const lr = /left/.test(dir) ? "right" : /right/.test(dir) ? "left" : "";
    if (toward[0] && lr) notes.push(`${toward[0]} the audience, to its ${lr}`);
    else if (toward[0]) notes.push(toward.join(" "));
    else if (lr) notes.push(`to the audience's ${lr}`);
    glyph = "➜";
  } else {
    const side = (e.side ?? "right") as "left" | "right";
    title = e.kind === "spin" ? `Spin to your ${side}` : `Turn to your ${side}`;
    notes.push(turnsText(e.degrees ?? 0));
    const onScreen = mirror ? (side === "left" ? "right" : "left") : side;
    glyph = onScreen === "right" ? "↻" : "↺";
  }
  return { title, detail: notes.join(" · "), glyph, until, progress };
}

/**
 * Screen-space angle (radians, 0 = right, counter-clockwise) of a floor vector seen through the
 * stage's main camera, or null if it's too short on screen or starts/ends behind the camera.
 * The camera itself is never mirrored (LiveStage mirrors at render time), so flip x for `mirror`.
 */
export function screenAngle(stage: LiveStage, from: [number, number], to: [number, number], mirror: boolean): number | null {
  const cam = stage.camera;
  const a = new THREE.Vector3(from[0], 0, from[1]);
  const b = new THREE.Vector3(to[0], 0, to[1]);
  const behind = (p: THREE.Vector3) => p.clone().applyMatrix4(cam.matrixWorldInverse).z >= 0;
  if (behind(a) || behind(b)) return null;
  a.project(cam);
  b.project(cam);
  const dx = (b.x - a.x) * cam.aspect * (mirror ? -1 : 1); // NDC x spans the width: scale to y's units
  const dy = b.y - a.y;
  if (Math.hypot(dx, dy) < 1e-4) return null;
  return Math.atan2(dy, dx);
}

const ARROW_Y = 0.015;

/** Flat arrow along the floor from a to b (three.js xz), in world coordinates. */
function walkArrowGeometry(a: [number, number], b: [number, number]): THREE.BufferGeometry {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len;
  const uz = dz / len;
  const nx = -uz;
  const nz = ux;
  const w = 0.07;
  const head = Math.min(0.35, len * 0.4);
  const hw = 0.2;
  const sx = b[0] - ux * head;
  const sz = b[1] - uz * head;
  const p = (x: number, z: number) => [x, ARROW_Y, z];
  const verts = [
    // shaft (two triangles)
    ...p(a[0] + nx * w, a[1] + nz * w), ...p(a[0] - nx * w, a[1] - nz * w), ...p(sx - nx * w, sz - nz * w),
    ...p(a[0] + nx * w, a[1] + nz * w), ...p(sx - nx * w, sz - nz * w), ...p(sx + nx * w, sz + nz * w),
    // head
    ...p(sx + nx * hw, sz + nz * hw), ...p(sx - nx * hw, sz - nz * hw), ...p(b[0], b[1]),
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  return g;
}

/**
 * Arc arrow on the floor round the origin, starting straight ahead (+z) and sweeping `sweep`
 * radians (three.js: positive = counter-clockwise from above, so a clockwise spin is negative).
 */
function arcArrowGeometry(radius: number, sweep: number): THREE.BufferGeometry {
  const w = 0.06;
  const headLen = 0.28;
  const dir = Math.sign(sweep) || 1;
  const bodyEnd = sweep - dir * (headLen / radius);
  const n = Math.max(8, Math.ceil(Math.abs(bodyEnd) / 0.08));
  const at = (phi: number, r: number) => [Math.sin(phi) * r, ARROW_Y, Math.cos(phi) * r];
  const verts: number[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = (bodyEnd * i) / n;
    const p1 = (bodyEnd * (i + 1)) / n;
    verts.push(...at(p0, radius - w), ...at(p0, radius + w), ...at(p1, radius + w));
    verts.push(...at(p0, radius - w), ...at(p1, radius + w), ...at(p1, radius - w));
  }
  verts.push(...at(bodyEnd, radius - 0.17), ...at(bodyEnd, radius + 0.17), ...at(sweep, radius));
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  return g;
}

/**
 * Floor arrows for the cue member's announced moves: a straight arrow from where a walk starts
 * to where it ends, a curved one round her for spins and turns. Lives in the stage's scene;
 * call update() every frame before the stage renders.
 */
export class MoveArrows {
  readonly group = new THREE.Group();
  private meshes = new Map<string, THREE.Mesh>();

  constructor() {
    this.group.renderOrder = 5;
  }

  update(stage: LiveStage, t: number, events: MoveEvent[] | undefined, cid: number | null, lead: number) {
    if (this.group.parent !== stage.scene) stage.scene.add(this.group);
    const live = new Set<string>();
    const member = cid === null ? undefined : stage.members.get(cid);
    if (member?.present) {
      for (const e of activeMoves(events, t, lead)) {
        live.add(e.id);
        let mesh = this.meshes.get(e.id);
        if (!mesh) {
          const geom = e.kind === "walk" && e.from && e.to
            ? walkArrowGeometry(e.from, e.to)
            : arcArrowGeometry(e.kind === "spin" ? 0.6 : 0.45, -THREE.MathUtils.degToRad(Math.sign(e.degrees ?? 0) * Math.min(330, Math.abs(e.degrees ?? 0))));
          const mat = new THREE.MeshBasicMaterial({
            color: MEMBER_COLORS[member.cid] ?? "#ffffff", transparent: true, depthWrite: false, side: THREE.DoubleSide,
          });
          mesh = new THREE.Mesh(geom, mat);
          mesh.renderOrder = 5;
          // the arc starts from the way she faces when the move begins (Unity heading: + = three.js -x)
          if (e.kind !== "walk") mesh.rotation.y = -THREE.MathUtils.degToRad(e.facingFrom);
          this.meshes.set(e.id, mesh);
          this.group.add(mesh);
        }
        const until = e.start - t;
        // fade in over the lead-in, then hold while the move plays
        (mesh.material as THREE.MeshBasicMaterial).opacity = until > 0 ? 0.35 + 0.5 * (1 - until / lead) : 0.6;
        if (e.kind !== "walk") mesh.position.set(member.hips.x, 0, member.hips.z); // round her, wherever she is
      }
    }
    for (const [id, mesh] of this.meshes) {
      if (live.has(id)) continue;
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      this.group.remove(mesh);
      this.meshes.delete(id);
    }
  }
}
