import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture, waitForStartup } from './editorFixture'
import { row as historyRow, holdWorker, release } from './historyJourney'

// The change view (Part 1 §1.4.11, §1.4.10.5, Step 5): what a peeked entry changed against the
// entry before it, marked on the chart with the rest dimmed, counted on the peek bar, brought
// into view by the edge arrows and Show Change, never by peeking itself; and Edits Here, the
// Timeline filtered to the entries that changed the beats in view.

const prefix = 'sonolus-next-sekai-editor.'

const runtimeErrors = new WeakMap<Page, string[]>()

test.beforeEach(async ({ page }) => {
    const errors: string[] = []
    runtimeErrors.set(page, errors)
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript((prefix) => {
        localStorage.setItem(`${prefix}showPreview`, 'false')
        localStorage.setItem(`${prefix}showSidebar`, 'false')
        localStorage.setItem('nse.test.storage', '{}')
    }, prefix)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await waitForStartup(page)
    await page.evaluate(installEditorFixture)
})

test.afterEach(({ page }) => {
    expect(runtimeErrors.get(page)).toEqual([])
})

type Change =
    | { kind: 'move'; beats: number[]; lanes?: number }
    | { kind: 'add'; beats: number[]; left?: number }
    | { kind: 'delete'; beats: number[] }
    | { kind: 'bpm'; bpm: number }
    | { kind: 'life' }
    | { kind: 'same' }
    | { kind: 'many'; count: number; from: number }
    | { kind: 'critical'; share: number }

/** Unknown extensions keep geometry fixtures separate; native groups opt in explicitly. */
const edit = (page: Page, label: string, change: Change, known = false) =>
    page.evaluate(
        async ({ label, change, known }) => {
            const { appImport, history, historySteps } = window.editorTest
            const [{ createTransaction }, notes, bpm, { noteObjectOf }, { createSlideId }] =
                await Promise.all([
                    appImport<typeof import('../../src/state/transaction')>(
                        '/src/state/transaction.ts',
                    ),
                    appImport<typeof import('../../src/state/mutations/slides/note')>(
                        '/src/state/mutations/slides/note.ts',
                    ),
                    appImport<typeof import('../../src/state/mutations/bpm')>(
                        '/src/state/mutations/bpm.ts',
                    ),
                    appImport<typeof import('../../src/local/records/extract')>(
                        '/src/local/records/extract.ts',
                    ),
                    appImport<typeof import('../../src/state/entities/slides')>(
                        '/src/state/entities/slides/index.ts',
                    ),
                ])
            const state = history.state.value
            const all = [...state.store.slides.note.values()].flat()
            const template = noteObjectOf(all[0]!)
            const transaction = createTransaction(state)
            let receipt: import('../../src/history/operations').NativeOperationInput = {
                id: 'nse.externalChange',
                data: {},
            }
            const capture = () => {
                const operation = historySteps.nativeOperation(receipt, label)
                return known ? operation : { ...operation, futureFixture: true }
            }
            switch (change.kind) {
                case 'delete':
                    receipt = {
                        id: 'nse.object.delete',
                        data: {
                            removed: {
                                note: all.filter((note) => change.beats.includes(note.beat)).length,
                            },
                        },
                    }
                    for (const note of all.filter((note) => change.beats.includes(note.beat)))
                        notes.removeNote(transaction, note)
                    break
                case 'move':
                    receipt = {
                        id: 'nse.object.move',
                        data: {
                            subject: 'note',
                            changed: {
                                note: all.filter((note) => change.beats.includes(note.beat)).length,
                            },
                        },
                    }
                    for (const note of all.filter((note) => change.beats.includes(note.beat)))
                        notes.replaceNote(transaction, note, {
                            ...noteObjectOf(note),
                            left: note.left + (change.lanes ?? 1),
                        })
                    break
                case 'add':
                    receipt = { id: 'nse.note.add', data: { created: change.beats.length } }
                    for (const beat of change.beats)
                        notes.addNote(transaction, createSlideId(), {
                            ...template,
                            beat,
                            left: change.left ?? -1,
                        })
                    break
                case 'many':
                    receipt = { id: 'nse.note.add', data: { created: change.count } }
                    for (let i = 0; i < change.count; i++)
                        notes.addNote(transaction, createSlideId(), {
                            ...template,
                            beat: change.from + i * 0.5,
                            left: -4 + (i % 8),
                        })
                    break
                case 'critical': {
                    const sorted = all.sort((a, b) => a.beat - b.beat)
                    receipt = {
                        id: 'nse.property.set',
                        data: {
                            subject: 'note',
                            changed: { note: Math.ceil(sorted.length * change.share) },
                            assignments: [
                                {
                                    field: 'isCritical',
                                    before: { mode: 'varying' },
                                    after: { mode: 'varying' },
                                },
                            ],
                        },
                    }
                    for (const note of sorted.slice(0, Math.ceil(sorted.length * change.share)))
                        notes.replaceNote(transaction, note, {
                            ...noteObjectOf(note),
                            isCritical: !note.isCritical,
                        })
                    break
                }
                case 'bpm': {
                    receipt = {
                        id: 'nse.object.edit',
                        data: { subject: 'bpm', changed: { bpm: 1 } },
                    }
                    const first = [...state.store.grid.bpm.values()].flatMap((b) => [...b])[0]!
                    bpm.replaceBpm(transaction, first, { beat: 0, bpm: change.bpm, meter: 4 })
                    break
                }
                case 'life':
                    receipt = {
                        id: 'nse.header.set',
                        data: {
                            field: 'initialLife',
                            before: state.initialLife,
                            after: state.initialLife + 1,
                        },
                    }
                    history.pushState(capture(), { ...state, initialLife: state.initialLife + 1 })
                    return
                case 'same':
                    // An edit that changes nothing is no step (owner, 2026-10-19), and Restore always is,
                    // so this is how an entry that changed nothing still reaches the Timeline. Stored
                    // histories from before the rule hold such entries too.
                    history.pushState(capture(), { ...state }, 'restore')
                    return
            }
            history.pushState(capture(), transaction.commit([]))
        },
        { label, change, known },
    )

/** Stores what the tab holds, so the Timeline reads it. */
const stored = (page: Page) =>
    page.evaluate(async () => {
        await window.nseFlushTest!.flusher.flush({ strict: true })
    })

/** The change view's state, as the page holds it. */
const changes = (page: Page) =>
    page.evaluate(async () => {
        const module = await window.editorTest.appImport<
            typeof import('../../src/editor/history/changes')
        >('/src/editor/history/changes.ts')
        const { view } = window.editorTest
        return {
            line: module.changeLine.value,
            layout: module.shownChange.value?.set.layout,
            objects: module.shownChange.value?.set.objects.length,
            rings: module.changeMarks.value?.rings.length,
            ghosts: module.changeMarks.value?.ghosts.length,
            dimmed: !!module.undimmed.value,
            off: module.offBand.value,
            band: module.changeBand.value,
            time: view.time,
        }
    })

const surface = (page: Page) => page.locator('[data-history-surface="panel"]')
const list = (page: Page) => surface(page).locator('[data-history-list]')
const row = (page: Page, title: string) => historyRow(page, title, 'panel')
const peekLine = (page: Page) => page.locator('[data-peek-change]')
const arrow = (page: Page, direction: 'up' | 'down') =>
    page.locator(`[data-change-arrow="${direction}"]`)

/** Two animation frames: whatever a change queued for the next draw has been drawn. */
const frames = (page: Page) =>
    page.evaluate(
        () =>
            new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
    )

/** How the peek's comparison stands: 'loading', 'known', 'initial' or 'unavailable'. */
const comparison = (page: Page) =>
    page.evaluate(async () => {
        const { comparisonStatus } = await window.editorTest.appImport<
            typeof import('../../src/editor/history/changes')
        >('/src/editor/history/changes.ts')
        return comparisonStatus.value
    })

const openTab = async (page: Page) => {
    await page
        .locator('[data-workspace-dock="right"]')
        .getByRole('tab', { name: 'History' })
        .click()
    await expect(surface(page)).toBeVisible()
}

/** Puts a beat at the pane's middle; the fixture's tempo is 120 BPM. */
const viewAt = (page: Page, beat: number) =>
    page.evaluate((beat) => {
        const { view } = window.editorTest
        view.scrollingY = undefined
        view.time = beat / 2
    }, beat)

const centreBeat = (page: Page) =>
    page.evaluate(async () => {
        const { appImport, history, view } = window.editorTest
        const { timeToBeat } = await appImport<typeof import('../../src/state/integrals/bpms')>(
            '/src/state/integrals/bpms.ts',
        )
        return timeToBeat(history.state.value.bpms, view.time)
    })

const runCommand = (page: Page, name: string) =>
    page.evaluate(async (name) => {
        const { appImport } = window.editorTest
        const [{ commands }, { runCommand }] = await Promise.all([
            appImport<typeof import('../../src/editor/commands')>('/src/editor/commands/index.ts'),
            appImport<typeof import('../../src/editor/commands/runCommand')>(
                '/src/editor/commands/runCommand.ts',
            ),
        ])
        await runCommand(commands[name as keyof typeof commands])
    }, name)

test('peeking marks what the entry changed and dims the rest, without scrolling', async ({
    page,
}) => {
    await edit(page, 'Moved 1 note', { kind: 'move', beats: [5] })
    await stored(page)
    const before = (await changes(page)).time
    await openTab(page)
    await row(page, 'Moved 1 note').click()
    await expect(peekLine(page)).toHaveText('1 change')
    const shown = await changes(page)
    expect(shown).toMatchObject({ layout: 'small', rings: 1, ghosts: 1, dimmed: true })
    // Peek never moves the chart.
    expect(shown.time).toBe(before)
    // An orange ring beside the moved note.
    const point = await page.evaluate(() => {
        const note = [...window.editorTest.history.state.value.store.slides.note.values()]
            .flat()
            .find((note) => note.beat === 5)!
        return window.editorTest.point(note.left + note.size, 5)
    })
    // The marks are in state before the canvas draws them, and a loaded frame loop draws them
    // late: look again until a frame shows the ring.
    await expect
        .poll(async () => {
            const shot = await page.screenshot({
                clip: { x: point.x - 30, y: point.y - 30, width: 60, height: 60 },
            })
            return page.evaluate(
                async (data) => {
                    const image = await createImageBitmap(new Blob([new Uint8Array(data)]))
                    const canvas = new OffscreenCanvas(image.width, image.height)
                    const context = canvas.getContext('2d')!
                    context.drawImage(image, 0, 0)
                    const pixels = context.getImageData(0, 0, image.width, image.height).data
                    let count = 0
                    for (let i = 0; i < pixels.length; i += 4)
                        if (
                            Math.abs(pixels[i]! - 255) < 30 &&
                            Math.abs(pixels[i + 1]! - 155) < 40 &&
                            Math.abs(pixels[i + 2]! - 66) < 50
                        )
                            count++
                    return count
                },
                [...shot],
            )
        })
        .toBeGreaterThan(10)
})

test('the bar counts the change; the arrows bring changes off screen into view', async ({
    page,
}) => {
    await edit(page, 'Added 2 notes', { kind: 'add', beats: [40, 41] })
    await stored(page)
    await viewAt(page, 6)
    await openTab(page)
    await row(page, 'Added 2 notes').click()
    await expect(peekLine(page)).toHaveText('2 changes')
    await expect(arrow(page, 'up')).toHaveAttribute('data-count', '2')
    await expect(arrow(page, 'up')).toHaveAccessibleName('Changes Above: 2')
    await expect(arrow(page, 'down')).toHaveAttribute('aria-disabled', 'true')
    await arrow(page, 'up').click()
    await expect.poll(async () => Math.round(await centreBeat(page))).toBeGreaterThan(38)
    await expect(arrow(page, 'up')).toHaveAttribute('aria-disabled', 'true')
})

test('Show Change steps through the changes in chart order and wraps', async ({ page }) => {
    await edit(page, 'Added 2 notes', { kind: 'add', beats: [40, 120] })
    await stored(page)
    await viewAt(page, 6)
    await openTab(page)
    await row(page, 'Added 2 notes').click()
    await expect(peekLine(page)).toHaveText('2 changes')
    const step = async () => {
        await runCommand(page, 'showChange')
        // A near stop eases for a quarter second of rendered frames, and the next step reads
        // where the view ends: wait for the ease to finish, not a fixed time a loaded frame
        // loop can overrun.
        await expect.poll(() => page.evaluate(() => !window.editorTest.view.scrollingY)).toBe(true)
        return Math.round(await centreBeat(page))
    }
    expect(Math.abs((await step()) - 40)).toBeLessThan(3)
    expect(Math.abs((await step()) - 120)).toBeLessThan(3)
    expect(Math.abs((await step()) - 40)).toBeLessThan(3)
    // Back to Now: nothing to show, and nothing moves.
    await page.locator('[data-peek-back]').click()
    const time = (await changes(page)).time
    await runCommand(page, 'showChange')
    expect((await changes(page)).time).toBe(time)
})

test('the row menu’s Show Change peeks the row and brings its change into view', async ({
    page,
}) => {
    await edit(page, 'Added 1 note', { kind: 'add', beats: [60] })
    await stored(page)
    await viewAt(page, 6)
    await openTab(page)
    await row(page, 'Added 1 note').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Show Change' }).click()
    await expect(peekLine(page)).toHaveText('1 change')
    await expect
        .poll(async () => {
            const module = await page.evaluate(async () =>
                (
                    await window.editorTest.appImport<
                        typeof import('../../src/editor/history/changes')
                    >('/src/editor/history/changes.ts')
                ).bandTimes(),
            )
            return Math.round(module.top + module.bottom)
        })
        .toBe(60)
})

test('a header-only change dims nothing; an entry that changed nothing says so', async ({
    page,
}) => {
    await edit(page, 'Set Initial Life to 1,001', { kind: 'life' })
    await edit(page, 'Selected', { kind: 'same' })
    await stored(page)
    await openTab(page)
    await row(page, 'Selected').click()
    await expect(peekLine(page)).toHaveText('No changes')
    expect((await changes(page)).dimmed).toBe(false)
    // On a wide pane the label is on the bar's first line already.
    await row(page, 'Set Initial Life to 1,001').click()
    await expect(peekLine(page)).toHaveText('Set Initial Life to 1,001')
    expect((await changes(page)).dimmed).toBe(false)
    // A narrow one shows the time alone, and the label under it.
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(peekLine(page)).toHaveText('Set Initial Life to 1,001')
})

test('a Restore’s change is against the state just before it', async ({ page }) => {
    await edit(page, 'Moved A', { kind: 'move', beats: [5] })
    await edit(page, 'Moved B', { kind: 'move', beats: [7] })
    await stored(page)
    await openTab(page)
    await row(page, 'Moved A').click()
    await page.locator('[data-peek-restore]').click()
    await stored(page)
    await row(page, 'Moved A').click()
    const restoreRow = list(page)
        .getByRole('row')
        .filter({ hasText: /^Restored to/ })
    await restoreRow.click()
    await expect(peekLine(page)).toHaveText('1 change')
    const objects = await page.evaluate(async () => {
        const { shownChange } = await window.editorTest.appImport<
            typeof import('../../src/editor/history/changes')
        >('/src/editor/history/changes.ts')
        return shownChange.value?.set.objects.map((object) => object.beat)
    })
    expect(objects).toEqual([7])
})

test('past 150 objects the bar counts by kind; most of the chart is told in words', async ({
    page,
}) => {
    await edit(page, 'Pasted 400 notes', { kind: 'many', count: 400, from: 300 })
    await edit(page, 'Pasted 200 notes', { kind: 'many', count: 200, from: 20 })
    await edit(page, 'Set Critical', { kind: 'critical', share: 0.9 })
    await stored(page)
    await viewAt(page, 0)
    await openTab(page)
    await row(page, 'Pasted 200 notes').click()
    await expect(peekLine(page)).toHaveText('Changed 200 notes')
    await expect(arrow(page, 'up')).toHaveAccessibleName('Changes Above')
    await expect(arrow(page, 'up')).not.toHaveAttribute('data-count')
    await row(page, 'Set Critical').click()
    await expect(peekLine(page)).toHaveText('Added 544 · Removed 544')
    const state = await changes(page)
    expect(state).toMatchObject({ layout: 'most', dimmed: true, rings: 544, ghosts: 544 })
    expect(state.rings).toBe(544)
    await expect(arrow(page, 'up')).toHaveAttribute('aria-disabled', 'false')
})

test('an entry whose previous state cannot be read shows its label alone, with no notice', async ({
    page,
}) => {
    await edit(page, 'Moved 1 note', { kind: 'move', beats: [5] })
    await stored(page)
    await page.evaluate(async () => {
        const { appImport } = window.editorTest
        const [{ requestPeek, keyOf }, { flusher }] = await Promise.all([
            appImport<typeof import('../../src/editor/history/selection')>(
                '/src/editor/history/selection.ts',
            ),
            appImport<typeof import('../../src/local/storing')>('/src/local/storing.ts'),
        ])
        const session = flusher!.session!
        const seq = flusher!.newestSeq(session)
        const { storageWorker } =
            await appImport<typeof import('../../src/local/start')>('/src/local/start.ts')
        const entry = await storageWorker!.call('readEntry', { sessionId: session.id, seq })
        const metadata = (
            await storageWorker!.call('readTimeline', {
                sessionId: session.id,
                before: seq + 1,
                limit: 1,
            })
        ).entries[0]!
        requestPeek({
            key: keyOf({ sessionId: session.id, seq }),
            time: entry!.time,
            recipe: (
                await appImport<typeof import('../../src/history/operationPresentation')>(
                    '/src/history/operationPresentation/index.ts',
                )
            ).captureOperationRecipe([{ description: metadata }]),
            snapshot: entry!.snapshot,
            // A previous state whose root is gone.
            previous: {
                key: keyOf({ sessionId: session.id, seq: seq - 1 }),
                snapshot: '0'.repeat(32),
            },
        })
    })
    await expect(page.locator('[data-peek-text]')).toBeVisible()
    // The comparison has ended: nothing is left to arrive after the checks below.
    await expect.poll(() => comparison(page)).toBe('unavailable')
    await frames(page)
    await expect(peekLine(page)).toHaveText('Changes unavailable')
    await expect(page.locator('.notification')).toHaveCount(0)
    expect((await changes(page)).dimmed).toBe(false)
})

test('Edits Here from Go To lists the entries that changed the beats in view', async ({ page }) => {
    await edit(page, 'Moved near', { kind: 'move', beats: [5] })
    await edit(page, 'Added far', { kind: 'add', beats: [200] })
    await edit(page, 'Moved near again', { kind: 'move', beats: [7] })
    await stored(page)
    await viewAt(page, 6)
    await openTab(page)
    await surface(page).locator('[data-history-goto-button]').click()
    const here = page.getByRole('radio', { name: 'Edits Here' })
    await expect(page.locator('[data-goto-here-range]')).toHaveText(/ – /)
    await here.click()
    await page.keyboard.press('Escape')
    await expect(surface(page).locator('[data-history-filter-banner]')).toContainText(
        'Edits Here · ',
    )
    await expect(row(page, 'Moved near')).toBeVisible()
    await expect(row(page, 'Moved near again')).toBeVisible()
    await expect(row(page, 'Added far')).toHaveCount(0)
    await expect(surface(page).locator('[data-history-scan]')).toHaveCount(0)
    // The bracket is drawn while filtering; a new entry here joins at the top.
    await edit(page, 'Moved near once more', { kind: 'move', beats: [3] })
    await stored(page)
    await expect(row(page, 'Moved near once more')).toBeVisible({ timeout: 10_000 })
    await surface(page).getByRole('button', { name: 'Show All' }).click()
    await expect(row(page, 'Added far')).toBeVisible()
})

test('Find Edits Here from the chart’s menu, and No edits here', async ({ page }) => {
    await edit(page, 'Moved near', { kind: 'move', beats: [5] })
    await stored(page)
    await viewAt(page, 6)
    const canvas = page.locator('canvas.editor-chart')
    const box = (await canvas.boundingBox())!
    await page.mouse.click(box.x + 40, box.y + box.height / 2, { button: 'right' })
    await page.getByRole('menuitem', { name: 'Find Edits Here' }).click()
    await expect(surface(page)).toBeVisible()
    await expect(row(page, 'Moved near')).toBeVisible()
    // Far from any edit: nothing.
    await viewAt(page, 400)
    await page.mouse.click(box.x + 40, box.y + box.height / 2, { button: 'right' })
    await page.getByRole('menuitem', { name: 'Find Edits Here' }).click()
    await expect(surface(page).locator('[data-history-empty]')).toHaveText('No edits here')
})

test('the History sheet counts as covering the chart', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await edit(page, 'Added 1 note', { kind: 'add', beats: [4] })
    await stored(page)
    await page.evaluate(async () => {
        const { openHistoryDialog } = await window.editorTest.appImport<
            typeof import('../../src/editor/history/openHistory')
        >('/src/editor/history/openHistory.ts')
        void openHistoryDialog('timeline')
    })
    const sheet = page.locator('[data-tool-dialog][data-sheet]')
    await expect(sheet).toBeVisible()
    await sheet
        .getByRole('row')
        .and(page.locator(':not(.timeline-now)'))
        .filter({ has: page.getByText('Added 1 note', { exact: true }) })
        .click()
    await expect(peekLine(page)).toHaveText('1 change')
    const size = await page.evaluate(async () => {
        const { sheetBox } = await window.editorTest.appImport<
            typeof import('../../src/editor/toolModals')
        >('/src/editor/toolModals.ts')
        return sheetBox.value
    })
    expect(size?.side).toBe('bottom')
    expect((await changes(page)).band.bottom).toBeGreaterThanOrEqual(size!.size)
})

test('arrowing keeps the dim and holds the beat across a tempo change', async ({ page }) => {
    await edit(page, 'Moved A', { kind: 'move', beats: [5] })
    await edit(page, 'Faster', { kind: 'bpm', bpm: 240 })
    await edit(page, 'Moved B', { kind: 'move', beats: [7] })
    await stored(page)
    await openTab(page)
    await row(page, 'Moved B').click()
    await expect(peekLine(page)).toHaveText('1 change')
    await viewAt(page, 6)
    const beat = await centreBeat(page)
    // Record whether the dim ever lifts in a frame between steps.
    await page.evaluate(async () => {
        const { undimmed } = await window.editorTest.appImport<
            typeof import('../../src/editor/history/changes')
        >('/src/editor/history/changes.ts')
        const record = window as unknown as { dimLifted: boolean }
        record.dimLifted = false
        const check = () => {
            if (!undimmed.value) record.dimLifted = true
            requestAnimationFrame(check)
        }
        requestAnimationFrame(check)
    })
    await list(page).press('ArrowDown')
    await expect(page.locator('[data-peek-text]')).toHaveAttribute('title', 'Faster')
    // The tempo differs: the beat in the middle stays.
    expect(Math.abs((await centreBeat(page)) - beat)).toBeLessThan(1e-6)
    await list(page).press('ArrowDown')
    await expect(page.locator('[data-peek-text]')).toHaveAttribute('title', 'Moved A')
    await expect(peekLine(page)).toHaveText('1 change')
    expect(Math.abs((await centreBeat(page)) - beat)).toBeLessThan(1e-6)
    expect(await page.evaluate(() => (window as unknown as { dimLifted: boolean }).dimLifted)).toBe(
        false,
    )
})

test('Show Edits default off leaves the chart undimmed and unmarked', async ({ page }) => {
    await edit(page, 'Moved 1 note', { kind: 'move', beats: [5] })
    await stored(page)
    await page.evaluate(() => {
        window.editorTest.settings.dimUnchangedObjects = false
    })
    await openTab(page)
    await row(page, 'Moved 1 note').click()
    await expect(peekLine(page)).toHaveText('1 change')
    expect(await changes(page)).toMatchObject({
        rings: undefined,
        ghosts: undefined,
        dimmed: false,
    })
})

test('a notice card stays clear of the adjacent spatial controls', async ({ page }) => {
    await edit(page, 'Added 2 notes', { kind: 'add', beats: [2, 3] })
    await stored(page)
    await viewAt(page, 60)
    await openTab(page)
    await row(page, 'Added 2 notes').click()
    await expect(arrow(page, 'down')).toBeVisible()
    await page.evaluate(async () => {
        const { notify } = await window.editorTest.appImport<
            typeof import('../../src/editor/notification')
        >('/src/editor/notification.ts')
        notify(() => 'Nothing to undo', { action: { label: () => 'Open History', run: () => {} } })
    })
    const card = page.locator('[data-notice-card]')
    await expect(card).toBeVisible()
    await expect(async () => {
        const [cardBox, arrowBox] = await Promise.all([
            card.boundingBox(),
            arrow(page, 'down').boundingBox(),
        ])
        expect(cardBox!.y).toBeGreaterThanOrEqual(arrowBox!.y + arrowBox!.height)
    }).toPass()
})

test('equal-count action groups retain exact group, child and Restore scopes', async ({
    page,
}, testInfo) => {
    for (const beat of [40, 50])
        await edit(page, 'Added 1 note', { kind: 'add', beats: [beat] }, true)
    for (const beat of [40, 50])
        await edit(page, 'Moved 1 note', { kind: 'move', beats: [beat] }, true)
    for (const beat of [40, 50])
        await edit(page, 'Deleted 1 note', { kind: 'delete', beats: [beat] }, true)
    await stored(page)
    await page.evaluate(() => {
        window.editorTest.settings.rightDockWidth = 440
    })
    await openTab(page)
    await expect
        .poll(() => list(page).evaluate((element) => element.clientWidth))
        .toBeGreaterThanOrEqual(340)
    // The list loads from storage after the panel opens: read the scopes once all are in.
    const readScopes = () =>
        page.evaluate(async () => {
            const { listedEntries } = await window.editorTest.appImport<
                typeof import('../../src/editor/history/source')
            >('/src/editor/history/source.ts')
            return listedEntries.value
                .slice(0, 7)
                .map(({ sessionId, seq }) => `${sessionId}:${seq}`)
        })
    await expect.poll(async () => (await readScopes()).length).toBe(7)
    const scopes = await readScopes()
    const actions = ['Deleted 2 notes', 'Moved notes', 'Added 2 notes']
    for (const [index, action] of actions.entries()) {
        const group = row(page, action).filter({ has: page.locator('[data-history-group-header]') })
        await expect(group.locator('[data-history-group-count]')).toHaveText('2 steps')
        if (index !== 1) {
            await expect(group.locator('.timeline-count')).toHaveText(index === 0 ? '−2' : '+2')
            await expect(group.locator('.timeline-count')).toBeVisible()
        } else await expect(group.locator('.timeline-count')).toHaveCount(0)
        await expect(group).toHaveAttribute('aria-label', new RegExp(`${action} · 2 steps`))
    }
    await page.screenshot({
        path: testInfo.outputPath('440-wide-action-deltas.png'),
        animations: 'disabled',
    })
    for (const [index, action] of actions.entries()) {
        const group = row(page, action).filter({ has: page.locator('[data-history-group-header]') })
        await group.click()
        await expect(peekLine(page)).toHaveText('2 changes')
        expect(
            await page.evaluate(async () => {
                const { peekedInfo, peekedLabel } = await window.editorTest.appImport<
                    typeof import('../../src/editor/history/selection')
                >('/src/editor/history/selection.ts')
                const { historyCalendar } = await window.editorTest.appImport<
                    typeof import('../../src/editor/history/calendarClock')
                >('/src/editor/history/calendarClock.ts')
                const { historyOperationContext } = await window.editorTest.appImport<
                    typeof import('../../src/editor/history/historyOperationContext')
                >('/src/editor/history/historyOperationContext.ts')
                const info = peekedInfo.value!
                return {
                    key: info.key,
                    oldest: info.oldest,
                    previous: info.previous?.key,
                    label: peekedLabel(info, historyOperationContext(historyCalendar())),
                }
            }),
        ).toEqual({
            key: scopes[index * 2],
            oldest: scopes[index * 2 + 1],
            previous: scopes[index * 2 + 2],
            label: `${action} · 2 steps`,
        })
    }
    const added = row(page, 'Added 2 notes').filter({
        has: page.locator('[data-history-group-header]'),
    })
    await added.locator('[data-history-disclosure]').click()
    const children = row(page, 'Added 1 note').filter({
        hasNot: page.locator('[data-history-group-header]'),
    })
    await children.first().click()
    await expect(peekLine(page)).toHaveText('1 change')
    await children.last().click()
    await expect(peekLine(page)).toHaveText('1 change')
    await added.locator('[data-history-disclosure]').click()
    await expect(added).toHaveAttribute('aria-selected', 'true')
    await expect(peekLine(page)).toHaveText('2 changes')
    await added.locator('[data-history-disclosure]').click()
    await children.last().click()
    await page.locator('[data-peek-restore]').click()
    expect(
        await page.evaluate(() =>
            [...window.editorTest.history.state.value.store.slides.note.values()]
                .flat()
                .filter(({ beat }) => beat === 40 || beat === 50)
                .map(({ beat }) => beat),
        ),
    ).toEqual([40])
})

test('group disclosure preserves scope and selecting its newest child changes the baseline', async ({
    page,
}) => {
    for (const beat of [40, 50, 60])
        await edit(page, 'Added 1 note', { kind: 'add', beats: [beat] }, true)
    await stored(page)
    await openTab(page)
    const group = row(page, 'Added 3 notes')
    await group.click()
    await expect(peekLine(page)).toHaveText('3 changes')
    await group.locator('[data-history-disclosure]').click()
    await expect(group).toHaveAttribute('aria-selected', 'true')
    await expect(peekLine(page)).toHaveText('3 changes')
    const child = row(page, 'Added 1 note')
        .filter({ hasNot: page.locator('[data-history-group-header]') })
        .first()
    await child.click()
    await expect(peekLine(page)).toHaveText('1 change')
    await group.locator('[data-history-disclosure]').click()
    await expect(group).toHaveAttribute('aria-selected', 'true')
    await expect(peekLine(page)).toHaveText('3 changes')
})

test('a delayed group Show Change cannot scroll a child comparison with the same target', async ({
    page,
}) => {
    for (const beat of [40, 60]) await edit(page, 'Add', { kind: 'add', beats: [beat] }, true)
    await stored(page)
    await openTab(page)
    await viewAt(page, 6)
    await page.evaluate(async () => {
        const { storageWorker } =
            await window.editorTest.appImport<typeof import('../../src/local/start')>(
                '/src/local/start.ts',
            )
        const gates: (() => Promise<void>)[] = []
        ;(window as unknown as { diffGates: (() => Promise<void>)[] }).diffGates = gates
        storageWorker!.call = new Proxy(storageWorker!.call, {
            apply(target, self, args) {
                if (args[0] !== 'readChanges') return Reflect.apply(target, self, args)
                return new Promise((resolve, reject) => {
                    // A gate lets the read go and returns when it has answered.
                    gates.push(() =>
                        Promise.resolve(Reflect.apply(target, self, args)).then(
                            (value) => resolve(value),
                            (error: unknown) => reject(error),
                        ),
                    )
                })
            },
        })
    })
    const group = row(page, 'Added 2 notes')
    await group.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Show Change' }).click()
    await expect
        .poll(() =>
            page.evaluate(() => (window as unknown as { diffGates: unknown[] }).diffGates.length),
        )
        .toBe(1)
    const bounds = await page.locator('[data-peek-main]').boundingBox()
    const lower = await page.locator('[data-peek-navigation]').boundingBox()
    await group.locator('[data-history-disclosure]').click()
    await row(page, 'Added 1 note')
        .filter({ hasNot: page.locator('[data-history-group-header]') })
        .first()
        .click()
    await expect
        .poll(() =>
            page.evaluate(() => (window as unknown as { diffGates: unknown[] }).diffGates.length),
        )
        .toBe(2)
    await page.evaluate(() => (window as unknown as { diffGates: (() => void)[] }).diffGates[1]!())
    await expect(peekLine(page)).toHaveText('1 change')
    // The stale read answers; its result reaches the comparison and is dropped there.
    await page.evaluate(async () => {
        await (window as unknown as { diffGates: (() => Promise<void>)[] }).diffGates[0]!()
    })
    await frames(page)
    await expect(peekLine(page)).toHaveText('1 change')
    expect((await changes(page)).time).toBe(3)
    expect(await page.locator('[data-peek-main]').boundingBox()).toEqual(bounds)
    expect(await page.locator('[data-peek-navigation]').boundingBox()).toEqual(lower)
})

test('a group at a page boundary reads the predecessor of its oldest member', async ({ page }) => {
    for (const beat of [40, 50, 60]) await edit(page, 'Add', { kind: 'add', beats: [beat] }, true)
    await stored(page)
    await openTab(page)
    await row(page, 'Added 3 notes').click()
    await expect(peekLine(page)).toHaveText('3 changes')
    await page.evaluate(async () => {
        const { requestPeek, peekedInfo } = await window.editorTest.appImport<
            typeof import('../../src/editor/history/selection')
        >('/src/editor/history/selection.ts')
        requestPeek({ ...peekedInfo.value!, previous: undefined })
    })
    await expect(peekLine(page)).toHaveText('3 changes')
})

test('an arrow keeps focus after its last target enters the visible band, and a covered chart cannot navigate', async ({
    page,
}) => {
    await edit(page, 'Add far', { kind: 'add', beats: [40] })
    await stored(page)
    await openTab(page)
    await row(page, 'Add far').click()
    await expect(arrow(page, 'up')).toHaveAttribute('aria-disabled', 'false')
    await arrow(page, 'up').focus()
    await page.keyboard.press('Enter')
    await expect(arrow(page, 'up')).toHaveAttribute('aria-disabled', 'true')
    await expect(arrow(page, 'up')).toBeFocused()
    const time = (await changes(page)).time
    await page.keyboard.press('Space')
    expect((await changes(page)).time).toBe(time)
    await page.evaluate(async () => {
        const { changeBand } = await window.editorTest.appImport<
            typeof import('../../src/editor/history/changes')
        >('/src/editor/history/changes.ts')
        changeBand.value = { top: window.editorTest.view.h, bottom: 1 }
    })
    await expect(arrow(page, 'down')).toHaveAttribute('aria-disabled', 'true')
    await expect(arrow(page, 'up')).toHaveAttribute('aria-disabled', 'true')
})

test('net-zero runs retain their real steps and show an equal comparison', async ({ page }) => {
    await edit(page, 'Adjust', { kind: 'life' }, true)
    await page.evaluate(() => {
        const { history } = window.editorTest
        history.pushState(
            window.editorTest.historySteps.initialLife(
                history.state.value.initialLife,
                history.state.value.initialLife - 1,
            ),
            {
                ...history.state.value,
                initialLife: history.state.value.initialLife - 1,
            },
        )
    })
    await stored(page)
    await openTab(page)
    const group = row(page, 'Changed Initial Life')
    await group.click()
    await expect(peekLine(page)).toHaveText('No changes')
    expect((await changes(page)).dimmed).toBe(false)
    await group.locator('[data-history-disclosure]').click()
    await expect(
        list(page)
            .getByRole('row')
            .filter({ hasText: /^Set Initial Life/ }),
    ).toHaveCount(2)
    await list(page)
        .getByRole('row')
        .filter({ hasText: /^Set Initial Life/ })
        .filter({ hasNot: page.locator('[data-history-group-header]') })
        .first()
        .click()
    await expect(peekLine(page)).toHaveText(/^Set Initial Life/)
})

test('both footprints of a moved object remain reachable on opposite sides of the clear band', async ({
    page,
}) => {
    await page.evaluate(async () => {
        const { history, appImport, settings, view } = window.editorTest
        const [{ createTransaction }, { replaceNote }, { noteObjectOf }] = await Promise.all([
            appImport<typeof import('../../src/state/transaction')>('/src/state/transaction.ts'),
            appImport<typeof import('../../src/state/mutations/slides/note')>(
                '/src/state/mutations/slides/note.ts',
            ),
            appImport<typeof import('../../src/local/records/extract')>(
                '/src/local/records/extract.ts',
            ),
        ])
        const transaction = createTransaction(history.state.value)
        const note = [...history.state.value.store.slides.note.values()]
            .flat()
            .find((note) => note.beat === 5)!
        replaceNote(transaction, note, { ...noteObjectOf(note), beat: 11 })
        const futureMove = {
            ...window.editorTest.historySteps.nativeOperation(
                { id: 'nse.object.move', data: { subject: 'note', changed: { note: 1 } } },
                'Moved across view',
            ),
            futureFixture: true,
        }
        history.pushState(futureMove, transaction.commit([]))
        settings.pps = 400
        view.time = 4
    })
    await stored(page)
    await openTab(page)
    await row(page, 'Moved across view').click()
    await expect(peekLine(page)).toHaveText('1 change')
    await expect(arrow(page, 'up')).toHaveAttribute('data-count', '1')
    await expect(arrow(page, 'down')).toHaveAttribute('data-count', '1')
    await arrow(page, 'down').click()
    await expect(arrow(page, 'down')).toHaveAttribute('aria-disabled', 'true')
    await expect(arrow(page, 'up')).toHaveAttribute('aria-disabled', 'false')
})

test('a selected edge singleton stays separate when an older matching page arrives', async ({
    page,
}) => {
    for (const beat of [40, 50, 60]) await edit(page, 'Add', { kind: 'add', beats: [beat] }, true)
    await stored(page)
    await page.evaluate(async () => {
        const { storageWorker } =
            await window.editorTest.appImport<typeof import('../../src/local/start')>(
                '/src/local/start.ts',
            )
        let first = true
        storageWorker!.call = new Proxy(storageWorker!.call, {
            apply(target, self, args) {
                if (args[0] !== 'readTimeline' || (args[1] as { limit: number }).limit !== 100)
                    return Reflect.apply(target, self, args)
                if (first) {
                    first = false
                    return Promise.resolve(Reflect.apply(target, self, args)).then(
                        (
                            result: import('../../src/local/worker/timelineHandlers').TimelinePage,
                        ) => {
                            const entry = result.entries[0]!
                            return {
                                entries: [entry],
                                next: { sessionId: entry.sessionId, before: entry.seq },
                            }
                        },
                    )
                }
                return new Promise((resolve, reject) => {
                    ;(window as unknown as { releasePage: () => void }).releasePage = () => {
                        Promise.resolve(Reflect.apply(target, self, args)).then(resolve, reject)
                    }
                })
            },
        })
    })
    await openTab(page)
    await row(page, 'Added 1 note').click()
    await expect(peekLine(page)).toHaveText('1 change')
    await page.evaluate(() => (window as unknown as { releasePage: () => void }).releasePage())
    await expect(row(page, 'Added 2 notes')).toHaveCount(1)
    await expect(
        row(page, 'Added 1 note').filter({ hasNot: page.locator('[data-history-disclosure]') }),
    ).toHaveAttribute('aria-selected', 'true')
    await expect(peekLine(page)).toHaveText('1 change')
    await row(page, 'Added 2 notes').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Show Change' }).click()
    await expect(peekLine(page)).toHaveText('2 changes')
})

test('Find Edits Here measures the live chart before and after peeking', async ({ page }) => {
    const initial = (await changes(page)).band
    expect(initial.top).toBe(0)
    expect(initial.bottom).toBeGreaterThan(0)
    await edit(page, 'Add', { kind: 'add', beats: [40] })
    await stored(page)
    await openTab(page)
    await row(page, 'Add').click()
    const barBottom = await page
        .locator('[data-peek-bar]')
        .evaluate(
            (bar) =>
                bar.getBoundingClientRect().bottom -
                bar.closest('.chart-pane')!.getBoundingClientRect().top,
        )
    expect(barBottom).toBeGreaterThan(0)
    await expect.poll(async () => (await changes(page)).band.top).toBe(barBottom)
    await page.locator('[data-peek-back]').click()
    await expect.poll(async () => (await changes(page)).band.top).toBe(0)
    const result = await page.evaluate(async () => {
        const { takeHereRange } = await window.editorTest.appImport<
            typeof import('../../src/editor/history/editsHere')
        >('/src/editor/history/editsHere.ts')
        return takeHereRange()
    })
    expect(result.to).toBeGreaterThan(result.from)
})

test('Find Edits Here follows toolbar stack height without resizing the pane', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const before = (await changes(page)).band.bottom
    const expected = await page.evaluate(() => {
        const pane = document.querySelector('.chart-pane')!
        const stack = pane.querySelector<HTMLElement>(':scope > [data-editor-toolbar] > div')!
        stack.style.height = `${stack.getBoundingClientRect().height + 90}px`
        return pane.getBoundingClientRect().bottom - stack.getBoundingClientRect().top
    })
    expect(expected).toBeGreaterThan(before + 80)
    await expect.poll(async () => (await changes(page)).band.bottom).toBeCloseTo(expected, 0)
    await page.evaluate(() => {
        document.querySelector<HTMLElement>(
            '.chart-pane > [data-editor-toolbar] > div',
        )!.style.height = ''
    })
    await expect.poll(async () => (await changes(page)).band.bottom).toBeCloseTo(before, 0)
    expect(errors.filter((message) => message.includes('ResizeObserver'))).toEqual([])
})

test('inactive History band waits for focus and resumes with current layout at Now and peek', async ({
    page,
}) => {
    await edit(page, 'Moved 1 note', { kind: 'move', beats: [5] })
    await stored(page)
    await openTab(page)
    await page.evaluate(installCanvasCounters, false)
    await page.evaluate(async () => {
        window.installEditorRendering!(
            await window.editorTest.appImport<typeof import('../../src/rendering/context')>(
                '/src/rendering/context.ts',
            ),
        )
    })
    for (const mode of ['now', 'peek'] as const) {
        if (mode === 'peek') {
            await row(page, 'Moved 1 note').click()
            await expect(peekLine(page)).toHaveText('1 change')
            await expect.poll(async () => (await changes(page)).band.top).toBeGreaterThan(0)
        }
        const before = (await changes(page)).band
        const result = await page.evaluate(async () => {
            const { appImport, nextTick } = window.editorTest
            const [{ changeBand }, { peekClearance }, { isAppActive }] = await Promise.all([
                appImport<typeof import('../../src/editor/history/changes')>(
                    '/src/editor/history/changes.ts',
                ),
                appImport<typeof import('../../src/editor/toolModals')>(
                    '/src/editor/toolModals.ts',
                ),
                appImport<typeof import('../../src/activity')>('/src/activity.ts'),
            ])
            const pane = document.querySelector('.chart-pane')!
            const stack = pane.querySelector<HTMLElement>(':scope > [data-editor-toolbar] > div')!
            const bar = pane.querySelector<HTMLElement>(':scope > [data-peek-bar]')
            window.dispatchEvent(new Event('blur'))
            await nextTick()
            let frames = 0
            const request = window.requestAnimationFrame
            // The band's own frame requests are the ones that must not come: other parts of the
            // page, such as the overlay scrollbars, measure after the resize as they should.
            window.requestAnimationFrame = (callback) => {
                if (new Error().stack?.includes('ChangeBand')) frames++
                return request.call(window, callback)
            }
            window.editorFrames = { chart: 0, overlay: 0 }
            try {
                stack.style.height = `${stack.getBoundingClientRect().height + 90}px`
                if (bar) bar.style.height = `${bar.getBoundingClientRect().height + 60}px`
                await nextTick()
                // Let observers deliver without counting a frame: they run in the draw step, so two
                // frames of the page's own, asked for before the count began, are enough.
                await new Promise<void>((resolve) =>
                    request.call(window, () => request.call(window, () => resolve())),
                )
                const box = pane.getBoundingClientRect()
                return {
                    active: isAppActive.value,
                    frames,
                    draws: { ...window.editorFrames },
                    band: { ...changeBand.value },
                    clearance: peekClearance.value,
                    expected: {
                        top: bar ? Math.max(0, bar.getBoundingClientRect().bottom - box.top) : 0,
                        bottom: Math.max(0, box.bottom - stack.getBoundingClientRect().top),
                    },
                }
            } finally {
                window.requestAnimationFrame = request
            }
        })
        expect(result.active).toBe(false)
        expect(result.frames).toBe(0)
        expect(result.draws).toEqual({ chart: 0, overlay: 0 })
        expect(result.band).toEqual(before)
        expect(result.clearance).toBe(before.top)
        expect(result.expected.bottom).toBeGreaterThan(before.bottom + 80)
        if (mode === 'peek') expect(result.expected.top).toBeGreaterThan(before.top + 50)
        await page.evaluate(() => window.dispatchEvent(new Event('focus')))
        await expect
            .poll(async () => (await changes(page)).band.bottom)
            .toBeCloseTo(result.expected.bottom, 0)
        await expect
            .poll(async () => (await changes(page)).band.top)
            .toBeCloseTo(result.expected.top, 0)
        await expect
            .poll(() =>
                page.evaluate(async () => {
                    const { peekClearance } = await window.editorTest.appImport<
                        typeof import('../../src/editor/toolModals')
                    >('/src/editor/toolModals.ts')
                    return peekClearance.value
                }),
            )
            .toBeCloseTo(result.expected.top, 0)
        await page.evaluate(() => {
            const pane = document.querySelector('.chart-pane')!
            pane.querySelector<HTMLElement>(':scope > [data-editor-toolbar] > div')!.style.height =
                ''
            const bar = pane.querySelector<HTMLElement>(':scope > [data-peek-bar]')
            if (bar) bar.style.height = ''
        })
        await expect
            .poll(async () => (await changes(page)).band.bottom)
            .toBeCloseTo(before.bottom, 0)
        await expect.poll(async () => (await changes(page)).band.top).toBeCloseTo(before.top, 0)
    }
})

test('Edits Here counts its last group exactly once its scan has finished, whatever the Timeline pages', async ({
    page,
}) => {
    await edit(page, 'Moved near', { kind: 'move', beats: [5] }, true)
    await edit(page, 'Moved near again', { kind: 'move', beats: [7] }, true)
    await stored(page)
    // The ordinary Timeline has older entries it has not loaded: its first page names a next one
    // and the next read never lands, so `canLoadMore` stays true.
    await page.evaluate(async () => {
        const start =
            await window.editorTest.appImport<typeof import('../../src/local/start')>(
                '/src/local/start.ts',
            )
        const worker = start.storageWorker as unknown as {
            call: (name: string, ...args: unknown[]) => Promise<unknown>
        }
        const call = worker.call.bind(worker)
        worker.call = async (name, ...args) => {
            const request = args[0] as { before?: number; limit?: number }
            if (name !== 'readTimeline' || (request.limit ?? 0) <= 1) return call(name, ...args)
            if (request.before !== undefined) return new Promise(() => undefined)
            const result = (await call(name, ...args)) as object
            return { ...result, next: { sessionId: 'older', before: 1 } }
        }
    })
    await edit(page, 'Added far', { kind: 'add', beats: [200] })
    await stored(page)
    await viewAt(page, 6)
    await openTab(page)
    await surface(page).locator('[data-history-goto-button]').click()
    await page.getByRole('radio', { name: 'Edits Here' }).click()
    await page.keyboard.press('Escape')
    await expect(surface(page).locator('[data-history-filter-banner]')).toContainText(
        'Edits Here · ',
    )
    const group = list(page).locator('[data-history-group-count]').filter({ hasText: /\d/ })
    await expect(group).toHaveCount(1)
    await expect(surface(page).locator('[data-history-scan]')).toHaveCount(0)
    await expect(group).toHaveText('2 steps')
})

/** Chooses Edits Here from Go To in the docked panel. */
const chooseHere = async (page: Page) => {
    await surface(page).locator('[data-history-goto-button]').click()
    await page.getByRole('radio', { name: 'Edits Here' }).click()
    await page.keyboard.press('Escape')
    await expect(surface(page).locator('[data-history-filter-banner]')).toContainText(
        'Edits Here · ',
    )
}

test('closing the History dialog does not stop the docked panel’s Edits Here scan', async ({
    page,
}) => {
    await edit(page, 'Moved near', { kind: 'move', beats: [5] })
    await stored(page)
    await viewAt(page, 6)
    await openTab(page)
    const hold = await holdWorker(page, 'findEdits')
    try {
        await chooseHere(page)
        await hold.reached()
        const scan = surface(page).locator('[data-history-scan]')
        await expect(scan).toHaveAttribute('data-scan', 'checking')
        // The dialog's own Timeline shows over the panel's, then goes while the scan is out.
        await page.evaluate(() => {
            const active = document.activeElement
            if (active instanceof HTMLElement) active.blur()
        })
        await page.keyboard.press('Shift+H')
        const dialog = page.locator('[data-history-surface="dialog"] [data-history-list]')
        await expect(dialog).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(dialog).toHaveCount(0)
        // The panel is still waiting for the scan: it is not shown as complete or as empty.
        await expect(scan).toHaveAttribute('data-scan', 'checking')
        await expect(surface(page).locator('[data-history-empty]')).toHaveCount(0)
    } finally {
        await release(page)
    }
    await expect(row(page, 'Moved near')).toBeVisible()
    await expect(surface(page).locator('[data-history-scan]')).toHaveCount(0)
})

test('a failed Edits Here scan says so, and Try Again scans again', async ({ page }) => {
    await edit(page, 'Moved near', { kind: 'move', beats: [5] })
    await stored(page)
    await viewAt(page, 6)
    await openTab(page)
    const hold = await holdWorker(page, 'findEdits')
    try {
        await chooseHere(page)
        await hold.reached()
    } finally {
        await release(page, true)
    }
    // Not "No edits here": the search did not finish.
    const failed = surface(page).locator('[data-history-failed]')
    await expect(failed).toContainText('The search could not be completed.')
    await expect(surface(page).locator('[data-history-empty]')).toHaveCount(0)
    await failed.getByRole('button', { name: 'Try Again' }).click()
    await expect(row(page, 'Moved near')).toBeVisible()
    await expect(failed).toHaveCount(0)
})

test('a failed Edits Here with nothing to search offers no Try Again', async ({ page }) => {
    await edit(page, 'Moved near', { kind: 'move', beats: [5] })
    await stored(page)
    await viewAt(page, 6)
    await openTab(page)
    await chooseHere(page)
    await expect(row(page, 'Moved near')).toBeVisible()
    await page.evaluate(async () => {
        const { here } = await window.editorTest.appImport<
            typeof import('../../src/editor/history/source')
        >('/src/editor/history/source.ts')
        here.canRetry = false
        here.failed = true
    })
    const failed = surface(page).locator('[data-history-failed]')
    await expect(failed).toContainText('The search could not be completed.')
    await expect(failed.getByRole('button')).toHaveCount(0)
})

const hereMatchIds = (page: Page) =>
    page.evaluate(async () => {
        const { here } = await window.editorTest.appImport<
            typeof import('../../src/editor/history/source')
        >('/src/editor/history/source.ts')
        return here.matches.map((entry) => `${entry.sessionId}:${entry.seq}`)
    })

/** Opens the History dialog over the docked panel, as its command does. */
const openDialog = async (page: Page) => {
    await page.evaluate(() => {
        const active = document.activeElement
        if (active instanceof HTMLElement) active.blur()
    })
    await page.keyboard.press('Shift+H')
    await expect(page.locator('[data-history-surface="dialog"] [data-history-list]')).toBeVisible()
}

test('the panel and the dialog both following Edits Here check newer entries once, and list a match once', async ({
    page,
}) => {
    await edit(page, 'Moved near', { kind: 'move', beats: [5] })
    await stored(page)
    await viewAt(page, 6)
    await openTab(page)
    await chooseHere(page)
    await expect(row(page, 'Moved near')).toBeVisible()
    await expect(surface(page).locator('[data-history-scan]')).toHaveCount(0)
    await openDialog(page)
    const hold = await holdWorker(page, 'findEdits')
    try {
        await edit(page, 'Moved again', { kind: 'move', beats: [7] })
        await stored(page)
        await hold.reached()
        // Both lists' timers have fired by now: one check is out, the other waits for it.
        await page.waitForTimeout(2500)
        expect(await hold.count()).toBe(1)
    } finally {
        await release(page)
    }
    await expect.poll(() => hereMatchIds(page).then((ids) => ids.length)).toBe(2)
    await page.waitForTimeout(1500)
    const ids = await hereMatchIds(page)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(2)
})

test('an edit stored while the Edits Here scan runs is listed once the scan ends', async ({
    page,
}) => {
    await edit(page, 'Moved near', { kind: 'move', beats: [5] })
    await stored(page)
    await viewAt(page, 6)
    await openTab(page)
    // The scan reads the chain at once, but its answer reaches the list only when released: the
    // chain it saw does not include the edit stored meanwhile.
    await page.evaluate(async () => {
        const { storageWorker } =
            await window.editorTest.appImport<typeof import('../../src/local/start')>(
                '/src/local/start.ts',
            )
        const worker = storageWorker!
        const original = worker.call
        const win = window as unknown as { releaseScan: () => void }
        const gate = new Promise<void>((resolve) => {
            win.releaseScan = () => {
                worker.call = original
                resolve()
            }
        })
        worker.call = new Proxy(original, {
            async apply(target, self, args) {
                const result = await Reflect.apply(target, self, args)
                if (args[0] === 'findEdits') await gate
                return result
            },
        })
    })
    try {
        await chooseHere(page)
        await expect(surface(page).locator('[data-history-scan]')).toHaveAttribute(
            'data-scan',
            'checking',
        )
        await edit(page, 'Moved again', { kind: 'move', beats: [7] })
        await stored(page)
        // The follow timer has fired while the scan is out: its check returned without looking.
        await page.waitForTimeout(2500)
    } finally {
        await page.evaluate(() => (window as unknown as { releaseScan: () => void }).releaseScan())
    }
    await expect(row(page, 'Moved near')).toBeVisible()
    await expect(row(page, 'Moved again')).toBeVisible({ timeout: 10_000 })
})

test('Edits Here chosen before anything is stored lists the entries stored after', async ({
    page,
}) => {
    // A new session with nothing stored yet: flushes are held, so the scan reads an empty chain.
    await page.evaluate(() => {
        window.nseFlushTest!.stall = true
        const { show, fixtures } = window.editorTest
        show(fixtures.interaction, 3)
    })
    await viewAt(page, 6)
    await openTab(page)
    await chooseHere(page)
    await expect(surface(page).locator('[data-history-empty]')).toHaveText('No edits here')
    // The scan read an empty chain: it has no newest entry to continue from.
    const top = await page.evaluate(async () => {
        const { appImport } = window.editorTest
        const [{ storageWorker }, { session }] = await Promise.all([
            appImport<typeof import('../../src/local/start')>('/src/local/start.ts'),
            appImport<typeof import('../../src/history/session')>('/src/history/session.ts'),
        ])
        const found = await storageWorker!.call('findEdits', {
            sessionId: session.value.sessionId,
            from: -1e9,
            to: 1e9,
        })
        return found.top
    })
    expect(top).toBeUndefined()
    await edit(page, 'Moved near', { kind: 'move', beats: [5] })
    await page.evaluate(() => {
        window.nseFlushTest!.stall = false
    })
    await stored(page)
    await expect(row(page, 'Moved near')).toBeVisible({ timeout: 10_000 })
})

test('a list closed while its follow timer runs does not read again', async ({ page }) => {
    await page.evaluate(() => {
        window.nseFlushTest!.stall = true
    })
    // Entries waiting for the worker keep a timer re-arming while its list shows.
    await page.evaluate(async () => {
        const start =
            await window.editorTest.appImport<typeof import('../../src/local/start')>(
                '/src/local/start.ts',
            )
        const worker = start.storageWorker as unknown as {
            call: (name: string, ...args: unknown[]) => Promise<unknown>
        }
        const call = worker.call.bind(worker)
        const win = window as unknown as { timelineReads: number }
        win.timelineReads = 0
        worker.call = (name, ...args) => {
            if (name === 'readTimeline') win.timelineReads++
            return call(name, ...args)
        }
    })
    await openDialog(page)
    const hold = await holdWorker(page, 'readTimeline')
    try {
        await edit(page, 'Moved near', { kind: 'move', beats: [5] })
        await hold.reached()
        await page.keyboard.press('Escape')
        await expect(page.locator('[data-history-surface="dialog"]')).toHaveCount(0)
    } finally {
        await release(page)
    }
    await page.waitForTimeout(500)
    const reads = () =>
        page.evaluate(() => (window as unknown as { timelineReads: number }).timelineReads)
    const settled = await reads()
    await page.waitForTimeout(4000)
    expect(await reads()).toBe(settled)
})

test('Edits Here takes the beats of a very large selection', async ({ page }) => {
    const span = await page.evaluate(async () => {
        const { beatSpan } = await window.editorTest.appImport<
            typeof import('../../src/editor/history/editsHere')
        >('/src/editor/history/editsHere.ts')
        const entities = Array.from({ length: 400_000 }, (_, i) => ({ beat: 10 + (i % 1000) }))
        return beatSpan(entities)
    })
    expect(span).toEqual({ from: 10, to: 1009 })
})

test('leaving the peek from the strip gives focus to the chart, by any of its ways (X-2)', async ({
    page,
}) => {
    await edit(page, 'Moved A', { kind: 'move', beats: [5] })
    await edit(page, 'Moved B', { kind: 'move', beats: [7] })
    await stored(page)
    await openTab(page)
    const chart = page.locator('.chart-pane')
    const peek = async () => {
        await row(page, 'Moved A').click()
        await expect(page.locator('[data-peek-main]')).toBeVisible()
    }
    const gone = async () => {
        await expect(page.locator('[data-peek-main]')).toHaveCount(0)
        await expect(chart).toBeFocused()
    }
    // Back to Now by keys, then by a click.
    await peek()
    await page.locator('[data-peek-back]').focus()
    await page.keyboard.press('Enter')
    await gone()
    await peek()
    await page.locator('[data-peek-back]').click()
    await gone()
    // Escape on a strip control.
    await peek()
    await page.locator('[data-peek-restore]').focus()
    await page.keyboard.press('Escape')
    await gone()
    // Restore, then a Restore that already matches, which changes nothing.
    await peek()
    await page.locator('[data-peek-restore]').click()
    await gone()
    await expect(
        list(page)
            .getByRole('row')
            .filter({ hasText: /^Restored to/ }),
    ).toHaveCount(1)
    await peek()
    await page.locator('[data-peek-restore]').click()
    await gone()
    await expect(
        page.locator('.notification', { hasText: 'Already matches the current chart' }),
    ).toBeVisible()
    // Undo pressed while the strip has focus ends the peek too.
    await peek()
    await page.locator('[data-peek-restore]').focus()
    await page.keyboard.press('Control+z')
    await gone()
})

test('Try Again and Show All by keys hand focus on as they go (X-2, X-5)', async ({ page }) => {
    await edit(page, 'Moved near', { kind: 'move', beats: [5] })
    await stored(page)
    await viewAt(page, 6)
    await openTab(page)
    const hold = await holdWorker(page, 'findEdits')
    try {
        await chooseHere(page)
        await hold.reached()
    } finally {
        await release(page, true)
    }
    const failed = surface(page).locator('[data-history-failed]')
    await failed.getByRole('button', { name: 'Try Again' }).focus()
    await page.keyboard.press('Enter')
    await expect(row(page, 'Moved near')).toBeVisible()
    await expect(failed).toHaveCount(0)
    // To the cursor's row.
    await expect(list(page).locator('[data-history-row][tabindex="0"]')).toBeFocused()
    // Show All goes with the banner: to the list's roving row, as a Go To pick goes (X-5).
    await surface(page).getByRole('button', { name: 'Show All' }).focus()
    await page.keyboard.press('Enter')
    await expect(surface(page).locator('[data-history-filter-banner]')).toHaveCount(0)
    await expect(list(page).locator('[data-history-row][tabindex="0"]')).toBeFocused()
})

test('an outside press that closes Go To or a row’s menu gives focus back to its opener (X-3)', async ({
    page,
}) => {
    await edit(page, 'Moved A', { kind: 'move', beats: [5] })
    await stored(page)
    await openTab(page)
    const chart = (await page.locator('canvas.editor-chart').boundingBox())!
    const outside = { x: chart.x + chart.width / 2, y: chart.y + chart.height / 2 }
    const button = surface(page).locator('[data-history-goto-button]')
    await button.click()
    await expect(page.locator('[data-history-goto]')).toBeVisible()
    await page.mouse.click(outside.x, outside.y)
    await expect(page.locator('[data-history-goto]')).toHaveCount(0)
    await expect(button).toBeFocused()
    // A resize closes it the same way.
    await button.click()
    await expect(page.locator('[data-history-goto]')).toBeVisible()
    await page.setViewportSize({ width: 1500, height: 950 })
    await expect(page.locator('[data-history-goto]')).toHaveCount(0)
    await expect(button).toBeFocused()
    // A row's menu: back to the row.
    await row(page, 'Moved A').click({ button: 'right' })
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    await page.mouse.click(outside.x, outside.y)
    await expect(menu).toHaveCount(0)
    await expect
        .poll(() => row(page, 'Moved A').evaluate((element) => element.matches(':focus-within')))
        .toBe(true)
})

test('Edits Here’s range names its first and last beats, for a selection and for the view (X-B 1, 6)', async ({
    page,
}) => {
    await edit(page, 'Moved near', { kind: 'move', beats: [5] })
    await stored(page)
    await viewAt(page, 6)
    await openTab(page)
    const banner = surface(page).locator('[data-history-filter-banner]')
    const range = page.locator('[data-goto-here-range]')
    // In the fixture's 4/4, beat 3 is 1.4, 5 is 2.2 and 7 is 2.4: a last beat at a bar's end reads
    // itself, not the next bar's first.
    for (const [beats, text] of [
        [[5], '2.2 – 2.2'],
        [[5, 7], '2.2 – 2.4'],
        [[3], '1.4 – 1.4'],
    ] as const) {
        await page.evaluate(
            async (beats) => {
                const { history, store } = window.editorTest
                history.replaceState({
                    ...history.state.value,
                    selectedEntities: [...store.getAllEntities()].filter(
                        (entity) => entity.type === 'note' && beats.includes(entity.beat),
                    ),
                })
                await window.editorTest.nextTick()
            },
            beats as readonly number[],
        )
        await surface(page).locator('[data-history-goto-button]').click()
        await expect(range).toHaveText(text)
        await page.getByRole('radio', { name: 'Edits Here' }).click()
        await page.keyboard.press('Escape')
        await expect(banner).toHaveText(new RegExp(`Edits Here · ${text}`))
    }
    // With nothing selected, the beats of the band in view: the grid beats its bottom and top are in.
    await page.evaluate(async () => {
        const { history } = window.editorTest
        history.replaceState({ ...history.state.value, selectedEntities: [] })
        await window.editorTest.nextTick()
    })
    await viewAt(page, 40)
    const expected = await page.evaluate(async () => {
        const { appImport, history } = window.editorTest
        const [{ bandTimes }, { timeToBeat }] = await Promise.all([
            appImport<typeof import('../../src/editor/history/changes')>(
                '/src/editor/history/changes.ts',
            ),
            appImport<typeof import('../../src/state/integrals/bpms')>(
                '/src/state/integrals/bpms.ts',
            ),
        ])
        const band = bandTimes()
        const label = (time: number) => {
            const beat = Math.floor(timeToBeat(history.state.value.bpms, time))
            return `${Math.floor(beat / 4) + 1}.${(beat % 4) + 1}`
        }
        return `${label(band.bottom)} – ${label(band.top)}`
    })
    await surface(page).locator('[data-history-goto-button]').click()
    await expect(range).toHaveText(expected)
})

// X-12: the view never goes below the chart's start, so a sheet over more than half the pane leaves a
// first stretch of the chart that no scroll can bring into the band. A change there is reachable
// by neither arrow: it counts in neither direction, and no button is enabled for it.
test('a change under the sheet at the chart’s start counts in neither direction and enables no arrow (X-12)', async ({
    page,
}) => {
    await page.setViewportSize({ width: 390, height: 844 })
    // Beat 0.2 is 0.1 s in, under the sheet at the start; beat 4 is 2 s in; beat 80 is far above.
    await edit(page, 'Added 3 notes', { kind: 'add', beats: [0.2, 4, 80] })
    await stored(page)
    await viewAt(page, 0)
    await page.evaluate(async () => {
        const { openHistoryDialog } = await window.editorTest.appImport<
            typeof import('../../src/editor/history/openHistory')
        >('/src/editor/history/openHistory.ts')
        void openHistoryDialog('timeline')
    })
    const sheet = page.locator('[data-tool-dialog][data-sheet]')
    await expect(sheet).toBeVisible()
    await sheet
        .getByRole('row')
        .and(page.locator(':not(.timeline-now)'))
        .filter({ has: page.getByText('Added 3 notes', { exact: true }) })
        .click()
    await expect(peekLine(page)).toHaveText('3 changes')
    // The sheet covers more than half of the pane: the band's bottom at view time 0 is after 0.1 s.
    const start = await changes(page)
    const { h, pps } = await page.evaluate(() => ({
        h: window.editorTest.view.h,
        pps: window.editorTest.settings.pps,
    }))
    expect(start.time).toBe(0)
    expect((start.band.bottom - 0.5 * h) / pps).toBeGreaterThan(0.1)
    // Beat 4 is in the band and beat 80 is above it: Down counts nothing and is disabled.
    expect(start.off).toEqual({ above: 1, below: 0 })
    await expect(arrow(page, 'down')).toHaveAttribute('data-count', '0')
    await expect(arrow(page, 'down')).toHaveAttribute('aria-disabled', 'true')
    await expect(arrow(page, 'up')).toHaveAttribute('data-count', '1')
    await expect(arrow(page, 'up')).toHaveAttribute('aria-disabled', 'false')
    // Up still works. Then beat 4 lies below the band and can be reached; beat 0.2 still cannot.
    await arrow(page, 'up').click()
    await expect.poll(async () => (await changes(page)).time).toBeGreaterThan(5)
    await expect(arrow(page, 'up')).toHaveAttribute('aria-disabled', 'true')
    await expect(arrow(page, 'down')).toHaveAttribute('data-count', '1')
    await arrow(page, 'down').click()
    await expect.poll(async () => (await changes(page)).off).toEqual({ above: 1, below: 0 })
    await expect(arrow(page, 'down')).toHaveAttribute('aria-disabled', 'true')
})

test('Go To’s Edits Here line follows the view while open, so a pick matches the banner (X-7)', async ({
    page,
}) => {
    await edit(page, 'Moved near', { kind: 'move', beats: [5] })
    await stored(page)
    await viewAt(page, 6)
    await openTab(page)
    const banner = surface(page).locator('[data-history-filter-banner]')
    const range = page.locator('[data-goto-here-range]')
    await surface(page).locator('[data-history-goto-button]').click()
    const opened = await range.textContent()
    // The view moves while Go To is open, as a wheel or a sheet's promotion moves it.
    await viewAt(page, 40)
    await expect(range).not.toHaveText(opened!)
    const moved = await range.textContent()
    await page.getByRole('radio', { name: 'Edits Here' }).click()
    await expect(banner).toHaveText(new RegExp(`Edits Here · ${moved}`))
    await expect(range).toHaveText(moved!)
    // Moved again, it names what choosing it again would take.
    await viewAt(page, 80)
    await expect(range).not.toHaveText(moved!)
    const again = await range.textContent()
    await page.getByRole('radio', { name: 'Edits Here' }).click()
    await expect(banner).toHaveText(new RegExp(`Edits Here · ${again}`))
})
