import { useEffect, useRef, type PointerEvent, type RefObject } from "react";
import * as THREE from "three";
import { MEMBER_COLORS, type LiveStage } from "./LiveStage";

/**
 * Formation minimap: the stage from above with the audience at the bottom, one dot per member on
 * stage (her symbol icon, or colour + initial until it loads; facing wedge) and the path each will take over the next couple of seconds, so
 * a dance group can see where everyone stands and where they're heading. Click a dot to follow her.
 *
 * Drawn on its own canvas from its own requestAnimationFrame loop, reading the stage's state from
 * its last update; React only re-renders it when the props change.
 *
 * Orientation: map right = three.js +x = screen right in the front camera (the top camera's view,
 * audience at the bottom). With Mirror on, the map flips left/right like the 3D view, so a dancer
 * facing the screen sees everyone on the same side as in the mirrored video, i.e. on her own side.
 * Only positions and facings flip; the icons are drawn unmirrored so their symbols stay readable.
 */

type StageMember = LiveStage["members"] extends Map<number, infer M> ? M : never;

/** Canvas size, CSS px. */
const W = 280;
const H = 196;
/** Seconds of path shown ahead of the playhead, and the spacing of its samples. */
const AHEAD = 2;
const STEP = 0.1;
const POINTS = Math.round(AHEAD / STEP);
/** Cached future samples per member (power of two, > POINTS). */
const RING = 32;
/** Map bounds: margin round the members (m), minimum size (m), hold before shrinking (ms), easing (s). */
const PAD = 0.8;
const MIN_HALF_W = 3;
const MIN_DEPTH = 4;
const SHRINK_MS = 2000;
const EASE = 0.35;
/** Plot area inside the canvas (px): title row at the top, audience label at the bottom. */
const INSET = { left: 10, right: 10, top: 18, bottom: 20 };

interface MapMember {
  cid: number;
  m: StageMember;
  color: string;
  /** Text colour on the dot. */
  ink: string;
  label: string;
  /** Her symbol icon (round, member colour + white symbol) once decoded; null while loading or if missing. */
  icon: HTMLImageElement | null;
  /** Future positions (x, z) by grid index g (time g * STEP), slot g & (RING - 1). */
  ahead: Float32Array;
  keys: Int32Array;
  /** Where her dot was drawn last frame (px), for clicks; NaN when not drawn. */
  sx: number;
  sy: number;
}

interface Bounds {
  /** Half width (m) about the stage's centre line x = 0, so the centre stays mid-map. */
  halfW: number;
  /** Back (z0) and front (z1) edges (m); +z is towards the audience. */
  z0: number;
  z1: number;
}

/** First letter, plus a later one where several members share it (Kozue/Kaho/Kosuzu: Ko, Ka, Ks). */
function initials(names: string[]): string[] {
  const first = names.map((n) => n.charAt(0).toUpperCase());
  const used = new Set<string>();
  return names.map((n, i) => {
    if (first.filter((f) => f === first[i]).length === 1) return first[i];
    for (const c of n.slice(1).toLowerCase()) {
      const l = first[i] + c;
      if (!used.has(l)) {
        used.add(l);
        return l;
      }
    }
    return first[i];
  });
}

function inkFor(hex: string): string {
  const c = new THREE.Color(hex);
  return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b > 0.6 ? "#0b0e14" : "#ffffff";
}

function buildMembers(stage: LiveStage, iconBase: string): MapMember[] {
  const ms = [...stage.members.values()];
  const labels = initials(ms.map((m) => m.name));
  return ms.map((m, i) => {
    const color = MEMBER_COLORS[m.cid] ?? "#ffffff";
    const mm: MapMember = {
      cid: m.cid, m, color, ink: inkFor(color), label: labels[i], icon: null,
      // empty slots hold INT32_MIN: -1 is a real grid index when the playhead is just below 0
      ahead: new Float32Array(RING * 2), keys: new Int32Array(RING).fill(-0x80000000), sx: NaN, sy: NaN,
    };
    const img = new Image();
    img.src = `${iconBase}/icon_charasymbol_${m.cid}.png`;
    img.decode().then(() => (mm.icon = img), () => undefined); // no icon: keep the lettered dot
    return mm;
  });
}

export default function Minimap({ stageRef, iconBase, mirror, onPick }: {
  stageRef: RefObject<LiveStage | null>;
  /** Folder of icon_charasymbol_<characterId>.png. */
  iconBase: string;
  mirror: boolean;
  onPick: (cid: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mirrorRef = useRef(mirror);
  mirrorRef.current = mirror;
  const membersRef = useRef<MapMember[]>([]);
  /** Dot radius of the last frame (px), for hit testing. */
  const radiusRef = useRef(8);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    let raf = 0;
    let stage: LiveStage | null = null;
    let members: MapMember[] = [];
    let held: Bounds | null = null;
    const view: Bounds = { halfW: MIN_HALF_W, z0: -MIN_DEPTH / 2, z1: MIN_DEPTH / 2 };
    const target: Bounds = { halfW: 0, z0: 0, z1: 0 };
    let shrinkSince: number | null = null;
    let last = performance.now();
    let lastSig = "";
    /** The view has stopped easing towards its bounds (redraws can be skipped while paused). */
    let settled = false;
    const tmp = new THREE.Vector3();
    let dotFontPx = 0;
    let dotFont = "";
    // stage metres -> canvas px, set each frame
    let scale = 1, dir = 1, cx = 0, cy = 0, zMid = 0;
    const sx = (x: number) => cx + dir * x * scale;
    const sy = (z: number) => cy + (z - zMid) * scale;

    /** Cache mm's position at grid index g (time g * STEP); false while she's off stage or it isn't loaded. */
    const aheadAt = (mm: MapMember, g: number): boolean => {
      const slot = g & (RING - 1);
      if (mm.keys[slot] === g) return true;
      if (!stage!.positionAt(mm.cid, g * STEP, tmp)) return false;
      mm.keys[slot] = g;
      mm.ahead[slot * 2] = tmp.x;
      mm.ahead[slot * 2 + 1] = tmp.z;
      return true;
    };

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const s = stageRef.current;
      if (!s) return;
      if (s !== stage) {
        stage = s;
        members = buildMembers(s, iconBase);
        membersRef.current = members;
        held = null;
      }
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const t = s.time;
      // nothing to redraw while paused with the same view: skip until something changes
      let icons = 0, vis = 0;
      for (const mm of members) {
        if (mm.icon) icons++;
        vis = vis * 2 + (mm.m.visible ? 1 : 0);
      }
      const sig = `${t}|${s.follow}|${mirrorRef.current}|${icons}|${vis}`;
      if (sig === lastSig && settled) return;
      lastSig = sig;
      const g0 = Math.floor(t / STEP) + 1;

      // bounds of everyone on stage now and over the next AHEAD seconds
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const mm of members) {
        const m = mm.m;
        if (m.present && m.onStage) {
          minX = Math.min(minX, m.hips.x); maxX = Math.max(maxX, m.hips.x);
          minZ = Math.min(minZ, m.hips.z); maxZ = Math.max(maxZ, m.hips.z);
        }
        for (let k = 0; k < POINTS; k++) {
          const g = g0 + k;
          if (!aheadAt(mm, g)) continue;
          const slot = (g & (RING - 1)) * 2;
          const x = mm.ahead[slot], z = mm.ahead[slot + 1];
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
        }
      }
      if (minX <= maxX) {
        // whole metres, so the map only rescales when someone crosses a grid line
        target.halfW = Math.max(MIN_HALF_W, Math.ceil(Math.max(-minX, maxX) + PAD));
        target.z0 = Math.floor(minZ - PAD);
        target.z1 = Math.ceil(maxZ + PAD);
        const extra = MIN_DEPTH - (target.z1 - target.z0);
        if (extra > 0) {
          target.z0 -= Math.floor(extra / 2);
          target.z1 += Math.ceil(extra / 2);
        }
        if (!held) {
          held = { ...target };
          Object.assign(view, target);
        }
        // grow at once, shrink only once the formation has stayed smaller for a while
        held.halfW = Math.max(held.halfW, target.halfW);
        held.z0 = Math.min(held.z0, target.z0);
        held.z1 = Math.max(held.z1, target.z1);
        if (target.halfW < held.halfW || target.z0 > held.z0 || target.z1 < held.z1) {
          shrinkSince ??= now;
          if (now - shrinkSince > SHRINK_MS) {
            Object.assign(held, target);
            shrinkSince = null;
          }
        } else shrinkSince = null;
      }
      if (held) {
        const k = 1 - Math.exp(-dt / EASE);
        view.halfW += (held.halfW - view.halfW) * k;
        view.z0 += (held.z0 - view.z0) * k;
        view.z1 += (held.z1 - view.z1) * k;
      }
      settled = !!held && shrinkSince === null && Math.abs(held.halfW - view.halfW) < 1e-3
        && Math.abs(held.z0 - view.z0) < 1e-3 && Math.abs(held.z1 - view.z1) < 1e-3;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (canvas.width !== Math.round(W * dpr)) {
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingQuality = "high"; // icons are 80 px, drawn at ~20
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = "rgba(11, 14, 20, 0.8)";
      ctx.beginPath();
      ctx.roundRect(0.5, 0.5, W - 1, H - 1, 6);
      ctx.fill();
      ctx.strokeStyle = "rgba(100, 116, 139, 0.5)";
      ctx.lineWidth = 1;
      ctx.stroke();

      const innerW = W - INSET.left - INSET.right;
      const innerH = H - INSET.top - INSET.bottom;
      scale = Math.min(innerW / (2 * view.halfW), innerH / (view.z1 - view.z0));
      dir = mirrorRef.current ? -1 : 1;
      cx = INSET.left + innerW / 2;
      cy = INSET.top + innerH / 2;
      zMid = (view.z0 + view.z1) / 2;

      // 1 m grid over the plot area, centre line stronger
      ctx.save();
      ctx.beginPath();
      ctx.rect(INSET.left, INSET.top, innerW, innerH);
      ctx.clip();
      ctx.strokeStyle = "rgba(148, 163, 184, 0.13)";
      ctx.beginPath();
      const xr = Math.ceil(innerW / 2 / scale);
      for (let x = -xr; x <= xr; x++) {
        if (x === 0) continue;
        const px = Math.round(sx(x)) + 0.5;
        ctx.moveTo(px, INSET.top);
        ctx.lineTo(px, INSET.top + innerH);
      }
      const zr = Math.ceil(innerH / 2 / scale) + 1;
      for (let z = Math.floor(zMid) - zr; z <= Math.ceil(zMid) + zr; z++) {
        const py = Math.round(sy(z)) + 0.5;
        ctx.moveTo(INSET.left, py);
        ctx.lineTo(INSET.left + innerW, py);
      }
      ctx.stroke();
      ctx.strokeStyle = "rgba(148, 163, 184, 0.35)";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(Math.round(cx) + 0.5, INSET.top);
      ctx.lineTo(Math.round(cx) + 0.5, INSET.top + innerH);
      ctx.stroke();
      ctx.setLineDash([]);

      // where everyone is going: the next AHEAD seconds, fading out, ending in a small ring
      const follow = s.follow;
      ctx.lineCap = "round";
      for (const mm of members) {
        const m = mm.m;
        const here = m.present && m.onStage;
        let px = here ? sx(m.hips.x) : NaN;
        let py = here ? sy(m.hips.z) : NaN;
        ctx.strokeStyle = mm.color;
        ctx.lineWidth = mm.cid === follow ? 2.5 : 1.75;
        const dim = m.visible ? 1 : 0.4;
        let k = 0;
        for (; k < POINTS; k++) {
          const g = g0 + k;
          if (!aheadAt(mm, g)) {
            if (Number.isNaN(px)) continue; // not on stage yet: the path starts where she enters
            break;
          }
          const slot = (g & (RING - 1)) * 2;
          const qx = sx(mm.ahead[slot]);
          const qy = sy(mm.ahead[slot + 1]);
          if (!Number.isNaN(px)) {
            ctx.globalAlpha = dim * (0.85 - (0.6 * k) / POINTS);
            ctx.beginPath();
            ctx.moveTo(px, py);
            ctx.lineTo(qx, qy);
            ctx.stroke();
          }
          px = qx;
          py = qy;
        }
        if (!Number.isNaN(px) && (k > 0 || !here)) {
          ctx.globalAlpha = dim * 0.6;
          ctx.lineWidth = 1.25;
          ctx.beginPath();
          ctx.arc(px, py, 2.5, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      ctx.restore();

      // members: facing wedge, dot, initial; the followed one last, ringed
      // 18-22 px across, big enough to read the symbols even when the formation is tight
      const r = Math.min(11, Math.max(9, 0.3 * scale));
      radiusRef.current = r;
      const fontPx = Math.round(r * 1.1);
      if (fontPx !== dotFontPx) {
        dotFontPx = fontPx;
        dotFont = `600 ${fontPx}px Inter, system-ui, sans-serif`;
      }
      ctx.font = dotFont;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      let followed: MapMember | null = null;
      for (const mm of members) {
        const m = mm.m;
        if (!(m.present && m.onStage)) {
          mm.sx = NaN;
          continue;
        }
        mm.sx = sx(m.hips.x);
        mm.sy = sy(m.hips.z);
        if (mm.cid === follow) followed = mm;
        else drawDot(ctx, mm, r, dir, false);
      }
      if (followed) drawDot(ctx, followed, r, dir, true);

      // labels
      ctx.font = "500 9px Inter, system-ui, sans-serif";
      ctx.fillStyle = "rgba(148, 163, 184, 0.9)";
      ctx.textAlign = "center";
      ctx.fillText("▼ AUDIENCE ▼", W / 2, H - 8);
      ctx.textAlign = "left";
      ctx.fillText(`Formation · next ${AHEAD} s`, 8, 10);
      if (mirrorRef.current) {
        ctx.textAlign = "right";
        ctx.fillStyle = "rgba(125, 211, 252, 0.9)";
        ctx.fillText("mirrored", W - 8, 10);
      }
      // scale bar: 1 m
      ctx.strokeStyle = "rgba(148, 163, 184, 0.9)";
      ctx.lineWidth = 1;
      const bx = W - 10 - scale;
      const by = H - 8;
      ctx.beginPath();
      ctx.moveTo(bx, by - 3);
      ctx.lineTo(bx, by);
      ctx.lineTo(bx + scale, by);
      ctx.lineTo(bx + scale, by - 3);
      ctx.stroke();
      ctx.fillStyle = "rgba(148, 163, 184, 0.9)";
      ctx.textAlign = "right";
      ctx.fillText("1 m", bx - 4, by - 1);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [stageRef, iconBase]);

  /** The on-stage member whose dot is under (x, y) (canvas px), nearest first. */
  const hit = (e: PointerEvent<HTMLCanvasElement>): number | null => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    const y = ((e.clientY - rect.top) / rect.height) * H;
    const reach = radiusRef.current + 4;
    let best: number | null = null;
    let bestD = reach * reach;
    for (const mm of membersRef.current) {
      if (Number.isNaN(mm.sx)) continue;
      const d = (mm.sx - x) ** 2 + (mm.sy - y) ** 2;
      if (d <= bestD) {
        bestD = d;
        best = mm.cid;
      }
    }
    return best;
  };

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-auto block"
      style={{ width: W, height: H }}
      onPointerDown={(e) => {
        const cid = hit(e);
        if (cid !== null) onPick(cid);
      }}
      onPointerMove={(e) => {
        const cursor = hit(e) !== null ? "pointer" : "default";
        if (e.currentTarget.style.cursor !== cursor) e.currentTarget.style.cursor = cursor;
      }}
      title="Formation from above, audience at the bottom. Lines show where each member goes in the next 2 s. Click a member to follow her (N hides the map)."
    />
  );
}

function drawDot(ctx: CanvasRenderingContext2D, mm: MapMember, r: number, dir: number, followed: boolean) {
  const m = mm.m;
  const x = mm.sx;
  const y = mm.sy;
  ctx.globalAlpha = m.visible ? 1 : 0.4;
  // facing wedge: a triangle poking out of the dot (map x flips with the mirror, z points down)
  const fx = dir * m.facing.x;
  const fz = m.facing.z;
  const tip = r + 7;
  const back = r + 1;
  const w = 0.45; // half-angle of the wedge's base seen from the dot's centre, radians
  const a = Math.atan2(fz, fx);
  ctx.fillStyle = mm.color;
  ctx.beginPath();
  ctx.moveTo(x + Math.cos(a) * tip, y + Math.sin(a) * tip);
  ctx.lineTo(x + Math.cos(a + w) * back, y + Math.sin(a + w) * back);
  ctx.lineTo(x + Math.cos(a - w) * back, y + Math.sin(a - w) * back);
  ctx.closePath();
  ctx.fill();
  if (mm.icon) ctx.drawImage(mm.icon, x - r, y - r, 2 * r, 2 * r); // never flipped, even when mirrored
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  if (!mm.icon) ctx.fill();
  ctx.lineWidth = followed ? 2 : 1;
  ctx.strokeStyle = followed ? "#ffffff" : "rgba(11, 14, 20, 0.85)";
  ctx.stroke();
  if (followed) {
    ctx.strokeStyle = "rgba(252, 211, 77, 0.9)";
    ctx.beginPath();
    ctx.arc(x, y, r + 3.5, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (!mm.icon) {
    ctx.fillStyle = mm.ink;
    ctx.fillText(mm.label, x, y + 0.5);
  }
  ctx.globalAlpha = 1;
}
