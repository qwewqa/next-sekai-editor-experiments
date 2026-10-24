// Clip synthesis: pure functions from a seeded PRNG and plain arithmetic to samples.
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

/** Seeded white noise in [-1, 1). */
const noise = (seconds, seed) => {
    const random = createRandom(seed)
    const out = empty(seconds)
    for (let i = 0; i < out.length; i++) out[i] = random() * 2 - 1
    return out
}

/**
 * A state-variable band pass (Chamberlin) round centre(t) Hz; damping 1 or more keeps it a broad
 * band of noise rather than a pitch. The centre stays under 6 kHz, where the filter is stable.
 */
const band = (samples, centre, damping = 1.2) => {
    const out = new Float64Array(samples.length)
    let low = 0
    let mid = 0
    for (let i = 0; i < samples.length; i++) {
        const at = typeof centre === 'number' ? centre : centre(timeOf(i))
        const f = 2 * Math.sin((Math.PI * at) / sampleRate)
        low += f * mid
        const high = samples[i] - low - damping * mid
        mid += f * high
        out[i] = mid
    }
    return out
}

/** An envelope: a sine-eased attack of the given length, then an exponential decay. */
const envelope = (samples, attack, decay, delay = 0) =>
    samples.map((sample, i) => {
        const t = timeOf(i) - delay
        if (t < 0) return 0
        const rise = t < attack ? Math.sin((Math.PI / 2) * (t / attack)) : 1
        return sample * rise * rise * Math.exp(-(t - (t < attack ? t : attack)) / decay)
    })

/** A noise hit: noise in a band, shaped by an envelope. */
const hit = (seconds, seed, { centre, damping = 1.2, attack = 0.0005, decay, delay = 0 }) =>
    envelope(band(noise(seconds, seed), centre, damping), attack, decay, delay)

/** A click: a very short burst of high passed noise, the transient of every hit. */
const click = (seconds, seed, decay = 0.0008, brightness = 0.5) =>
    envelope(highPass(noise(seconds, seed), brightness), 0.0001, decay)

/** A soft thump: noise in the low band (about 60 to 200 Hz), felt more than heard, with no pitch. */
const thump = (seconds, seed, decay, coefficient = 0.03) =>
    envelope(highPass(lowPass(noise(seconds, seed), coefficient), 0.009), 0.001, decay)

/** The tap: a tight click on a short mid-range knock of noise over a soft thump. */
const tap = (seed, { tone = 1800, body = 0.022, dull = 1 } = {}) =>
    lowPass(
        mix(
            scale(click(0.12, seed), 0.6),
            hit(0.12, seed + 1, { centre: tone, damping: 1.1, decay: body }),
            scale(thump(0.12, seed + 2, 0.026), 2.5),
        ),
        dull,
    )

/** A critical tap: the tap brighter and fuller, a clap of three quick bursts and a bright air. */
const clap = (seed) =>
    lowPass(
        mix(
            tap(seed, { tone: 2200, body: 0.028 }),
            ...[0, 0.009, 0.019].map((delay, k) =>
                scale(
                    hit(0.22, seed + 3 + k, { centre: 2600, damping: 1.4, decay: 0.012, delay }),
                    0.8 - 0.15 * k,
                ),
            ),
            scale(envelope(highPass(noise(0.22, seed + 6), 0.2), 0.001, 0.07), 0.35),
        ),
        0.75,
    )

/**
 * The flick: a soft swish, noise in a broad band gliding up an octave and a bit, eased in so it
 * breathes rather than cracks.
 */
const swish = (seed, { from = 1100, to = 2600, length = 0.28, dull = 0.6 } = {}) => {
    const glide = (t) => {
        const x = t < 0.14 ? t / 0.14 : 1
        return from + (to - from) * x * (2 - x)
    }
    return lowPass(
        mix(
            envelope(band(noise(length, seed), glide, 1.6), 0.03, 0.06),
            scale(click(length, seed + 1, 0.0006, 0.6), 0.2),
        ),
        dull,
    )
}

/** A critical flick: the swish with a crisper start and a brighter air on top. */
const criticalSwish = (seed) =>
    lowPass(
        mix(
            swish(seed, { from: 1300, to: 3200, dull: 0.75 }),
            scale(click(0.3, seed + 2, 0.0012, 0.4), 0.45),
            scale(envelope(highPass(noise(0.3, seed + 3), 0.25), 0.02, 0.07), 0.3),
        ),
        0.75,
    )

/**
 * A seamless one-second loop of a soft low hum: sine partials on whole hertz, so every one ends
 * where it began, each with a quieter twin a hertz or two off for a slow beat, and one gentle swell a
 * second whose low point is the loop's start, so a hold fades in. Partials are [hertz, level, twin].
 */
const hum = (partials, swell) => {
    const out = empty(1)
    for (let i = 0; i < out.length; i++) {
        const t = timeOf(i)
        let sum = 0
        for (const [frequency, amount, twin] of partials) {
            sum += amount * Math.sin((tau * ((frequency * i) % sampleRate)) / sampleRate)
            // The twin starts in opposite phase, so the beat too starts at its quietest.
            if (twin) {
                const at = ((frequency + twin) * i) % sampleRate
                sum -= 0.12 * amount * Math.sin((tau * at) / sampleRate)
            }
        }
        const rise = 0.5 - 0.5 * Math.sin(tau * (t + 0.25))
        out[i] = sum * (1 - swell * (1 - rise))
    }
    return out
}

/** The empty-lane tap: a muted knock. */
const thud = (seed) =>
    mix(scale(thump(0.15, seed, 0.03, 0.02), 3), scale(lowPass(click(0.15, seed + 1), 0.4), 0.4))

/** The tick: a light, sharp tick, high and short, its top rolled off so it never sizzles. */
const tick = (seed, bright = 0) =>
    lowPass(
        mix(
            scale(click(0.1, seed, 0.0006, 0.3), 0.7),
            hit(0.1, seed + 1, { centre: 4200 + 800 * bright, damping: 1.3, decay: 0.006 }),
            scale(
                envelope(highPass(noise(0.1, seed + 2), 0.2), 0.001, 0.012 + 0.02 * bright),
                0.2 + 0.25 * bright,
            ),
        ),
        0.65,
    )

/** The trace: an airy tsk, softer and longer than a tick. */
const trace = (seed, bright = 0) =>
    lowPass(
        mix(
            scale(click(0.2, seed, 0.0005, 0.4), 0.3 + 0.3 * bright),
            hit(0.2, seed + 1, { centre: 5200, damping: 1.6, attack: 0.002, decay: 0.022 }),
            scale(
                envelope(highPass(noise(0.2, seed + 2), 0.15), 0.003, 0.03 + 0.07 * bright),
                0.5 + 0.3 * bright,
            ),
        ),
        0.6,
    )

/** The clips the engine loops while a hold is held. */
export const loops = ['#HOLD', 'Sekai Critical Hold']

/** The 15 clips in the engine's order, as Float64 samples before levelling. */
export function renderClips() {
    const clips = {
        '#PERFECT': tap(1),
        '#GREAT': tap(3, { tone: 1500, dull: 0.6 }),
        '#GOOD': tap(4, { tone: 1200, dull: 0.35 }),
        '#PERFECT_ALTERNATIVE': swish(2),
        '#GREAT_ALTERNATIVE': swish(5, { from: 950, to: 2200, dull: 0.45 }),
        '#GOOD_ALTERNATIVE': swish(6, { from: 800, to: 1800, dull: 0.3 }),
        '#HOLD': hum(
            [
                [110, 1, 1],
                [220, 0.4, 2],
                [330, 0.12],
                [440, 0.04],
            ],
            0.1,
        ),
        '#STAGE': thud(8),
        'Sekai Tick': tick(9),
        'Sekai Critical Tap': clap(20),
        'Sekai Critical Flick': criticalSwish(30),
        'Sekai Critical Hold': hum(
            [
                [110, 1, 1],
                [220, 0.55, 2],
                [330, 0.25, 1],
                [440, 0.12],
                [550, 0.05],
                [660, 0.025],
            ],
            0.12,
        ),
        'Sekai Critical Tick': tick(11, 1),
        'Sekai Trace': trace(12),
        'Sekai Critical Trace': trace(13, 1),
    }
    return Object.fromEntries(
        Object.entries(clips).map(([name, samples]) => [
            name,
            loops.includes(name) ? samples : fadeOut(samples),
        ]),
    )
}

// Loudness is measured as K-weighted (ITU-R BS.1770) power in LU relative to full scale: over the first
// 200 ms, zero padded, for one-shot clips, and over the whole loop for the hold loops.
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

/** A loop's whole-length loudness in LUFS, K-weighted and measured on its second play. */
export function loopLoudness(samples) {
    const twice = new Float64Array(samples.length * 2)
    twice.set(samples)
    twice.set(samples, samples.length)
    const weighted = biquad(biquad(twice, shelf()), kHighPass())
    let sum = 0
    for (let i = samples.length; i < twice.length; i++) sum += weighted[i] * weighted[i]
    return -0.691 + 10 * Math.log10(sum / samples.length)
}

/** A clip's loudness as its target is set: loops over their length, the rest over 200 ms. */
export const measure = (name, samples) =>
    loops.includes(name) ? loopLoudness(samples) : loudness(samples)

const peakOf = (samples) => samples.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0)

/**
 * The loudness each clip is set to (LUFS, as measure() measures it), from the web's Default clips
 * measured the same way (mono equivalent, from the onset; the holds over their whole length); the
 * Sonolus-only clips sit under the hits. After the owner’s listening pass the flicks sit 1 LU and the
 * hold loops 3 LU under the Default's.
 */
export const targets = {
    '#PERFECT': -15.5,
    '#GREAT': -16.5,
    '#GOOD': -17.5,
    '#PERFECT_ALTERNATIVE': -15.3,
    '#GREAT_ALTERNATIVE': -16.3,
    '#GOOD_ALTERNATIVE': -17.3,
    '#HOLD': -24.4,
    '#STAGE': -20,
    'Sekai Tick': -18.2,
    'Sekai Critical Tap': -11.7,
    'Sekai Critical Flick': -13.9,
    'Sekai Critical Hold': -22.3,
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
function level(samples, target, loudness) {
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
    for (const [name, samples] of Object.entries(clips))
        out[name] = level(samples, targets[name], (part) => measure(name, part))
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
