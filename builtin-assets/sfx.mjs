// Clip synthesis: pure functions from a seeded PRNG and plain arithmetic to samples (Part 2, 2.9.6).
// Only + - * / and Math.sin, Math.exp are used, so the bytes don't depend on the machine.

export const sampleRate = 44100
const tau = 2 * Math.PI

// The -3 dBFS peak every clip is normalised to, as a fraction of full scale.
export const peakLevel = 0.7

/** A seeded xorshift32 PRNG: next() is in [0, 1). */
export function createRandom(seed) {
    let state = seed >>> 0 || 1
    return () => {
        state ^= state << 13
        state >>>= 0
        state ^= state >>> 17
        state ^= state << 5
        state >>>= 0
        return state / 4294967296
    }
}

const empty = (seconds) => new Float64Array(Math.round(seconds * sampleRate))
const timeOf = (i) => i / sampleRate

/** A one-pole low pass; a smaller coefficient is duller. */
const lowPass = (samples, coefficient) => {
    let state = 0
    for (let i = 0; i < samples.length; i++) {
        state += coefficient * (samples[i] - state)
        samples[i] = state
    }
    return samples
}

/** What a one-pole low pass takes away: a gentle high pass. */
const highPass = (samples, coefficient) => {
    const low = lowPass(Float64Array.from(samples), coefficient)
    return samples.map((sample, i) => sample - low[i])
}

/** The sum, as long as the longest part. */
const mix = (...parts) => {
    const out = new Float64Array(Math.max(...parts.map((part) => part.length)))
    for (const part of parts) for (let i = 0; i < part.length; i++) out[i] += part[i]
    return out
}

const scale = (samples, level) => samples.map((sample) => sample * level)

/** A 30 ms fade at the end, so a one-shot clip never stops on a click. */
const fadeOut = (samples) => {
    const length = Math.round(0.03 * sampleRate)
    const out = Float64Array.from(samples)
    for (let i = 0; i < length; i++) {
        const gain = Math.sin(((Math.PI / 2) * i) / length)
        out[out.length - 1 - i] *= gain * gain
    }
    return out
}

/**
 * Decaying sine partials: [frequency, level, decay in seconds], with a short linear attack so the
 * start doesn't click.
 */
const partials = (seconds, list, { attack = 0.001, start = 0 } = {}) => {
    const out = empty(seconds)
    const from = Math.round(start * sampleRate)
    for (let i = from; i < out.length; i++) {
        const t = timeOf(i - from)
        let sum = 0
        for (const [frequency, level, decay] of list)
            sum += level * Math.sin(tau * frequency * t) * Math.exp(-t / decay)
        out[i] = sum * Math.min(1, t / attack)
    }
    return out
}

/** A noise burst with an exponential decay, high passed so it is a crisp tick rather than a thud. */
const burst = (seconds, decay, seed, brightness = 0.5) => {
    const random = createRandom(seed)
    const out = empty(seconds)
    for (let i = 0; i < out.length; i++) out[i] = (random() * 2 - 1) * Math.exp(-timeOf(i) / decay)
    return highPass(out, brightness)
}

/** A sine whose pitch falls from one frequency to another, for a soft knock. */
const knock = (seconds, from, to, decay) => {
    const out = empty(seconds)
    let phase = 0
    for (let i = 0; i < out.length; i++) {
        const t = timeOf(i)
        const frequency = to + (from - to) * Math.exp(-t / 0.012)
        phase += (tau * frequency) / sampleRate
        out[i] = Math.sin(phase) * Math.exp(-t / decay) * Math.min(1, t / 0.0005)
    }
    return out
}

/** The tap: a crisp tick over a short bright bell and a soft knock for weight. */
const tap = (pitch, bright, seed) =>
    mix(
        scale(burst(0.03, 0.003, seed, 0.3 + 0.4 * bright), 0.5),
        partials(0.32, [
            [1318.5 * pitch, 0.55, 0.07],
            [2637 * pitch, 0.3 * bright, 0.04],
            [3955.5 * pitch, 0.18 * bright, 0.025],
            [5274 * pitch, 0.1 * bright, 0.015],
        ]),
        scale(knock(0.12, 420 * pitch, 260 * pitch, 0.03), 0.45),
    )

/** The flick: a rising swish of band-limited noise, a rising chirp and the tap's tick. */
const swish = (seconds, from, to, seed, bright) => {
    const random = createRandom(seed)
    const out = empty(seconds)
    let low = 0
    let lower = 0
    let phase = 0
    for (let i = 0; i < out.length; i++) {
        const t = timeOf(i)
        const rise = t < 0.12 ? t / 0.12 : 1
        const frequency = from + (to - from) * rise
        // A band of noise round the rising frequency: the difference of two one-pole low passes.
        const coefficient = (tau * frequency) / sampleRate
        const noise = random() * 2 - 1
        low += coefficient * 1.6 * (noise - low)
        lower += coefficient * 0.5 * (noise - lower)
        phase += (tau * frequency) / sampleRate
        const envelope = Math.min(1, t / 0.012) * Math.exp(-t / 0.07)
        out[i] = envelope * (1.6 * (low - lower) + 0.35 * bright * Math.sin(phase))
    }
    return mix(out, scale(burst(0.03, 0.003, seed + 1, 0.6), 0.35))
}

/** A bell chord with a longer ring: [frequency, level] pairs. */
const bell = (seconds, notes, decay) =>
    partials(
        seconds,
        notes.flatMap(([frequency, level]) => [
            [frequency, level, decay],
            [frequency * 2.756, level * 0.25, decay * 0.4],
        ]),
        { attack: 0.002 },
    )

/**
 * A seamless one-second loop: whole cycles of every partial, a slow shimmer of whole cycles, and an
 * air of high partials at whole frequencies with seeded phases.
 */
const pad = (notes, air, shimmer, seed) => {
    const random = createRandom(seed)
    const sparkle = Array.from({ length: 24 }, (_, k) => [
        3000 + 125 * k + Math.floor(random() * 100),
        random(),
    ])
    const out = empty(1)
    for (let i = 0; i < out.length; i++) {
        const t = timeOf(i)
        let tone = 0
        for (const [frequency, level] of notes) tone += level * Math.sin(tau * frequency * t)
        let hiss = 0
        for (const [frequency, phase] of sparkle) hiss += Math.sin(tau * (frequency * t + phase))
        const swell = 0.8 + 0.2 * Math.sin(tau * shimmer * t)
        const flutter = 0.6 + 0.4 * Math.sin(tau * 2 * shimmer * t + 1)
        out[i] = tone * swell + (air / 24) * hiss * flutter
    }
    return out
}

/** The empty-lane tap: a muted knock. */
const thud = (seed) =>
    mix(knock(0.15, 300, 140, 0.04), scale(lowPass(burst(0.02, 0.004, seed, 0.9), 0.5), 0.4))

/** The tick: a short glassy pip with a tiny click. */
const tick = (seed) =>
    mix(
        scale(burst(0.02, 0.0015, seed, 0.5), 0.35),
        partials(0.16, [
            [2093, 0.6, 0.035],
            [4186, 0.25, 0.015],
            [6279, 0.08, 0.008],
        ]),
    )

/** The trace: an airy tsk over a high soft pip. */
const trace = (seed) =>
    mix(
        scale(burst(0.06, 0.012, seed, 0.25), 0.6),
        partials(0.12, [
            [2793.8, 0.4, 0.03],
            [5587.6, 0.12, 0.015],
        ]),
    )

// A whole tone and a fourth lower, as constants so no pow call is involved.
const toneDown = 0.8908987181403393
const fourthDown = 0.7491535384383408

/** The 15 clips in the engine's order, as Float64 samples before levelling. */
export function renderClips() {
    const perfect = tap(1, 1, 1)
    const flick = swish(0.32, 1100, 3200, 2, 1)
    const crown = (notes) => bell(0.6, notes, 0.16)
    const holdNotes = [
        [523, 0.5],
        [784, 0.3],
        [1046, 0.22],
        [1568, 0.1],
    ]
    const clips = {
        '#PERFECT': perfect,
        '#GREAT': lowPass(tap(toneDown, 0.6, 3), 0.7),
        '#GOOD': lowPass(tap(fourthDown, 0.3, 4), 0.45),
        '#PERFECT_ALTERNATIVE': flick,
        '#GREAT_ALTERNATIVE': lowPass(swish(0.3, 900, 2500, 5, 0.6), 0.7),
        '#GOOD_ALTERNATIVE': lowPass(swish(0.28, 700, 1800, 6, 0.3), 0.45),
        '#HOLD': pad(holdNotes, 0.08, 2, 7),
        '#STAGE': thud(8),
        'Sekai Tick': tick(9),
        'Sekai Critical Tap': mix(
            perfect,
            crown([
                [1568, 0.3],
                [1975.5, 0.22],
                [2637, 0.2],
            ]),
        ),
        'Sekai Critical Flick': mix(
            flick,
            crown([
                [2093, 0.3],
                [2637, 0.22],
                [3136, 0.2],
            ]),
        ),
        'Sekai Critical Hold': pad(
            [...holdNotes, [1318, 0.18], [1975, 0.1], [2637, 0.06]],
            0.16,
            3,
            10,
        ),
        'Sekai Critical Tick': mix(
            tick(11),
            bell(
                0.3,
                [
                    [3136, 0.3],
                    [4699, 0.15],
                ],
                0.07,
            ),
        ),
        'Sekai Trace': trace(12),
        'Sekai Critical Trace': mix(
            trace(13),
            bell(
                0.3,
                [
                    [3520, 0.3],
                    [5274, 0.15],
                ],
                0.08,
            ),
        ),
    }
    const loops = ['#HOLD', 'Sekai Critical Hold']
    return Object.fromEntries(
        Object.entries(clips).map(([name, samples]) => [
            name,
            loops.includes(name) ? samples : fadeOut(samples),
        ]),
    )
}

// Loudness is measured as K-weighted (ITU-R BS.1770) power over the first 200 ms, zero padded, in LU
// relative to full scale: short clips and the start of a loop are compared on the same window.
const window = Math.round(0.2 * sampleRate)

const biquad = (samples, [b0, b1, b2, a1, a2]) => {
    const out = new Float64Array(samples.length)
    let x1 = 0
    let x2 = 0
    let y1 = 0
    let y2 = 0
    for (let i = 0; i < samples.length; i++) {
        const x = samples[i]
        const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        out[i] = y
        x2 = x1
        x1 = x
        y2 = y1
        y1 = y
    }
    return out
}

const shelf = () => {
    const [f0, gain, q] = [1681.974450955533, 3.999843853973347, 0.7071752369554196]
    const k = Math.tan((Math.PI * f0) / sampleRate)
    const vh = Math.exp((gain / 20) * Math.LN10)
    const vb = Math.exp(0.4996667741545416 * Math.log(vh))
    const a0 = 1 + k / q + k * k
    return [
        (vh + (vb * k) / q + k * k) / a0,
        (2 * (k * k - vh)) / a0,
        (vh - (vb * k) / q + k * k) / a0,
        (2 * (k * k - 1)) / a0,
        (1 - k / q + k * k) / a0,
    ]
}

const kHighPass = () => {
    const [f0, q] = [38.13547087602444, 0.5003270373238773]
    const k = Math.tan((Math.PI * f0) / sampleRate)
    const a0 = 1 + k / q + k * k
    return [1, -2, 1, (2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0]
}

/** The loudness of the first 200 ms in LUFS (K-weighted, zero padded). */
export function loudness(samples) {
    const head = new Float64Array(window)
    head.set(samples.subarray(0, window))
    const weighted = biquad(biquad(head, shelf()), kHighPass())
    let sum = 0
    for (const value of weighted) sum += value * value
    return -0.691 + 10 * Math.log10(sum / window)
}

const peakOf = (samples) => samples.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0)

/**
 * The loudness each clip is set to (LUFS, as loudness() measures it), from the web's Default clips
 * measured the same way (mono equivalent, from the onset); the Sonolus-only clips sit under the hits.
 */
export const targets = {
    '#PERFECT': -15.5,
    '#GREAT': -16.5,
    '#GOOD': -17.5,
    '#PERFECT_ALTERNATIVE': -14.3,
    '#GREAT_ALTERNATIVE': -15.3,
    '#GOOD_ALTERNATIVE': -16.3,
    '#HOLD': -22.5,
    '#STAGE': -20,
    'Sekai Tick': -18.2,
    'Sekai Critical Tap': -11.7,
    'Sekai Critical Flick': -12.9,
    'Sekai Critical Hold': -17.5,
    'Sekai Critical Tick': -17.9,
    'Sekai Trace': -17.2,
    'Sekai Critical Trace': -11.4,
}

// A soft limiter towards peakLevel: unchanged below the knee, then a smooth curve that never reaches it.
const knee = 0.45
const limit = (samples) =>
    samples.map((sample) => {
        const size = Math.abs(sample)
        if (size <= knee) return sample
        const over = (size - knee) / (peakLevel - knee)
        const shaped = knee + ((peakLevel - knee) * over) / (1 + over)
        return sample < 0 ? -shaped : shaped
    })

/** Scales a clip to its target, limiting peaks; a few passes settle the gain the limiter costs. */
function level(samples, target) {
    let gain = Math.exp(((target - loudness(samples)) / 20) * Math.LN10)
    let out = limit(scale(samples, gain))
    for (let pass = 0; pass < 6; pass++) {
        gain *= Math.exp(((target - loudness(out)) / 20) * Math.LN10)
        out = limit(scale(samples, gain))
    }
    return out
}

/** The clips by name as Float64 samples at their targets, peaks below peakLevel. */
export function matchLoudness(clips) {
    const out = {}
    for (const [name, samples] of Object.entries(clips)) out[name] = level(samples, targets[name])
    return { clips: out }
}

/** Quantises to 16 bits with TPDF dither from the clip's own PRNG. */
export function toPcm16(samples, seed) {
    const random = createRandom(seed)
    const out = new Int16Array(samples.length)
    for (let i = 0; i < samples.length; i++) {
        const dither = random() + random() - 1
        const value = Math.round(samples[i] * 32767 + dither)
        out[i] = Math.max(-32768, Math.min(32767, value))
    }
    return out
}

/** A RIFF WAV: PCM, 16-bit, mono, 44.1 kHz. */
export function encodeWav(pcm) {
    const bytes = Buffer.alloc(44 + pcm.length * 2)
    bytes.write('RIFF', 0)
    bytes.writeUInt32LE(36 + pcm.length * 2, 4)
    bytes.write('WAVEfmt ', 8)
    bytes.writeUInt32LE(16, 16)
    bytes.writeUInt16LE(1, 20)
    bytes.writeUInt16LE(1, 22)
    bytes.writeUInt32LE(sampleRate, 24)
    bytes.writeUInt32LE(sampleRate * 2, 28)
    bytes.writeUInt16LE(2, 32)
    bytes.writeUInt16LE(16, 34)
    bytes.write('data', 36)
    bytes.writeUInt32LE(pcm.length * 2, 40)
    for (let i = 0; i < pcm.length; i++) bytes.writeInt16LE(pcm[i], 44 + i * 2)
    return bytes
}

/** The clips as WAV files, by clip name. */
export function renderWavs() {
    const wavs = {}
    let seed = 100
    for (const [name, samples] of Object.entries(matchLoudness(renderClips()).clips))
        wavs[name] = encodeWav(toPcm16(samples, seed++))
    return wavs
}

/**
 * A short demo BGM for fixtures and screenshots: a 30 s loop of chords and a bass line from the same
 * synthesis. Rendered when needed, never committed.
 */
export function renderDemoBgm() {
    const seconds = 30
    const out = empty(seconds)
    const chords = [
        [261.63, 329.63, 392],
        [220, 261.63, 329.63],
        [174.61, 220, 261.63],
        [196, 246.94, 293.66],
    ]
    const beat = 0.5
    for (let i = 0; i < out.length; i++) {
        const t = timeOf(i)
        const bar = Math.floor(t / (beat * 4)) % chords.length
        const local = t % (beat * 4)
        let sum = 0
        for (const frequency of chords[bar]) sum += 0.2 * Math.sin(tau * frequency * t)
        sum *= Math.exp(-local / 1.2)
        const step = local % beat
        sum += 0.4 * Math.sin(tau * chords[bar][0] * 0.5 * t) * Math.exp(-step / 0.15)
        out[i] = sum
    }
    return encodeWav(toPcm16(scale(out, peakLevel / peakOf(out)), 999))
}
