import * as THREE from "three";

/**
 * Project Sekai's hair and skirt physics: UTJ SpringBone ("UnityChan SpringBone" release 1.1,
 * github.com/unity3d-jp/UnityChanSpringBone, MIT, (c) Unity Technologies Japan), which PJSK ships
 * as `SpringManager` / `SpringBone` / `Sekai.SekaiSpringBone`. A line-by-line port of
 * Runtime/SpringManager.cs, SpringBone.cs, AngleLimits.cs and Colliders/Spring{Sphere,Capsule}Collider.cs,
 * checked against PJSK's build (JP libil2cpp: SpringManager.UpdateDynamics 0xA6160F8,
 * SpringBone.UpdateSpring 0xA613EB8, SatisfyConstraintsAndComputeRotation 0xA614154,
 * ApplyAngleLimits 0xA614BFC are upstream's code). Hand-rolled on purpose and only for the cast
 * swap (the user approved this exception); the Hasu models' own MagicaCloth isn't touched.
 *
 * The data are node extras written by scripts/export_pjsk_model.py (`utjSpringManager`,
 * `utjSpringBone`, `utjSpringCollider`, references by `utjNode` index). Body colliders selected by
 * a SekaiSpringBone's colliderFlag are already appended there (ModelUtility.SpringBoneSetup).
 *
 * Differences from the game, all for the reader:
 * - Simulation runs in world space with the model's uniform scale `s` applied to every length and
 *   force (spring lengths, radii, springForce, gravity), so a scaled stand-in moves exactly like
 *   the native-size model. Unity applies the bone radius unscaled; PJSK models are never scaled.
 * - Fixed 1/simulationFrameRate steps from an accumulator of real frame time (at most 3 per
 *   frame), instead of one step per rendered frame (CalcTimeStep), so 120 Hz displays don't run
 *   the cloth at double speed. dt = 0 (paused / single redraws) doesn't step.
 * - Tips reset to the pose on screen when the character jumps (seek, cast change, rescale).
 * Not ported, because no PJSK model uses them: panel colliders, ground collision, wind/force
 * providers. Length limits are ported but disabled in every manager.
 * Glue for the glTF mirror (x -> -x): Unity's `-pivot.right` is the pivot's +X here, `-pivot.up`
 * and `-pivot.forward` stay -Y and -Z.
 */

interface AngleLimitsData {
  active: boolean;
  min: number;
  max: number;
}

interface SpringBoneData {
  stiffnessForce: number;
  dragForce: number;
  springForce: [number, number, number];
  pivotNode?: number | null;
  angularStiffness: number;
  yAngleLimits: AngleLimitsData;
  zAngleLimits: AngleLimitsData;
  lengthLimitTargets?: number[];
  radius: number;
  sphereColliders?: number[];
  capsuleColliders?: number[];
  panelColliders?: number[];
}

interface SpringManagerData {
  isPaused: boolean;
  simulationFrameRate: number;
  dynamicRatio: number;
  gravity: [number, number, number];
  bounce: number;
  friction: number;
  enableAngleLimits: boolean;
  enableCollision: boolean;
  enableLengthLimits: boolean;
  collideWithGround: boolean;
  springBones?: number[];
}

interface ColliderData {
  type: "sphere" | "capsule" | "panel";
  radius: number;
  height: number;
}

const enum CollisionStatus {
  NoCollision,
  HeadIsEmbedded,
  TailCollision,
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();

function worldRotation(node: THREE.Object3D, out: THREE.Quaternion): THREE.Quaternion {
  return out.setFromRotationMatrix(_m1.extractRotation(node.matrixWorld));
}

function worldPosition(node: THREE.Object3D, out: THREE.Vector3): THREE.Vector3 {
  return out.setFromMatrixPosition(node.matrixWorld);
}

function project(v: THREE.Vector3, onto: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const sq = onto.lengthSq();
  return sq < Number.EPSILON ? out.set(0, 0, 0) : out.copy(onto).multiplyScalar(v.dot(onto) / sq);
}

// ---- AngleLimits.cs ------------------------------------------------------------------------------

function computeFalloff(value: number, range: number): number {
  if (Math.abs(range) <= 0.0001) return 0;
  const n = THREE.MathUtils.clamp(value / range, 0, 1);
  return Math.min(n, Math.sqrt(n));
}

function constrainVector(
  limits: AngleLimitsData,
  basisSide: THREE.Vector3,
  basisUp: THREE.Vector3,
  basisForward: THREE.Vector3,
  springStrength: number,
  deltaTime: number,
  vector: THREE.Vector3
): void {
  const upProjection = project(vector, basisUp, _v1);
  const projection = _v2.copy(vector).sub(upProjection);
  const projectionMagnitude = projection.length();
  const originalSine = THREE.MathUtils.clamp(projection.divideScalar(projectionMagnitude).dot(basisSide), -1, 1);
  // Soft limits from Hooke's law to reduce jitter, then hard limits
  let newAngle = THREE.MathUtils.RAD2DEG * Math.asin(originalSine);
  const acceleration = -newAngle * springStrength;
  newAngle += acceleration * deltaTime * deltaTime;
  newAngle = THREE.MathUtils.clamp(newAngle, limits.min, limits.max);
  const curveLimit = newAngle < 0 ? limits.min : limits.max;
  newAngle = computeFalloff(newAngle, curveLimit) * curveLimit;
  const radians = THREE.MathUtils.DEG2RAD * newAngle;
  vector
    .copy(basisSide)
    .multiplyScalar(Math.sin(radians))
    .addScaledVector(basisForward, Math.cos(radians))
    .multiplyScalar(projectionMagnitude)
    .add(upProjection);
}

// ---- Colliders -----------------------------------------------------------------------------------

class Collider {
  readonly inverse = new THREE.Matrix4();
  /** |worldToLocal * (1, 0, 0)|: world -> local length */
  radiusScale = 1;
  constructor(
    readonly node: THREE.Object3D,
    readonly data: ColliderData
  ) {}
  /** SpringManager.PreUpdateCollider: the collider's world-to-local matrix for this step. */
  preUpdate() {
    this.inverse.copy(this.node.matrixWorld).invert();
    this.radiusScale = _v3.setFromMatrixColumn(this.inverse, 0).length();
  }
}

class Circle3 {
  origin = new THREE.Vector3();
  upVector = new THREE.Vector3();
  radius = 0;
}
const _circle = new Circle3();

/** SpringSphereCollider.ComputeIntersection (sphere-sphere intersection circle). */
function computeIntersection(
  originA: THREE.Vector3,
  radiusA: number,
  originB: THREE.Vector3,
  radiusB: number,
  out: Circle3
): boolean {
  const aToB = _v3.copy(originB).sub(originA);
  const dSqr = aToB.lengthSq();
  const d = Math.sqrt(dSqr);
  if (d <= 0) return false;
  const radiusASqr = radiusA * radiusA;
  const radiusBSqr = radiusB * radiusB;
  const denominator = 0.5 / d;
  const subTerm = dSqr - radiusBSqr + radiusASqr;
  const x = subTerm * denominator;
  const squaredTerm = subTerm * subTerm;
  out.radius = Math.sqrt(4 * dSqr * radiusASqr - squaredTerm) * denominator;
  out.upVector.copy(aToB).divideScalar(d);
  out.origin.copy(originA).addScaledVector(out.upVector, x);
  return true;
}

/** SpringSphereCollider.ComputeNewTailPosition: the closest point on the circle. */
function computeNewTailPosition(c: Circle3, tail: THREE.Vector3): void {
  tail.addScaledVector(c.upVector, -c.upVector.dot(_v3.copy(tail).sub(c.origin)));
  const v = _v3.copy(tail).sub(c.origin).normalize();
  tail.copy(c.origin).addScaledVector(v, c.radius);
}

/** SpringSphereCollider.CheckForCollisionAndReact (static, local space) */
function sphereCheckLocal(
  localHead: THREE.Vector3,
  localTail: THREE.Vector3,
  localTailRadius: number,
  sphereOrigin: THREE.Vector3,
  sphereRadius: number
): CollisionStatus {
  const combinedRadius = sphereRadius + localTailRadius;
  if (_v3.copy(localTail).sub(sphereOrigin).lengthSq() >= combinedRadius * combinedRadius) {
    return CollisionStatus.NoCollision;
  }
  if (_v3.copy(localHead).sub(sphereOrigin).lengthSq() <= sphereRadius * sphereRadius) {
    // The head is inside the sphere, so just try to push the tail out
    const dir = _v3.copy(localTail).sub(sphereOrigin).normalize();
    localTail.copy(sphereOrigin).addScaledVector(dir, combinedRadius);
    return CollisionStatus.HeadIsEmbedded;
  }
  const localHeadRadius = localTail.distanceTo(localHead);
  if (computeIntersection(localHead, localHeadRadius, sphereOrigin, combinedRadius, _circle)) {
    computeNewTailPosition(_circle, localTail);
  }
  return CollisionStatus.TailCollision;
}

const _localHead = new THREE.Vector3();
const _localTail = new THREE.Vector3();
const _origin = new THREE.Vector3();

function sphereCheck(c: Collider, head: THREE.Vector3, tail: THREE.Vector3, tailRadius: number, hitNormal: THREE.Vector3) {
  _localHead.copy(head).applyMatrix4(c.inverse);
  _localTail.copy(tail).applyMatrix4(c.inverse);
  // Unity: InverseTransformDirection(tailRadius, 0, 0) (rotation only); scaled here, see the top
  const result = sphereCheckLocal(_localHead, _localTail, tailRadius * c.radiusScale, _origin.set(0, 0, 0), c.data.radius);
  if (result !== CollisionStatus.NoCollision) {
    tail.copy(_localTail).applyMatrix4(c.node.matrixWorld);
    hitNormal.copy(_localTail).normalize().transformDirection(c.node.matrixWorld);
  }
  return result;
}

/** SpringCapsuleCollider.CheckForCollisionAndReact: a capsule along local +Y from 0 to height. */
function capsuleCheck(c: Collider, moverHead: THREE.Vector3, mover: THREE.Vector3, moverRadius: number, hitNormal: THREE.Vector3) {
  const { radius, height } = c.data;
  if (radius <= 0.0001) return CollisionStatus.NoCollision;
  const localHead = _localHead.copy(moverHead).applyMatrix4(c.inverse);
  const localMover = _localTail.copy(mover).applyMatrix4(c.inverse);
  const localMoverRadius = moverRadius * c.radiusScale;
  const moverIsAboveTop = localMover.y >= height;
  if (localMover.y <= 0 || moverIsAboveTop) {
    const sphereOrigin = _origin.set(0, moverIsAboveTop ? height : 0, 0);
    const combinedRadius = localMoverRadius + radius;
    if (_v3.copy(localMover).sub(sphereOrigin).lengthSq() >= combinedRadius * combinedRadius) {
      return CollisionStatus.NoCollision;
    }
    if (_v3.copy(localHead).sub(sphereOrigin).lengthSq() <= radius * radius) {
      // The head is inside the sphere, so just try to push the tail out
      const localHitNormal = _v2.copy(localMover).sub(sphereOrigin).normalize();
      localMover.copy(sphereOrigin).addScaledVector(localHitNormal, combinedRadius);
      mover.copy(localMover).applyMatrix4(c.node.matrixWorld);
      hitNormal.copy(localHitNormal).transformDirection(c.node.matrixWorld);
      return CollisionStatus.HeadIsEmbedded;
    }
    const localHeadRadius = localMover.distanceTo(localHead);
    if (computeIntersection(localHead, localHeadRadius, sphereOrigin, combinedRadius, _circle)) {
      computeNewTailPosition(_circle, localMover);
      mover.copy(localMover).applyMatrix4(c.node.matrixWorld);
      hitNormal.copy(localMover).sub(sphereOrigin).normalize().transformDirection(c.node.matrixWorld);
    }
    return CollisionStatus.TailCollision;
  }
  // Cylinder (CheckForCylinderCollisionAndReact)
  const combinedRadius = radius + localMoverRadius;
  const ox = localMover.x;
  const oz = localMover.z;
  const sq = ox * ox + oz * oz;
  if (sq > combinedRadius * combinedRadius) return CollisionStatus.NoCollision;
  const len = Math.sqrt(sq);
  const nx = len > 0 ? ox / len : 0;
  const nz = len > 0 ? oz / len : 0;
  mover.set(combinedRadius * nx, localMover.y, combinedRadius * nz).applyMatrix4(c.node.matrixWorld);
  hitNormal.set(nx, 0, nz).transformDirection(c.node.matrixWorld);
  return localHead.x * localHead.x + localHead.z * localHead.z <= radius * radius
    ? CollisionStatus.HeadIsEmbedded
    : CollisionStatus.TailCollision;
}

// ---- SpringBone.cs -------------------------------------------------------------------------------

class SpringBone {
  readonly boneAxis = new THREE.Vector3(-1, 0, 0);
  /** in the model's native units (multiplied by the scale each step) */
  springLength = 0;
  readonly initialLocalRotation = new THREE.Quaternion();
  readonly currTipPos = new THREE.Vector3();
  readonly prevTipPos = new THREE.Vector3();
  lengthsToLimitTargets: number[] = [];
  /** reader addition: also keep the bone's whole length out of its colliders (collideSegment) */
  segmentCollision = false;

  get allColliders(): Collider[] {
    return [...this.capsuleColliders, ...this.sphereColliders];
  }

  constructor(
    readonly node: THREE.Object3D,
    readonly data: SpringBoneData,
    readonly pivotNode: THREE.Object3D | null,
    readonly sphereColliders: Collider[],
    readonly capsuleColliders: Collider[],
    readonly lengthLimitTargets: THREE.Object3D[]
  ) {}

  /** Initialize: run on the rest pose, with `toNative` = the model's world-to-local matrix. */
  initialize(toNative: THREE.Matrix4) {
    const child = this.computeChildPosition(_v1);
    this.boneAxis.copy(child).applyMatrix4(_m1.copy(this.node.matrixWorld).invert()).normalize();
    this.initialLocalRotation.copy(this.node.quaternion);
    const nativeChild = child.clone().applyMatrix4(toNative);
    const nativeSelf = worldPosition(this.node, _v2).applyMatrix4(toNative);
    this.springLength = nativeChild.distanceTo(nativeSelf);
    this.lengthsToLimitTargets = this.lengthLimitTargets.map((t) =>
      worldPosition(t, _v2).applyMatrix4(toNative).distanceTo(nativeChild)
    );
  }

  computeChildPosition(out: THREE.Vector3): THREE.Vector3 {
    const children = this.node.children;
    const self = worldPosition(this.node, _v3);
    if (children.length === 0) {
      // "This should never happen": transform.position + transform.right * -0.1
      return out.setFromMatrixColumn(this.node.matrixWorld, 0).normalize().multiplyScalar(0.1).add(self);
    }
    if (children.length === 1) return worldPosition(children[0], out);
    const tail = out.set(0, 0, 0);
    let averageDistance = 0;
    const p = new THREE.Vector3();
    for (const c of children) {
      worldPosition(c, p);
      tail.add(p);
      averageDistance += p.distanceTo(self);
    }
    averageDistance /= children.length;
    tail.divideScalar(children.length);
    // selfPosition + averageDistance * normalize(initialTailPosition - selfPosition); tail is `out`
    return tail.sub(self).normalize().multiplyScalar(averageDistance).add(self);
  }

  /** The tip where the bone points with its rest local rotation, from the pose on screen. */
  reset(scale: number) {
    this.node.quaternion.copy(this.initialLocalRotation);
    this.node.updateMatrixWorld(true);
    const base = worldRotation(this.node.parent!, _q1).multiply(this.initialLocalRotation);
    worldPosition(this.node, this.currTipPos);
    this.currTipPos.add(_v1.copy(this.boneAxis).applyQuaternion(base).multiplyScalar(this.springLength * scale));
    this.prevTipPos.copy(this.currTipPos);
  }

  updateSpring(deltaTime: number, externalForce: THREE.Vector3, scale: number) {
    const baseWorldRotation = worldRotation(this.node.parent!, _q1).multiply(this.initialLocalRotation);
    const head = worldPosition(this.node, _v2);
    const springLength = this.springLength * scale;
    const orientedInitialPosition = _v1.copy(this.boneAxis).applyQuaternion(baseWorldRotation).multiplyScalar(springLength).add(head);

    // Hooke's law: force to push us to equilibrium
    const force = orientedInitialPosition.sub(this.currTipPos).multiplyScalar(this.data.stiffnessForce);
    force.addScaledVector(_v3.fromArray(this.data.springForce), scale).add(externalForce);
    force.multiplyScalar(0.5 * deltaTime * deltaTime);

    // Verlet
    force.addScaledVector(_v3.copy(this.currTipPos).sub(this.prevTipPos), 1 - this.data.dragForce);
    this.prevTipPos.copy(this.currTipPos);
    this.currTipPos.add(force);

    // Inlined FixBoneLength
    const headToTail = _v3.copy(this.currTipPos).sub(head);
    const magnitude = headToTail.length();
    if (magnitude <= 0.001 * scale) {
      headToTail.copy(this.boneAxis).applyQuaternion(worldRotation(this.node, _q2));
    } else {
      headToTail.divideScalar(magnitude);
    }
    this.currTipPos.copy(head).addScaledVector(headToTail, springLength);
  }

  satisfyConstraintsAndComputeRotation(m: SpringManager, deltaTime: number, scale: number) {
    if (m.data.enableLengthLimits) this.applyLengthLimits(deltaTime);
    if (m.data.enableCollision) {
      this.checkForCollision(m, scale);
      if (this.segmentCollision) this.collideSegment(scale);
    }
    if (m.data.enableAngleLimits) this.applyAngleLimits(deltaTime);
    // reader addition: the body wins over the angle limits (which UTJ applies last)
    if (m.data.enableCollision && this.segmentCollision) this.collideSegment(scale);

    const tip = this.currTipPos;
    if (Number.isNaN(tip.x) || Number.isNaN(tip.y) || Number.isNaN(tip.z)) this.reset(scale);

    // dynamicRatio only blends bones the current motion animates; the stand-in's spring bones
    // never are (the Hasu motions don't reach them), so the ratio is 1: the simulated rotation.
    this.computeRotation(this.node.quaternion);
    this.node.updateMatrixWorld(true);
  }

  private computeRotation(out: THREE.Quaternion) {
    const baseWorldRotation = worldRotation(this.node.parent!, _q1).multiply(this.initialLocalRotation);
    const localBoneVector = _v1
      .copy(this.currTipPos)
      .sub(worldPosition(this.node, _v2))
      .applyQuaternion(baseWorldRotation.invert())
      .normalize();
    const aimRotation = _q2.setFromUnitVectors(this.boneAxis, localBoneVector);
    out.copy(this.initialLocalRotation).multiply(aimRotation);
  }

  private applyAngleLimits(deltaTime: number) {
    const { yAngleLimits, zAngleLimits, angularStiffness } = this.data;
    if ((!yAngleLimits.active && !zAngleLimits.active) || !this.pivotNode) return;
    const origin = worldPosition(this.node, _head);
    const vector = _desired.copy(this.currTipPos).sub(origin);
    const pm = this.pivotNode.matrixWorld;
    const forward = _forward.setFromMatrixColumn(pm, 0).normalize(); // Unity -pivot.right
    const down = _down.setFromMatrixColumn(pm, 1).normalize().negate(); // -pivot.up
    const back = _back.setFromMatrixColumn(pm, 2).normalize().negate(); // -pivot.forward
    if (yAngleLimits.active) constrainVector(yAngleLimits, down, back, forward, angularStiffness, deltaTime, vector);
    if (zAngleLimits.active) constrainVector(zAngleLimits, back, down, forward, angularStiffness, deltaTime, vector);
    this.currTipPos.copy(origin).add(vector);
  }

  private checkForCollision(m: SpringManager, scale: number) {
    const desiredPosition = _desired.copy(this.currTipPos);
    const head = worldPosition(this.node, _head);
    const scaledRadius = this.data.radius * scale;
    const hitNormal = _hitNormal.set(0, 0, 1);
    let hadCollision = false;
    for (const c of this.capsuleColliders) {
      hadCollision = capsuleCheck(c, head, this.currTipPos, scaledRadius, hitNormal) !== CollisionStatus.NoCollision || hadCollision;
    }
    for (const c of this.sphereColliders) {
      hadCollision = sphereCheck(c, head, this.currTipPos, scaledRadius, hitNormal) !== CollisionStatus.NoCollision || hadCollision;
    }
    if (!hadCollision) return;
    const reflectedVector = desiredPosition.sub(this.prevTipPos).reflect(hitNormal);
    // friction
    const upwardComponent = _v1.copy(hitNormal).multiplyScalar(reflectedVector.dot(hitNormal));
    const lateralComponent = reflectedVector.sub(upwardComponent);
    const bounceVelocity = upwardComponent.multiplyScalar(m.data.bounce).addScaledVector(lateralComponent, 1 - m.data.friction);
    if (bounceVelocity.lengthSq() > 0.0001 * scale * scale) {
      const distanceTraveled = this.currTipPos.distanceTo(this.prevTipPos);
      this.prevTipPos.copy(this.currTipPos).sub(bounceVelocity);
      const speed = bounceVelocity.length();
      this.currTipPos.addScaledVector(bounceVelocity.divideScalar(speed), Math.max(0, speed - distanceTraveled));
    } else {
      this.prevTipPos.copy(this.currTipPos);
    }
  }

  /**
   * Reader addition (not in UTJ or PJSK, see `readerCollision`): UTJ only keeps the tip out of
   * colliders, so the middle of a bone can still cut through a sphere or capsule. Find the point
   * of the bone (head -> tip) closest to each collider's axis and, if it's inside, turn the bone
   * about its head so that point clears the surface. The velocity is kept (prevTipPos moves too).
   */
  private collideSegment(scale: number) {
    const head = worldPosition(this.node, _segHead);
    const boneRadius = this.data.radius * scale;
    const length = this.springLength * scale;
    for (let pass = 0; pass < SEGMENT_PASSES; pass++) {
      for (const c of this.allColliders) {
        const m = c.node.matrixWorld;
        _axisA.setFromMatrixPosition(m);
        if (c.data.type === "capsule") _axisB.set(0, c.data.height, 0).applyMatrix4(m);
        else _axisB.copy(_axisA);
        const combined = c.data.radius * _v3.setFromMatrixColumn(m, 0).length() + boneRadius;
        // A head inside the collider can't be cleared by turning the bone: push only the tip out
        // (UTJ's HeadIsEmbedded response); otherwise clear the deepest point of the bone.
        closestPointsOnSegments(head, head, _axisA, _axisB, _p, _q);
        const headEmbedded = _p.distanceToSquared(_q) < combined * combined;
        const t = headEmbedded
          ? closestPointsOnSegments(this.currTipPos, this.currTipPos, _axisA, _axisB, _p, _q) + 1
          : closestPointsOnSegments(head, this.currTipPos, _axisA, _axisB, _p, _q);
        const d = _p.distanceTo(_q);
        if (t <= 0 || d >= combined || d < 1e-6) continue;
        // where that point of the bone has to be: on the surface, straight out from the axis
        const target = _p.sub(_q).multiplyScalar(combined / d).add(_q);
        const newTip = target.sub(head).normalize().multiplyScalar(length).add(head);
        _delta.copy(newTip).sub(this.currTipPos);
        this.currTipPos.add(_delta);
        this.prevTipPos.add(_delta);
      }
    }
  }

  private applyLengthLimits(deltaTime: number) {
    if (this.lengthLimitTargets.length === 0) return;
    const accelerationMultiplier = 0.5 * deltaTime * deltaTime; // SpringConstant
    const movement = new THREE.Vector3();
    const toTarget = new THREE.Vector3();
    this.lengthLimitTargets.forEach((t, i) => {
      toTarget.copy(this.currTipPos).sub(worldPosition(t, _v3));
      const distanceFromEquilibrium = toTarget.length() - this.lengthsToLimitTargets[i];
      movement.addScaledVector(toTarget.normalize(), -accelerationMultiplier * distanceFromEquilibrium);
    });
    this.currTipPos.add(movement);
  }
}

const _desired = new THREE.Vector3();
const _head = new THREE.Vector3();
const _hitNormal = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _down = new THREE.Vector3();
const _back = new THREE.Vector3();
/** overlapping colliders (the chest spheres) can push a bone from one into the next */
const SEGMENT_PASSES = 6;
const _segHead = new THREE.Vector3();
const _axisA = new THREE.Vector3();
const _axisB = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _d1 = new THREE.Vector3();
const _d2 = new THREE.Vector3();
const _r = new THREE.Vector3();

/**
 * Closest points between segments p1-q1 and p2-q2 (Ericson, Real-Time Collision Detection 5.1.9):
 * writes them to c1 / c2 and returns c1's parameter along p1-q1.
 */
function closestPointsOnSegments(
  p1: THREE.Vector3,
  q1: THREE.Vector3,
  p2: THREE.Vector3,
  q2: THREE.Vector3,
  c1: THREE.Vector3,
  c2: THREE.Vector3
): number {
  const d1 = _d1.copy(q1).sub(p1);
  const d2 = _d2.copy(q2).sub(p2);
  const r = _r.copy(p1).sub(p2);
  const a = d1.lengthSq();
  const e = d2.lengthSq();
  const f = d2.dot(r);
  let s: number;
  let t: number;
  if (a <= 1e-12 && e <= 1e-12) {
    s = t = 0;
  } else if (a <= 1e-12) {
    s = 0;
    t = THREE.MathUtils.clamp(f / e, 0, 1);
  } else {
    const c = d1.dot(r);
    if (e <= 1e-12) {
      t = 0;
      s = THREE.MathUtils.clamp(-c / a, 0, 1);
    } else {
      const b = d1.dot(d2);
      const denom = a * e - b * b;
      s = denom > 1e-12 ? THREE.MathUtils.clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = THREE.MathUtils.clamp(-c / a, 0, 1);
      } else if (t > 1) {
        t = 1;
        s = THREE.MathUtils.clamp((b - c) / a, 0, 1);
      }
    }
  }
  c1.copy(p1).addScaledVector(d1, s);
  c2.copy(p2).addScaledVector(d2, t);
  return s;
}

// ---- SpringManager.cs ----------------------------------------------------------------------------

class SpringManager {
  /** last position of the manager's node, to spot jumps */
  readonly lastPosition = new THREE.Vector3(Number.NaN, 0, 0);
  constructor(
    readonly node: THREE.Object3D,
    readonly data: SpringManagerData,
    readonly bones: SpringBone[]
  ) {}

  updateDynamics(timeStep: number, scale: number) {
    if (this.data.isPaused) return; // ComputeRotation with unchanged tips keeps the rotations
    const sumOfForces = new THREE.Vector3().fromArray(this.data.gravity).multiplyScalar(scale);
    for (const bone of this.bones) {
      bone.updateSpring(timeStep, sumOfForces, scale);
      bone.satisfyConstraintsAndComputeRotation(this, timeStep, scale);
    }
  }
}

export interface UtjSpringBones {
  /** Run after the pose is set for this frame. */
  update(dt: number): void;
  /** Put every tip back on the pose on screen (no momentum). */
  reset(): void;
  managers: number;
  bones: number;
}

function depth(n: THREE.Object3D): number {
  let d = 0;
  for (let p: THREE.Object3D | null = n; p; p = p.parent) d++;
  return d;
}

/** The body colliders every hair strand gets with `readerCollision`: torso, upper arms, forearms. */
const READER_HAIR_COLLIDERS = /^CL_(Chest|Spine|Waist|Hip|Left_Arm|Right_Arm|Left_Elbow|Right_Elbow)/;

/**
 * Build the springs of a freshly cloned PJSK model (rest pose), or null if it has none.
 * `readerCollision` (the cast swap turns it on; off = exactly the game): the game's colliders are
 * meant for PJSK's standing dance motions, and Hasu's tilted / seated story poses push the hair
 * into the body, so every hair strand collides with all the torso and arm colliders, along the
 * bone's whole length instead of only at its tip (collideSegment).
 */
export function createUtjSpringBones(model: THREE.Object3D, opts: { readerCollision?: boolean } = {}): UtjSpringBones | null {
  const byIndex = new Map<number, THREE.Object3D>();
  model.traverse((n) => {
    if (typeof n.userData.utjNode === "number") byIndex.set(n.userData.utjNode, n);
  });
  const colliders = new Map<THREE.Object3D, Collider>();
  for (const n of byIndex.values()) {
    const c = n.userData.utjSpringCollider as ColliderData | undefined;
    if (c) colliders.set(n, new Collider(n, c));
  }
  const pick = (ids: number[] | undefined, type: ColliderData["type"]) =>
    (ids ?? []).map((i) => colliders.get(byIndex.get(i)!)).filter((c): c is Collider => c?.data.type === type);

  model.updateMatrixWorld(true);
  const toNative = new THREE.Matrix4().copy(model.matrixWorld).invert();
  const managers: SpringManager[] = [];
  model.traverse((n) => {
    const m = n.userData.utjSpringManager as SpringManagerData | undefined;
    if (!m) return;
    if (m.collideWithGround) console.warn("[utjSpringBone] ground collision isn't ported", n.name);
    const bones: SpringBone[] = [];
    for (const i of m.springBones ?? []) {
      const node = byIndex.get(i);
      const d = node?.userData.utjSpringBone as SpringBoneData | undefined;
      if (!node || !d || !node.parent) continue;
      if (d.panelColliders?.length) console.warn("[utjSpringBone] panel colliders aren't ported", node.name);
      const spheres = pick(d.sphereColliders, "sphere");
      const capsules = pick(d.capsuleColliders, "capsule");
      const readerHair = !!opts.readerCollision && node.name.includes("hair");
      if (readerHair) {
        // The modelled rest shape is clean by definition: a torso collider the strand already
        // overlaps at rest would only push it away from the body (e.g. Shiho's back hair rests
        // 1.6 cm inside CL_ChestSphereCollider_Top), so it isn't added. Arm colliders always are:
        // the rest pose is a T-pose, with the arms nowhere near where they'll be.
        const head = worldPosition(node, new THREE.Vector3());
        const tip = new SpringBone(node, d, null, [], [], []).computeChildPosition(new THREE.Vector3());
        for (const c of colliders.values()) {
          if (!READER_HAIR_COLLIDERS.test(c.node.name)) continue;
          const list = c.data.type === "sphere" ? spheres : c.data.type === "capsule" ? capsules : null;
          if (!list || list.includes(c)) continue;
          if (/^CL_(Left|Right)_/.test(c.node.name)) {
            list.push(c);
            continue;
          }
          const m = c.node.matrixWorld;
          _axisA.setFromMatrixPosition(m);
          if (c.data.type === "capsule") _axisB.set(0, c.data.height, 0).applyMatrix4(m);
          else _axisB.copy(_axisA);
          const combined = c.data.radius * _v3.setFromMatrixColumn(m, 0).length() + d.radius;
          closestPointsOnSegments(head, tip, _axisA, _axisB, _p, _q);
          if (_p.distanceToSquared(_q) >= combined * combined) list.push(c);
        }
      }
      const bone = new SpringBone(
        node,
        d,
        d.pivotNode != null ? (byIndex.get(d.pivotNode) ?? null) : null,
        spheres,
        capsules,
        (d.lengthLimitTargets ?? []).map((i) => byIndex.get(i)).filter((t): t is THREE.Object3D => !!t)
      );
      bone.segmentCollision = readerHair;
      bone.initialize(toNative);
      bones.push(bone);
    }
    // FindSpringBones: depth order, so a parent bone is solved before its children
    bones.sort((a, b) => depth(a.node) - depth(b.node));
    managers.push(new SpringManager(n, m, bones));
  });
  if (managers.length === 0) return null;

  const allColliders = [...colliders.values()];
  // Every PJSK manager runs at simulationFrameRate 60
  const rate = managers[0].data.simulationFrameRate;
  const timeStep = 1 / (rate > 0 ? rate : 60);
  const MAX_STEPS = 3;
  let accumulator = 0;
  let needsReset = true;

  return {
    managers: managers.length,
    bones: managers.reduce((s, m) => s + m.bones.length, 0),
    reset() {
      needsReset = true;
    },
    update(dt) {
      model.updateWorldMatrix(true, true);
      const scale = _v1.setFromMatrixScale(model.matrixWorld).x;
      // A jump of the character (seek, teleporting キャラ表示) would fling the hair.
      for (const m of managers) {
        const p = worldPosition(m.node, _v2);
        if (!(p.distanceToSquared(m.lastPosition) < (0.5 * scale) ** 2)) needsReset = true;
        m.lastPosition.copy(p);
      }
      if (needsReset) {
        needsReset = false;
        accumulator = 0;
        for (const m of managers) for (const b of m.bones) b.reset(scale);
      }
      if (dt <= 0) return;
      accumulator += dt;
      let steps = Math.floor(accumulator / timeStep);
      if (steps > MAX_STEPS) {
        steps = MAX_STEPS;
        accumulator = 0;
      } else {
        accumulator -= steps * timeStep;
      }
      for (let i = 0; i < steps; i++) {
        for (const c of allColliders) c.preUpdate();
        for (const m of managers) m.updateDynamics(timeStep, scale);
      }
    },
  };
}
