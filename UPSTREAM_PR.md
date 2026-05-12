# Upstream PR draft for `jrouwe/JoltPhysics.js`

Target branch: `main`
Suggested title: **Expose `CROSS_PLATFORM_DETERMINISTIC` build flag**

---

## Summary

Adds a CMake option `CROSS_PLATFORM_DETERMINISTIC` (default OFF) that,
when set, threads the upstream `JoltPhysics`
`CROSS_PLATFORM_DETERMINISTIC` flag into both the static-library build
*and* the embind glue compilation. This lets downstream consumers
opt into Jolt's strictest cross-architecture determinism mode without
maintaining a fork.

When OFF (the default), the build is byte-identical to before this
patch.

## Motivation

I'm building a browser-based physics-rollback netcode layer on top of
JoltPhysics.js. Two clients on different CPU architectures (x86 desktop
vs ARM laptop, or x86 vs an ARM phone) currently get the engine's
"in-practice safe" determinism — Jolt's polynomial trig, emscripten's
default `-ffp-contract=off`, wasm's strict IEEE-754 — but **not** the
explicit `CROSS_PLATFORM_DETERMINISTIC` opt-in that upstream
JoltPhysics offers and recommends for cross-arch netcode.

Specifically, without the define, `Vec3::sZero()` can produce different
binary results on NEON vs SSE
([upstream release notes](https://github.com/jrouwe/JoltPhysics/blob/master/Docs/ReleaseNotes.md)
search for "JPH_CROSS_PLATFORM_DETERMINISTIC"), and the engine's `Hash`
+ `EstimateCollisionResponse` paths take slightly different fast routes
that aren't required to match across SIMD ISAs.

The flag exists in upstream JoltPhysics already; this PR just surfaces
it through the JS wrapper.

## Cost when enabled

Per upstream JoltPhysics docs, enabling `CROSS_PLATFORM_DETERMINISTIC`
adds approximately **8% runtime overhead**. Since this is opt-in
(default OFF), users who don't need cross-arch determinism pay zero.

## Changes

Two small additions to `CMakeLists.txt`, both behind
`if (CROSS_PLATFORM_DETERMINISTIC)` so they're inert when the flag is
OFF.

### 1. Forward the option to the upstream JoltPhysics build

Inserted just before the `include(FetchContent)` block:

```cmake
option(CROSS_PLATFORM_DETERMINISTIC "Compile Jolt with the cross-platform deterministic build flag" OFF)
if (CROSS_PLATFORM_DETERMINISTIC)
    set(CROSS_PLATFORM_DETERMINISTIC ON CACHE BOOL "Pass-through to upstream JoltPhysics" FORCE)
    message(STATUS "JoltPhysics.js: CROSS_PLATFORM_DETERMINISTIC=ON (cross-arch determinism, ~8% perf cost)")
endif()
```

The wrapper already sets `set(CMAKE_POLICY_DEFAULT_CMP0077 NEW)` at the
top of `CMakeLists.txt`, so the parent variable wins over the
sub-project's `option(... OFF)` call inside upstream
`JoltPhysics/Build/CMakeLists.txt:21`.

### 2. Apply the same define + `-ffp-contract=off` to `glue.cpp`

`glue.cpp` is built by a raw `emcc` custom command, so it doesn't
inherit `target_compile_definitions(Jolt PUBLIC JPH_CROSS_PLATFORM_DETERMINISTIC)`
that upstream sets on the Jolt static library. Without applying the
define to the glue, the glue's inline math (Vec3, Quat, etc.) compiles
with different IEEE-754 contracts than libJolt.a, defeating the point.

Inserted right after `set(EMCC_GLUE_ARGS …)`:

```cmake
if (CROSS_PLATFORM_DETERMINISTIC)
    set(EMCC_GLUE_ARGS ${EMCC_GLUE_ARGS} -DJPH_CROSS_PLATFORM_DETERMINISTIC -ffp-contract=off)
endif()
```

## Validation

Tested on macOS arm64 (Apple Silicon, emscripten 3.1.74) with the
`Distribution + BUILD_WASM_COMPAT_ONLY` config. A 60-frame, 125-body
box-stack scene reaches a SHA-256 of the final body state that
matches between this build (with the flag ON) and the existing npm
`jolt-physics@1.0.0` package — confirming the deterministic flag
doesn't change observable same-arch behavior, only tightens cross-arch
guarantees. Build script and verification driver are in the repo I'm
preparing the PR from.

I haven't run a multi-arch comparison (would need an x86 Linux/Windows
machine to compile the same fork and compare hashes), but that's the
next step on my side. Happy to share results when I have them.

## Open questions for the maintainer

1. **Should the published npm package ship a deterministic variant by
   default?** I'd suggest no for the default export (perf cost), but
   there's an argument for adding `jolt-physics/wasm-compat-deterministic`
   (and the multi-thread equivalent) as a parallel export so consumers
   don't need to fork+self-host. Happy to add the build steps to
   `build.sh` and the package.json `exports` map in a follow-up PR if
   you're amenable.

2. **`GetConfigurationString` binding.** The embind IDL doesn't expose
   `Jolt::GetConfigurationString()`, which would let JS introspect
   which build defines (DEBUG_RENDERER, OBJECT_LAYER_BITS, this new
   one, etc.) are active in the wasm. Useful for diagnostics. Probably
   a separate PR; mentioning in case you'd accept it bundled.

3. **CI matrix.** It would be valuable to have a CI job that builds
   with `CROSS_PLATFORM_DETERMINISTIC=ON` on both `linux-x86_64` and
   `linux-aarch64` (or macOS arm64) and asserts hash equality on a
   reference scene. I can draft that job if there's interest.

## Backwards compatibility

None affected. Default behavior unchanged. New flag is purely additive.

## License

Both files modified are MIT (matching the rest of the repo). All new
text above is licensed MIT.
