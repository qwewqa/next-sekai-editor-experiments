import { expect, test, type Page } from '@playwright/test'
import { installEditorFixture, waitForStartup } from './editorFixture'

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
    | { kind: 'bpm'; bpm: number }
    | { kind: 'life' }
    | { kind: 'same' }
    | { kind: 'many'; count: number; from: number }
    | { kind: 'critical'; share: number }

/** Pushes an edit as the tools do: one undoable step with a label. */
const edit = (page: Page, label: string, change: Change) =>
    page.evaluate(
        async ({ label, change }) => {
            const { appImport, history } = window.editorTest
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
            switch (change.kind) {
                case 'move':
                    for (const note of all.filter((note) => change.beats.includes(note.beat)))
                        notes.replaceNote(transaction, note, {
                            ...noteObjectOf(note),
                            left: note.left + (change.lanes ?? 1),
                        })
                    break
                case 'add':
                    for (const beat of change.beats)
                        notes.addNote(transaction, createSlideId(), {
                            ...template,
                            beat,
                            left: change.left ?? -1,
                        })
                    break
                case 'many':
                    for (let i = 0; i < change.count; i++)
                        notes.addNote(transaction, createSlideId(), {
                            ...template,
                            beat: change.from + i * 0.5,
                            left: -4 + (i % 8),
                        })
                    break
                case 'critical': {
                    const sorted = all.sort((a, b) => a.beat - b.beat)
                    for (const note of sorted.slice(0, Math.ceil(sorted.length * change.share)))
                        notes.replaceNote(transaction, note, {
                            ...noteObjectOf(note),
                            isCritical: !note.isCritical,
                        })
                    break
                }
                case 'bpm': {
                    const first = [...state.store.grid.bpm.values()].flatMap((b) => [...b])[0]!
                    bpm.replaceBpm(transaction, first, { beat: 0, bpm: change.bpm, meter: 4 })
                    break
                }
                case 'life':
                    history.pushState(() => label, { ...state, initialLife: state.initialLife + 1 })
                    return
                case 'same':
                    history.pushState(() => label, { ...state })
                    return
            }
            history.pushState(() => label, transaction.commit([]))
        },
        { label, change },
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
const row = (page: Page, text: string) =>
    list(page)
        .getByRole('option')
        .filter({ has: page.getByText(text, { exact: true }) })
const peekLine = (page: Page) => page.locator('[data-peek-change]')
const arrow = (page: Page, direction: 'up' | 'down') =>
    page.locator(`[data-change-arrow="${direction}"]`)

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
    const shot = await page.screenshot({
        clip: { x: point.x - 30, y: point.y - 30, width: 60, height: 60 },
    })
    const orange = await page.evaluate(
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
    expect(orange).toBeGreaterThan(10)
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
    await expect(arrow(page, 'down')).toHaveCount(0)
    await arrow(page, 'up').click()
    await expect.poll(async () => Math.round(await centreBeat(page))).toBeGreaterThan(38)
    await expect(arrow(page, 'up')).toHaveCount(0)
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
        await page.waitForTimeout(400)
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
    await expect.poll(async () => Math.round(await centreBeat(page))).toBe(60)
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
    await expect(page.locator('[data-peek-text]')).toContainText('Set Initial Life to 1,001')
    await expect(peekLine(page)).toHaveCount(0)
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
        .getByRole('option')
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
    await expect(peekLine(page)).toHaveText('Changed 544 of 604 notes')
    const state = await changes(page)
    expect(state).toMatchObject({ layout: 'most', dimmed: false })
    expect(state.rings).toBeUndefined()
    await expect(arrow(page, 'up')).toHaveCount(0)
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
        requestPeek({
            key: keyOf({ sessionId: session.id, seq }),
            time: entry!.time,
            label: 'Moved 1 note',
            snapshot: entry!.snapshot,
            // A previous state whose root is gone.
            previous: {
                key: keyOf({ sessionId: session.id, seq: seq - 1 }),
                snapshot: '0'.repeat(32),
            },
        })
    })
    await expect(page.locator('[data-peek-text]')).toBeVisible()
    await page.waitForTimeout(500)
    await expect(peekLine(page)).toHaveCount(0)
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
        .getByRole('option')
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
    await expect(page.locator('[data-peek-text]')).toContainText('Faster')
    // The tempo differs: the beat in the middle stays.
    expect(Math.abs((await centreBeat(page)) - beat)).toBeLessThan(1e-6)
    await list(page).press('ArrowDown')
    await expect(page.locator('[data-peek-text]')).toContainText('Moved A')
    await expect(peekLine(page)).toHaveText('1 change')
    expect(Math.abs((await centreBeat(page)) - beat)).toBeLessThan(1e-6)
    expect(await page.evaluate(() => (window as unknown as { dimLifted: boolean }).dimLifted)).toBe(
        false,
    )
})

test('Dim Unchanged Objects off leaves the chart undimmed', async ({ page }) => {
    await edit(page, 'Moved 1 note', { kind: 'move', beats: [5] })
    await stored(page)
    await page.evaluate(() => {
        window.editorTest.settings.dimUnchangedObjects = false
    })
    await openTab(page)
    await row(page, 'Moved 1 note').click()
    await expect(peekLine(page)).toHaveText('1 change')
    expect(await changes(page)).toMatchObject({ rings: 1, dimmed: false })
})
