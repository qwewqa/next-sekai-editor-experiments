import { createPlayerAudio } from '../playerAudio'
import {
    planActiveSound,
    planSounds,
    type SoundClip,
    type SoundPlanState,
    type SoundSource,
} from '../playerSounds'
import type { BpmIntegral } from '../state/integrals/bpms'
import {
    AUDIO_BLOCK,
    AUDIO_CHANNELS,
    AUDIO_GUARD,
    AUDIO_RATE,
    clipSamples,
    type AudioBlock,
} from './timing'

export type MixSettings = {
    in: number
    frames: number
    frameRate: 30 | 60
    bgm: boolean
    sfx: boolean
    bgmVolume: number
    sfxVolume: number
    fadeIn: number
    fadeOut: number
}
export type MixBuffers = {
    bgm?: { buffer: AudioBuffer; offset: number }
    sfx: Partial<Record<SoundClip, AudioBuffer>>
}
export type MixVoice = {
    buffer: AudioBuffer
    start: number
    end: number
    offset: number
    volume: number
    attack: boolean
    hold?: { clip: SoundClip; endBeat: number }
}
export type MixBlockPlan = {
    startSample: number
    length: number
    guard: number
    voices: MixVoice[]
}

/** Voices retain their original start, offset and envelope across offline contexts. */
export const createMixPlan = (
    source: SoundSource,
    bpms: BpmIntegral[],
    buffers: MixBuffers,
    settings: MixSettings,
) => {
    const samples = clipSamples(settings.frames, settings.frameRate)
    let nextSample = 0
    let state: SoundPlanState = { lastSfx: {} }
    let voices: MixVoice[] = []
    const clips = Object.fromEntries(
        Object.entries(buffers.sfx).map(([clip, buffer]) => [clip, !!buffer]),
    )
    if (settings.bgm && buffers.bgm) {
        const { buffer, offset } = buffers.bgm
        const start = Math.max(settings.in, -offset)
        voices.push({
            buffer,
            start,
            end: buffer.duration - offset,
            offset: Math.max(0, start + offset),
            volume: settings.bgmVolume,
            attack: true,
        })
    }
    return {
        samples,
        next(): MixBlockPlan | undefined {
            if (nextSample === samples) return
            const startSample = nextSample
            const length = Math.min(AUDIO_BLOCK, samples - startSample)
            const guard = Math.min(AUDIO_GUARD, startSample)
            const from = settings.in + startSample / AUDIO_RATE
            const to = settings.in + (startSample + length) / AUDIO_RATE
            const guardStart = from - guard / AUDIO_RATE
            voices = voices.filter((voice) => voice.end > guardStart)
            if (settings.sfx) {
                const plan = planSounds(source, bpms, clips, { from, to }, state)
                state = plan.state
                for (const event of plan.events) {
                    const buffer = buffers.sfx[event.clip]
                    if (!buffer) continue
                    if (event.type === 'hit') {
                        voices.push({
                            buffer,
                            start: event.time,
                            end: event.time + buffer.duration,
                            offset: 0,
                            volume: settings.sfxVolume,
                            attack: false,
                        })
                        continue
                    }
                    let merged = false
                    for (const voice of voices) {
                        if (voice.hold?.clip !== event.clip) continue
                        const action = planActiveSound(
                            { endBeat: voice.hold.endBeat, endTime: voice.end },
                            event.startBeat,
                            event.endBeat,
                            guardStart,
                        )
                        if (action === 'covered' || action === 'extend') {
                            if (action === 'extend') {
                                voice.hold.endBeat = event.endBeat
                                voice.end = event.endTime
                            }
                            merged = true
                            break
                        }
                    }
                    if (!merged)
                        voices.push({
                            buffer,
                            start: Math.max(settings.in, event.time),
                            end: event.endTime,
                            offset: 0,
                            volume: settings.sfxVolume,
                            attack: true,
                            hold: { clip: event.clip, endBeat: event.endBeat },
                        })
                }
            }
            nextSample += length
            return {
                startSample,
                length,
                guard,
                voices: voices.map((voice) => ({
                    ...voice,
                    hold: voice.hold && { ...voice.hold },
                })),
            }
        },
    }
}

export const mixGain = (sample: number, samples: number, fadeIn: number, fadeOut: number) => {
    const attack = Math.min(samples, fadeIn * AUDIO_RATE)
    const release = Math.min(samples, (fadeOut || 0.005) * AUDIO_RATE)
    return Math.min(1, attack ? sample / attack : 1, (samples - sample) / release)
}

export const renderMixBlock = async (
    plan: MixBlockPlan,
    settings: MixSettings,
    signal?: AbortSignal,
): Promise<AudioBlock> => {
    signal?.throwIfAborted()
    const context = new OfflineAudioContext(AUDIO_CHANNELS, plan.length + plan.guard, AUDIO_RATE)
    const origin = settings.in + (plan.startSample - plan.guard) / AUDIO_RATE
    for (const voice of plan.voices) {
        const sourceRate = voice.buffer.sampleRate
        const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)
        // Resume on the same source/output sample phase. The guard absorbs the skipped prefix.
        const period = 1 / gcd(sourceRate, AUDIO_RATE)
        const elapsed = Math.max(0, origin - voice.start)
        const start = voice.start + Math.ceil(elapsed / period - 1e-9) * period
        if (voice.end <= start) continue
        const when = Math.max(0, start - origin)
        const audio = createPlayerAudio(
            context,
            { buffer: voice.buffer, loop: !!voice.hold },
            voice.volume,
            () => undefined,
        )
        if (voice.attack) audio.fadeIn(when, undefined, start - voice.start)
        const offset = voice.offset + start - voice.start
        audio.start(when, voice.hold ? offset % voice.buffer.duration : offset)
        audio.source.stop(voice.end - origin)
    }
    const rendered = await context.startRendering()
    signal?.throwIfAborted()
    const samples = clipSamples(settings.frames, settings.frameRate)
    const planes: AudioBlock['planes'] = [
        new Float32Array(plan.length),
        new Float32Array(plan.length),
    ]
    for (const [channel, output] of planes.entries()) {
        const input = rendered.getChannelData(channel).subarray(plan.guard)
        for (const [i, sample] of input.entries()) {
            const value =
                sample * mixGain(plan.startSample + i, samples, settings.fadeIn, settings.fadeOut)
            output[i] = Math.max(-1, Math.min(1, value))
        }
    }
    return { startSample: plan.startSample, planes }
}

export async function* mixAudio(
    source: SoundSource,
    bpms: BpmIntegral[],
    buffers: MixBuffers,
    settings: MixSettings,
    signal?: AbortSignal,
): AsyncGenerator<AudioBlock> {
    const plan = createMixPlan(source, bpms, buffers, settings)
    for (let block = plan.next(); block; block = plan.next())
        yield await renderMixBlock(block, settings, signal)
}
