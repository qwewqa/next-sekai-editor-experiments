import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWorld, flow, sameBytes, settle, type Setup, type World } from './world'

const { FileError } = await import('../../../src/platform')
const { diskFinding, setDiskFinding } = await import('../../../src/editor/file/state')

// Recent Sessions' Save… of a session that is not open: every button after a failed write or a
// refused pick acts on that session, and the file records the name the picker gave it. Try Again
// and Save As… used to save the open session and report success.

type Build = {
    chainId: string
    target: { kind: string; docId?: string; sessionId?: string }
    options: { fileName: string; save: { operation: unknown } }
}

const world = async (setup: Setup = {}) => {
    const w = await createWorld({ own: 'bound', storage: 'lacks', ...setup })
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

for (const [code, dialog, choice] of [
    ['denied', 'denied', 'tryAgain'],
    ['denied', 'denied', 'saveAs'],
    ['no-space', 'failed', 'saveAs'],
    ['read-only', 'readOnly', 'saveAs'],
    ['not-found', 'notFound', 'saveAs'],
] as const)
    test(`Recent Sessions' Save…: after a failed write (${code}), ${choice} saves the same session again`, async () => {
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

test("Recent Sessions' Save…: a picked file that is not found leaves the open session's file state", async () => {
    const { w } = await world()
    failOnce(w, 'fresh.nxsp', () => new FileError('not-found', 'Not found'))
    w.pick('fresh.nxsp')
    w.answers.saveDialog.push(answer('fresh.nxsp'))
    await flow.saveToFile('session-other')
    await settle()
    assert.deepEqual(kinds(w, 'notFound'), [['fresh.nxsp']])
    assert.equal(diskFinding.value, undefined)
})

test("Recent Sessions' Save…: a refused level data file offers no Export, which exports the open session", async () => {
    const r = await world({ opened: 'levelData' })
    const { w } = r
    w.pick('opened.nsld', 'unknown.nxsp')
    w.answers.saveDialog.push(answer('opened.nsld'), answer('unknown.nxsp'))
    w.answers.refused.push('chooseAnother')
    await flow.saveToFile('session-other')
    await settle()
    assert.deepEqual(kinds(w, 'refused'), [['opened.nsld', 'notProject']])
    assert.deepEqual(kinds(w, 'saveDialog'), [['saveToFile'], ['saveToFile']])
    await onlyStored(r)
    assert.deepEqual(kinds(w, 'saved'), [['unknown.nxsp']])
})

/** Recent Sessions' Save… with "suggested" typed and `fresh.nxsp` picked. */
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

test("Recent Sessions' Save…: a picker that renames the file writes the picked name into it", async () => {
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
    test(`Recent Sessions' Save…: a rebuild under the picked name that ${how} writes the first build`, async () => {
        const { w, builds, written } = await renamed(rebuild)
        assert.deepEqual(
            builds.map((build) => build.options.fileName),
            ['suggested.nxsp', 'fresh.nxsp'],
        )
        assert.ok(sameBytes(written, w.builtLog[0]!.bytes), 'the first build is written whole')
    })
