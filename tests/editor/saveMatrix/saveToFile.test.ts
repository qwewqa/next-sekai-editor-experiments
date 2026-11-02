import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import type { JournalApplyBatch } from '../../../src/local/journal/apply'
import type { OpenDeps } from '../../../src/local/startup/open'
import type { RecoveryContext } from '../../../src/local/startup/steps'
import type { JournalFound } from '../../../src/platform/types'
import { createWorld, flow, sameBytes, settle, type Setup, type World } from './world'

const { FileError } = await import('../../../src/platform')
const { diskFinding, setDiskFinding } = await import('../../../src/editor/file/state')
const { i18n } = await import('../../../src/i18n')
const { setSessionContext } = await import('../../../src/local/startup/api')
const { journalContent } = await import('../../../src/local/journal/content')
const { JOURNAL_VERSION } = await import('../../../src/local/journal/format')
const { RECORDS_V, SESSION_V } = await import('../../../src/local/records/version')
const { goldenChart, stateOf } = await import('../../local/records/charts')
const { initialStep } = await import('../../helpers/historySteps')

// In Recent Sessions' Save of a session that is not open, every button after a failed write
// acts on that session, and the file records the name the picker gave it. Try Again
// and Save As used to save the open session and report success.

type Build = {
    chainId: string
    target: { kind: string; docId?: string; sessionId?: string }
    options: { fileName: string; save: { operation: unknown } }
}

const world = async (setup: Setup = {}) => {
    const w = await createWorld({ own: 'bound', ...setup })
    setDiskFinding(undefined)
    const builds: Build[] = []
    w.on('worker:buildSave', (_n, arg) => {
        builds.push(arg as Build)
    })
    return { w, builds, own: w.files['own.nxsp'] }
}

const answer = (fileName: string) => ({ action: 'save', fileName, history: true, bgm: true })

/** Fails the write of `name` once, at the platform's check. */
const failOnce = (w: World, name: string, error: () => Error) => {
    let fired = false
    w.mock.fault = (point, at) => {
        if (point !== 'checked' || at !== name || fired) return
        fired = true
        w.mock.files.delete(name)
        throw error()
    }
}

const kinds = (w: World, kind: string) =>
    w.dialogs.filter((dialog) => dialog.kind === kind).map((dialog) => dialog.args)

/** Every build was the stored session's, and the open chain's own file is as it was. */
const onlyStored = async (r: Awaited<ReturnType<typeof world>>) => {
    assert.ok(r.builds.length > 0)
    for (const build of r.builds) {
        assert.equal(build.chainId, 'chain-other')
        assert.equal(build.target.sessionId, 'session-other')
    }
    assert.deepEqual(await r.w.fileBytes('own.nxsp'), r.own)
}

for (const [code, dialog, choice, label] of [
    ['denied', 'denied', 'saveAs', 'Save As'],
    ['no-space', 'failed', 'saveAs', 'Save As'],
    ['read-only', 'readOnly', 'saveAs', 'Save As'],
    ['not-found', 'notFound', 'saveAs', 'Save As'],
] as const)
    test(`Recent Sessions' Save: after a failed write (${code}), ${label} saves the same session again`, async () => {
        const r = await world()
        const { w } = r
        failOnce(w, 'fresh.nxsp', () => new FileError(code, 'The write failed'))
        w.pick('fresh.nxsp', 'unknown.nxsp')
        w.answers.saveDialog.push(answer('fresh.nxsp'), answer('unknown.nxsp'))
        ;(w.answers[dialog] as string[]).push(choice)
        await flow.saveToFile('session-other')
        await settle()
        assert.deepEqual(kinds(w, dialog), [['fresh.nxsp']])
        assert.deepEqual(kinds(w, 'saveDialog'), [['saveToFile'], ['saveToFile']])
        await onlyStored(r)
        assert.deepEqual(
            w.writes.map((write) => write.name),
            ['unknown.nxsp'],
        )
        assert.deepEqual(kinds(w, 'saved'), [['unknown.nxsp']])
    })

test("Recent Sessions' Save: a picked file that is not found leaves the open session's file state", async () => {
    const { w } = await world()
    failOnce(w, 'fresh.nxsp', () => new FileError('not-found', 'Not found'))
    w.pick('fresh.nxsp')
    w.answers.saveDialog.push(answer('fresh.nxsp'))
    await flow.saveToFile('session-other')
    await settle()
    assert.deepEqual(kinds(w, 'notFound'), [['fresh.nxsp']])
    assert.equal(diskFinding.value, undefined)
})

test("Recent Sessions' Save writes over level data", async () => {
    const r = await world({ opened: 'levelData' })
    const { w } = r
    w.pick('opened.nsld')
    w.answers.saveDialog.push(answer('opened.nsld'))
    await flow.saveToFile('session-other')
    await settle()
    await onlyStored(r)
    assert.deepEqual(kinds(w, 'saved'), [['opened.nsld']])
})

test("Recent Sessions' Save revokes the open chain's binding", async () => {
    const { w, builds } = await world()
    w.pick('own.nxsp')
    w.answers.saveDialog.push(answer('own.nxsp'))
    await flow.saveToFile('session-other')
    await settle()
    assert.equal(w.boundName(), undefined)
    assert.equal(
        (await w.storedChains()).find((row) => row.chainId === 'chain-own')?.file,
        undefined,
    )
    assert.ok(builds.every((build) => build.target.sessionId === 'session-other'))
    assert.deepEqual(kinds(w, 'saved'), [['own.nxsp']])
    assert.deepEqual(kinds(w, 'emptied'), [])
})

for (const stored of [true, false])
    test(`Recent Sessions' Save followed by Save As records the new binding when revocation ${stored ? 'succeeds' : 'fails'}`, async (t) => {
        const { w } = await world()
        let now = Date.now()
        t.mock.method(Date, 'now', () => ++now)
        if (!stored) w.behaviour.set('revokeOwner', () => 'throw')
        w.pick('own.nxsp', 'fresh.nxsp')
        w.answers.saveDialog.push(answer('own.nxsp'), answer('fresh.nxsp'))
        await flow.saveToFile('session-other')
        const record = (await w.storedChains()).find((row) => row.chainId === 'chain-own')!
        assert.deepEqual(w.session.chain?.replaced, record.replaced)
        assert.deepEqual(w.session.chain?.file, record.file)
        await flow.saveAs()
        await settle()
        const saved = (await w.storedChains()).find((row) => row.chainId === 'chain-own')!
        assert.equal((saved.file as { name: string } | undefined)?.name, 'fresh.nxsp')
        assert.equal(saved.replaced, undefined)
        assert.deepEqual(kinds(w, 'saved'), [['own.nxsp'], ['fresh.nxsp']])
    })

/** Recent Sessions' Save with "suggested" typed and `fresh.nxsp` picked. */
const renamed = async (rebuild?: 'throw' | { refuse: string }) => {
    const r = await world()
    const { w } = r
    if (rebuild) w.behaviour.set('buildSave', (n) => (n === 2 ? rebuild : undefined))
    w.pick('fresh.nxsp')
    w.answers.saveDialog.push(answer('suggested.nxsp'))
    await flow.saveToFile('session-other')
    await settle()
    await onlyStored(r)
    assert.deepEqual(kinds(w, 'saved'), [['fresh.nxsp']])
    return { ...r, written: (await w.fileBytes('fresh.nxsp'))! }
}

test("Recent Sessions' Save: a picker that renames the file writes the picked name into it", async () => {
    const { w, builds, written } = await renamed()
    const at = w.builtLog.findIndex((built) => sameBytes(built.bytes, written))
    assert.ok(at > 0, 'the build under the picked name is written')
    const build = builds[at]!
    assert.equal(build.options.fileName, 'fresh.nxsp')
    assert.match(JSON.stringify(build.options.save.operation), /fresh\.nxsp/)
    assert.doesNotMatch(JSON.stringify(build.options.save.operation), /suggested/)
    assert.equal(build.target.kind, 'new')
    assert.equal(build.target.docId, builds[0]!.target.docId, 'the same new document')
})

for (const [how, rebuild] of [
    ['throws', 'throw'],
    ['is refused', { refuse: 'unreadableHead' }],
] as const)
    test(`Recent Sessions' Save: a rebuild under the picked name that ${how} writes the first build`, async () => {
        const { w, builds, written } = await renamed(rebuild)
        assert.deepEqual(
            builds.map((build) => build.options.fileName),
            ['suggested.nxsp', 'fresh.nxsp'],
        )
        assert.ok(sameBytes(written, w.builtLog[0]!.bytes), 'the first build is written whole')
    })

// A tab that had the stored session open died with edits only its journal holds. The Save
// replays that journal first, as Restore does, and never writes the stored session without them.

/** That journal, as the dead tab wrote it. */
const journalText = () =>
    JSON.stringify({
        journalVersion: JOURNAL_VERSION,
        kind: 'journal',
        recordsV: RECORDS_V,
        appVersion: 'test',
        writtenAt: 1,
        sessionId: 'session-other',
        seq: 2,
        descriptor: {
            v: SESSION_V,
            origin: 'new',
            startedAt: 0,
            chainId: 'chain-other',
            docId: 'doc-other',
            lineageId: 'lineage-other',
        },
        ...journalContent(stateOf(goldenChart())),
        stack: {
            keep: 0,
            context: { head: initialStep(), headIndex: 0, dropped: [], omitted: 0 },
            head: true,
            index: 0,
        },
    })

type Pending = {
    text?: string
    applyJournal?: (batch: JournalApplyBatch) => Promise<unknown>
    read?: () => Promise<JournalFound[]>
}

/** Startup's context with `text` pending for the stored session; the real replay runs over it. */
const pending = (t: TestContext, w: World, setup: Pending = {}) => {
    const applied: JournalApplyBatch[] = []
    let journals: JournalFound[] = [
        {
            sessionId: 'session-other',
            from: 'journal.session-other',
            text: setup.text ?? journalText(),
        },
    ]
    setSessionContext(
        { locks: w.mock.locks } as unknown as OpenDeps,
        {
            status: { mode: 'stored' },
            locks: w.mock.locks,
            journal: {
                read: setup.read ?? (() => Promise.resolve(journals)),
                remove: (found: JournalFound) => {
                    journals = journals.filter((each) => each !== found)
                },
            },
            worker: {
                applyJournal: (batch: JournalApplyBatch) => {
                    applied.push(batch)
                    return (
                        setup.applyJournal?.(batch) ??
                        Promise.resolve({ kind: 'applied', created: false })
                    )
                },
                keepRecovered: () => Promise.resolve(true),
            },
            appVersion: 'test',
            operations: { recovered: () => 'Recovered' },
            outcomes: [],
        } as unknown as RecoveryContext,
    )
    t.after(() => {
        journals = []
    })
    return { applied, left: () => journals.length }
}

for (const [how, setup, message] of [
    [
        'failed to apply',
        { applyJournal: () => Promise.reject(new Error('QuotaExceededError')) },
        () => i18n.value.save.sessionUnavailable,
    ],
    [
        'could not be listed',
        { read: () => Promise.reject(new Error('SecurityError')) },
        () => i18n.value.save.sessionUnavailable,
    ],
    [
        'a newer build wrote',
        { text: JSON.stringify({ journalVersion: JOURNAL_VERSION + 1 }) },
        () => i18n.value.load.sessionLater,
    ],
] as const)
    test(`Recent Sessions' Save of a session whose journal ${how} stops before the picker`, async (t) => {
        const { w } = await world()
        const journal = pending(t, w, setup)
        await flow.saveToFile('session-other')
        await settle()
        assert.deepEqual(kinds(w, 'error'), [[message()]])
        assert.deepEqual(kinds(w, 'saveDialog'), [])
        assert.deepEqual(w.writes, [])
        assert.deepEqual(kinds(w, 'saved'), [])
        assert.equal(journal.left(), 1, 'the journal stays for a later try')
    })

test("Recent Sessions' Save of a session whose journal was kept as a recovery session saves that one, and Save As after a failure saves it again", async (t) => {
    const r = await world()
    const { w, builds } = r
    const journal = pending(t, w, {
        applyJournal: (batch) =>
            Promise.resolve({ kind: 'recovery', ...batch.recovery, why: 'continued elsewhere' }),
    })
    failOnce(w, 'fresh.nxsp', () => new FileError('no-space', 'The write failed'))
    w.pick('fresh.nxsp', 'unknown.nxsp')
    w.answers.saveDialog.push(answer('fresh.nxsp'), answer('unknown.nxsp'))
    w.answers.failed.push('saveAs')
    await flow.saveToFile('session-other')
    await settle()
    const kept = journal.applied[0]?.recovery.sessionId
    assert.ok(kept)
    assert.equal(journal.left(), 0)
    assert.ok(builds.length > 1)
    assert.deepEqual(new Set(builds.map((build) => build.target.sessionId)), new Set([kept]))
    assert.deepEqual(kinds(w, 'saved'), [['unknown.nxsp']])
})

test("Recent Sessions' Save of a session whose journal this build cannot read saves the session as stored", async (t) => {
    const r = await world()
    const { w } = r
    const journal = pending(t, w, { text: 'not json' })
    w.pick('fresh.nxsp')
    w.answers.saveDialog.push(answer('fresh.nxsp'))
    await flow.saveToFile('session-other')
    await settle()
    assert.deepEqual(journal.applied, [])
    assert.equal(journal.left(), 0, 'its bytes went to Local Data')
    await onlyStored(r)
    assert.deepEqual(kinds(w, 'saved'), [['fresh.nxsp']])
})
