// Headless check of the PJSK spring bones (src/engine/castSwap/utjSpringBone.ts) on exported GLBs.
// It rebuilds each GLB's node tree (TRS + extras) without three's loader, so it runs under node:
//
//   node_modules/.bin/esbuild scripts/pjsk_spring_check.ts --bundle --platform=node --format=esm \
//     --outfile=/tmp/pjsk_spring_check.mjs && node /tmp/pjsk_spring_check.mjs <command> ...
//
//   all <model dir> [scale] [fix]   every model: rest, then a hip sway; largest bone angle, NaN
//   pose <glb> <pose> [fix]         settle in a pose (rest | seated | tilt<deg>, e.g. tilt-40) and
//                                   report strand tips / bone segments inside colliders
//
// `fix` turns on the cast swap's readerCollision; without it the port is exactly the game.
import * as fs from "node:fs";
import * as path from "node:path";
import * as THREE from "three";
import { createUtjSpringBones } from "../src/engine/castSwap/utjSpringBone";

interface Loaded {
  model: THREE.Group;
  nodes: THREE.Object3D[];
}

function load(file: string): Loaded {
  const b = fs.readFileSync(file);
  const n = b.readUInt32LE(12);
  const g = JSON.parse(b.subarray(20, 20 + n).toString());
  const nodes: THREE.Object3D[] = g.nodes.map((nd: any) => {
    const o = new THREE.Object3D();
    o.name = nd.name;
    if (nd.translation) o.position.fromArray(nd.translation);
    if (nd.rotation) o.quaternion.fromArray(nd.rotation);
    if (nd.scale) o.scale.fromArray(nd.scale);
    o.userData = nd.extras ?? {};
    return o;
  });
  g.nodes.forEach((nd: any, i: number) => (nd.children ?? []).forEach((c: number) => nodes[i].add(nodes[c])));
  const model = new THREE.Group();
  model.add(nodes[g.scenes[0].nodes[0]]);
  return { model, nodes };
}

const deg = THREE.MathUtils.degToRad;

function checkAll(dir: string, scale: number, fix: boolean) {
  for (const id of fs.readdirSync(dir).sort()) {
    const { model } = load(path.join(dir, id, `${id}.glb`));
    const springs = createUtjSpringBones(model, { readerCollision: fix })!;
    model.scale.setScalar(scale);
    springs.reset();
    const bones: THREE.Object3D[] = [];
    model.traverse((o) => o.userData.utjSpringBone && bones.push(o));
    const rest = bones.map((b) => b.quaternion.clone());
    const hip = model.getObjectByName("Hip")!;
    let restMax = 0;
    let restWorst = "";
    let swayMax = 0;
    let swayWorst = "";
    let nan = false;
    for (let f = 0; f < 600; f++) {
      const t = (f - 120) / 60; // 3 periods of sin(4t), starting and ending at 0
      hip.position.x = t >= 0 && t < (3 * Math.PI) / 2 ? 0.15 * Math.sin(4 * t) : 0;
      springs.update(1 / 60);
      bones.forEach((b, i) => {
        const a = THREE.MathUtils.RAD2DEG * b.quaternion.angleTo(rest[i]);
        if (Number.isNaN(a)) nan = true;
        if (f < 120 && a > restMax) [restMax, restWorst] = [a, b.name];
        if (f >= 120 && a > swayMax) [swayMax, swayWorst] = [a, b.name];
      });
    }
    console.log(
      `${id.padEnd(10)} bones ${String(springs.bones).padStart(2)}  rest max ${restMax.toFixed(1).padStart(5)}° (${restWorst})` +
        `  sway max ${swayMax.toFixed(1).padStart(5)}° (${swayWorst})  NaN ${nan}`
    );
  }
}

function setPose({ model }: Loaded, pose: string) {
  const get = (name: string) => model.getObjectByName(name)!;
  const wristOf = (side: string) => {
    model.updateMatrixWorld(true);
    return new THREE.Vector3().setFromMatrixPosition(get(`${side}_Wrist`).matrixWorld);
  };
  if (pose.startsWith("tilt")) {
    // the head tilted toward a shoulder and down
    const a = Number(pose.slice(4) || 25);
    get("Neck").quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(deg(15), 0, deg(a))));
    get("Head").quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(deg(10), 0, deg(a / 2))));
  } else if (pose === "seated") {
    // arms down at the sides, forearms forward, as in the seated story motions
    for (const side of ["Left", "Right"]) {
      const turn = (bone: THREE.Object3D, restQ: THREE.Quaternion, axis: THREE.Vector3, d: number) =>
        bone.quaternion.copy(restQ).multiply(new THREE.Quaternion().setFromAxisAngle(axis, deg(d)));
      const arm = get(`${side}_Arm`);
      const armRest = arm.quaternion.clone();
      const z = new THREE.Vector3(0, 0, 1);
      turn(arm, armRest, z, 70);
      const down = wristOf(side).y;
      turn(arm, armRest, z, -70);
      if (down < wristOf(side).y) turn(arm, armRest, z, 70);
      const elbow = get(`${side}_Elbow`);
      const elbowRest = elbow.quaternion.clone();
      let best = { z: -Infinity, axis: z, d: 0 };
      for (const axis of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), z])
        for (const d of [80, -80]) {
          turn(elbow, elbowRest, axis, d);
          const fz = wristOf(side).z;
          if (fz > best.z) best = { z: fz, axis, d };
        }
      turn(elbow, elbowRest, best.axis, best.d);
    }
  } else if (pose !== "rest") {
    throw new Error(`unknown pose ${pose}`);
  }
}

interface Col {
  node: THREE.Object3D;
  type: string;
  radius: number;
  height: number;
}

function signedDistance(c: Col, p: THREE.Vector3): number {
  const local = p.clone().applyMatrix4(c.node.matrixWorld.clone().invert());
  if (c.type === "sphere") return local.length() - c.radius;
  const y = THREE.MathUtils.clamp(local.y, 0, c.height);
  return local.sub(new THREE.Vector3(0, y, 0)).length() - c.radius;
}

function checkPose(file: string, pose: string, fix: boolean) {
  const loaded = load(file);
  const { model, nodes } = loaded;
  const springs = createUtjSpringBones(model, { readerCollision: fix })!;
  setPose(loaded, pose);
  for (let f = 0; f < 240; f++) springs.update(1 / 60);
  model.updateMatrixWorld(true);

  const colliders: Col[] = nodes.filter((o) => o.userData.utjSpringCollider).map((o) => ({ node: o, ...o.userData.utjSpringCollider }));
  const head = model.getObjectByName("Neck")!;
  let ownWorst = 0;
  const tips: string[] = [];
  const segments: string[] = [];
  for (const o of nodes) {
    const s = o.userData.utjSpringBone;
    // the head manager's bones (hair, head accessories)
    if (!s || !head.userData.utjSpringManager?.springBones?.includes(o.userData.utjNode)) continue;
    const own = new Set([...(s.sphereColliders ?? []), ...(s.capsuleColliders ?? [])].map((i: number) => nodes[i]));
    const from = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
    const tip = new THREE.Vector3().setFromMatrixPosition(o.children[0].matrixWorld);
    for (const c of colliders) {
      const d = signedDistance(c, tip) - s.radius;
      if (own.has(c.node)) ownWorst = Math.max(ownWorst, -d);
      if (d < -0.005) tips.push(`${o.name.padEnd(22)} tip inside ${c.node.name.padEnd(36)} by ${(-d * 100).toFixed(1)} cm${own.has(c.node) ? " (own)" : ""}`);
    }
    let worst = { d: Infinity, t: 0, c: "" };
    for (let t = 0.1; t < 0.95; t += 0.1) {
      const p = from.clone().lerp(tip, t);
      for (const c of colliders.filter((c) => c.node.name.includes("Chest"))) {
        const d = signedDistance(c, p) - s.radius;
        if (d < worst.d) worst = { d, t, c: c.node.name };
      }
    }
    if (worst.d < -0.005) segments.push(`${o.name.padEnd(22)} bone at ${(worst.t * 100).toFixed(0)}% inside ${worst.c} by ${(-worst.d * 100).toFixed(1)} cm`);
  }
  console.log(`${path.basename(file)} pose ${pose}${fix ? " (readerCollision)" : ""}: deepest tip inside its own colliders ${(ownWorst * 100).toFixed(2)} cm`);
  console.log(tips.join("\n") || "no tip inside any collider");
  console.log(segments.join("\n") || "no bone inside the chest colliders");
}

const [command, a, b, c] = process.argv.slice(2);
if (command === "all") checkAll(a, b && b !== "fix" ? Number(b) : 1, c === "fix" || b === "fix");
else if (command === "pose") checkPose(a, b ?? "rest", c === "fix");
else console.error("usage: all <model dir> [scale] [fix] | pose <glb> <pose> [fix]");
