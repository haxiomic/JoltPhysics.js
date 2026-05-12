# Patch: expose `CROSS_PLATFORM_DETERMINISTIC` in JoltPhysics.js

## Why

Upstream `JoltPhysics` (the C++ engine) exposes a CMake option called
`CROSS_PLATFORM_DETERMINISTIC` (default OFF) which, when ON, forces strict
IEEE-754 paths so simulation results are bit-identical across CPU
architectures (NEON vs SSE, etc.). It costs roughly 8% performance per
upstream's own measurements.

`JoltPhysics.js` (the WebAssembly/embind wrapper) wraps the C++ engine
and ships pre-built artifacts on npm. **It does not currently surface the
deterministic flag.** Apps doing browser-side multiplayer rollback over
the public internet between heterogeneous clients (x86 desktops vs ARM
laptops vs ARM phones) need the flag enabled — without it, NEON and SSE
can produce diverging trig / vector / contact results that desync state.

Even with `JPH_CROSS_PLATFORM_DETERMINISTIC` undefined, the JS port is
"in-practice safe" today because:

1. Jolt's polynomial trig is used everywhere (no libm per-CPU `sin`/`cos`).
2. Emscripten compiles with `-ffp-contract=off` by default for wasm
   targets (no fused multiply-add).
3. Wasm's IEEE-754 contract is strict (no x87 80-bit promotions).

But "in-practice safe" isn't the same as "audited and opted into the
upstream guarantee." For multiplayer netcode that ships, we want the
strongest determinism mode the engine offers.

## Diff (against `JoltPhysics.js/CMakeLists.txt`, upstream main)

Two additions, both bracketed by `if (CROSS_PLATFORM_DETERMINISTIC)`:

### 1. Forward the option to the upstream JoltPhysics build

Inserted before `include(FetchContent)` near line 105:

```cmake
# Option to enable upstream JoltPhysics' CROSS_PLATFORM_DETERMINISTIC build mode.
# This forces deterministic IEEE-754 paths (Jolt's polynomial trig + strict
# associativity) at a ~8% perf cost. Required for cross-architecture netcode
# (browser-side multiplayer rollback over the public internet).
# Default OFF preserves upstream behavior; opt in via -DCROSS_PLATFORM_DETERMINISTIC=ON.
option(CROSS_PLATFORM_DETERMINISTIC "Compile Jolt with the cross-platform deterministic build flag" OFF)
if (CROSS_PLATFORM_DETERMINISTIC)
    # Forward to the upstream JoltPhysics CMake option of the same name.
    # Must be set BEFORE FetchContent_MakeAvailable so the option() call inside
    # JoltPhysics/Build/CMakeLists.txt picks it up (CMP0077 NEW honors parent vars).
    set(CROSS_PLATFORM_DETERMINISTIC ON CACHE BOOL "Pass-through to upstream JoltPhysics" FORCE)
    message(STATUS "JoltPhysics.js: CROSS_PLATFORM_DETERMINISTIC=ON (cross-arch determinism, ~8% perf cost)")
endif()
```

### 2. Apply the same define + `-ffp-contract=off` to `glue.cpp`

`glue.cpp` is compiled by a custom command (`emcc ${EMCC_GLUE_ARGS} -o glue.o`),
not via the Jolt CMake target. So `target_compile_definitions(Jolt PUBLIC
JPH_CROSS_PLATFORM_DETERMINISTIC)` from the upstream build doesn't propagate
to the glue automatically. The glue includes `<Jolt/Jolt.h>` and uses
inline math (`Vec3`, `Quat`, …) — without the same define, those inlines
could compile to a different IR than `libJolt.a`'s versions, defeating
the point.

Inserted right after `set(EMCC_GLUE_ARGS … ${ENABLE_SIMD_FLAG})` near line 197:

```cmake
# Forward the cross-platform-deterministic define to glue.cpp so Jolt's inline
# math (Vec3, Quat, etc.) used in the embind glue is compiled with the same
# IEEE-754 contracts as libJolt.a. Without this, glue's inline math could
# diverge from the static lib's compiled-in deterministic paths.
if (CROSS_PLATFORM_DETERMINISTIC)
    set(EMCC_GLUE_ARGS ${EMCC_GLUE_ARGS} -DJPH_CROSS_PLATFORM_DETERMINISTIC -ffp-contract=off)
endif()
```

## Effect when OFF

Zero. `option(... OFF)` is the default, and both `if`-guarded blocks
skip when OFF. Existing builds and the published npm package are
byte-identical to before the patch.

## Effect when ON

- `libJolt.a` is compiled with `JPH_CROSS_PLATFORM_DETERMINISTIC` and
  `-ffp-contract=off` (driven by upstream `JoltPhysics/Build/CMakeLists.txt`'s
  existing `if (CROSS_PLATFORM_DETERMINISTIC)` branch on line ~245).
- `glue.o` is compiled with the same define + `-ffp-contract=off`.
- The resulting wasm carries Jolt's deterministic code paths and
  reports `JPH_CROSS_PLATFORM_DETERMINISTIC` in
  `Jolt::GetConfigurationString()`.

## Validation

See `BUILD.md` for the build command and `verify.ts` for a same-machine
hash-comparison test. On Apple Silicon (arm64) we measured identical
hashes between the npm package and the deterministic fork after 60
frames of a 125-body stack scene.

## Future work / upstream PR

This patch is being prepared for upstream submission to
`jrouwe/JoltPhysics.js` — see `UPSTREAM_PR.md`.
