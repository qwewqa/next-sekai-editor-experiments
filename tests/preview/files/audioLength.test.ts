import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { measureClip } from '../../../src/preview/assets/files/audioLength'
import { AssetImportError } from '../../../src/preview/assets/files/errors'
import { importItem } from '../../../src/preview/assets/files/importer'
import { openSourcePackage } from '../../../src/preview/assets/files/package'
import {
    audioZip,
    blobOf,
    concat,
    decodeTestAudio,
    decodeTestImage,
    effectData,
    gz,
    scp,
    utf8,
    wav,
} from './fixtures'

// A clip's length is read from its container before it decodes (Part 2, 2.5.5): a few MB can
// decode to hours. The fixtures in `audio/` are 0.5 s of real audio, as an encoder made them.

const fixture = (name: string) => new Uint8Array(readFileSync(`tests/preview/files/audio/${name}`))
const repeat = (bytes: Uint8Array, times: number) =>
    concat(...Array.from({ length: times }, () => bytes))

test('each format the browsers decode is measured from its container', () => {
    for (const name of ['clip.mp3', 'clip.aac', 'clip.m4a', 'clip.flac', 'clip.ogg', 'clip.opus']) {
        const length = measureClip(fixture(name))
        assert.ok(length, name)
        // At least what decodes, give or take an encoder's priming frames.
        assert.ok(length.seconds >= 0.5 && length.seconds < 0.6, `${name}: ${length.seconds}`)
        assert.equal(length.channels, 2, name)
    }
    const perfect = measureClip(new Uint8Array(readFileSync('src/assets/se_live_perfect.mp3')))
    assert.ok(perfect && perfect.seconds > 0.7 && perfect.seconds < 0.8)
    assert.deepEqual(measureClip(wav(2)), { seconds: 2, channels: 1 })
})

test('a clip in a format that cannot be measured has no length', () => {
    assert.equal(measureClip(utf8('plain text is not audio at all')), undefined)
    assert.equal(measureClip(new Uint8Array(4)), undefined)
})

test('a length is what the bytes hold, not what a header claims', () => {
    // A WAV whose data chunk says 1 s, followed by 130 s of samples.
    const long = wav(130)
    new DataView(long.buffer).setUint32(40, 8000, true)
    assert.equal(measureClip(long)?.seconds, 130)

    // Frames repeated past a header's end all count, as a decoder finds them all.
    for (const [name, times] of [
        ['clip.mp3', 250],
        ['clip.aac', 250],
        ['clip.flac', 250],
        ['clip.opus', 250],
        ['clip.ogg', 250],
    ] as const) {
        const seconds = measureClip(repeat(fixture(name), times))?.seconds ?? 0
        assert.ok(seconds > 120, `${name}: ${seconds}`)
    }
    // MP3 frames with junk between them are found again.
    const frames = fixture('clip.mp3')
    const junk = repeat(concat(frames, utf8('junk between frames')), 250)
    assert.ok((measureClip(junk)?.seconds ?? 0) > 120)

    // An M4A track's sample count is what the decoder walks.
    const m4a = fixture('clip.m4a')
    const stsz = new TextDecoder('latin1').decode(m4a).indexOf('stsz')
    assert.ok(stsz > 0)
    new DataView(m4a.buffer).setUint32(stsz + 12, 10_000_000)
    assert.ok((measureClip(m4a)?.seconds ?? 0) > 120)
})

const effectWith = (clips: Record<string, Uint8Array>) =>
    scp('effect', {
        resources: {
            data: gz(
                effectData({
                    clips: Object.keys(clips).map((filename, i) => ({
                        name: i ? 'Sekai Tick' : '#PERFECT',
                        filename,
                    })),
                }),
            ),
            audio: audioZip(clips),
        },
    })

const importEffect = async (bytes: Uint8Array, decodeAudio = decodeTestAudio, name = 'fixture') => {
    const pkg = await openSourcePackage(blobOf(bytes))
    return importItem(pkg, 'effect', name, {
        maxTextureSide: 4096,
        decodeAudio,
        decodeImage: decodeTestImage,
        signal: new AbortController().signal,
        origin: 'fixture.scp',
        now: () => 1,
    })
}

test('a clip over 120 s by its container is refused before anything decodes it', async () => {
    for (const clip of [
        wav(121),
        repeat(fixture('clip.mp3'), 250),
        repeat(fixture('clip.flac'), 250),
    ]) {
        let decoded = 0
        await assert.rejects(
            importEffect(effectWith({ 'perfect.bin': clip }), async (data) => {
                decoded++
                return decodeTestAudio(data)
            }),
            (error: unknown) => error instanceof AssetImportError && error.code === 'audioLength',
        )
        assert.equal(decoded, 0)
    }
    // Two clips that pass alone but not together: the second is not decoded either.
    let decoded = 0
    await assert.rejects(
        importEffect(effectWith({ 'a.wav': wav(70), 'b.wav': wav(70) }), async (data) => {
            decoded++
            return decodeTestAudio(data)
        }),
        (error: unknown) => error instanceof AssetImportError && error.code === 'audioLength',
    )
    assert.equal(decoded, 1)
})

test('a clip whose length cannot be read is not decoded, so it counts as absent', async () => {
    let decoded = 0
    await assert.rejects(
        importEffect(effectWith({ 'perfect.bin': utf8('no container at all') }), async (data) => {
            decoded++
            return decodeTestAudio(data)
        }),
        (error: unknown) => error instanceof AssetImportError && error.code === 'noPerfect',
    )
    assert.equal(decoded, 0)
})

test('decoded samples past the cap are refused, should a container understate them', async () => {
    await assert.rejects(
        importEffect(effectWith({ 'perfect.wav': wav(1) }), async () => {
            // One second by its header, an hour of stereo once decoded.
            return { duration: 3600, length: 3600 * 48000, numberOfChannels: 2 } as AudioBuffer
        }),
        (error: unknown) => error instanceof AssetImportError && error.code === 'audioLength',
    )
})

test('the Built-in sound effects measure and import', async () => {
    // Its clips are WAV, which the test decoder reads as the browser would.
    const record = await importEffect(
        new Uint8Array(readFileSync('public/builtin/effect.scp')),
        decodeTestAudio,
        'nse-builtin',
    )
    assert.equal(record.type, 'effect')
})
