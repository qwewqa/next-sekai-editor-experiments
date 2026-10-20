import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type en from '../../src/i18n/en/index.json'
import {
    chartOf,
    closePage,
    dragNote,
    errorsFail,
    flush,
    holdWorker,
    liveOf,
    load,
    newestSeq,
    noErrors,
    notice,
    openHistory,
    peekRow,
    placeTap,
    release,
    reloadAndWait,
    restoreFromStrip,
    rowTitles,
    selectNote,
    setProperty,
    timeline,
    type Digest,
} from './historyJourney'
import { pressSave, projectOf, queuePicks, readFile, submitSave } from './saveFlows'

// The History journeys of D2 package P1 (work/history-redesign/testplan/plan.md §3.1): real
// tool input from a blank chart through History, and the peek-safety checks, the top data risk:
// Save, Export, a reload and a crash while a chart other than the live one is shown must never
// write that chart. Every write is checked against the live state by its content (the level in
// the file, the stored entry's root hash), with a peeked state that really differs from the live
// one.

test.skip(
    ({ browserName }) => browserName === 'webkit' && process.platform === 'win32',
    'Playwright WebKit on Windows does not provide Web Audio',
)

test.afterEach(({ page }) => noErrors(page))

// --- Text from the catalogue

const english = JSON.parse(
    readFileSync(new URL('../../src/i18n/en/index.json', import.meta.url), 'utf8'),
) as typeof en

/** Fills a catalogue message as the app does: the first value picks the singular or plural form. */
const text = (message: string, ...params: (string | number)[]) => {
    const forms = message.split('|')
    const form = forms.length > 1 && String(params[0]) !== '1' ? forms[1]! : forms[0]!
    return form.replace(/\{(\d+)\}/g, (_, index: string) => String(params[Number(index)]))
}
const lane = english.modals.form.left.label
const operation = english.history.operation
const addedNotes = (count: number) => text(english.tools.note.added, count)
const movedNotes = (count: number) => text(english.tools.note.moved, count)
const setLane = (value: number) => text(operation.setValueOnNotes, 1, lane, value)
const changedLane = text(english.history.summary.setOnNotes, lane)
const now = (label: string) => `${english.history.now} · ${label}`
const restoredPrefix = text(english.entry.restoredTo, '')

// --- Rows and peek, beyond the shared helper

const timeOfRow = (page: Page, id: string) =>
    page.locator(`[id="${id}"] [data-history-group-time]`).innerText()

/** The ids of the rows (members too, or only those at `level`), top down. */
const rowIds = (page: Page, level?: 1 | 2) =>
    timeline(page)
        .locator(`[data-history-row]${level ? `[aria-level="${level}"]` : ''}`)
        .evaluateAll((rows) =>
            rows
                .map((row) => ({ id: row.id, top: parseFloat((row as HTMLElement).style.top) }))
                .sort((a, b) => a.top - b.top)
                .map(({ id }) => id),
        )

const peekReady = async (page: Page) => {
    await expect(page.locator('[data-peek-bar]')).toBeVisible()
    await expect
        .poll(() =>
            page.evaluate(async () => {
                const peek =
                    await window.editorTest.appImport<typeof import('../../src/history/peek')>(
                        '/src/history/peek.ts',
                    )
                return (
                    peek.isPeeking.value &&
                    peek.peekedKey.value !== undefined &&
                    peek.displayedPeekKey.value === peek.peekedKey.value &&
                    !peek.peekLoading.value
                )
            }),
        )
        .toBe(true)
}

/** Clicks the row with this id (a real click on its title) and waits until its state is shown. */
const peekId = async (page: Page, id: string) => {
    await page.locator(`[id="${id}"] [data-history-group-action]`).click()
    await peekReady(page)
}

const peekEnded = async (page: Page) => {
    await expect(page.locator('[data-peek-bar]')).toHaveCount(0)
    await expect
        .poll(() =>
            page.evaluate(async () => {
                const peek =
                    await window.editorTest.appImport<typeof import('../../src/history/peek')>(
                        '/src/history/peek.ts',
                    )
                return peek.isPeeking.value
            }),
        )
        .toBe(false)
}

const peekTime = (page: Page) => page.locator('[data-peek-details] span').last().innerText()

const expandGroup = async (page: Page, groupId: string) => {
    await page.locator(`[id="${groupId}"] [data-history-disclosure]`).click()
    await expect(page.locator(`[id="${groupId}"]`)).toHaveAttribute('aria-expanded', 'true')
}

const canvasKey = async (page: Page, key: string) => {
    await page
        .locator('canvas.editor-chart')
        .focus()
        .catch(() => undefined)
    await page.keyboard.press(key)
}

/** Waits until the shown chart equals the digest (polling: queued moves and flushes land later). */
const showsChart = (page: Page, digest: Digest) =>
    expect.poll(() => chartOf(page), { message: 'the shown chart' }).toEqual(digest)
const liveIs = (page: Page, digest: Digest) =>
    expect.poll(() => liveOf(page), { message: 'the live chart' }).toEqual(digest)

const topTitles = (page: Page, count: number) => async () => (await rowTitles(page)).slice(0, count)

// --- What a write holds

/** A level's tap notes in the digest's form (a level's lane is the note's centre, its size half). */
const levelNotes = (level: LevelData) =>
    level.entities
        .filter((entity) => entity.archetype === 'NormalTapNote')
        .map((entity) => {
            const value = (name: string) =>
                entity.data.find((field) => field.name === name)!.value as number
            const size = value('size') * 2
            return { beat: value('#BEAT'), left: value('lane') - size / 2, size }
        })
        .sort((a, b) => a.beat - b.beat || a.left - b.left || a.size - b.size)

type LevelData = {
    bgmOffset: number
    entities: { archetype: string; data: { name: string; value?: unknown }[] }[]
}

const initialLifeOfLevel = (level: LevelData) =>
    level.entities
        .find((entity) => entity.archetype === 'Initialization')!
        .data.find((field) => field.name === 'initialLife')!.value

/** The `level.json` of an OPFS `.nxsp`: its text, as written. */
const levelTextOf = (page: Page, name: string) =>
    page.evaluate(async (name) => {
        const root = await navigator.storage.getDirectory()
        const { ZipReader } =
            (await import('/src/zip/reader.ts')) as typeof import('../../src/zip/reader')
        const file = await (await root.getFileHandle(name)).getFile()
        const reader = await ZipReader.open(file)
        const bytes = await reader.read(reader.get('level.json')!, { maxSize: 4_000_000 })
        return new TextDecoder().decode(bytes)
    }, name)

/** An exported gzipped level data file in OPFS, parsed. */
const exportedLevel = (page: Page, name: string) =>
    page.evaluate(async (name) => {
        const root = await navigator.storage.getDirectory()
        const file = await (await root.getFileHandle(name)).getFile()
        const stream = file.stream().pipeThrough(new DecompressionStream('gzip'))
        return JSON.parse(await new Response(stream).text()) as LevelData
    }, name)

/** The hash of a state's snapshot root, as storage keeps it for an entry (hex). */
const rootOf = (page: Page, which: 'state' | 'liveState') =>
    page.evaluate(async (which) => {
        const { history, appImport } = window.editorTest
        const records = await appImport<typeof import('../../src/local/records/records')>(
            '/src/local/records/records.ts',
        )
        const snapshot = await appImport<typeof import('../../src/local/records/snapshot')>(
            '/src/local/records/snapshot.ts',
        )
        const { toHex } =
            await appImport<typeof import('../../src/local/hash')>('/src/local/hash.ts')
        return toHex(snapshot.encodeSnapshot(records.toRecords(history[which].value)).root.hash)
    }, which)

type StoredEntry = {
    sessionId: string
    seq: number
    kind: string
    noteCount: number
    root: string
}

/** The stored entries (every session), oldest first by seq within a session; roots in hex. */
const storedEntries = (page: Page) =>
    page.evaluate(async () => {
        const stored = await window.nseStorageTest!.worker.call('testRows', ['entries'])
        const hex = (bytes: ArrayLike<number>) =>
            [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
        return stored
            .entries!.map(({ value }) => value as Record<string, unknown>)
            .map((value) => ({
                sessionId: value.sessionId as string,
                seq: value.seq as number,
                kind: value.kind as string,
                noteCount: value.noteCount as number,
                root: hex(value.snapshot as ArrayLike<number>),
            }))
            .sort((a, b) =>
                a.sessionId === b.sessionId
                    ? a.seq - b.seq
                    : a.sessionId.localeCompare(b.sessionId),
            ) satisfies StoredEntry[]
    })

const currentSession = (page: Page) =>
    page.evaluate(async () => {
        const { session } =
            await window.editorTest.appImport<typeof import('../../src/history/session')>(
                '/src/history/session.ts',
            )
        return session.value.sessionId
    })

const opfs = { fileSystemAccess: 'opfs' } as const

/** Many steps by `history.pushState`, for volume only: older rows under what the test then does. */
const addVolume = (page: Page, count: number) =>
    page.evaluate((count) => {
        const { history, historySteps } = window.editorTest
        for (let i = 1; i <= count; i++)
            history.pushState(
                historySteps.futureInitialLife(
                    history.state.value.initialLife,
                    history.state.value.initialLife + 1,
                    `Property ${i}`,
                ),
                {
                    ...history.state.value,
                    initialLife: history.state.value.initialLife + 1,
                },
            )
    }, count)

// --- J1

test('J1: edit, group, peek, Details, Restore, Undo, Redo and reload, all by real input', async ({
    page,
}) => {
    test.slow()
    errorsFail(page)
    await load(page)
    await addVolume(page, 30)

    // 1. Three taps, a drag, and Lane changed three times.
    await placeTap(page, { lane: -3, beat: 4 })
    await placeTap(page, { lane: -1, beat: 5 })
    await placeTap(page, { lane: 1, beat: 6 })
    await dragNote(page, { lane: 2, beat: 6 }, { lane: 4, beat: 7 })
    await selectNote(page, { lane: 4, beat: 7 })
    const lanes = [0, -1, -2]
    const afterLane: Digest[] = []
    for (const value of lanes) {
        await setProperty(page, lane, String(value))
        afterLane.push(await liveOf(page))
    }
    const headBeforeRestore = afterLane[2]!
    expect(afterLane[0]!.notes).not.toEqual(headBeforeRestore.notes)

    // 2. History: the rows, newest first, with the Lane edits as one closed group.
    await openHistory(page)
    await expect
        .poll(topTitles(page, 5))
        .toEqual([now(setLane(-2)), changedLane, movedNotes(1), addedNotes(3), 'Property 30'])
    const [, groupId] = await rowIds(page)
    const group = page.locator(`[id="${groupId!}"]`)
    await expect(group).toHaveAttribute('aria-expanded', 'false')
    await expect(group.locator('[data-history-group-count]')).toHaveText(
        text(english.history.steps, 3),
    )

    // 3. Expanded by its disclosure: the three steps in order, and no count row.
    await expandGroup(page, groupId!)
    await expect
        .poll(topTitles(page, 8))
        .toEqual([
            now(setLane(-2)),
            changedLane,
            setLane(-2),
            setLane(-1),
            setLane(0),
            movedNotes(1),
            addedNotes(3),
            'Property 30',
        ])
    expect(await rowIds(page, 2)).toHaveLength(3)

    // 4. Scrolled with the wheel until the group's row is out of view, a step is focused and Left
    // collapses the group: its row takes focus, in view, and it is the one roving entry.
    const list = timeline(page)
    await list.hover()
    await expect
        .poll(async () => {
            const box = await group.boundingBox()
            const listBox = await list.boundingBox()
            if (box && listBox && box.y + box.height <= listBox.y + 1) return 'gone'
            await page.mouse.wheel(0, 40)
            return 'scrolling'
        })
        .toBe('gone')
    const members = await rowIds(page, 2)
    expect(members).toHaveLength(3)
    await page.locator(`[id="${members[1]!}"]`).focus()
    await expect(page.locator(`[id="${members[1]!}"]`)).toBeFocused()
    await page.keyboard.press('ArrowLeft')
    await expect(group).toHaveAttribute('aria-expanded', 'false')
    await expect(group).toBeFocused()
    await expect
        .poll(async () => {
            const box = await group.boundingBox()
            const listBox = await list.boundingBox()
            return (
                !!box &&
                !!listBox &&
                box.y >= listBox.y - 1 &&
                box.y + box.height <= listBox.y + listBox.height + 1
            )
        })
        .toBe(true)
    await expect(list.locator('[tabindex="0"]')).toHaveCount(1)
    expect(
        await list
            .locator('[tabindex="0"]')
            .evaluate((element) => element.closest('[data-history-row]')?.id),
    ).toBe(groupId)

    // 5. The oldest step, by click: peeking. The live chart does not change.
    await page.keyboard.press('ArrowRight')
    await expect(group).toHaveAttribute('aria-expanded', 'true')
    const oldest = (await rowIds(page, 2)).at(-1)!
    const oldestTime = await timeOfRow(page, oldest)
    await peekId(page, oldest)
    await showsChart(page, afterLane[0]!)
    expect(await liveOf(page)).toEqual(headBeforeRestore)
    await expect(page.locator('[data-history-announcement]')).toContainText(oldestTime)

    // 6. Step Details names the Lane change (the product shows the new value); Escape closes it
    // and focus returns to the date button.
    await page.locator('[data-peek-details]').click()
    const details = page.getByRole('dialog').filter({ hasText: english.history.details.title })
    await expect(details).toBeVisible()
    await expect(details.locator('[data-operation-description]')).toHaveText(setLane(0))
    await expect(
        details.locator('[data-operation-section="properties"] [data-operation-field="left"]'),
    ).toHaveText(new RegExp(`^${lane}[\\s]*0$`))
    await page.keyboard.press('Escape')
    await expect(details).toHaveCount(0)
    await expect(page.locator('[data-peek-details]')).toBeFocused()

    // 7. Restore: the notice, the chart, and a Restore row on top.
    const time = await peekTime(page)
    await restoreFromStrip(page)
    await expect(notice(page, text(english.notice.restoredTo, time))).toBeVisible()
    await showsChart(page, afterLane[0]!)
    await liveIs(page, afterLane[0]!)
    await expect
        .poll(async () => (await rowTitles(page))[1] ?? '')
        .toMatch(new RegExp(`^${restoredPrefix}`))

    // 8. Undo returns to the state before the Restore, Redo to the restored one: the Timeline
    // shows Redo, then Undo, above the Restore.
    await canvasKey(page, 'z')
    await liveIs(page, headBeforeRestore)
    await canvasKey(page, 'y')
    await liveIs(page, afterLane[0]!)
    await list.hover()
    await page.mouse.wheel(0, -3000)
    const topRows = [
        expect.stringMatching(new RegExp(`^${english.history.now} · `)),
        expect.stringMatching(new RegExp(`^${english.commands.redo.title} · ${restoredPrefix}`)),
        expect.stringMatching(new RegExp(`^${english.commands.undo.title} · ${restoredPrefix}`)),
        expect.stringMatching(new RegExp(`^${restoredPrefix}`)),
        changedLane,
    ]
    await expect.poll(topTitles(page, 5)).toEqual(topRows)

    // 9. Stored and reloaded: the same Timeline, the restored chart live, and Undo still reaches
    // the state before the Restore.
    const beforeReload = await topTitles(page, 5)()
    await flush(page)
    await reloadAndWait(page)
    await openHistory(page)
    await expect.poll(topTitles(page, 5)).toEqual(beforeReload)
    await liveIs(page, afterLane[0]!)
    await canvasKey(page, 'z')
    await liveIs(page, headBeforeRestore)
})

// --- J2

/** Presses Export's key with the chart focused and waits for the dialog to place its focus. */
const openExport = async (page: Page) => {
    await page
        .locator('canvas.editor-chart')
        .focus()
        .catch(() => undefined)
    await page.keyboard.press('Shift+P')
    const dialog = page
        .getByRole('dialog')
        .filter({ hasText: english.commands.exportLevel.title.replace('…', '') })
    await expect(dialog).toBeVisible()
    await expect(
        dialog.locator('[data-export-name]:focus, button[type="submit"]:focus'),
    ).toHaveCount(1)
    return dialog
}

test('J2: Save, Export and a reload while peeking write and show the live chart', async ({
    page,
}) => {
    test.slow()
    errorsFail(page)
    await load(page, { platform: opfs })

    // 1. Five taps, saved to j2.nxsp.
    for (let i = 0; i < 5; i++) await placeTap(page, { lane: -4 + i, beat: 4 + i })
    await pressSave(page)
    await submitSave(page, 'j2')
    await expect(notice(page, text(english.save.saved, 'j2.nxsp'))).toBeVisible()

    // 2. Two more taps: seven are live.
    await placeTap(page, { lane: 2, beat: 9 })
    await placeTap(page, { lane: 3, beat: 10 })
    const live = await liveOf(page)
    expect(live.notes).toHaveLength(7)

    // 3. Peek the state of three taps ago (four notes).
    await openHistory(page)
    await expect
        .poll(topTitles(page, 5))
        .toEqual([
            now(addedNotes(1)),
            addedNotes(2),
            text(english.entry.saved, 'j2.nxsp'),
            addedNotes(5),
            operation.importedLevel,
        ])
    const [, , , lower] = await rowIds(page)
    await expandGroup(page, lower!)
    const fourth = (await rowIds(page, 2))[1]!
    await peekId(page, fourth)
    const peeked = await chartOf(page)
    expect(peeked.notes).toHaveLength(4)
    expect(peeked.notes).toEqual(live.notes.slice(0, 4))
    const peekedRoot = await rootOf(page, 'state')
    const liveRoot = await rootOf(page, 'liveState')
    expect(peekedRoot).not.toBe(liveRoot)
    const savedBefore = (await readFile(page, 'j2.nxsp'))!
    const revisionBefore = (await projectOf(page, 'j2.nxsp')).revision as { n: number }

    // 4. Save with the shortcut again, while peeking. The file holds the seven live notes and
    // the live header, and the shown peek is untouched.
    await pressSave(page)
    await expect(notice(page, text(english.notice.savedCurrent, 'j2.nxsp'))).toBeVisible()
    await expect
        .poll(async () => ((await projectOf(page, 'j2.nxsp')).revision as { n: number }).n)
        .toBe(revisionBefore.n + 1)
    const project = await projectOf(page, 'j2.nxsp')
    expect(project.summary).toMatchObject({ noteCount: 7 })
    const saved = JSON.parse(await levelTextOf(page, 'j2.nxsp')) as LevelData
    expect(levelNotes(saved)).toEqual(live.notes)
    expect(levelNotes(saved)).not.toEqual(peeked.notes)
    expect(saved.bgmOffset).toBe(live.offset)
    expect(initialLifeOfLevel(saved)).toBe(live.initialLife)
    expect((await readFile(page, 'j2.nxsp'))!).not.toEqual(savedBefore)
    await expect(page.locator('[data-peek-bar]')).toBeVisible()
    expect(await chartOf(page)).toEqual(peeked)
    expect(await liveOf(page)).toEqual(live)
    // The Save row is at the top of the Timeline.
    await expect
        .poll(async () => (await rowTitles(page))[1])
        .toBe(text(english.entry.saved, 'j2.nxsp'))
    // The stored Save entry is the live state: its root hash and note count.
    await flush(page)
    const session = await currentSession(page)
    const mine = (await storedEntries(page)).filter((entry) => entry.sessionId === session)
    const saves = mine.filter((entry) => entry.kind === 'save')
    expect(saves).toHaveLength(2)
    expect(saves[1]).toMatchObject({ noteCount: 7, root: liveRoot })
    expect(saves[1]!.root).not.toBe(peekedRoot)
    expect(mine.at(-1)).toMatchObject({ kind: 'save', root: liveRoot })

    // 5. Export Level Data while peeking: the exported level is the live chart.
    const dialog = await openExport(page)
    await expect(dialog.getByText(english.peek.exportsCurrent)).toBeVisible()
    await queuePicks(page, ['j2-export'])
    const projectBytes = (await readFile(page, 'j2.nxsp'))!
    await page.keyboard.press('Enter')
    await expect(notice(page, text(english.export.exported, 'j2-export'))).toBeVisible()
    const exported = await exportedLevel(page, 'j2-export')
    expect(levelNotes(exported)).toEqual(live.notes)
    expect(levelNotes(exported)).not.toEqual(peeked.notes)
    expect(exported.bgmOffset).toBe(live.offset)
    expect(initialLifeOfLevel(exported)).toBe(live.initialLife)
    // Export wrote only its own file.
    expect(await readFile(page, 'j2.nxsp')).toEqual(projectBytes)
    await expect(page.locator('[data-peek-bar]')).toBeVisible()
    expect(await chartOf(page)).toEqual(peeked)
    expect(await liveOf(page)).toEqual(live)
    await flush(page)
    expect(
        (await storedEntries(page)).filter((entry) => entry.sessionId === session).at(-1),
    ).toMatchObject({ kind: 'export', root: liveRoot, noteCount: 7 })

    // 6. Reload while peeking: the live head is shown, with no peek.
    await reloadAndWait(page)
    await expect(page.locator('[data-peek-bar]')).toHaveCount(0)
    expect(await liveOf(page)).toEqual(live)
    expect(await chartOf(page)).toEqual(live)
    expect(await rootOf(page, 'state')).toBe(liveRoot)
})

test('J2: a crash while peeking recovers the live chart, never the peeked one', async ({
    playwright,
    browserName,
}, testInfo) => {
    test.skip(browserName !== 'chromium', 'CDP Page.crash is Chromium’s')
    // Two browser starts over one profile on disk.
    test.setTimeout(120_000)
    const directory = await mkdtemp(join(tmpdir(), 'nse-journey-'))
    const { baseURL, launchOptions } = testInfo.project.use
    const launch = () =>
        playwright.chromium.launchPersistentContext(directory, {
            ...(baseURL ? { baseURL } : {}),
            viewport: { width: 1600, height: 1000 },
            ...(launchOptions?.args ? { args: launchOptions.args } : {}),
            ...(launchOptions?.executablePath
                ? { executablePath: launchOptions.executablePath }
                : {}),
        })
    let context = await launch()
    try {
        const page = await context.newPage()
        errorsFail(page)
        await load(page)
        await page.evaluate(() => {
            window.editorTest.history.resetState(false)
        })
        await placeTap(page, { lane: -4, beat: 4 })
        const first = await liveOf(page)
        for (let i = 1; i < 4; i++) await placeTap(page, { lane: -4 + i, beat: 4 + i })
        // What is stored so far; the next edit only the journal will hold.
        await expect
            .poll(() =>
                page.evaluate(async () => {
                    const test = window.nseFlushTest!
                    await test.flusher.flush({ strict: true })
                    return !test.flusher.hasPending
                }),
            )
            .toBe(true)
        await page.evaluate(() => {
            window.nseFlushTest!.stall = true
        })
        await placeTap(page, { lane: 2, beat: 3 })
        const live = await liveOf(page)
        expect(live.notes).toHaveLength(5)
        const liveRoot = await rootOf(page, 'liveState')
        const session = await currentSession(page)

        // Peek the first tap (one note) from its row.
        await openHistory(page)
        await expect
            .poll(topTitles(page, 3))
            .toEqual([now(addedNotes(1)), addedNotes(5), operation.newLevel])
        const [, group] = await rowIds(page)
        await expandGroup(page, group!)
        await peekId(page, (await rowIds(page, 2)).at(-1)!)
        const peeked = await chartOf(page)
        expect(peeked).toEqual(first)
        const peekedRoot = await rootOf(page, 'state')
        expect(peekedRoot).not.toBe(liveRoot)

        // The renderer dies while peeking, after the page was hidden (the journal's write).
        await page.evaluate(() => {
            Object.defineProperty(document, 'visibilityState', {
                value: 'hidden',
                configurable: true,
            })
            document.dispatchEvent(new Event('visibilitychange'))
        })
        const cdp = await context.newCDPSession(page)
        const crashed = page.waitForEvent('crash')
        // The call never answers: the renderer is gone.
        void cdp.send('Page.crash').catch(() => undefined)
        await crashed
        await context.close().catch(() => undefined)
        context = await launch()

        // A new visit: the journal is applied at load, and the session it continues shows the
        // live chart.
        const next = await context.newPage()
        errorsFail(next)
        await load(next, { chart: 'keep' })
        await expect
            .poll(() =>
                next.evaluate(() => window.nseJournalTest?.outcomes.map((o) => o.kind) ?? []),
            )
            .toContain('applied')
        await expect(next.locator('[data-peek-bar]')).toHaveCount(0)
        await liveIs(next, live)
        expect(await chartOf(next)).toEqual(live)
        expect(await rootOf(next, 'liveState')).toBe(liveRoot)
        await flush(next)
        const recovered = (await storedEntries(next)).filter((entry) => entry.sessionId === session)
        expect(recovered.at(-1)).toMatchObject({ kind: 'recovered', root: liveRoot, noteCount: 5 })
        // Only the first tap's own edit entry holds the peeked state; nothing written since.
        expect(
            recovered.filter((entry) => entry.root === peekedRoot).map((entry) => entry.kind),
        ).toEqual(['edit'])
        await openHistory(next)
        await expect
            .poll(async () => (await rowTitles(next))[0])
            .toBe(now(english.entry.recoveredChanges))
        noErrors(next)
    } finally {
        await context.close().catch(() => undefined)
        // Windows can hold the closed browser's files a moment longer.
        await rm(directory, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 200,
        }).catch(() => undefined)
    }
})

// --- J3

const isRestore = (title: string) => title.startsWith(restoredPrefix)

test('J3: Restore chains and "Already matches", saved and reopened', async ({ page, context }) => {
    test.slow()
    errorsFail(page)
    await load(page, { platform: opfs })

    // Three edits that stay three rows: a tap (A), a drag (B) and a Lane change (C).
    await placeTap(page, { lane: -3, beat: 4 })
    const a = await liveOf(page)
    await dragNote(page, { lane: -2, beat: 4 }, { lane: 0, beat: 5 })
    const b = await liveOf(page)
    await selectNote(page, { lane: 0, beat: 5 })
    await setProperty(page, lane, '3')
    const c = await liveOf(page)
    expect(
        new Set([JSON.stringify(a.notes), JSON.stringify(b.notes), JSON.stringify(c.notes)]).size,
    ).toBe(3)
    const [titleA, titleB, titleC] = [addedNotes(1), movedNotes(1), setLane(3)]

    // Restore A from the strip.
    await openHistory(page)
    await expect
        .poll(topTitles(page, 5))
        .toEqual([now(titleC), titleC, titleB, titleA, operation.importedLevel])
    await peekRow(page, titleA)
    expect(await chartOf(page)).toEqual(a)
    await restoreFromStrip(page)
    await showsChart(page, a)
    await liveIs(page, a)

    // Restore B from its row, by Enter.
    await expect
        .poll(async () => (await rowTitles(page))[1])
        .toMatch(new RegExp(`^${restoredPrefix}`))
    await peekRow(page, titleB)
    expect(await chartOf(page)).toEqual(b)
    await page.keyboard.press('Enter')
    await peekEnded(page)
    await liveIs(page, b)
    await expect.poll(async () => (await rowTitles(page)).filter(isRestore)).toHaveLength(2)

    // Undo, Undo, Redo, Redo walk the chain: A, C, A, B.
    await canvasKey(page, 'z')
    await liveIs(page, a)
    await canvasKey(page, 'z')
    await liveIs(page, c)
    await canvasKey(page, 'y')
    await liveIs(page, a)
    await canvasKey(page, 'y')
    await liveIs(page, b)

    // The newest Restore row matches the chart already: a notice, and no entry is added.
    await timeline(page).hover()
    await page.mouse.wheel(0, -3000)
    const restoreRows = async () => {
        const titles = await rowTitles(page)
        const ids = await rowIds(page)
        return ids.filter((_, index) => isRestore(titles[index] ?? ''))
    }
    await expect.poll(async () => (await restoreRows()).length).toBe(2)
    const restoreTitles = (await rowTitles(page)).filter(isRestore)
    expect(restoreTitles).toHaveLength(2)
    const newest = (await restoreRows())[0]!
    await flush(page)
    const seqBefore = await newestSeq(page)
    await peekId(page, newest)
    expect(await chartOf(page)).toEqual(b)
    await page.locator('[data-peek-restore]').click()
    await expect(notice(page, english.notice.alreadyMatches)).toBeVisible()
    await peekEnded(page)
    await flush(page)
    expect(await newestSeq(page)).toBe(seqBefore)
    await liveIs(page, b)

    // Saved, then reopened in a new visit: the same two Restore rows.
    await pressSave(page)
    await submitSave(page, 'j3')
    await expect(notice(page, text(english.save.saved, 'j3.nxsp'))).toBeVisible()
    await flush(page)
    await closePage(page, { runBeforeUnload: false })
    const next = await context.newPage()
    errorsFail(next)
    await load(next, { platform: opfs })
    await queuePicks(next, ['j3.nxsp'])
    await next.keyboard.press('o')
    await expect(notice(next, text(english.history.openedFile, 'j3.nxsp'))).toBeVisible()
    await openHistory(next)
    await expect.poll(async () => (await rowTitles(next)).filter(isRestore)).toEqual(restoreTitles)
    await liveIs(next, b)
    noErrors(next)
})

// --- J4

test('J4: peek and Restore an entry still waiting for its flush', async ({ page }) => {
    test.slow()
    errorsFail(page)
    await load(page)
    const hold = await holdWorker(page, 'flush')
    let middle: Digest
    try {
        await placeTap(page, { lane: -3, beat: 4 })
        await dragNote(page, { lane: -2, beat: 4 }, { lane: 0, beat: 5 })
        middle = await liveOf(page)
        await selectNote(page, { lane: 0, beat: 5 })
        await setProperty(page, lane, '3')
        const last = await liveOf(page)
        expect(last.notes).not.toEqual(middle.notes)
        await hold.reached()
        // Nothing the three edits made is stored: the flush has not run.
        const session = await currentSession(page)
        expect(
            (await storedEntries(page))
                .filter((entry) => entry.sessionId === session && entry.kind !== 'init')
                .map((entry) => entry.kind),
        ).toEqual([])

        // Peek the middle one, then Restore it.
        await openHistory(page)
        await expect
            .poll(topTitles(page, 4))
            .toEqual([now(setLane(3)), setLane(3), movedNotes(1), addedNotes(1)])
        await peekRow(page, movedNotes(1))
        expect(await chartOf(page)).toEqual(middle)
        expect(await liveOf(page)).toEqual(last)
        await restoreFromStrip(page)
        await liveIs(page, middle)
        await expect.poll(async () => (await rowTitles(page)).filter(isRestore).length).toBe(1)
    } finally {
        await release(page)
    }
    await flush(page)
    const session = await currentSession(page)
    const stored = (await storedEntries(page)).filter((entry) => entry.sessionId === session)
    expect(stored.map((entry) => entry.kind)).toEqual(['init', 'edit', 'edit', 'edit', 'restore'])
    expect(new Set(stored.map((entry) => entry.seq)).size).toBe(stored.length)
    expect(stored.at(-1)).toMatchObject({ root: await rootOf(page, 'liveState') })

    // After a reload the Restore row and the chart persist, and no row is repeated.
    await reloadAndWait(page)
    await liveIs(page, middle)
    await openHistory(page)
    await expect
        .poll(topTitles(page, 5))
        .toEqual([
            expect.stringMatching(new RegExp(`^${english.history.now} · ${restoredPrefix}`)),
            expect.stringMatching(new RegExp(`^${restoredPrefix}`)),
            setLane(3),
            movedNotes(1),
            addedNotes(1),
        ])
    const ids = await rowIds(page)
    expect(new Set(ids).size).toBe(ids.length)
    expect((await rowTitles(page)).filter(isRestore)).toHaveLength(1)
})
