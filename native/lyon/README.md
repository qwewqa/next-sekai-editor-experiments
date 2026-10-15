# Editor path tessellation

This is the small fill kernel used after the editor has flattened and outlined a
path. It uses Lyon 1.0.22 with a fixed `1e-5` tolerance and explicit nonzero/evenodd
fill rules. Native strokes, text shaping, curve flattening and the editor's
positive/zero interval decisions remain in their existing callers. No upstream
Lyon arithmetic is patched.

The checked-in `src/rendering/vendor/lyon.wasm` allows normal JavaScript builds
without Rust. `npm run check:lyon` verifies the exact owned source, lockfile,
compiler settings and binary hashes in `artifact.json`. `npm run build` runs that
check before Vite. Changing native source requires rebuilding and reviewing the
new manifest and geometry tests together.

To rebuild, install the exact toolchain in `rust-toolchain.toml`, then run
`npm run build:lyon`. The script verifies Rust 1.96.0's full compiler commit and
uses `cargo --locked`, release optimization, LTO, panic abort, an unshared memory
with a 2 MiB initial size and 64 MiB maximum, and a 64 KiB stack. `SEKAI_RUSTC` and
`SEKAI_CARGO` can point to isolated binaries; the compiler pin still applies.
`CARGO_HOME`, `RUSTUP_HOME` and `CARGO_TARGET_DIR` may be isolated by the caller.
Relative `CARGO_HOME` and `CARGO_TARGET_DIR` paths resolve from `native/lyon`,
matching Cargo's build working directory; artifact copying uses that same path.
No global toolchain or package-manager setting is changed by these scripts.
Cargo checks every downloaded crate against its committed lockfile checksum.

The module has no host imports or generated binding framework. `reserve`
initializes input storage before JavaScript writes it. Input and output pointers
are valid only until the next mutating export or memory growth. The TypeScript
wrapper refreshes heap views and copies the complete triangle list into its own
Float64Array before returning. It retains one page-owned instance and reuses its
scratch storage; memory can grow to the stated maximum and does not shrink while
that instance remains live. A trap retires all exports/views without calling a
possibly corrupted destructor. Normal page unload releases the page-owned kernel.

The JS caller and native ABI independently cap submitted edges at 32,767 because
Lyon's internal winding accumulator is signed 16-bit. A single contour can wind
repeatedly, so contour count alone is insufficient. The JS wrapper also checks
finite/local coordinates, actual f32 input packing error, worst-case f32 spacing
within the local bounding box, fixed endpoint-snap scale, and restoration error
of newly generated intersection vertices. Its error budget is 0.025 compiled
pixels, one quarter of the existing 0.1-pixel curve tolerance. The existing mesh
upload precision guard is retained separately. These numeric checks bound the
representation changes; visual tests are still required for Lyon's intersection
algorithm and anti-aliasing behavior.

Unsupported geometry uses the unchanged JS tessellator with the original input.
Helpers without an explicit compiled resolution also retain JS because their
final device-space precision cannot be bounded yet.
Allocation/status/output errors and traps retire the instance and use that same
JS path for this and subsequent calls. No partially computed geometry is exposed.
The original JS dependency remains deliberately available for these cases.

`initializeLyon` starts alongside renderer initialization without delaying drawing.
Existing cached JS geometry stays valid while later cache misses use Lyon; there
is no cache invalidation or geometry swap when loading completes. It fetches the
same-origin Vite-generated asset and compiles it without host imports. A four
second total deadline aborts a slow request while rendering continues through JS;
a late instance is disposed. HTTP/compile/CSP failures also keep rendering on JS
for the page. Deployment should serve the emitted asset with the rest of the
build; `application/wasm` is recommended, though this loader uses `arrayBuffer`
and does not depend on streaming MIME handling. A restrictive CSP must permit
the asset fetch and WebAssembly compilation for acceleration; it need not be
weakened to preserve editor correctness.

`tests/editor/lyon.test.ts` exercises winding, holes, precision boundaries,
generated intersections at distant origins, allocation/status/trap/output
failure, detached views, disposal, HTTP/compile/deadline failure and unchanged JS
fallback. For a failing contour, instantiate the module and pass its existing
contours through `LyonTessellator`; retain the fill rule and compiled resolution.
The optional Cargo `release-debug` profile keeps optimized code with DWARF debug
information (`cargo build --locked --profile release-debug --target
wasm32-unknown-unknown`). These larger debugging artifacts are not distributed.
The browser wrapper remains normal TypeScript with Vite source maps; failures
can be reproduced without a generated JS bridge.

All nine locked package notices, including the complete libm notices and the
build-only autocfg package, are shipped in `public/third-party/lyon`. Lyon texts
were retrieved from each crate's recorded upstream revision. The complete Rust
1.96.0 library-distribution notice is retained separately; it lists additional
upstream components, not necessarily every component linked into this module.
The notice inventory records original sources and SHA-256 hashes. Source and
binary upgrades require refreshing this inventory and rerunning the real-chart
geometry and whole-editor performance checks, rather than assuming a newer
compiler or library preserves topology or improves speed.
