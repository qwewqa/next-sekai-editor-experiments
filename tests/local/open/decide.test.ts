import assert from 'node:assert/strict'
import test from 'node:test'
import { parseLevelDataChart } from '../../../src/chart/parse/levelData'
import { LevelDataReport } from '../../../src/levelData/report'
import { executePlan, planNxsp, readNxsp } from '../../../src/local/nxsp'
import {
    bindingName,
    changedOf,
    earlierNotice,
    levelState,
    matchesHead,
    partialLine,
    type EarlierChain,
} from '../../../src/local/open/decide'
import { stateFromRecords } from '../../../src/local/records/records'
import '../../helpers/lockChecks'
import { fresh } from '../nxsp/chain'
import { crafted, jsonOf, setJson } from '../nxsp/craft'

// The open's decisions: the partial open's line, the binding's
// name, "a file matches its head" with absence never a change, the live state from level.json
// and project.json, the binding's options, and the notice about earlier sessions.

const readFile = async (file: Blob) => {
    const read = await readNxsp(file)
    if (read.kind !== 'nxsp' || !read.project || !read.history) throw new Error('not whole')
    const level = read.level as { bgmOffset: number; entities: never[] }
    const head = stateFromRecords(read.history.headRecords)
    return { read, project: read.project, level, head }
}

const freshFile = () => executePlan(planNxsp(fresh().input).plan, new Map())

test('a fresh file matches its head, with thirds of a lane and a default-coloured guide', async () => {
    const { project, level, head } = await readFile(await freshFile())
    assert.equal(matchesHead(level.entities, level.bgmOffset, project, head), true)
})

test('an edited title is a change: level.json and project.json win, keeping the head’s BGM when bgm is absent', async () => {
    const file = await crafted(
        (items) => {
            const project = jsonOf(items, 'project.json')
            project.metadata.title = 'Edited'
            // Left out, as an unticked BGM is: absence is never a change.
            delete project.bgm
            setJson(items, 'project.json', project)
            return items.filter((item) => !item.name.startsWith('bgm/'))
        },
        await freshFile(),
    )
    const { project, level, head } = await readFile(file)
    assert.equal(matchesHead(level.entities, level.bgmOffset, project, head), false)
    const chart = parseLevelDataChart(level.entities, project.editor.defaultGuideColors)
    const live = levelState(chart, level.bgmOffset, project, head)
    assert.equal(live.levelInfo.title, 'Edited')
    assert.deepEqual(live.bgm.meta, head.bgm.meta)
})

test('a file without bgm whose head records one still matches: it was saved without it', async () => {
    const file = await crafted(
        (items) => {
            const project = jsonOf(items, 'project.json')
            delete project.bgm
            setJson(items, 'project.json', project)
            return items.filter((item) => !item.name.startsWith('bgm/'))
        },
        await freshFile(),
    )
    const { project, level, head } = await readFile(file)
    assert.equal(matchesHead(level.entities, level.bgmOffset, project, head), true)
})

test('a metadata-only bgm is the head’s BGM, included but not held', async () => {
    const file = await crafted(
        (items) => {
            const project = jsonOf(items, 'project.json')
            const bgm = { ...(project.bgm as Record<string, string>) }
            bgm.hash = (bgm.sha256 ?? '').slice(0, 32)
            delete bgm.sha256
            delete bgm.file
            project.bgm = bgm
            setJson(items, 'project.json', project)
            return items.filter((item) => !item.name.startsWith('bgm/'))
        },
        await freshFile(),
    )
    const { read, project, level, head } = await readFile(file)
    assert.equal(read.media.bgm, undefined)
    assert.equal(matchesHead(level.entities, level.bgmOffset, project, head), true)
})

test('the partial open’s line: damage, then history, then newer content, then media', () => {
    const item = (reason: Parameters<typeof partialLine>[0][number]['reason'], media?: 'bgm') => ({
        reason,
        path: '',
        ...(media ? { media } : {}),
    })
    assert.equal(partialLine([], undefined), undefined)
    assert.equal(partialLine([], new LevelDataReport()), undefined)
    assert.deepEqual(partialLine([item('unknown-entry'), item('damaged')], undefined), {
        kind: 'damaged',
    })
    assert.deepEqual(partialLine([item('newer-history'), item('unknown-key')], undefined), {
        kind: 'historyUnreadable',
    })
    assert.deepEqual(
        partialLine([item('media-unreadable', 'bgm'), item('newer-level')], undefined),
        {
            kind: 'newerVersion',
        },
    )
    const report = new LevelDataReport()
    report.addArchetype('FutureNote')
    assert.deepEqual(partialLine([], report), { kind: 'newerVersion' })
    assert.deepEqual(partialLine([item('media-unreadable', 'bgm')], undefined), {
        kind: 'mediaBad',
        media: 'bgm',
    })
    // A newer major version asked first: no line after it.
    assert.equal(partialLine([item('newer-version')], undefined), undefined)
})

test('a newer patch alone has its own line; a partial open never says it twice', () => {
    const item = (reason: Parameters<typeof partialLine>[0][number]['reason'], media?: 'bgm') => ({
        reason,
        path: '',
        ...(media ? { media } : {}),
    })
    assert.deepEqual(partialLine([item('newer-patch')], undefined), { kind: 'newerPatch' })
    assert.deepEqual(partialLine([item('newer-patch')], new LevelDataReport()), {
        kind: 'newerPatch',
    })
    // Anything else wrong comes first, and its line already says "newer version".
    assert.deepEqual(partialLine([item('newer-patch'), item('unknown-entry')], undefined), {
        kind: 'newerVersion',
    })
    assert.deepEqual(partialLine([item('newer-patch'), item('unknown-key')], undefined), {
        kind: 'newerVersion',
    })
    const report = new LevelDataReport()
    report.addArchetype('FutureNote')
    assert.deepEqual(partialLine([item('newer-patch')], report), { kind: 'newerVersion' })
    assert.deepEqual(partialLine([item('newer-patch'), item('damaged')], undefined), {
        kind: 'damaged',
    })
    assert.deepEqual(partialLine([item('newer-patch'), item('newer-history')], undefined), {
        kind: 'historyUnreadable',
    })
    assert.deepEqual(
        partialLine([item('newer-patch'), item('media-unreadable', 'bgm')], undefined),
        {
            kind: 'mediaBad',
            media: 'bgm',
        },
    )
    assert.equal(partialLine([item('newer-patch'), item('newer-version')], undefined), undefined)
})

test('a file with a newer patch alone opens whole: bound, history read, and one line', async () => {
    const file = await crafted(
        (items) => setJson(items, 'project.json', { ...jsonOf(items, 'project.json'), patch: 2 }),
        await freshFile(),
    )
    const { read, project, level, head } = await readFile(file)
    // Whole: the open binds it and keeps its history.
    assert.equal(read.open, 'full')
    assert.equal(matchesHead(level.entities, level.bgmOffset, project, head), true)
    assert.deepEqual(partialLine(read.report, new LevelDataReport()), { kind: 'newerPatch' })
})

test('a download binds by the name its revision recorded, without the browser’s suffix', () => {
    assert.equal(bindingName('coconut (3).nxsp', 'coconut.nxsp', false), 'coconut.nxsp')
    assert.equal(bindingName('coconut(3).nxsp', 'coconut.nxsp', false), 'coconut.nxsp')
    assert.equal(bindingName('coconut.nxsp', 'coconut.nxsp', false), 'coconut.nxsp')
    // Another name, or a handle, binds as picked.
    assert.equal(bindingName('melon (3).nxsp', 'coconut.nxsp', false), 'melon (3).nxsp')
    assert.equal(bindingName('coconut (3).nxsp', 'coconut.nxsp', true), 'coconut (3).nxsp')
    assert.equal(bindingName('coconut (3).nxsp', undefined, false), 'coconut (3).nxsp')
})

const chain = (fields: Partial<EarlierChain>): EarlierChain => ({
    chainId: 'c',
    sessionId: 's',
    changed: true,
    openElsewhere: false,
    updatedAt: 1,
    ...fields,
})

test('earlier sessions on the file are recognised by revision', () => {
    const file = { id: 'r3', ancestors: ['r2', 'r1'] }
    const same = chain({ revision: { id: 'r3', ancestors: ['r2'] }, bound: { handle: false } })
    assert.deepEqual(earlierNotice(file, [same]), {
        kind: 'unsavedChanges',
        chain: same,
        restore: true,
    })
    // Unchanged, or unbound: nothing to say.
    assert.equal(earlierNotice(file, [{ ...same, changed: false }]), undefined)
    assert.equal(earlierNotice(file, [{ ...same, bound: undefined }]), undefined)
    // Open in another tab: never named.
    assert.equal(earlierNotice(file, [{ ...same, openElsewhere: true }]), undefined)

    // An earlier revision: Restore only with a handle, whose Save meets the conflict dialog.
    const earlierDownload = chain({
        revision: { id: 'r1', ancestors: [] },
        bound: { handle: false },
    })
    assert.deepEqual(earlierNotice(file, [earlierDownload]), {
        kind: 'unsavedEarlier',
        chain: earlierDownload,
    })
    const earlierHandle = { ...earlierDownload, bound: { handle: true } }
    assert.deepEqual(earlierNotice(file, [earlierHandle]), {
        kind: 'unsavedChanges',
        chain: earlierHandle,
        restore: true,
    })

    // A newer version in Recent Sessions.
    const newer = chain({ revision: { id: 'r4', ancestors: ['r3'] }, changed: false })
    assert.deepEqual(earlierNotice(file, [newer]), { kind: 'olderVersion', chain: newer })

    // The most recent of several.
    const older = { ...same, chainId: 'old', updatedAt: 0 }
    assert.equal(earlierNotice(file, [older, same])?.chain, same)
    assert.equal(earlierNotice(undefined, [same]), undefined)
})

test('a bound chain’s pending journal counts as a change', () => {
    const base = { changed: false, bound: { handle: true }, sessionId: 's' }
    assert.equal(changedOf(base, new Set()), false)
    assert.equal(changedOf(base, new Set(['s'])), true)
    // Already changed in storage, or not bound (a journal is only Restore's for a bound chain).
    assert.equal(changedOf({ ...base, changed: true }, new Set()), true)
    assert.equal(changedOf({ ...base, bound: undefined }, new Set(['s'])), false)
})
