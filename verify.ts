// Diagnostic: drive a fixed deterministic physics scene through both the
// fork (jolt-physics-deterministic, built with CROSS_PLATFORM_DETERMINISTIC=ON)
// and the npm jolt-physics package (no deterministic flag), and compare the
// resulting body-pose hash.
//
// On a single machine, both builds should produce IDENTICAL hashes — the
// CROSS_PLATFORM_DETERMINISTIC flag tightens cross-architecture behavior
// (NEON vs SSE, Vec3::sZero, polynomial trig contracts) but does NOT change
// observable results within the same compiled binary on the same arch.
// A divergence on this machine would indicate the flag changed something
// unexpected (e.g. solver iteration count, contact selection order) and
// should be investigated before adopting the fork.
//
// Run from project root:
//   npx tsx lib/jolt-physics-deterministic/verify.ts
//
// Requires the symlink/install at node_modules/jolt-physics-deterministic/
// (created in BUILD.md step 4).

import { createHash } from 'node:crypto';

const FRAMES = 60;
const FIXED_DT = 1 / 60;

interface BodyState {
  position: [number, number, number];
  rotation: [number, number, number, number];
  linearVelocity: [number, number, number];
  angularVelocity: [number, number, number];
}

const LAYER_NON_MOVING = 0;
const LAYER_MOVING = 1;

async function runSim(packageName: 'jolt-physics' | 'jolt-physics-deterministic'): Promise<{
  configString: string;
  hashHex: string;
  finalStates: BodyState[];
}> {
  const init = (await import(packageName)).default;
  const Jolt: any = await init();

  // Jolt configuration string — exposes which build defines were active.
  const configString: string = typeof Jolt.GetConfigurationString === 'function'
    ? Jolt.GetConfigurationString()
    : '<GetConfigurationString unavailable>';

  // ── World setup ────────────────────────────────────────────────────────
  const NUM_OBJECT_LAYERS = 2;
  const NUM_BROAD_PHASE_LAYERS = 2;

  const settings = new Jolt.JoltSettings();
  const olpf = new Jolt.ObjectLayerPairFilterTable(NUM_OBJECT_LAYERS);
  olpf.EnableCollision(LAYER_NON_MOVING, LAYER_MOVING);
  olpf.EnableCollision(LAYER_MOVING, LAYER_MOVING);

  const bpli = new Jolt.BroadPhaseLayerInterfaceTable(NUM_OBJECT_LAYERS, NUM_BROAD_PHASE_LAYERS);
  bpli.MapObjectToBroadPhaseLayer(LAYER_NON_MOVING, new Jolt.BroadPhaseLayer(0));
  bpli.MapObjectToBroadPhaseLayer(LAYER_MOVING, new Jolt.BroadPhaseLayer(1));

  const ovbpf = new Jolt.ObjectVsBroadPhaseLayerFilterTable(bpli, NUM_BROAD_PHASE_LAYERS, olpf, NUM_OBJECT_LAYERS);

  settings.mObjectLayerPairFilter = olpf;
  settings.mBroadPhaseLayerInterface = bpli;
  settings.mObjectVsBroadPhaseLayerFilter = ovbpf;
  settings.mMaxBodies = 256;

  const joltIface = new Jolt.JoltInterface(settings);
  const system = joltIface.GetPhysicsSystem();
  const ps = system.GetPhysicsSettings();
  ps.mDeterministicSimulation = true;
  system.SetPhysicsSettings(ps);
  system.SetGravity(new Jolt.Vec3(0, -9.81, 0));
  const bodyIface = system.GetBodyInterface();

  // ── Scene: static floor + 5x5x5 falling box stack with light angular velocity
  const bodyIds: any[] = [];

  // Floor: 50x1x50 box at y=-0.5
  {
    const shape = new Jolt.BoxShapeSettings(new Jolt.Vec3(25, 0.5, 25)).Create().Get();
    const bcs = new Jolt.BodyCreationSettings(
      shape,
      new Jolt.RVec3(0, -0.5, 0),
      new Jolt.Quat(0, 0, 0, 1),
      Jolt.EMotionType_Static,
      LAYER_NON_MOVING,
    );
    const id = new Jolt.BodyID(bodyIface.CreateAndAddBody(bcs, Jolt.EActivation_Activate).GetIndexAndSequenceNumber());
    bodyIds.push(id);
    Jolt.destroy(bcs);
  }

  // 5x5x5 stack of unit boxes, slightly perturbed initial state for richer mixing.
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      for (let k = 0; k < 5; k++) {
        const shapeS = new Jolt.BoxShapeSettings(new Jolt.Vec3(0.5, 0.5, 0.5));
        shapeS.mDensity = 100;
        const shape = shapeS.Create().Get();
        const bcs = new Jolt.BodyCreationSettings(
          shape,
          new Jolt.RVec3(i * 1.05 - 2, 1.5 + k * 1.05, j * 1.05 - 2),
          new Jolt.Quat(0, 0, 0, 1),
          Jolt.EMotionType_Dynamic,
          LAYER_MOVING,
        );
        bcs.mLinearVelocity = new Jolt.Vec3(0.01 * i, 0, 0.02 * j);
        bcs.mAngularVelocity = new Jolt.Vec3(0.03 * (k - 2), 0.05, -0.02 * (i - 2));
        bcs.mFriction = 0.5;
        bcs.mRestitution = 0.1;
        const id = new Jolt.BodyID(bodyIface.CreateAndAddBody(bcs, Jolt.EActivation_Activate).GetIndexAndSequenceNumber());
        bodyIds.push(id);
        Jolt.destroy(bcs);
      }
    }
  }

  // ── Step ───────────────────────────────────────────────────────────────
  for (let f = 0; f < FRAMES; f++) {
    joltIface.Step(FIXED_DT, 1);
  }

  // ── Read final state ───────────────────────────────────────────────────
  const finalStates: BodyState[] = [];
  for (const id of bodyIds) {
    const pos = bodyIface.GetPosition(id);
    const rot = bodyIface.GetRotation(id);
    const lv = bodyIface.GetLinearVelocity(id);
    const av = bodyIface.GetAngularVelocity(id);
    finalStates.push({
      position: [pos.GetX(), pos.GetY(), pos.GetZ()],
      rotation: [rot.GetX(), rot.GetY(), rot.GetZ(), rot.GetW()],
      linearVelocity: [lv.GetX(), lv.GetY(), lv.GetZ()],
      angularVelocity: [av.GetX(), av.GetY(), av.GetZ()],
    });
  }

  // Hash the raw IEEE-754 bits of every component.
  const buf = Buffer.alloc(finalStates.length * 13 * 8);
  let off = 0;
  for (const s of finalStates) {
    for (const x of [...s.position, ...s.rotation, ...s.linearVelocity, ...s.angularVelocity]) {
      buf.writeDoubleLE(x, off);
      off += 8;
    }
  }
  const hashHex = createHash('sha256').update(buf).digest('hex');

  Jolt.destroy(joltIface);
  return { configString, hashHex, finalStates };
}

async function main() {
  console.log('=== JoltPhysics CROSS_PLATFORM_DETERMINISTIC verification ===');
  console.log(`Frames: ${FRAMES}, fixed dt: ${FIXED_DT}, scene: 5x5x5 box stack on floor`);
  console.log();

  console.log('[1/2] Running with npm jolt-physics (no deterministic flag)...');
  const npm = await runSim('jolt-physics');
  console.log('  configuration:', npm.configString);
  console.log('  hash:         ', npm.hashHex);
  console.log();

  console.log('[2/2] Running with jolt-physics-deterministic (CROSS_PLATFORM_DETERMINISTIC=ON)...');
  const det = await runSim('jolt-physics-deterministic');
  console.log('  configuration:', det.configString);
  console.log('  hash:         ', det.hashHex);
  console.log();

  // Compare positions to give a sense of magnitude even if hashes differ.
  let maxDeltaPos = 0;
  let maxDeltaRot = 0;
  for (let i = 0; i < npm.finalStates.length; i++) {
    const a = npm.finalStates[i];
    const b = det.finalStates[i];
    for (let j = 0; j < 3; j++) {
      maxDeltaPos = Math.max(maxDeltaPos, Math.abs(a.position[j] - b.position[j]));
    }
    for (let j = 0; j < 4; j++) {
      maxDeltaRot = Math.max(maxDeltaRot, Math.abs(a.rotation[j] - b.rotation[j]));
    }
  }

  console.log('=== Result ===');
  if (npm.hashHex === det.hashHex) {
    console.log('PASS: hashes match within-platform — cross-platform-deterministic flag did not');
    console.log('      change observable behavior on this machine. Cross-arch hardening is the');
    console.log('      effect we expect; same-arch results are unchanged. Safe to adopt the fork.');
  } else {
    console.log('DIVERGENCE: hashes differ on this machine.');
    console.log(`  max |Δposition|: ${maxDeltaPos.toExponential(3)}`);
    console.log(`  max |Δrotation|: ${maxDeltaRot.toExponential(3)}`);
    console.log('  This is unusual but not necessarily wrong — the deterministic build forces');
    console.log('  -ffp-contract=off and JPH_CROSS_PLATFORM_DETERMINISTIC code paths, which on');
    console.log('  some compilers/CPUs can flip a small set of last-bit results even on x86/ARM');
    console.log('  alone. Investigate whether the magnitude is within solver-residual noise');
    console.log('  before treating this as a regression.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
