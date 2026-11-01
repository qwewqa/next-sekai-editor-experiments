import assert from 'node:assert/strict'
import test from 'node:test'
import { createMixPlan, mixGain, type MixSettings } from '../../src/exportVideo/mix'
import { exportSoundSource, exportSoundState } from '../helpers/exportVideo'

const settings: MixSettings = {
    in: 83,
    frames: 660,
    frameRate: 60,
    bgm: true,
    sfx: true,
    bgmVolume: 50,
    sfxVolume: 25,
    fadeIn: 0,
    fadeOut: 0,
}
const buffer = { duration: 0.2 } as AudioBuffer

test('block planning retains hit tails, hold phase and the guard interval at a nonzero In', () => {
    const state = exportSoundState(settings.in)
    const plan = createMixPlan(
        exportSoundSource(state),
        state.bpms,
        {
            sfx: { normalActive: buffer, criticalTap: buffer },
            bgm: { buffer: { duration: 100 } as AudioBuffer, offset: -1 },
        },
        settings,
    )
    const first = plan.next()!
    const second = plan.next()!
    assert.equal(first.startSample, 0)
    assert.equal(first.guard, 0)
    assert.equal(second.startSample, 480000)
    assert.equal(second.guard, 6144)
    assert.equal(second.length, 48000)
    const hold = second.voices.find((v) => v.hold)
    assert.equal(hold?.start, 83)
    assert.equal(hold?.end, 94)
    assert.equal(hold?.attack, true)
    assert.ok(second.voices.some((v) => v.start === 92.95 && v.end === 93.15))
    assert.equal(second.voices.find((v) => v.volume === 50)?.offset, 82)
    assert.equal(plan.next(), undefined)
    assert.equal(plan.samples, 528000)
})

test('sound toggles omit voices and fades use clip samples', () => {
    const state = exportSoundState(settings.in)
    const plan = createMixPlan(
        exportSoundSource(state),
        state.bpms,
        { sfx: { normalActive: buffer, criticalTap: buffer } },
        { ...settings, sfx: false, bgm: false },
    )
    assert.deepEqual(plan.next()?.voices, [])
    assert.equal(mixGain(0, 48000, 0, 0), 1)
    assert.equal(mixGain(120, 48000, 0, 0), 1)
    assert.equal(mixGain(47880, 48000, 0, 0), 0.5)
    assert.equal(mixGain(12000, 48000, 0.5, 0.5), 0.5)
})
