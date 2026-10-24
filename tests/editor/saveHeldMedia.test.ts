import assert from 'node:assert/strict'
import test from 'node:test'
import { buildOptions, type BuildEnv, type BuildRequest } from '../../src/editor/save/build'
import type { Flusher, FlushSession } from '../../src/local/flush'
import { holdMedia, resetHeldMediaForTests } from '../../src/local/heldMedia'
import { captureMedia } from '../../src/local/media'
import { stateAt } from '../local/save/fixture'

// A Save's build carries the cover and preview bytes this tab holds beside the BGM's,
// so the file holds them rather than writing the items without their bytes.

const env: BuildEnv = {
    session: {
        id: 'session',
        chainId: 'chain',
        docId: 'doc',
        lineageId: 'lineage',
        startedAt: 1,
        stored: true,
        chain: {},
    } as unknown as FlushSession,
    flusher: { unstored: () => ({ entries: [], stack: undefined }) } as unknown as Flusher,
    worker: { call: (() => Promise.resolve(undefined)) as BuildEnv['worker']['call'] },
}

const requestOf = (state: BuildRequest['state']): BuildRequest => ({
    target: { kind: 'copy' },
    history: true,
    bgm: true,
    fileName: 'coconut',
    save: { time: 1, operation: 'Saved' },
    state,
})

const pick = async (kind: 'cover' | 'preview', head: number[], name: string) => {
    const bytes = new Uint8Array(512)
    bytes.set(head)
    const captured = await captureMedia(
        bytes.buffer,
        { name, type: '' },
        kind === 'cover' ? 'image' : 'audio',
    )
    holdMedia({
        hash: captured.meta.hash,
        bytes: captured.source,
        type: captured.meta.type,
        filename: captured.meta.filename,
        kind,
    })
    return captured
}

test('the build posts the held cover and preview the head names, and nothing it does not', async () => {
    resetHeldMediaForTests()
    const cover = await pick('cover', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'cover.png')
    const preview = await pick('preview', [0x49, 0x44, 0x33, 0x04], 'preview.mp3')
    await pick('cover', [0xff, 0xd8, 0xff], 'old.jpg')
    const base = stateAt(1).state
    const state = {
        ...base,
        levelInfo: { ...base.levelInfo, cover: cover.meta, preview: preview.meta },
    }
    const options = await buildOptions(env, requestOf(state))
    assert.deepEqual(
        options.media?.map(({ hash, type, filename }) => ({ hash, type, filename })),
        [
            { hash: cover.meta.hash, type: 'image/png', filename: 'cover.png' },
            { hash: preview.meta.hash, type: 'audio/mpeg', filename: 'preview.mp3' },
        ],
    )
    assert.deepEqual(options.media?.[0]?.bytes, new Uint8Array(cover.source))
    resetHeldMediaForTests()
})
