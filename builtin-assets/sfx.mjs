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

/** A bright click: two sines with an exponential decay and a 4 ms burst of noise. */
const click = (seconds, pitch, seed) => {
    const out = empty(seconds)
    const random = createRandom(seed)
    for (let i = 0; i < out.length; i++) {
        const t = timeOf(i)
        const tone = Math.sin(tau * 1320 * pitch * t) + 0.4 * Math.sin(tau * 2640 * pitch * t)
        out[i] = tone * Math.exp(-t / 0.012) * Math.min(1, t / 0.001)
        if (t < 0.004) out[i] += (random() * 2 - 1) * (1 - t / 0.004)
    }
    return out
}

/** A sweep with a short band of noise (a whoosh). */
const sweep = (seconds, from, to, seed) => {
    const out = empty(seconds)
    const random = createRandom(seed)
    const noise = lowPass(
        Float64Array.from(out, () => random() * 2 - 1),
        0.3,
    )
    for (let i = 0; i < out.length; i++) {
        const t = timeOf(i)
        const phase = tau * (from * t + ((to - from) / (2 * seconds)) * t * t)
        const envelope = Math.sin((Math.PI * t) / seconds)
        out[i] = (Math.sin(phase) + 0.4 * noise[i]) * envelope
    }
    return out
}

/** A seamless pad: whole cycles of each partial in the loop, with a 4 Hz tremolo. */
const pad = (partials) => {
    const out = empty(1)
    for (let i = 0; i < out.length; i++) {
        const t = timeOf(i)
        let sum = 0
        for (const [frequency, level] of partials) sum += level * Math.sin(tau * frequency * t)
        out[i] = sum * (0.75 + 0.25 * Math.sin(tau * 4 * t))
    }
    return out
}

const pip = (seconds, frequency, level = 1) => {
    const out = empty(seconds)
    for (let i = 0; i < out.length; i++) {
        const t = timeOf(i)
        out[i] = level * Math.sin(tau * frequency * t) * Math.exp(-t / (seconds / 4)) * Math.min(1, t / 0.001)
    }
    return out
}

/** A bell partial pair with a 140 ms decay. */
const bell = (seconds, low, high) => {
    const out = empty(seconds)
    for (let i = 0; i < out.length; i++) {
        const t = timeOf(i)
        out[i] = (Math.sin(tau * low * t) + 0.5 * Math.sin(tau * high * t)) * Math.exp(-t / 0.045)
    }
    return out
}

const stage = () => {
    const out = empty(0.2)
    const notes = [523.25, 659.25, 783.99]
    for (let i = 0; i < out.length; i++) {
        const t = timeOf(i)
        const note = Math.min(2, Math.floor(t / (0.2 / 3)))
        const local = t - note * (0.2 / 3)
        out[i] = Math.sin(tau * notes[note] * t) * Math.exp(-local / 0.03)
    }
    return out
}

/** The sum, as long as the longest part. */
const mix = (...parts) => {
    const out = new Float64Array(Math.max(...parts.map((part) => part.length)))
    for (const part of parts) for (let i = 0; i < part.length; i++) out[i] += part[i]
    return out
}

const scale = (samples, level) => samples.map((sample) => sample * level)

// A semitone and a fifth lower, as constants so no pow call is involved.
const semitoneDown = 0.9438743126816935
const fifthDown = 2 / 3

/** The 15 clips in the engine's order, as Float64 samples before normalisation. */
export function renderClips() {
    const tap = click(0.07, 1, 1)
    const flick = sweep(0.09, 900, 2200, 2)
    const holdPartials = [
        [440, 1],
        [660, 0.6],
        [880, 0.4],
    ]
    const traceTick = pip(0.035, 1800, 0.8)
    return {
        '#PERFECT': tap,
        '#GREAT': lowPass(click(0.07, semitoneDown, 3), 0.5),
        '#GOOD': lowPass(click(0.07, fifthDown, 4), 0.3),
        '#PERFECT_ALTERNATIVE': flick,
        '#GREAT_ALTERNATIVE': lowPass(sweep(0.09, 700, 1700, 5), 0.5),
        '#GOOD_ALTERNATIVE': lowPass(sweep(0.09, 500, 1200, 6), 0.3),
        '#HOLD': pad(holdPartials),
        '#STAGE': stage(),
        'Sekai Tick': pip(0.025, 2400, 0.5),
        'Sekai Critical Tap': mix(tap, scale(bell(0.14, 1760, 3520), 0.6)),
        'Sekai Critical Flick': mix(flick, scale(bell(0.14, 1760, 3520), 0.6)),
        'Sekai Critical Hold': pad([...holdPartials, [1320, 0.3]]),
        'Sekai Critical Tick': mix(pip(0.025, 2400, 0.5), pip(0.025, 4800, 0.3)),
        'Sekai Trace': traceTick,
        'Sekai Critical Trace': mix(traceTick, pip(0.035, 2700, 0.4)),
    }
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

const highPass = () => {
    const [f0, q] = [38.13547087602444, 0.5003270373238773]
    const k = Math.tan((Math.PI * f0) / sampleRate)
    const a0 = 1 + k / q + k * k
    return [1, -2, 1, (2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0]
}

/** The loudness of the first 200 ms in LUFS (K-weighted, zero padded). */
export function loudness(samples) {
    const head = new Float64Array(window)
    head.set(samples.subarray(0, window))
    const weighted = biquad(biquad(head, shelf()), highPass())
    let sum = 0
    for (const value of weighted) sum += value * value
    return -0.691 + 10 * Math.log10(sum / window)
}

const peakOf = (samples) => samples.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0)

/** LU below the hits: loops sit under them, and ticks and traces come in dense runs. */
export const offsets = {
    '#HOLD': -4,
    'Sekai Critical Hold': -4,
    'Sekai Tick': -3,
    'Sekai Critical Tick': -3,
    'Sekai Trace': -3,
    'Sekai Critical Trace': -3,
}

/** The clips by name as Float64 samples scaled to one loudness (less each offset), peak <= peakLevel. */
export function matchLoudness(clips) {
    const offset = (name) => offsets[name] ?? 0
    const measured = Object.entries(clips).map(([name, samples]) => {
        const lufs = loudness(samples)
        // The most loudness this clip can reach before its peak passes peakLevel.
        const reach = lufs + 20 * Math.log10(peakLevel / peakOf(samples))
        return { name, samples, lufs, limit: reach - offset(name) }
    })
    const target = Math.min(...measured.map(({ limit }) => limit))
    const out = {}
    for (const { name, samples, lufs } of measured) {
        const gain = Math.exp(((target + offset(name) - lufs) / 20) * Math.LN10)
        out[name] = samples.map((sample) => sample * gain)
    }
    return { clips: out, target }
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
