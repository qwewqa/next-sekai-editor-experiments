import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { iconOutputs } from '../../builtin-assets/build.mjs'
import { clipFiles } from '../../builtin-assets/manifest.mjs'
import { createRandom, measure, renderDemoBgm, targets } from '../../builtin-assets/sfx.mjs'
import { readZip } from '../../builtin-assets/zip.mjs'
import { readBuiltinItem } from './helpers.mjs'
import { decode, pixelAt } from './pngDecode.mjs'

const samplesOf = (wav) =>
    new Int16Array(wav.buffer.slice(wav.byteOffset + 44, wav.byteOffset + wav.length))

const clips = () => {
    const { resource } = readBuiltinItem('effect')
    return readZip(resource('audio'))
}

test('every clip is a valid 16-bit mono 44.1 kHz WAV', () => {
    const files = clips()
    assert.equal(files.size, 15)
    for (const [name, file] of Object.entries(clipFiles)) {
        const wav = files.get(file)
        assert.ok(wav, name)
        assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
        assert.equal(wav.toString('ascii', 8, 16), 'WAVEfmt ')
        assert.equal(wav.readUInt32LE(4), wav.length - 8)
        assert.equal(wav.readUInt16LE(20), 1)
        assert.equal(wav.readUInt16LE(22), 1)
        assert.equal(wav.readUInt32LE(24), 44100)
        assert.equal(wav.readUInt16LE(34), 16)
        assert.equal(wav.toString('ascii', 36, 40), 'data')
        assert.equal(wav.readUInt32LE(40), wav.length - 44)
    }
})

test('every clip peaks at or below -3 dBFS', () => {
    const limit = 32767 * 10 ** (-3 / 20)
    for (const [file, wav] of clips()) {
        const peak = Math.max(...samplesOf(wav).map(Math.abs))
        assert.ok(peak <= limit, `${file} peaks at ${peak}`)
    }
})

test('the clips sit at their targets, matched to the web’s Default clips', () => {
    for (const [name, file] of Object.entries(clipFiles)) {
        const samples = Float64Array.from(samplesOf(clips().get(file)), (sample) => sample / 32768)
        const level = measure(name, samples)
        assert.ok(Math.abs(level - targets[name]) < 0.2, `${name} is at ${level.toFixed(2)} LUFS`)
    }
    // Criticals sit over their normal clips, and the judgments step down.
    assert.ok(targets['Sekai Critical Tap'] > targets['#PERFECT'])
    assert.ok(targets['Sekai Critical Flick'] > targets['#PERFECT_ALTERNATIVE'])
    assert.ok(targets['#PERFECT'] > targets['#GREAT'] && targets['#GREAT'] > targets['#GOOD'])
})

test('the hold loops are seamless', () => {
    for (const name of ['#HOLD', 'Sekai Critical Hold']) {
        const samples = samplesOf(clips().get(clipFiles[name]))
        assert.equal(samples.length, 44100)
        let largest = 0
        for (let i = 1; i < samples.length; i++)
            largest = Math.max(largest, Math.abs(samples[i] - samples[i - 1]))
        const seam = Math.abs(samples[0] - samples[samples.length - 1])
        assert.ok(seam <= largest, `${name}: seam ${seam}, largest step ${largest}`)
    }
})

test('the PRNG is seeded and the demo BGM is deterministic', () => {
    const a = createRandom(7)
    const b = createRandom(7)
    assert.deepEqual([a(), a(), a()], [b(), b(), b()])
    const bgm = renderDemoBgm()
    assert.equal(bgm.length, 44 + 30 * 44100 * 2)
    assert.ok(bgm.equals(renderDemoBgm()))
})

test('every icon output exists, and the 1024 icon has no alpha channel', () => {
    const lock = JSON.parse(
        readFileSync(
            new URL('../../builtin-assets/builtin-assets.lock.json', import.meta.url),
            'utf8',
        ),
    )
    for (const [file] of iconOutputs) assert.ok(lock.files[`builtin-assets/out/icon/${file}`], file)
    assert.ok(lock.files['builtin-assets/out/icon/app-icon-background.txt'])
    for (const size of [16, 32, 180, 512])
        assert.equal(decode(readIcon(`app-icon-${size}.png`)).width, size)
    const icon = decode(readIcon('app-icon-1024.png'))
    assert.equal(icon.colorType, 2)
    assert.equal(icon.width, 1024)
    assert.equal(icon.height, 1024)
})

const readIcon = (file) =>
    readFileSync(new URL(`../../builtin-assets/out/icon/${file}`, import.meta.url))

test('the Android layers keep their opaque pixels inside the 66/108 safe zone', () => {
    const radius = (1024 * 66) / 108 / 2
    for (const file of ['app-icon-foreground-1024.png', 'app-icon-monochrome-1024.png']) {
        const image = decode(readIcon(file))
        let opaque = 0
        for (let y = 0; y < 1024; y++)
            for (let x = 0; x < 1024; x++) {
                if (pixelAt(image, x, y)[3] === 0) continue
                opaque++
                assert.ok(
                    Math.hypot(x + 0.5 - 512, y + 0.5 - 512) <= radius,
                    `${file} has a pixel at ${x},${y} outside the safe zone`,
                )
            }
        assert.ok(opaque > 10000, `${file} has a mark`)
    }
})
