# Building `jolt-physics-deterministic`

This directory is a fork of [jrouwe/JoltPhysics.js](https://github.com/jrouwe/JoltPhysics.js)
with two CMake additions (see `PATCH.md`) that thread upstream JoltPhysics'
`CROSS_PLATFORM_DETERMINISTIC` flag through the wasm build. We use this
fork instead of the npm `jolt-physics` package for browser-side
multiplayer rollback so that two clients on different CPU architectures
(x86 vs ARM) produce bit-identical simulation results.

## Why a fork?

The npm `jolt-physics@1.0.0` package is built from the upstream wrapper
without the deterministic flag. Per upstream's own audit, the
JoltPhysics engine's cross-arch hardening (NEON-vs-SSE divergence in
`Vec3::sZero`, polynomial vs libm trig, FMA contract) is gated on the
`CROSS_PLATFORM_DETERMINISTIC` CMake option which the wrapper does not
expose. Without it, two web clients on different architectures may
desync after enough frames of contact-rich simulation.

See `/Users/geo/Downloads/web-physics-comparisons/docs/cross-machine-determinism-audit.md`
for the full analysis.

## Output artifacts

After a successful build, `dist/` contains (matching the npm package's layout):

```
dist/jolt-physics.wasm-compat.js         single-file wasm (base64-inlined)
dist/jolt-physics.wasm-compat.d.ts       TypeScript declarations
dist/jolt-physics.d.ts                   type re-export
dist/types.d.ts                          generated from JoltJS.idl
```

The default `import init from 'jolt-physics-deterministic'` resolves to
`dist/jolt-physics.wasm-compat.js` (per `package.json`'s `main` field).
This matches the npm package's default export, so the fork is a drop-in
replacement.

If you need the non-inlined wasm or the multi-threaded variants, run the
full upstream `build.sh` instead of just the ST/wasm-compat target — see
the "Full build" section below.

## Build prerequisites

- `cmake` ≥ 3.13
- `python3`
- `npx` (for `webidl-dts-gen`, run during the binding step)
- An Emscripten toolchain ≥ 3.x with the `cmake/Modules/Platform/Emscripten.cmake`
  toolchain file and `tools/webidl_binder.py` available.

The `CMakeLists.txt` (inherited from upstream) hardcodes the toolchain
path as `$ENV{EMSDK}/upstream/emscripten`. If your Emscripten install
follows the official `emsdk` layout (`emsdk install latest && emsdk activate latest`
+ `source emsdk_env.sh`), `EMSDK` is already set correctly.

If you installed Emscripten via Homebrew (`brew install emscripten`),
the layout differs — see "Homebrew workaround" below.

## Recommended path: Docker

The cleanest, host-agnostic build uses the official Emscripten image:

```sh
cd /Users/geo/Downloads/web-physics-comparisons/lib/jolt-physics-deterministic

docker run --rm -v "$PWD":/src -w /src emscripten/emsdk:latest sh -c '
  rm -rf dist Build
  mkdir dist
  cmake -B Build/Distribution/ST \
    -DCMAKE_BUILD_TYPE=Distribution \
    -DBUILD_WASM_COMPAT_ONLY=ON \
    -DCROSS_PLATFORM_DETERMINISTIC=ON
  cmake --build Build/Distribution/ST -j$(nproc)
'

# Generate the .d.ts shims that build.sh would normally write
cat > dist/jolt-physics.d.ts <<EOF
import Jolt from "./types";
export default Jolt;
export * from "./types";
EOF
cp dist/jolt-physics.d.ts dist/jolt-physics.wasm-compat.d.ts
```

Look for `JoltPhysics.js: CROSS_PLATFORM_DETERMINISTIC=ON` in the cmake
configure output to confirm the flag took effect. The Jolt static lib
will then carry `target_compile_definitions(Jolt PUBLIC JPH_CROSS_PLATFORM_DETERMINISTIC)`
from upstream `Jolt/Jolt.cmake:542`.

## Fallback path: native Emscripten

If Docker isn't available and you have `emcc` on PATH:

```sh
# 1. Make sure $EMSDK is set and points to the emsdk root such that
#    $EMSDK/upstream/emscripten contains cmake/ and tools/.
which emcc      # must exist
echo $EMSDK     # must point to emsdk root

cd /Users/geo/Downloads/web-physics-comparisons/lib/jolt-physics-deterministic

rm -rf dist Build
mkdir dist

cmake -B Build/Distribution/ST \
  -DCMAKE_BUILD_TYPE=Distribution \
  -DBUILD_WASM_COMPAT_ONLY=ON \
  -DCROSS_PLATFORM_DETERMINISTIC=ON
cmake --build Build/Distribution/ST -j$(sysctl -n hw.ncpu)   # macOS

cat > dist/jolt-physics.d.ts <<EOF
import Jolt from "./types";
export default Jolt;
export * from "./types";
EOF
cp dist/jolt-physics.d.ts dist/jolt-physics.wasm-compat.d.ts
```

### Homebrew workaround

`brew install emscripten` installs to `/opt/homebrew/opt/emscripten/libexec/`
which has the `cmake/` and `tools/` subdirectories at the top level —
i.e. it corresponds to where `$EMSDK/upstream/emscripten` would be in an
official emsdk install. Easiest fix is a symlink:

```sh
mkdir -p /tmp/_jolt_emsdk_shim/upstream
ln -s /opt/homebrew/opt/emscripten/libexec /tmp/_jolt_emsdk_shim/upstream/emscripten
EMSDK=/tmp/_jolt_emsdk_shim cmake -B Build/Distribution/ST \
  -DCMAKE_BUILD_TYPE=Distribution \
  -DBUILD_WASM_COMPAT_ONLY=ON \
  -DCROSS_PLATFORM_DETERMINISTIC=ON
EMSDK=/tmp/_jolt_emsdk_shim cmake --build Build/Distribution/ST -j$(sysctl -n hw.ncpu)
```

This is the path the maintainer used for the initial reference build on
macOS arm64.

## Full build (all variants, mirrors upstream `build.sh`)

```sh
cd /Users/geo/Downloads/web-physics-comparisons/lib/jolt-physics-deterministic
./build.sh Distribution -DCROSS_PLATFORM_DETERMINISTIC=ON
```

This produces:

- `dist/jolt-physics.wasm-compat.js` (single-file)
- `dist/jolt-physics.wasm.js` + `dist/jolt-physics.wasm.wasm` (separate files)
- `dist/jolt-physics.multithread.wasm-compat.js` + multithread.wasm

Note: on macOS, `build.sh` uses `nproc` which doesn't exist — replace
with `$(sysctl -n hw.ncpu)` or build the variants you need manually.

## Updating from upstream

This fork tracks `jrouwe/JoltPhysics.js` main. The C++ `JoltPhysics`
engine is fetched as a `FetchContent` declaration (NOT a git submodule),
so updating just means:

```sh
cd /Users/geo/Downloads/web-physics-comparisons/lib/jolt-physics-deterministic
git fetch origin
git rebase origin/main             # preserve PATCH.md changes on top
# Re-apply the two CMakeLists.txt hunks from PATCH.md if they conflict.
# Bump the upstream JoltPhysics tag inside CMakeLists.txt's
# FetchContent_Declare(GIT_TAG "v5.5.0") if you want a newer engine.
rm -rf Build  # force a fresh FetchContent_MakeAvailable
# Then rebuild as above.
```

Once the upstream PR (`UPSTREAM_PR.md`) lands, this fork can be retired
and we can switch back to the npm package — assuming the maintainer
also publishes a `wasm-compat-deterministic` build variant or we
agree on a build flag clients can opt into.

## Integration with the parent project

The parent `package.json` is **not modified** by this fork's build. To
integrate, add to `package.json`:

```json
"dependencies": {
  "jolt-physics-deterministic": "file:./lib/jolt-physics-deterministic"
}
```

Then run `npm install` and update `src/engines/jolt.ts` to import from
`'jolt-physics-deterministic'`. (Both packages export the same
`init()`-returning default, so the change is one line.)

For local validation without touching `package.json` (e.g. while
prototyping), a symlink works equally well:

```sh
ln -sfn ../lib/jolt-physics-deterministic ./node_modules/jolt-physics-deterministic
```

## Verification

`verify.ts` runs the same 5×5×5 box-stack scene through both the npm
`jolt-physics` and the deterministic fork for 60 frames at 60Hz, hashes
the final per-body state (position, rotation, linear & angular
velocity), and reports whether the hashes match.

```
$ npx tsx lib/jolt-physics-deterministic/verify.ts
=== JoltPhysics CROSS_PLATFORM_DETERMINISTIC verification ===
Frames: 60, fixed dt: 0.016666666666666666, scene: 5x5x5 box stack on floor

[1/2] Running with npm jolt-physics (no deterministic flag)...
  configuration: <GetConfigurationString unavailable>
  hash:          98e6facaca1ce4dd0902756ddffc2579824e91f9709f2bbb257db9f03dfc439a

[2/2] Running with jolt-physics-deterministic (CROSS_PLATFORM_DETERMINISTIC=ON)...
  configuration: <GetConfigurationString unavailable>
  hash:          98e6facaca1ce4dd0902756ddffc2579824e91f9709f2bbb257db9f03dfc439a

=== Result ===
PASS: hashes match within-platform — cross-platform-deterministic flag did not
      change observable behavior on this machine. Cross-arch hardening is the
      effect we expect; same-arch results are unchanged. Safe to adopt the fork.
```

(Build machine: macOS arm64, Apple Silicon, emscripten 3.1.74,
JoltPhysics v5.5.0.)

The hash-equality result is the expected outcome — the
`CROSS_PLATFORM_DETERMINISTIC` flag tightens *cross-architecture*
behavior. On a single architecture, both builds compile to the same
machine semantics. The flag's value shows up only when you compare
artifacts compiled on different CPU architectures (e.g. arm64 vs x86_64).

## Caveats encountered

1. **JoltPhysics is not a git submodule.** The fork uses
   `FetchContent_Declare` to pull v5.5.0 of the C++ engine at CMake
   configure time. The `--recurse-submodules` clone option in the task
   spec was harmless but unnecessary.

2. **`Jolt::GetConfigurationString()` is not bound.** The embind/IDL
   bindings don't expose Jolt's configuration string, so we can't
   programmatically confirm `JPH_CROSS_PLATFORM_DETERMINISTIC` is in the
   shipped wasm via JS. We confirm via the build log
   (`JoltPhysics.js: CROSS_PLATFORM_DETERMINISTIC=ON`) and the CMake
   cache (`grep CROSS_PLATFORM_DETERMINISTIC Build/Distribution/ST/CMakeCache.txt`).
   Adding `GetConfigurationString` to `JoltJS.idl` would be a small
   additional patch worth sending upstream.

3. **glue.cpp needed an explicit define.** Upstream's
   `target_compile_definitions(Jolt PUBLIC JPH_CROSS_PLATFORM_DETERMINISTIC)`
   doesn't reach the wrapper's glue.cpp because it's compiled by a raw
   `emcc` custom command, not the Jolt CMake target. PATCH.md hunk #2
   addresses this.
