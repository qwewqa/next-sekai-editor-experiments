import assert from 'node:assert/strict'
import test from 'node:test'
import {
    assetEntryName,
    bgmEntryName,
    bgmFilenameOf,
    levelInfoOf,
    metadataOf,
    summaryOf,
} from '../../../src/local/nxsp'
import type { RecordValue } from '../../../src/local/records/canonical'
import type { SnapshotRecords } from '../../../src/local/records/records'
import { emptyLevelInfo, type LevelInfo } from '../../../src/state/levelInfo'

test('metadata’s pinned mapping: empty strings and tags left out, rating 0 kept, filename "" left out', () => {
    const ref = { hash: 'a'.repeat(32), filename: '', size: 3, type: 'image/png' }
    const info: LevelInfo = {
        title: 'T',
        artists: '',
        author: '',
        description: '',
        tags: [{ title: 'x' }, { title: 'y' }],
        cover: ref,
        rating: 0,
    }
    const cover = { file: 'assets/cover.png', type: 'image/png', sha256: 'a'.repeat(64), size: 3 }
    const metadata = metadataOf(info, { cover })
    assert.deepEqual(metadata, {
        title: 'T',
        rating: 0,
        tags: [{ title: 'x' }, { title: 'y' }],
        cover,
    })
    assert.deepEqual(levelInfoOf(metadata), info)
    assert.equal(metadataOf(emptyLevelInfo), undefined)
    assert.deepEqual(levelInfoOf(undefined), {
        title: '',
        artists: '',
        author: '',
        description: '',
        tags: [],
    })
    // Metadata only: the 16-byte hash; an absent filename is "" with no entry-name fallback.
    const preview = { type: 'audio/mpeg', hash: 'b'.repeat(32), size: 9 }
    assert.deepEqual(levelInfoOf({ preview }).preview, {
        hash: 'b'.repeat(32),
        filename: '',
        size: 9,
        type: 'audio/mpeg',
    })
})

test('a bgm’s file name: filename, else the entry name after bgm/, else ""', () => {
    const sha256 = 'c'.repeat(64)
    assert.equal(
        bgmFilenameOf({ file: 'bgm/a.mp3', filename: 'Á.mp3', type: '', sha256, size: 1 }),
        'Á.mp3',
    )
    assert.equal(bgmFilenameOf({ file: 'bgm/a.mp3', type: '', sha256, size: 1 }), 'a.mp3')
    assert.equal(bgmFilenameOf({ type: '', hash: 'c'.repeat(32), size: 1 }), '')
})

test('entry names are ASCII, from the original name', () => {
    assert.equal(bgmEntryName('coconut.mp3', 'audio/mpeg'), 'bgm/coconut.mp3')
    assert.equal(bgmEntryName('ココナッツ.mp3', 'audio/mpeg'), 'bgm/bgm.mp3')
    assert.equal(
        bgmEntryName('Coconut  (Master) v2.mp3', 'audio/mpeg'),
        'bgm/Coconut-Master-v2.mp3',
    )
    assert.equal(bgmEntryName('..hidden..ogg', 'audio/ogg'), 'bgm/hidden.ogg')
    assert.equal(bgmEntryName('CON.mp3', 'audio/mpeg'), 'bgm/CON-.mp3')
    assert.equal(bgmEntryName('noext', 'audio/wav'), 'bgm/noext.wav')
    assert.equal(bgmEntryName('', ''), 'bgm/bgm.bin')
    assert.equal(bgmEntryName(`${'a'.repeat(300)}.mp3`, 'audio/mpeg'), `bgm/${'a'.repeat(120)}.mp3`)
    assert.equal(assetEntryName('cover', 'カバー.PNG', 'image/png'), 'assets/cover.PNG')
    assert.equal(assetEntryName('preview', 'preview', 'audio/mpeg'), 'assets/preview.mp3')
    // The extension only when it is 1–10 ASCII letters and digits; else the type's, or `bin`.
    assert.equal(bgmEntryName('song.mp3 (1)', 'audio/mpeg'), 'bgm/song.mp3-1.mp3')
    assert.equal(bgmEntryName(`a.${'x'.repeat(300)}`, ''), `bgm/a.${'x'.repeat(118)}.bin`)
    assert.equal(bgmEntryName('a.mp3x5678901', 'audio/ogg'), 'bgm/a.mp3x5678901.ogg')
    assert.equal(bgmEntryName('a.wav56789012', ''), 'bgm/a.wav56789012.bin')
    assert.equal(assetEntryName('cover', 'c.png (2)', 'image/jpeg'), 'assets/cover.jpg')
    assert.equal(assetEntryName('preview', 'p.ab-c', ''), 'assets/preview.bin')
    // A reserved name is the stem up to its first dot.
    assert.equal(bgmEntryName('con.foo.mp3', 'audio/mpeg'), 'bgm/con-.foo.mp3')
    assert.equal(bgmEntryName('LPT1.x.y.ogg', ''), 'bgm/LPT1-.x.y.ogg')
    assert.equal(bgmEntryName('console.mp3', ''), 'bgm/console.mp3')
    for (const name of [bgmEntryName('a/b\\c:d.mp3', ''), bgmEntryName('\ud800.mp3', '')])
        assert.match(name, /^bgm\/[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+$/)
})

const records = (beats: number[], bpms: [number, number][]): SnapshotRecords => ({
    header: [],
    kinds: [
        ...(beats.length
            ? [
                  {
                      kind: 'slides' as const,
                      records: beats.map((beat) => ({
                          key: beat,
                          record: [[1, 1, beat] as RecordValue],
                      })),
                  },
              ]
            : []),
        ...(bpms.length
            ? [
                  {
                      kind: 'bpms' as const,
                      records: bpms.map(([beat, bpm]) => ({ key: beat, record: [beat, bpm, 4] })),
                  },
              ]
            : []),
    ],
})

test('summary: the latest note’s time over the BPM changes, the first BPM from beat 0, rounded', () => {
    assert.deepEqual(summaryOf(records([], [[0, 120]])), { noteCount: 0, durationMs: 0 })
    assert.deepEqual(summaryOf(records([8], [])), { noteCount: 1, durationMs: 0 })
    assert.equal(summaryOf(records([8], [[0, 120]])).durationMs, 4000)
    // The first BPM applies from beat 0 even when it starts later.
    assert.equal(summaryOf(records([8], [[4, 120]])).durationMs, 4000)
    // 4 beats at 120, then 4 at 60.
    assert.equal(
        summaryOf(
            records(
                [2, 8],
                [
                    [0, 120],
                    [4, 60],
                ],
            ),
        ).durationMs,
        6000,
    )
    // Same-beat BPMs: the later in order holds from there.
    assert.equal(
        summaryOf(
            records(
                [8],
                [
                    [0, 120],
                    [4, 240],
                    [4, 60],
                ],
            ),
        ).durationMs,
        6000,
    )
    assert.equal(summaryOf(records([1], [[0, 7]])).durationMs, Math.round(60000 / 7))
})
