import { expect, test, type Browser, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
    chartOf,
    errorsFail,
    flush,
    liveOf,
    load,
    noErrors,
    notice,
    openHistory,
    peekRow,
    placeTap,
    restoreFromStrip,
    row,
    rowTitles,
    timeline,
} from './historyJourney'
import { pressSave, queuePicks, rows, submitSave } from './saveFlows'

// History in files (D2 plan §3.3, F1 and F2): a future operation and a 520-entry history go
// through Save, a reopen in a fresh context (a new chain), the Timeline, Restore and an append.
// NSE_DUMP_FILES=<dir> keeps the saved files there, for the Python checker (plan §4).

const opfs = { fileSystemAccess: 'opfs' } as const

type Row = Record<string, unknown>
type EntryForm = { kind: string; step?: { operation: unknown }; operation?: unknown }
type Zip = {
    project: Row
    manifest: { entries: EntryForm[] }
    segments: { entries: EntryForm[] }[]
    /** Each entry's CRC-32, by name. */
    crcs: Record<string, number>
}

/** The `.nxsp` in OPFS, read as the app's own ZIP reader does: project, history parts and CRCs. */
const zipOf = (page: Page, name: string) =>
    page.evaluate(async (name) => {
        const root = await navigator.storage.getDirectory()
        const { ZipReader } =
            (await import('/src/zip/reader.ts')) as typeof import('../../src/zip/reader')
        const until = performance.now() + 5000
        for (;;) {
            try {
                const file = await (await root.getFileHandle(name)).getFile()
                const reader = await ZipReader.open(file)
                const read = async (entryName: string) =>
                    JSON.parse(
                        new TextDecoder().decode(
                            await reader.read(reader.get(entryName)!, { maxSize: 64_000_000 }),
                        ),
                    ) as never
                const project = (await read('project.json')) as Row
                const history = project.history as { manifest: string; segments?: string[] }
                const segments: Zip['segments'] = []
                for (const part of history.segments ?? []) segments.push(await read(part))
                return {
                    project,
                    manifest: await read(history.manifest),
                    segments,
                    crcs: Object.fromEntries(
                        reader.entries.map((entry) => [entry.name, entry.crc32]),
                    ),
                } as Zip
            } catch (error) {
                // A file a save is still writing is not readable for a moment.
                if ((error as Error).name !== 'NotReadableError') throw error
                if (performance.now() > until) throw error
                await new Promise((resolve) => setTimeout(resolve, 50))
            }
        }
    }, name)

/** An OPFS file's bytes as base64, to carry it to another context. */
const encoded = (page: Page, name: string) =>
    page.evaluate(async (name) => {
        const root = await navigator.storage.getDirectory()
        const file = await (await root.getFileHandle(name)).getFile()
        const bytes = new Uint8Array(await file.arrayBuffer())
        let text = ''
        for (let i = 0; i < bytes.length; i += 0x8000)
            text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        return btoa(text)
    }, name)

const store = (page: Page, name: string, base64: string) =>
    page.evaluate(
        async ({ name, base64 }) => {
            const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
            const root = await navigator.storage.getDirectory()
            const writable = await (
                await root.getFileHandle(name, { create: true })
            ).createWritable()
            await writable.write(bytes)
            await writable.close()
        },
        { name, base64 },
    )

const keep = async (page: Page, name: string) => {
    const dir = process.env.NSE_DUMP_FILES
    if (!dir) return
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name), Buffer.from(await encoded(page, name), 'base64'))
}

/** A fresh context and page with the platform override: nothing stored, so a file opens as a new chain. */
const freshPage = async (browser: Browser) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    errorsFail(page)
    await load(page, { platform: opfs, chart: 'keep' })
    return { context, page }
}

/** Opens an OPFS file with Open, and waits until its history has been imported. */
const openFile = async (page: Page, name: string) => {
    await queuePicks(page, [name])
    await page.keyboard.press('o')
    await expect(notice(page, name).first()).toBeVisible()
    await expect
        .poll(async () => {
            const { sessions } = await rows(page, ['sessions'])
            return sessions!.filter((entry) => entry.value.importPending === true).length
        })
        .toBe(0)
}

/** Takes the focus off the History list, so the editor's keys reach their commands. */
const leaveList = (page: Page) =>
    page.evaluate(() => {
        const active = document.activeElement
        if (active instanceof HTMLElement && active !== document.body) active.blur()
    })

/** Pushes `count` steps titled "<tag> <n>" that this editor cannot read. */
const pushFuture = (page: Page, tag: string, count: number) =>
    page.evaluate(
        ({ tag, count }) => {
            const { history, historySteps } = window.editorTest
            for (let i = 1; i <= count; i++) {
                const life = history.state.value.initialLife
                history.pushState(historySteps.futureInitialLife(life, life + 1, `${tag} ${i}`), {
                    ...history.state.value,
                    initialLife: life + 1,
                })
            }
        },
        { tag, count },
    )

test.beforeEach(({ page }) => {
    errorsFail(page)
})

test('F1: an operation from a newer editor survives Save, reopen, Restore and an append', async ({
    page,
    browser,
}) => {
    test.slow()
    await load(page, { platform: opfs })
    await placeTap(page, { lane: -2, beat: 1 })
    await placeTap(page, { lane: 0, beat: 2 })
    // What the UI cannot make: a step from a newer editor, with its fallback text.
    const pushed = await page.evaluate(async () => {
        const { history, historySteps, appImport } = window.editorTest
        const life = history.state.value.initialLife
        history.pushState(historySteps.futureInitialLife(life, life + 1, 'Future Thing'), {
            ...history.state.value,
            initialLife: life + 1,
        })
        const stack =
            await appImport<typeof import('../../src/history/stack')>('/src/history/stack.ts')
        return JSON.stringify(stack.headStep.value?.operation)
    })
    const afterFuture = await liveOf(page)
    await placeTap(page, { lane: 2, beat: 3 })

    await pressSave(page)
    await submitSave(page, 'f1')
    await expect(notice(page, 'Saved to f1.nxsp')).toBeVisible()
    const first = await zipOf(page, 'f1.nxsp')
    const futureOf = (zip: Zip) =>
        zip.manifest.entries.filter(
            (entry) =>
                (entry.step?.operation as { fallback?: { text?: string } } | undefined)?.fallback
                    ?.text === 'Future Thing',
        )
    expect(futureOf(first)).toHaveLength(1)
    expect(JSON.stringify(futureOf(first)[0]!.step!.operation)).toBe(pushed)
    await keep(page, 'f1.nxsp')

    // A fresh context: the file opens as a new chain.
    const { context, page: other } = await freshPage(browser)
    try {
        await store(other, 'f1.nxsp', await encoded(page, 'f1.nxsp'))
        await openFile(other, 'f1.nxsp')
        await openHistory(other)
        const future = row(other, 'Future Thing')
        await expect(future).toHaveCount(1)
        // Plain text: no group, no kind count.
        await expect(future).not.toHaveAttribute('aria-expanded')
        await expect(future.locator('[data-history-group-header]')).toHaveCount(0)
        await future.click({ button: 'right' })
        await other.getByRole('menuitem', { name: 'Details', exact: true }).click()
        const details = other.getByRole('dialog', { name: 'Step Details', exact: true })
        await expect(details).toBeVisible()
        await expect(details).toContainText('Future Thing')
        await other.keyboard.press('Escape')
        await expect(details).toHaveCount(0)

        // French: what this editor reads changes language, the other editor's text does not.
        const english = await rowTitles(other)
        await other.evaluate(() => {
            window.editorTest.settings.locale = 'fr'
        })
        await expect
            .poll(async () => {
                const titles = await rowTitles(other)
                return titles.length === english.length
                    ? titles.map((title, i) => title === english[i])
                    : undefined
            })
            .toEqual(english.map((title) => title === 'Future Thing'))
        expect(await rowTitles(other)).toContain('Future Thing')
        await other.evaluate(() => {
            window.editorTest.settings.locale = 'en'
        })
        await expect.poll(() => rowTitles(other)).toEqual(english)

        // Peek and Restore it: the chart after that step.
        await peekRow(other, 'Future Thing')
        expect(await chartOf(other)).toEqual(afterFuture)
        await restoreFromStrip(other)
        expect(await liveOf(other)).toEqual(afterFuture)

        // An append: the earlier entries, the future one among them, are carried unchanged.
        await leaveList(other)
        await other.keyboard.press('p')
        await expect(notice(other, 'Saved to f1.nxsp')).toBeVisible()
        const second = await zipOf(other, 'f1.nxsp')
        expect(second.segments).toHaveLength(0)
        expect(second.manifest.entries.length).toBeGreaterThan(first.manifest.entries.length)
        expect(
            JSON.stringify(second.manifest.entries.slice(0, first.manifest.entries.length)),
        ).toBe(JSON.stringify(first.manifest.entries))
        expect(futureOf(second)).toHaveLength(1)
        expect(JSON.stringify(futureOf(second)[0]!.step!.operation)).toBe(pushed)
        await keep(other, 'f1-appended.nxsp')
        noErrors(other)
    } finally {
        await context.close()
    }
    noErrors(page)
})

test('F2: a 520-entry file crosses a segment, pages in order, restores and appends', async ({
    page,
    browser,
}) => {
    test.slow()
    await load(page, { platform: opfs })
    const start = await liveOf(page)
    await pushFuture(page, 'Step', 515)
    for (let i = 0; i < 5; i++) await placeTap(page, { lane: -3 + i, beat: 1 + i })
    const final = await liveOf(page)
    expect(final.initialLife).toBe(start.initialLife + 515)
    await flush(page)

    await pressSave(page)
    await submitSave(page, 'f2')
    await expect(notice(page, 'Saved to f2.nxsp')).toBeVisible()
    const first = await zipOf(page, 'f2.nxsp')
    // The initialize entry, 515 steps, 5 edits and the save: 500 in a segment, the rest in the manifest.
    const total = 1 + 515 + 5 + 1
    expect(first.segments).toHaveLength(1)
    expect(first.segments[0]!.entries).toHaveLength(500)
    expect(first.manifest.entries).toHaveLength(total - 500)
    await keep(page, 'f2.nxsp')

    const { context, page: other } = await freshPage(browser)
    try {
        await store(other, 'f2.nxsp', await encoded(page, 'f2.nxsp'))
        await openFile(other, 'f2.nxsp')
        await openHistory(other)
        // Scrolling down reads the pages in turn until the first entry (the import) shows.
        const list = timeline(other)
        await expect
            .poll(async () => {
                await list.evaluate((element) => {
                    element.scrollTop = element.scrollHeight
                })
                return (await rowTitles(other)).includes('Imported a level')
            })
            .toBe(true)
        const read = await other.evaluate(async () => {
            const source = await window.editorTest.appImport<
                typeof import('../../src/editor/history/source')
            >('/src/editor/history/source.ts')
            return {
                ids: source.entries.value.map((entry) => `${entry.sessionId}:${entry.seq}`),
                seqs: source.entries.value.map((entry) => [entry.sessionId, entry.seq] as const),
                more: source.canLoadMore.value,
            }
        })
        expect(read.more).toBe(false)
        expect(new Set(read.ids).size).toBe(read.ids.length)
        // No gap: within a session the seqs fall by one from entry to entry.
        for (const [i, [sessionId, seq]] of read.seqs.entries()) {
            const older = read.seqs[i + 1]
            if (older?.[0] === sessionId) expect(older[1]).toBe(seq - 1)
        }
        await expect(other.locator('[data-history-gap]')).toHaveCount(0)
        const imported = read.seqs.filter(([sessionId]) => sessionId === read.seqs.at(-1)![0])
        // The file's entries and the entry that says it was opened.
        expect(imported).toHaveLength(total + 1)

        // The oldest edit: the first step's value. Restore it, then Undo.
        await expect(row(other, 'Step 1')).toBeVisible()
        await peekRow(other, 'Step 1')
        expect((await chartOf(other)).initialLife).toBe(start.initialLife + 1)
        await restoreFromStrip(other)
        expect((await liveOf(other)).initialLife).toBe(start.initialLife + 1)
        await leaveList(other)
        await other.keyboard.press('z')
        await expect.poll(() => liveOf(other)).toEqual(final)
        await flush(other)

        // Go To: one session, one day: the file's entries, the one that says it was opened, the
        // Restore and the Undo.
        await other.locator('[data-history-surface="dialog"] [data-history-goto-button]').click()
        const items = other.locator('[data-history-goto] [data-goto-item]')
        await expect(items).toHaveCount(2)
        await expect(items.nth(1)).toContainText('Today')
        await expect(items.nth(1)).toContainText(`${total + 3} steps`)
        await other.keyboard.press('Escape')
        await expect(items).toHaveCount(0)

        // An append (of a new edit: the Undo went back to what the file holds) keeps the full
        // segment as it was, byte for byte.
        await other.keyboard.press('Escape')
        await expect(timeline(other)).toHaveCount(0)
        await placeTap(other, { lane: 3, beat: 6 })
        await leaveList(other)
        await other.keyboard.press('p')
        await expect(notice(other, 'Saved to f2.nxsp')).toBeVisible()
        const second = await zipOf(other, 'f2.nxsp')
        expect(second.segments).toHaveLength(1)
        expect(second.crcs['history/segments/1.json']).toBe(first.crcs['history/segments/1.json'])
        expect(second.segments[0]).toEqual(first.segments[0])
        await keep(other, 'f2-appended.nxsp')
        noErrors(other)
    } finally {
        await context.close()
    }
    noErrors(page)
})
