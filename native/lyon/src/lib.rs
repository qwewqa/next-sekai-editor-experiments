//! Single-instance bulk ABI for the editor's already-flattened local contours.
//! No callbacks/imported host functions are used while Rust owns the buffers.

#[cfg(not(target_arch = "wasm32"))]
compile_error!("Path tessellation must be built for wasm32-unknown-unknown.");
#[cfg(target_feature = "atomics")]
compile_error!("The bulk ABI requires unshared memory and a single calling thread.");

use std::cell::RefCell;
use std::mem::size_of;

use lyon_tessellation::geometry_builder::{BuffersBuilder, Positions, VertexBuffers};
use lyon_tessellation::math::{point, Point};
use lyon_tessellation::{FillOptions, FillRule, FillTessellator};

const OK: i32 = 0;
const ALLOCATION_FAILED: i32 = 1;
const INVALID_INPUT: i32 = -1;
const UNSUPPORTED_COORDINATE: i32 = -2;
const TESSELLATION_FAILED: i32 = -3;
const INVALID_OUTPUT: i32 = -4;
const REENTRANT_CALL: i32 = -6;
const TOO_MANY_EDGES: i32 = -7;

// Reviewed against real chart contours, phase/scale sweeps and actual pixels.
// This does not disable Lyon's separate fixed intersection-endpoint snapping.
const TOLERANCE: f32 = 1.0e-5;
// Also checked by the JS caller with its actual compiled-pixel resolution.
const MAX_LOCAL_COORDINATE: f64 = 8_388_608.0;
// Lyon's winding accumulator is i16. A single contour may self-wind, so the
// conservative bound counts every submitted edge, not merely contours.
const MAX_EDGES: usize = 32_767;

struct Kernel {
    input: Vec<f64>,
    counts: Vec<u32>,
    output: Vec<f64>,
    mesh: VertexBuffers<Point, u32>,
    tessellator: FillTessellator,
}

impl Kernel {
    fn new() -> Self {
        Self {
            input: Vec::new(),
            counts: Vec::new(),
            output: Vec::new(),
            mesh: VertexBuffers::new(),
            tessellator: FillTessellator::new(),
        }
    }

    fn reserve(&mut self, coordinates: usize, contours: usize) -> bool {
        self.output.clear();
        if coordinates > MAX_EDGES * 2
            || contours > MAX_EDGES
            || !valid_length::<f64>(coordinates)
            || !valid_length::<u32>(contours)
        {
            return false;
        }
        // Initialize all host-writable elements; capacity alone is not a valid
        // Rust slice. Partial success is owned and remains safe to retry/drop.
        if !resize_zeroed(&mut self.input, coordinates)
            || !resize_zeroed(&mut self.counts, contours)
        {
            return false;
        }
        true
    }

    fn run(&mut self, contour_count: usize, coordinate_count: usize, odd: i32) -> i32 {
        self.output.clear();
        self.mesh.clear();
        if contour_count > self.counts.len()
            || coordinate_count > self.input.len()
            || (odd != 0 && odd != 1)
        {
            return INVALID_INPUT;
        }

        let mut checked = 0usize;
        let mut polygons = 0usize;
        for &count in &self.counts[..contour_count] {
            let count = count as usize;
            if count > (coordinate_count - checked) / 2 {
                return INVALID_INPUT;
            }
            checked += count * 2;
            polygons += usize::from(count >= 3);
        }
        if checked != coordinate_count {
            return INVALID_INPUT;
        }
        if checked / 2 > MAX_EDGES {
            return TOO_MANY_EDGES;
        }
        // Validate before taking Lyon's reusable event storage into a builder.
        // A finite f64 can overflow f32; the bound also excludes that case.
        for &value in &self.input[..coordinate_count] {
            if !value.is_finite() || value.abs() > MAX_LOCAL_COORDINATE {
                return UNSUPPORTED_COORDINATE;
            }
        }
        if polygons == 0 {
            return OK;
        }

        let rule = if odd == 1 { FillRule::EvenOdd } else { FillRule::NonZero };
        let options = FillOptions::default()
            .with_fill_rule(rule)
            .with_tolerance(TOLERANCE)
            .with_intersections(true);
        let result = {
            let mut geometry = BuffersBuilder::new(&mut self.mesh, Positions);
            let mut path = self.tessellator.builder(&options, &mut geometry);
            let mut offset = 0usize;
            for &count in &self.counts[..contour_count] {
                let count = count as usize;
                if count >= 3 {
                    path.begin(point(self.input[offset] as f32, self.input[offset + 1] as f32));
                    for vertex in 1..count {
                        let i = offset + vertex * 2;
                        path.line_to(point(self.input[i] as f32, self.input[i + 1] as f32));
                    }
                    path.end(true);
                }
                offset += count * 2;
            }
            path.build()
        };
        if result.is_err() {
            // BuffersBuilder aborts ordinary errors; explicitly clear again and
            // replace the tessellator so a failed run cannot retain sweep state.
            self.mesh.clear();
            self.tessellator = FillTessellator::new();
            return TESSELLATION_FAILED;
        }

        if self.mesh.indices.len() % 3 != 0 {
            self.mesh.clear();
            return INVALID_OUTPUT;
        }
        let Some(length) = self.mesh.indices.len().checked_mul(2) else {
            return INVALID_OUTPUT;
        };
        if !valid_length::<f64>(length) || length > u32::MAX as usize {
            return INVALID_OUTPUT;
        }
        if self.output.try_reserve(length).is_err() {
            return ALLOCATION_FAILED;
        }
        for &index in &self.mesh.indices {
            let Some(position) = self.mesh.vertices.get(index as usize) else {
                self.output.clear();
                return INVALID_OUTPUT;
            };
            if !position.x.is_finite() || !position.y.is_finite() {
                self.output.clear();
                return INVALID_OUTPUT;
            }
            self.output.push(f64::from(position.x));
            self.output.push(f64::from(position.y));
        }
        OK
    }
}

fn valid_length<T>(length: usize) -> bool {
    length <= (isize::MAX as usize) / size_of::<T>()
}

fn resize_zeroed<T: Copy + Default>(buffer: &mut Vec<T>, length: usize) -> bool {
    if length > buffer.len() && buffer.try_reserve(length - buffer.len()).is_err() {
        return false;
    }
    buffer.resize(length, T::default());
    true
}

thread_local! {
    // No unsafe static aliasing. Every borrow ends before returning to JS.
    static STATE: RefCell<Option<Kernel>> = const { RefCell::new(None) };
}

fn with_kernel<R>(unavailable: R, operation: impl FnOnce(&mut Kernel) -> R) -> R {
    STATE.with(|cell| {
        let Ok(mut state) = cell.try_borrow_mut() else { return unavailable };
        operation(state.get_or_insert_with(Kernel::new))
    })
}

fn read_kernel<R>(empty: R, operation: impl FnOnce(&Kernel) -> R) -> R {
    STATE.with(|cell| {
        let Ok(state) = cell.try_borrow() else { return empty };
        match state.as_ref() {
            Some(kernel) => operation(kernel),
            None => empty,
        }
    })
}

#[no_mangle]
pub extern "C" fn reserve(coordinates: u32, contours: u32) -> i32 {
    with_kernel(0, |kernel| i32::from(kernel.reserve(coordinates as usize, contours as usize)))
}

#[no_mangle]
pub extern "C" fn input_ptr() -> u32 {
    read_kernel(0, |kernel| if kernel.input.is_empty() { 0 } else { kernel.input.as_ptr() as u32 })
}

#[no_mangle]
pub extern "C" fn counts_ptr() -> u32 {
    read_kernel(0, |kernel| if kernel.counts.is_empty() { 0 } else { kernel.counts.as_ptr() as u32 })
}

#[no_mangle]
pub extern "C" fn output_ptr() -> u32 {
    read_kernel(0, |kernel| if kernel.output.is_empty() { 0 } else { kernel.output.as_ptr() as u32 })
}

#[no_mangle]
pub extern "C" fn output_length() -> u32 {
    read_kernel(0, |kernel| kernel.output.len() as u32)
}

#[no_mangle]
pub extern "C" fn run(contours: u32, coordinates: u32, odd: i32) -> i32 {
    with_kernel(REENTRANT_CALL, |kernel| kernel.run(contours as usize, coordinates as usize, odd))
}

#[no_mangle]
pub extern "C" fn abi_version() -> u32 {
    1
}

#[no_mangle]
pub extern "C" fn heap_bytes() -> f64 {
    // f64 reports the full 4 GiB boundary without wrapping a u32 byte count.
    (core::arch::wasm32::memory_size::<0>() as f64) * 65_536.0
}

#[no_mangle]
pub extern "C" fn dispose() -> i32 {
    STATE.with(|cell| {
        let Ok(mut state) = cell.try_borrow_mut() else { return REENTRANT_CALL };
        *state = None;
        OK
    })
}

