import { expect, type Browser } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { appVersion } from '../../scripts/version.mjs'
import { readNxsp } from '../../src/local/nxsp'
import { variants } from '../browser/previewAssetsPackages'
import { queuePicks } from '../browser/saveFlows'
import { prefix } from '../samples/driver'
import { craftedCopy, fixtureFile, levelJson } from './level'
import type { Products } from './products'
import {
    addNamed,
    addPreviewPackage,
    closeTimeline,
    editLevelInfo,
    enableDynamicStages,
    exportLevel,
    exportRawData,
    fillEntries,
    made,
    moveIntoNewFolder,
    pickBgm,
    placeNote,
    png,
    redo,
    restoreRow,
    rowAction,
    saveAs,
    selectTool,
    tapAt,
    undo,
    wav,
} from './ui'
import {
    clientIdOf,
    DAY,
    hide,
    holdFlushes,
    journals,
    loadEvents,
    locksReleased,
    MINUTE,
    openChainId,
    Profile,
    readOpfs,
    START,
    writeOpfs,
    type Row,
    type Tab,
} from './world'

// Context A: a write-back browser on its own device (steps A1 to A13).

/** The build the fixtures carry: the dev server's own version string, which no reader compares. */
export const BUILD = appVersion({ cwd: resolve(import.meta.dirname, '../..') }).appVersion

/** The old auto save of step 1: raw level data, as a v0.5 build left it. */
export const oldAutoSave = JSON.stringify({
    bgmOffset: 0,
    entities: [
        { archetype: 'Initialization', data: [{ name: 'initialLife', value: 1000 }] },
        {
            archetype: '#BPM_CHANGE',
            data: [
                { name: '#BEAT', value: 0 },
                { name: '#BPM', value: 150 },
            ],
        },
    ],
})

/** The sample's stop point: `NSE_FIXTURES_STOP=A5` ends context A after step 5 (for working on the script). */
export const stopAfter = (step: string) => process.env.NSE_FIXTURES_STOP === step

export type A = {
    profile: Profile
    products: Products
    /** The chain ids by the letters the scenario uses. */
    chains: Record<string, string>
}

const fixtureName = 'fixture.nxsp'

/** A shortened run for working on the script: far fewer than 500 entries. */
export const fast = process.env.NSE_FIXTURES_FAST === '1'

/** Zooms the chart out so a few dozen beats fit, with the Note tool selected. */
const prepareChart = async (tab: Tab) => {
    for (let i = 0; i < 12; i++) await tab.command('-')
    await tab.command('a')
}

/** One note a beat or more apart in lanes that never overlap, in a region past the level's last note. */
const lanes = [-5, -1, 3]

export const stepA1 = async (browser: Browser, products: Products): Promise<{ a: A; tab: Tab }> => {
    const profile = await Profile.create(browser, { start: START, files: 'opfs' })
    const blank = await profile.blank()
    await blank.evaluate(
        ([prefix, value]) => localStorage.setItem(`${prefix}autoSave.levelData`, value!),
        [prefix, oldAutoSave],
    )
    await writeOpfs(blank, fixtureName, await fixtureFile(START - DAY, BUILD))
    await blank.close()

    const tab = await profile.visit()
    // The first load migrated the old auto save, and the key is gone.
    expect(
        await tab.page.evaluate(
            (prefix) => localStorage.getItem(`${prefix}autoSave.levelData`),
            prefix,
        ),
    ).toBeNull()
    const sessions = await tab.stored('sessions')
    expect(sessions.map((row) => row.origin)).toEqual(['migrated'])
    const meta = await tab.stored('meta')
    const migrated = meta.find((row) => row.key === 'migratedHashes')
    expect((migrated?.value as unknown[] | undefined)?.length).toBe(1)
    const [chain] = await tab.stored('chains')
    return { a: { profile, products, chains: { M: chain!.chainId as string } }, tab }
}

/** Step 2: Open fixture.nxsp. */
export const stepA2 = async ({ chains }: A, tab: Tab) => {
    await tab.open(fixtureName)
    await expect(tab.notice('Opened fixture.nxsp')).toBeVisible()
    await expect
        .poll(
            async () =>
                (await tab.stored('sessions')).filter((row) => row.importPending === true).length,
        )
        .toBe(0)
    const chain = await tab.chain()
    chains.A = chain.chainId as string
    const session = await tab.session()
    const row = (await tab.stored('sessions')).find((each) => each.id === session.sessionId)
    expect(row?.origin).toBe('nxsp')
    expect(chain.file).toMatchObject({ name: fixtureName, event: 'opened' })
    expect(chain.extra).toEqual({
        zzTopLevel: { carried: true },
        metadata: { zzMeta: ['carried', 1] },
    })
    expect(chain.summary).toMatchObject({ rating: 12, tags: ['First tag', 'Tag'] })
    expect(await tab.stored('sessions')).toHaveLength(2)
}

/** Step 3: the chart worked on through the editor. */
export const stepA3 = async (tab: Tab) => {
    const { page } = tab
    await prepareChart(tab)
    // BGM, then Level Info with a cover and a preview.
    await pickBgm(tab, 'bgm-1.wav', wav(2, 5))
    await editLevelInfo(tab, {
        title: 'Fixture Level',
        artists: 'Fixture Artist',
        author: 'Fixture Author',
        description: 'A level written by the fixture scenario.',
        cover: { name: 'cover-1.png', buffer: png(64, 64, [40, 120, 200]) },
        preview: { name: 'preview-1.wav', buffer: wav(1, 7) },
    })
    // A group in a folder; dynamic stages, then a stage in a folder.
    await addNamed(tab, 'Groups', 'Outro')
    await moveIntoNewFolder(tab, 'Groups', 'Outro', 'Closing')
    await enableDynamicStages(tab)
    await addNamed(tab, 'Stages', 'Side')
    await moveIntoNewFolder(tab, 'Stages', 'Side', 'Closing Stages')
    // One event of each kind.
    const events = [
        'cameraEvent',
        'stageMaskEvent',
        'stagePivotEvent',
        'stageStyleEvent',
        'stageTransformEvent',
    ] as const
    for (const [i, name] of events.entries()) {
        await selectTool(tab, 'd', name)
        await tab.focus(40 + i * 4)
        await made(tab, name, () => tab.click(0, 40 + i * 4))
    }
    // The panels out of the way, the chart zoomed out further.
    for (const which of ['Groups', 'Stages'])
        if (await page.getByTitle(`Hide ${which}`).isVisible())
            await page.getByTitle(`Hide ${which}`).click()
    for (let i = 0; i < 12; i++) await tab.command('-')
    // Notes at lane division 3, then an elevation edit.
    await page.getByTitle('1/1 Lane Division').click({ button: 'right' })
    await page.getByText('1/3 Lane Division', { exact: true }).click()
    await tab.command('a')
    for (const [i, lane] of [-2.2, -0.5, 0.6, 1.4].entries()) await placeNote(tab, lane, 20 + i)
    const third = (await tab.notes()).find((note) => note.beat === 20 && note.size === 3)
    if (!third) throw new Error('No note at lane division 3')
    await tab.command('f')
    await tab.click(third.left + third.size / 2, third.beat)
    const elevation = page.getByRole('spinbutton', { name: 'Elevation' }).first()
    await made(tab, 'elevation', async () => {
        await elevation.fill('0.5')
        await elevation.press('Enter')
    })
    // An undo past a branch: the redo state the next edit drops; a redo; a Timeline Restore.
    await tab.command('a')
    await undo(tab, 2)
    await redo(tab, 1)
    await placeNote(tab, -4, 60)
    await restoreRow(tab, /^Added 4 notes/)
    // Export Level Data: the chain's Export target.
    await exportLevel(tab, 'fixture-level')
    // Edits until the chain holds more than 500 entries.
    await fillEntries(tab, fast ? 40 : 520)
    await tab.stored_()
    const chain = await tab.chain()
    const entries = await tab.chainEntries()
    expect(entries.length).toBeGreaterThan(fast ? 40 : 500)
    expect(entries.some((row) => row.kind === 'export')).toBe(true)
    expect(chain.exportTarget).toBeDefined()
    expect(chain.exportName).toBe('fixture-level')
    expect([...new Set(entries.map((row) => row.kind))].sort()).toEqual([
        'continue',
        'edit',
        'export',
        'redo',
        'restore',
        'undo',
    ])
    // The head's header: a group and a stage in folders.
    const folders = await page.evaluate(async () => {
        const { liveState } =
            (await import('/src/history/stack.ts')) as typeof import('../../src/history/stack')
        const { groups, stages, isDynamicStages } = liveState.value
        return {
            isDynamicStages,
            groups: [...groups.values()].filter((group) => group.folderId !== undefined).length,
            stages: [...stages.values()].filter((stage) => stage.folderId !== undefined).length,
        }
    })
    expect(folders.isDynamicStages).toBe(true)
    expect(folders.groups).toBeGreaterThan(0)
    expect(folders.stages).toBeGreaterThan(0)
}

const hour = 60 * MINUTE

/** Waits for the next load after a kill: the profile as a new visit finds it. */
const prefixKey = `${prefix}journal.`

/** Step 4: a new day and visit; a held flush, an edit and the page closed; a bad journal planted; the next load. */
export const stepA4 = async (a: A, tab: Tab) => {
    const { profile } = a
    await tab.stored_()
    await tab.leave()
    await profile.clock.passTo(START + DAY + 2 * hour)
    let visit = await profile.visit()
    await prepareChart(visit)
    await visit.focus(900)
    // The visit's first edit is stored, so its session exists for the journal to apply to.
    await tapAt(visit, -5, 900)
    await visit.stored_()
    const sessionId = (await visit.session()).sessionId
    const first = (await visit.stored('sessions')).find((row) => row.id === sessionId)
    expect(first?.origin).toBe('continued')
    await holdFlushes(visit.page)
    await tapAt(visit, -1, 900)
    await tapAt(visit, 3, 900)
    await hide(visit.page)
    const found = await journals(visit.page, prefix)
    expect(Object.keys(found)).toEqual([`${prefixKey}${sessionId}`])
    await visit.kill()
    // A journal of an unknown kind of version: one planted key, with journalVersion 0.
    const planted = crypto.randomUUID()
    const blank = await profile.blank()
    await blank.evaluate(
        ([key, text]) => {
            const journal = JSON.parse(text!) as Record<string, unknown>
            const id = key!.slice(key!.lastIndexOf('.') + 1)
            localStorage.setItem(
                key!,
                JSON.stringify({ ...journal, journalVersion: 0, sessionId: id }),
            )
        },
        [`${prefixKey}${planted}`, found[`${prefixKey}${sessionId}`]],
    )
    await blank.close()
    visit = await profile.visit()
    expect(await loadEvents(visit.page)).toContain('journalRecovered')
    const entries = (await visit.stored('entries')).filter((row) => row.sessionId === sessionId)
    const recovered = entries.find((row) => row.kind === 'recovered')
    expect(recovered).toMatchObject({
        stack: expect.anything(),
        recoveryContext: expect.anything(),
    })
    const kept = await visit.stored('recovered')
    expect(kept).toHaveLength(1)
    expect(kept[0]).toMatchObject({ source: 'journal', sessionId: planted })
    expect(Object.keys(await journals(visit.page, prefix))).toEqual([])
    return visit
}

/** A's own file: the one step 2 opened. */
export const aFile = fixtureName

/** Step 5: Save, the chain's first history write. */
export const stepA5 = async (tab: Tab) => {
    // The file was opened without history; a plain Save of it adds history from the open onward
    // (History and BGM are chosen per Save, and a Save with no dialog writes both).
    await tab.page.locator('canvas.editor-chart').focus()
    await tab.page.keyboard.press('p')
    await expect(tab.notice(`Saved to ${aFile}`)).toBeVisible()
    await tab.stored_()
    const chain = await tab.chain()
    expect(chain.file).toMatchObject({ name: aFile, event: 'saved' })
    const read = await readNxsp(new Blob([new Uint8Array(await readOpfs(tab.page, aFile))]))
    if (read.kind !== 'nxsp' || !read.history) throw new Error('The Save wrote no history')
    expect(read.open).toBe('full')
    const revision = (read.projectJson.revision ?? {}) as Row
    // A segment of 500 and the head manifest; the history is complete from the revision opened.
    if (!fast) expect((read.projectJson.history as Row).segments).toHaveLength(1)
    expect(revision.completeFrom).toBe(revision.parent)
    expect(read.history.entries.length).toBeGreaterThan(fast ? 40 : 500)
}

const hex = (bytes: unknown) =>
    Buffer.from(Object.values(bytes as Record<string, number>)).toString('hex')

/** The hashes a chain's `badChunks` packs (16 bytes each), as hex. */
export const badChunksOf = (chain: Row) => {
    const packed = chain.badChunks
    if (!packed) return []
    const all = hex(packed)
    return all.match(/.{32}/g) ?? []
}

/** Step 6: more edits and new media; a chunk only one new row needs goes bad; the next Save finds it. */
export const stepA6 = async (a: A, tab: Tab) => {
    const { profile, products } = a
    await tab.stored_()
    await tab.leave()
    await profile.clock.passTo(START + 2 * DAY + 2 * hour)
    const visit = await profile.visit()
    await visit.command('a')
    await visit.focus(1000)
    // A tap whose chunk for its 16-beat window is no other row's, then undone and branched over:
    // its row stays in the chain (it is the damaged one), its state leaves the undo stack, so Undo
    // never meets it.
    const damaged = await tapAt(visit, -5, 1002)
    await undo(visit)
    await tapAt(visit, -1, 1002)
    await pickBgm(visit, 'bgm-2.wav', wav(3, 9))
    await editLevelInfo(visit, {
        title: 'Fixture Level (Master)',
        cover: { name: 'cover-2.png', buffer: png(64, 64, [200, 90, 60]) },
        preview: { name: 'preview-2.wav', buffer: wav(1, 11) },
    })
    // The Save of step 5 kept the Export target and name that step 4 made.
    expect((await visit.chain()).exportTarget).toBeDefined()
    await visit.focus(1010)
    await tapAt(visit, 3, 1010)
    await visit.stored_()
    const { sessionId } = await visit.session()
    const hash = await visit.page.evaluate(
        (key) =>
            window.nseStorageTest!.worker.call('testDamage', key) as Promise<string | undefined>,
        { sessionId, seq: damaged.seq },
    )
    expect(hash).toMatch(/^[0-9a-f]{32}$/)
    await visit.page.keyboard.press('p')
    await expect(visit.notice(`Saved to ${aFile}`)).toBeVisible()
    await visit.stored_()
    const chain = await visit.chain()
    expect(badChunksOf(chain)).toContain(hash)
    const row = (await visit.stored('entries')).find(
        (each) => each.sessionId === sessionId && each.seq === damaged.seq,
    )
    expect(row?.kept).toBe(false)
    const bytes = await readOpfs(visit.page, aFile)
    const read = await readNxsp(new Blob([new Uint8Array(bytes)]))
    if (read.kind !== 'nxsp' || !read.history) throw new Error('The Save wrote no history')
    expect(read.open).toBe('full')
    expect(read.history.entries.filter((entry) => entry.kept === false)).toHaveLength(1)
    products.put('step6.nxsp', bytes)
    return visit
}

export const noMedia = 'no-media.nxsp'
const forkName = 'fork.nxsp'

/**
 * Step 7: File › New (chain N) saved with history (`no-media.nxsp`); a copy of it (chain F) saved
 * with history to a file of its own, which step 9 takes over; Restore Session of A.
 */
export const stepA7 = async (a: A, tab: Tab) => {
    const { profile, chains } = a
    await tab.stored_()
    await tab.leave()
    await profile.clock.passTo(START + 3 * DAY + 2 * hour)
    const first = await profile.visit()
    await first.command('n')
    await expect(first.notice('New level')).toBeVisible()
    await first.command('a')
    await first.focus(4)
    await tapAt(first, 0, 4)
    await first.stored_()
    chains.N = (await first.chain()).chainId as string
    // N's file: a copy's chain holds only its own rows, so the fixture with an `init` row is N's.
    await saveAs(first, { pick: noMedia, name: 'no-media', history: true })
    await expect(first.notice(`Saved to ${noMedia}`)).toBeVisible()
    await first.stored_()
    const noMediaBytes = await readOpfs(first.page, noMedia)
    const read = await readNxsp(new Blob([new Uint8Array(noMediaBytes)]))
    if (read.kind !== 'nxsp' || !read.history) throw new Error('No history in no-media.nxsp')
    expect(read.open).toBe('full')
    expect(read.history.entries.map((entry) => entry.kind)).toEqual(['init', 'edit', 'save'])
    expect(read.projectJson.bgm).toBeUndefined()
    expect(((read.projectJson.metadata ?? {}) as Row).cover).toBeUndefined()
    expect(((read.projectJson.metadata ?? {}) as Row).preview).toBeUndefined()
    a.products.put(noMedia, noMediaBytes)
    // A second tab finds N open in the first and starts blank: N's row offers Restore as a Copy.
    const second = await profile.visit()
    await rowAction(second, chains.N, 'Restore as a Copy')
    await expect(second.notice('Restored a copy of')).toBeVisible()
    await closeTimeline(second.page)
    await second.command('a')
    await second.focus(8)
    await tapAt(second, 0, 8)
    await second.stored_()
    const copy = await second.chain()
    chains.F = copy.chainId as string
    expect(chains.F).not.toBe(chains.N)
    expect(copy.file).toBeUndefined()
    await saveAs(second, { pick: forkName, name: 'fork', history: true })
    await expect(second.notice(`Saved to ${forkName}`)).toBeVisible()
    await second.stored_()
    expect((await second.chain()).file).toMatchObject({ name: forkName, event: 'saved' })
    // Restore Session of A, which no tab holds.
    await rowAction(second, chains.A, 'Restore Session')
    await expect(second.notice('Restored')).toBeVisible()
    await closeTimeline(second.page)
    await first.leave()
    return second
}

export const noHistory = 'no-history.nxsp'
const levelName = 'imported-level.json.gz'

/** Step 8: a level `.json` opened (chain I), one edit, Save As… with History unticked. */
export const stepA8 = async (a: A, tab: Tab) => {
    const { chains } = a
    expect(await openChainId(tab.page)).toBe(chains.A)
    await writeOpfs(tab.page, levelName, levelJson())
    await tab.open(levelName)
    await expect(tab.notice('Opened level')).toBeVisible()
    await tab.command('a')
    await tab.focus(10)
    await tapAt(tab, 0, 10)
    await tab.stored_()
    const chain = await tab.chain()
    chains.I = chain.chainId as string
    expect(chain.sourceName).toBe('imported-level')
    expect(chain.exportTarget).toMatchObject({ opened: true })
    expect((await tab.stored('sessions')).find((row) => row.chainId === chains.I)?.origin).toBe(
        'import',
    )
    // A Save, not Save As…: a new `docId` would clear the Export target that the open made.
    await saveAs(tab, { pick: noHistory, name: 'no-history', history: false, plain: true })
    await expect(tab.notice(`Saved to ${noHistory}`)).toBeVisible()
    await tab.stored_()
    expect((await tab.chain()).file).toMatchObject({ name: noHistory, event: 'saved' })
    expect((await tab.chain()).exportTarget).toMatchObject({ opened: true })
    const bytes = await readOpfs(tab.page, noHistory)
    const read = await readNxsp(new Blob([new Uint8Array(bytes)]))
    if (read.kind !== 'nxsp') throw new Error('Not a project file')
    expect(read.open).toBe('full')
    expect(read.history).toBeUndefined()
    a.products.put(noHistory, bytes)
}

const copyName = 'fixture-history-copy.nxsp'

/** The `saving.*` keys the editor holds in localStorage, without the editor's prefix. */
const storedMarkers = (tab: Tab) =>
    tab.page.evaluate((prefix) => {
        const found: string[] = []
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i)
            if (key?.startsWith(`${prefix}saving.`)) found.push(key.slice(prefix.length))
        }
        return found
    }, prefix)

/**
 * Holds the storage flush from the instant a Save writes its `saving.*` marker (a flush held earlier
 * would stop the Save before the marker: the Save commits first), so the file is written and the
 * binding never is.
 */
const holdFlushAtMarker = (tab: Tab) =>
    tab.page.evaluate((prefix) => {
        const set = Storage.prototype.setItem
        Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
            set.call(this, key, value)
            if (key.startsWith(`${prefix}saving.`)) window.nseFlushTest!.stall = true
        }
    }, prefix)

/** The `revision.n` of a project file in the profile's OPFS (0 when it is not a project file). */
const revisionN = async (tab: Tab, name: string) => {
    const read = await readNxsp(new Blob([new Uint8Array(await readOpfs(tab.page, name))]))
    return read.kind === 'nxsp' ? Number((read.projectJson.revision as Row).n) : 0
}

/**
 * Step 9: a copy of step 6's file with an unknown manifest key (chain P) takes over fork.nxsp (F's
 * file). Then P's file is written by a Save whose binding is never recorded (the page is killed),
 * the next load recognises that Save as our own, and the Save after it appends to a file whose base
 * has no row of its own: P's binding then holds `entry.inexact`. Returns the tab that is open after.
 */
export const stepA9 = async (a: A, tab: Tab) => {
    const { chains, products } = a
    const crafted = await craftedCopy(products.bytes('step6.nxsp'))
    await writeOpfs(tab.page, copyName, crafted)
    await tab.open(copyName)
    await expect(tab.notice('Made by a newer version')).toBeVisible()
    await expect
        .poll(
            async () =>
                (await tab.stored('sessions')).filter((row) => row.importPending === true).length,
        )
        .toBe(0)
    await tab.command('a')
    await tab.focus(14)
    await tapAt(tab, 0, 14)
    await tab.stored_()
    const opened = await tab.chain()
    chains.P = opened.chainId as string
    expect(opened.file).toBeUndefined()
    expect(opened.partialImport).toBe(true)
    expect((await tab.stored('handles')).find((row) => row.chainId === chains.P)).toMatchObject({
        role: 'kept',
    })
    await saveAs(tab, { pick: forkName, name: 'fork', history: true })
    await expect(tab.notice(`Saved to ${forkName}`)).toBeVisible()
    await tab.stored_()
    const p = await tab.chain()
    expect(p.file).toMatchObject({ name: forkName, event: 'saved' })
    const f = (await tab.stored('chains')).find((row) => row.chainId === chains.F)!
    expect(f.file).toBeUndefined()
    expect(f.replaced).toMatchObject({ by: chains.P, name: forkName })
    expect(f.name).toBe('fork')

    // An own Save the binding never recorded: the file is written, the page goes.
    await tapAt(tab, 0, 1030)
    await tab.stored_()
    const was = await revisionN(tab, forkName)
    await holdFlushAtMarker(tab)
    await tab.page.keyboard.press('p')
    await expect.poll(() => revisionN(tab, forkName)).toBeGreaterThan(was)
    await hide(tab.page)
    expect(await storedMarkers(tab)).toEqual([`saving.${chains.P}`])
    await tab.kill()

    // The next load recognises it; the Save after that appends to it.
    const visit = await a.profile.visit()
    expect(await openChainId(visit.page)).toBe(chains.P)
    await visit.command('a')
    await tapAt(visit, 0, 1034)
    await visit.stored_()
    await visit.page.keyboard.press('p')
    await expect(visit.notice(`Saved to ${forkName}`)).toBeVisible()
    await visit.stored_()
    expect(await storedMarkers(visit)).toEqual([])
    expect(((await visit.chain()).file as Row).entry).toMatchObject({ inexact: true })
    return visit
}

/** Step 10: more edits to A and a Save (its file now diverges from step 6's); a preview asset package. */
export const stepA10 = async (a: A, tab: Tab) => {
    const { profile, chains, products } = a
    await tab.stored_()
    await tab.leave()
    await profile.clock.passTo(START + 4 * DAY + 2 * hour)
    const visit = await profile.visit()
    await rowAction(visit, chains.A, 'Restore Session')
    await expect(visit.notice('Restored')).toBeVisible()
    await closeTimeline(visit.page)
    expect(await openChainId(visit.page)).toBe(chains.A)
    await visit.command('a')
    await visit.focus(1100)
    for (const [i, lane] of lanes.entries()) await tapAt(visit, lane, 1100 + i * 2)
    await visit.page.keyboard.press('p')
    await expect(visit.notice(`Saved to ${aFile}`)).toBeVisible()
    await visit.stored_()
    products.put('step10.nxsp', await readOpfs(visit.page, aFile))
    await addPreviewPackage(
        visit,
        'fixture-particle.scp',
        await variants('particle', [{ name: 'fixture-particle', title: 'Fixture Particle' }]),
    )
    expect(await visit.stored('userAssets')).toHaveLength(1)
    return visit
}

/** The media store's rows: hash and kind, sorted by hash. */
const mediaRows = (tab: Tab) =>
    tab.page.evaluate(async () => {
        const { toHex } =
            (await import('/src/local/hash.ts')) as typeof import('../../src/local/hash')
        const { media } = (await window.nseStorageTest!.worker.call('testRows', [
            'media',
        ])) as unknown as {
            media: { key: ArrayBuffer; value: { kind: string } }[]
        }
        return media.map((row) => ({ hash: toHex(new Uint8Array(row.key)), kind: row.value.kind }))
    })

/** The live state's BGM, cover and preview hashes. */
const headMedia = (tab: Tab) =>
    tab.page.evaluate(async () => {
        const { liveState } =
            (await import('/src/history/stack.ts')) as typeof import('../../src/history/stack')
        const { bgm, levelInfo } = liveState.value
        return [bgm.meta?.hash, levelInfo.cover?.hash, levelInfo.preview?.hash].filter(
            (hash): hash is string => hash !== undefined,
        )
    })

/**
 * Step 11: two more days of use, then a load with a full browser: the next write pauses storing,
 * cleanup removes the earlier media, and storing resumes.
 */
export const stepA11 = async (a: A, tab: Tab) => {
    const { profile } = a
    await tab.stored_()
    await tab.leave()
    await profile.clock.passTo(START + 5 * DAY + 2 * hour)
    const day5 = await profile.visit()
    await day5.command('a')
    await day5.focus(1200)
    await tapAt(day5, 0, 1200)
    await day5.stored_()
    // Before the full browser: the earlier media are still stored, beside the head's.
    const before = await mediaRows(day5)
    expect(before.map((row) => row.kind).sort()).toEqual([
        'bgm',
        'bgm',
        'cover',
        'cover',
        'preview',
        'preview',
    ])
    await day5.leave()
    await profile.clock.passTo(START + 6 * DAY + 2 * hour)
    const blank = await profile.blank()
    await profile.flags(blank, { quotaUntilFreed: true })
    await blank.close()
    const visit = await profile.visit()
    await visit.command('a')
    await visit.focus(1300)
    await tapAt(visit, 0, 1300)
    const head = await headMedia(visit)
    expect(head).toHaveLength(3)
    await expect
        .poll(async () => (await mediaRows(visit)).map((row) => row.hash).sort())
        .toEqual([...head].sort())
    await expect
        .poll(() => visit.page.evaluate(() => window.nseStorageTest?.status()))
        .toEqual({ mode: 'stored' })
    await visit.stored_()
    const runs = await visit.page.evaluate(async () => {
        const { pressureRuns } =
            (await import('/src/local/pressure.ts')) as typeof import('../../src/local/pressure')
        return pressureRuns.filter((run) => run.trigger === 'full')
    })
    expect(runs.some((run) => run.freed > 0)).toBe(true)
    await profile.flags(visit.page, undefined)
    // GC ran at the load.
    await expect
        .poll(async () => (await visit.stored('meta')).some((row) => row.key === 'lastGcAt'))
        .toBe(true)
    return visit
}

/** Step 12: Settings › Local Data › Recovery › Export Raw Data…: `raw-export.zip`. */
export const stepA12 = async (a: A, tab: Tab) => {
    const { name, path } = await exportRawData(tab)
    expect(name).toMatch(/^Next SEKAI Editor raw data \d{4}-\d{2}-\d{2}\.zip$/)
    a.products.put('raw-export.zip', readFileSync(path))
}

const qName = 'fixture-history-q.nxsp'

/**
 * Step 13: N deleted (last, so no sweep removes it before the dump); a second tab's import of a copy
 * of A's file (chain Q) closed while it runs; in A's tab a held flush, an edit and a Save, whose marker
 * stays, and the page closed. Then the database and localStorage are dumped.
 */
export const stepA13 = async (a: A, tab: Tab) => {
    const { profile, chains } = a
    await rowAction(tab, chains.N, 'Delete')
    await expect(tab.page.locator('[data-sessions-live]')).toContainText('Deleted')
    await closeTimeline(tab.page)
    const all = await tab.stored('chains')
    expect(all.find((row) => row.chainId === chains.N)?.deleting).toBeDefined()
    // A and I keep an Export target, I's the opened file.
    expect(all.find((row) => row.chainId === chains.A)?.exportTarget).toBeDefined()
    expect(all.find((row) => row.chainId === chains.I)?.exportTarget).toMatchObject({
        opened: true,
    })
    expect(
        (await tab.stored('handles'))
            .filter((row) => row.role === 'exportTarget')
            .map((row) => row.chainId)
            .sort(),
    ).toEqual([chains.A, chains.I].sort())

    // Q: a copy of A's file opened in a second tab and the tab closed while the background import runs.
    const second = await profile.visit()
    await writeOpfs(second.page, qName, await readOpfs(tab.page, aFile))
    await queuePicks(second.page, [qName])
    const clientId = await clientIdOf(second.page)
    // A slow CPU (a browser's own emulation, not a hook) keeps the import running while the tab goes.
    const cdp = await profile.context.newCDPSession(second.page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    await second.page.keyboard.press('o')
    await expect
        .poll(
            async () => (await second.stored('sessions')).some((row) => row.importPending === true),
            {
                intervals: [5],
                timeout: 30_000,
            },
        )
        .toBe(true)
    // Closed at once; the browser's release of its locks is waited for after.
    await second.page.close({ runBeforeUnload: false })
    await locksReleased(profile, clientId)
    const rows = await tab.stored('sessions')
    const pending = rows.filter((row) => row.importPending === true)
    if (pending.length !== 1) throw new Error(`The import was not left pending: ${pending.length}`)
    chains.Q = pending[0]!.chainId as string

    // A: a Save whose binding is never committed. The flush is held from the moment its marker is
    // written (a held flush earlier would stop the Save before the marker: the Save commits first).
    await selectTool(tab, 'a', 'note')
    await tab.focus(1400)
    await tapAt(tab, 0, 1400)
    await tab.stored_()
    const written = (await tab.stored('chains')).find((row) => row.chainId === chains.A)!
    const before = (written.file as Row).hash
    await holdFlushAtMarker(tab)
    await tab.page.keyboard.press('p')
    // The file has the Save's revision, and the binding still the one before it.
    await expect
        .poll(async () => {
            const read = await readNxsp(new Blob([new Uint8Array(await readOpfs(tab.page, aFile))]))
            return read.kind === 'nxsp' ? (read.projectJson.revision as Row).n : 0
        })
        .toBeGreaterThan(Number(((await tab.chain()).revision as Row).n))
    expect(
        ((await tab.stored('chains')).find((row) => row.chainId === chains.A)!.file as Row).hash,
    ).toEqual(before)
    // The file the marker names: a fixture of its own (a later build must recognise it as our Save).
    a.products.put('saving-marker-file.nxsp', await readOpfs(tab.page, aFile))
    // An edit the journal alone holds, then the page goes.
    await tapAt(tab, 0, 1404)
    await hide(tab.page)
    const keys = await tab.page.evaluate((prefix) => {
        const found: string[] = []
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i)
            if (key?.startsWith(prefix)) found.push(key.slice(prefix.length))
        }
        return found
    }, prefix)
    expect(keys.some((key) => key.startsWith('saving.'))).toBe(true)
    expect(keys.some((key) => key.startsWith('journal.'))).toBe(true)
    await tab.kill()
    return profile.dump(BUILD)
}
