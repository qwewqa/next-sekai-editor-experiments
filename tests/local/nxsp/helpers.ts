import { createHash } from 'node:crypto'
import { captureEntryDescription, type EntryDescription } from '../../../src/history/operations'
import { serializeEditorMetadata } from '../../../src/levelData/editorMetadata'
import { serializeToLevelData } from '../../../src/levelData/serialize'
import { deflateChunk } from '../../../src/local/chunkVerify'
import { toHex } from '../../../src/local/hash'
import type {
    BuildContext,
    BuildInput,
    EntryForm,
    ExecutionSource,
    InputChunk,
} from '../../../src/local/nxsp'
import { summaryOf } from '../../../src/local/nxsp'
import type { RecordValue } from '../../../src/local/records/canonical'
import { toRecords } from '../../../src/local/records/records'
import { chunkCrc32 } from '../../../src/local/records/rows'
import { encodeSnapshot } from '../../../src/local/records/snapshot'
import type { State } from '../../../src/state'
import type { MediaRef } from '../../../src/state/levelInfo'
import { goldenChart, note, type FixtureChart } from '../records/charts'

// Fixtures for the `.nxsp` tests: states with real media hashes, their bodies as the builder takes
// them, and a store that holds every state's roots, nodes and chunks.

export const utf8 = (text: string) => new TextEncoder().encode(text)

export const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** A media item: its bytes, full SHA-256 and the `mediaRef` a state records. */
export const mediaItem = (filename: string, type: string, text = `${filename} bytes`) => {
    const bytes = utf8(text)
    const sha256 = sha256Hex(bytes)
    const ref: MediaRef = { hash: sha256.slice(0, 32), filename, size: bytes.length, type }
    return { bytes, sha256, ref }
}

export const COVER = mediaItem('cover.png', 'image/png')
export const COVER_2 = mediaItem('cover-2.png', 'image/png', 'a second cover')
export const PREVIEW = mediaItem('preview.mp3', 'audio/mpeg')
export const BGM = mediaItem('曲 名.mp3', 'audio/mpeg')
export const BGM_2 = mediaItem('Coconut (Master).mp3', 'audio/mpeg', 'a second BGM')

/** The golden chart with real media: `bgm` and `cover` pick which. */
export const chartWith = ({
    bgm = BGM,
    cover = COVER,
    extraNotes = 0,
}: { bgm?: typeof BGM; cover?: typeof COVER; extraNotes?: number } = {}): FixtureChart => {
    const fixture = goldenChart()
    const { levelInfo } = fixture.extras
    if (!levelInfo) throw new Error('The golden chart has level info')
    fixture.extras = {
        ...fixture.extras,
        levelInfo: { ...levelInfo, cover: cover.ref, preview: PREVIEW.ref },
        bgm: { ...bgm.ref, durationMs: 1000 },
    }
    for (let i = 0; i < extraNotes; i++) fixture.chart.slides.push([note(64 + i)])
    return fixture
}

/** Every body of every state stored: what the builder takes from storage. */
export class Store {
    readonly roots = new Map<string, readonly RecordValue[]>()
    readonly nodes = new Map<string, readonly RecordValue[]>()
    readonly chunks = new Map<string, InputChunk>()

    /** Stores a state's snapshot and returns its root hash. */
    add(state: State) {
        const snapshot = encodeSnapshot(toRecords(state))
        this.roots.set(toHex(snapshot.root.hash), snapshot.root.json)
        for (const node of snapshot.nodes) this.nodes.set(toHex(node.hash), node.json)
        for (const chunk of [snapshot.header, ...snapshot.chunks]) {
            const stored = deflateChunk(chunk.bytes)
            this.chunks.set(toHex(chunk.hash), {
                stored,
                crc32: chunkCrc32(chunk.hash, stored),
                size: chunk.bytes.length,
            })
        }
        return toHex(snapshot.root.hash)
    }
}

export const levelOf = (state: State) => {
    const level = serializeToLevelData(
        state.initialLife,
        state.isDynamicStages,
        state.bgm.offset,
        state.store,
        state.groups,
        state.stages,
        { groups: state.groupFolders, stages: state.stageFolders },
    )
    return { level, editor: serializeEditorMetadata(level.entities, state.store) }
}

/** A fixed context: ids from a counter, a fixed device and app version. */
export const fixedContext = (now: number, prefix = 'r'): BuildContext => {
    let n = 0
    return {
        now,
        newId: () => `${prefix}${String(++n).padStart(3, '0')}-0000-4000-8000-000000000000`,
        device: { id: 'c3f00000-0000-4000-8000-000000000000', label: 'Web (Chrome)' },
        appVersion: '0.6.0',
    }
}

/** The head-related part of a build input for a state. */
export const headInput = (state: State) => {
    const { level, editor } = levelOf(state)
    return {
        levelVersion: 1,
        level,
        editor,
        summary: summaryOf(toRecords(state)),
        levelInfo: state.levelInfo,
    } satisfies Partial<BuildInput>
}

export const entry = (
    description: EntryDescription,
    time: number,
    snapshot: string,
    extra: Partial<Omit<EntryForm, 'kind' | 'step' | 'operation' | 'recoveryContext'>> = {},
): EntryForm => ({
    ...captureEntryDescription(description),
    time,
    snapshot,
    noteCount: 0,
    ...extra,
})

/** An executor source over bytes held in memory, its fingerprint fixed unless `changed` is set. */
export const memorySource = (
    bytes: Uint8Array | Blob,
    fingerprint = 'zip:test',
    role: 'target' | 'base' = 'target',
): ExecutionSource & { changed: boolean } => {
    const source = {
        file: bytes instanceof Blob ? bytes : new Blob([new Uint8Array(bytes)]),
        fingerprint,
        role,
        changed: false,
        readFingerprint: async () => (source.changed ? `${fingerprint}:changed` : fingerprint),
    }
    return source
}

export const blobBytes = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer())
