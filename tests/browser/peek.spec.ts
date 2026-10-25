import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { confirmWhenReady } from './confirmWhenReady'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// Peek and its gating: an entry's state shown read-only while writers keep the
// live state, commands and tools refused with the notice, Undo leaving first, drags and scaling
// sessions cancelled, the read-only panels, the Elevation Editor closed or behind its overlay,
// Restore, and Copy while peeking then pasting after leaving. History's own panel is 5-panel's;
// these drive peek through its module, as the panel does.

const runtimeErrors = new WeakMap<Page, string[]>()

test.beforeEach(async ({ page }) => {
    const errors: string[] = []
    runtimeErrors.set(page, errors)
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    const startup = await sessionId(page)
    await page.evaluate(installEditorFixture)
    await storesNewSession(page, startup)
})

const sessionId = (page: Page) =>
    page.evaluate(async () => {
        const { flusher } = await import('/src/local/storing.ts')
        return flusher?.session?.id
    })

/**
 * Storing follows the shown chart: its session is the one peeked. A new chart starts a new session
 * with the chart as its first entry. Entries are pending only until the next flush (about a
 * second), which a loaded machine can pass before this first looks, so wait for the entry itself,
 * not for it to be unsent.
 */
const storesNewSession = (page: Page, previous: string | undefined) =>
    expect
        .poll(() =>
            page.evaluate(async (previous) => {
                const { flusher } =
                    await window.editorTest.appImport<typeof import('../../src/local/storing')>(
                        '/src/local/storing.ts',
                    )
                const session = flusher?.session
                return !!session && session.id !== previous && flusher.newestSeq(session) > 0
            }, previous),
        )
        .toBe(true)

test.afterEach(({ page }) => {
    // A missed edit path throws in development (pushState while viewing history).
    expect(runtimeErrors.get(page)).toEqual([])
})

/** The newest entry's seq in the open session. */
const newestSeq = (page: Page) =>
    page.evaluate(async () => {
        const { flusher } =
            await window.editorTest.appImport<typeof import('../../src/local/storing')>(
                '/src/local/storing.ts',
            )
        return flusher!.newestSeq(flusher!.session!)
    })

/** Runs peek's `peekEntry`, `restoreEntry` or `leavePeek` on an entry of the open session. */
const act = (page: Page, action: 'peekEntry' | 'restoreEntry' | 'leavePeek', seq = 0) =>
    page.evaluate(
        async ([action, seq]) => {
            const { appImport } = window.editorTest
            const [peek, { flusher }] = await Promise.all([
                appImport<typeof import('../../src/history/peek')>('/src/history/peek.ts'),
                appImport<typeof import('../../src/local/storing')>('/src/local/storing.ts'),
            ])
            if (action === 'leavePeek') peek.leavePeek()
            else await peek[action](peek.entryKey(flusher!.session!.id, seq))
        },
        [action, seq] as const,
    )

const peek = (page: Page, seq: number) => act(page, 'peekEntry', seq)
const restore = (page: Page, seq: number) => act(page, 'restoreEntry', seq)
const leave = (page: Page) => act(page, 'leavePeek')

/** The shown chart's note beats, and the live chart's. */
const beats = (page: Page) =>
    page.evaluate(() => {
        const { history } = window.editorTest
        const of = (state: typeof history.state.value) =>
            [...state.store.slides.note.values()]
                .flat()
                .map((note) => note.beat)
                .sort((a, b) => a - b)
        return {
            shown: of(history.state.value),
            live: of(history.liveState.value),
            peeking: history.isPeeking.value,
        }
    })

/** Deletes the note at a beat, as the user would: select it, then Delete. */
const deleteAt = async (page: Page, beat: number) => {
    await page.evaluate((beat) => {
        const { history } = window.editorTest
        const note = [...history.state.value.store.slides.note.values()]
            .flat()
            .find((note) => note.beat === beat)!
        history.replaceState({ ...history.state.value, selectedEntities: [note] })
    }, beat)
    await page.keyboard.press('Delete')
}

const notePoint = (page: Page, beat: number) =>
    page.evaluate((beat) => {
        const { history, point } = window.editorTest
        const note = [...history.state.value.store.slides.note.values()]
            .flat()
            .find((note) => note.beat === beat)!
        return point(note.left + note.size / 2, note.beat)
    }, beat)

/** Writes what is pending, so the open session counts as stored. */
const flushStorage = (page: Page) =>
    page.evaluate(async () => {
        const { flusher } =
            await window.editorTest.appImport<typeof import('../../src/local/storing')>(
                '/src/local/storing.ts',
            )
        await flusher!.flush()
        await flusher!.flush()
        if (flusher!.hasPending) throw new Error('Still pending')
    })

const notice = (page: Page) => page.locator('.notification')

test('a peek shows the entry while writers keep the live chart, and edits are refused', async ({
    page,
}) => {
    const first = await newestSeq(page)
    await deleteAt(page, 3)
    expect(await beats(page)).toEqual({ shown: [5, 7, 9], live: [5, 7, 9], peeking: false })

    await peek(page, first)
    expect(await beats(page)).toEqual({ shown: [3, 5, 7, 9], live: [5, 7, 9], peeking: true })

    // Tools and edits are refused with the notice; the toolbar shows them disabled.
    await page.keyboard.press('a')
    await expect(notice(page)).toHaveText('Read-only while viewing history')
    await expect(page.locator('button[aria-disabled="true"]').first()).toBeVisible()
    const point = await notePoint(page, 5)
    await page.mouse.click(point.x, point.y)
    // A tap selects in the peeked state only.
    expect(
        await page.evaluate(() => {
            const { history } = window.editorTest
            return [
                history.state.value.selectedEntities.length,
                history.liveState.value.selectedEntities.length,
            ]
        }),
    ).toEqual([1, 0])
    await page.keyboard.press('Delete')
    await expect(notice(page)).toHaveText('Read-only while viewing history')
    await page.keyboard.press('u')
    expect(await beats(page)).toEqual({ shown: [3, 5, 7, 9], live: [5, 7, 9], peeking: true })
    expect(await newestSeq(page)).toBe(first + 1)

    // Leaving discards the peek and its selection.
    await leave(page)
    expect(await beats(page)).toEqual({ shown: [5, 7, 9], live: [5, 7, 9], peeking: false })
    expect(
        await page.evaluate(() => window.editorTest.history.state.value.selectedEntities.length),
    ).toBe(0)
})

test('a refused toolbar tool dims only its content and still shows the refusal on a tap', async ({
    page,
}) => {
    const first = await newestSeq(page)
    await deleteAt(page, 3)
    await peek(page, first)

    const refused = page.locator('[data-editor-toolbar] button[aria-disabled="true"]').first()
    await expect(refused).toBeVisible()
    const tool = page
        .locator('[data-editor-toolbar]')
        .getByTitle((await refused.getAttribute('title'))!, { exact: true })
        .first()
    await expect(tool).toBeVisible()
    const opacities = await tool.evaluate((button) => ({
        face: getComputedStyle(button).opacity,
        children: [...button.children].map((child) => getComputedStyle(child).opacity),
    }))
    expect(opacities.face).toBe('1')
    expect(opacities.children.length).toBeGreaterThan(0)
    expect(opacities.children.every((opacity) => opacity === '0.4')).toBe(true)

    // aria-disabled reads as not enabled to Playwright; the click is still a real press.
    await tool.click({ force: true })
    await expect(notice(page)).toHaveText('Read-only while viewing history')
    await expect(tool).toHaveAttribute('aria-disabled', 'true')
    await leave(page)
    await expect(tool).not.toHaveAttribute('aria-disabled', 'true')
})

test('Undo leaves the peek first, then undoes', async ({ page }) => {
    const first = await newestSeq(page)
    await deleteAt(page, 3)
    await peek(page, first)
    await page.keyboard.press('z')
    await expect(notice(page)).toHaveText(/^Undid /)
    expect(await beats(page)).toEqual({ shown: [3, 5, 7, 9], live: [3, 5, 7, 9], peeking: false })
})

/** Swaps the file picker for one that answers in turn: a file, or null for a cancel. */
const stubPicker = (page: Page, answers: ({ name: string; text: string } | null)[]) =>
    page.evaluate(async (answers) => {
        const { setPlatformForTests, platform } =
            (await import('/src/platform/index.ts')) as typeof import('../../src/platform')
        const queue = [...answers]
        const stub = window as unknown as { pickerCalls: number }
        stub.pickerCalls = 0
        setPlatformForTests({
            ...platform,
            pickFiles: () => {
                stub.pickerCalls++
                const next = queue.shift()
                return Promise.resolve(
                    next ? [{ file: new File([next.text], next.name), handle: undefined }] : [],
                )
            },
        })
    }, answers)

const pickerCalls = (page: Page) =>
    page.evaluate(() => (window as unknown as { pickerCalls: number }).pickerCalls)

test('Open keeps the peek when the picker is cancelled, and leaves it once a file opens', async ({
    page,
}) => {
    const first = await newestSeq(page)
    await deleteAt(page, 3)
    const usc = JSON.stringify({
        version: 2,
        usc: {
            offset: 0,
            objects: [
                { type: 'bpm', beat: 0, bpm: 120 },
                { type: 'timeScaleGroup', changes: [{ beat: 0, timeScale: 1 }] },
            ],
        },
    })
    await stubPicker(page, [null, { name: 'opened.usc', text: usc }])
    await peek(page, first)
    // Stored, so that leaving asks nothing.
    await flushStorage(page)

    // Cancelled: nothing was opened, so the peek stays.
    await page.keyboard.press('o')
    await expect.poll(() => pickerCalls(page)).toBe(1)
    expect(await beats(page)).toEqual({ shown: [3, 5, 7, 9], live: [5, 7, 9], peeking: true })

    // A chosen file replaces the chart, which ends the peek; the live chart was never edited.
    await page.keyboard.press('o')
    await expect.poll(async () => (await beats(page)).peeking).toBe(false)
    expect((await beats(page)).live).toEqual([])
})

test('Undo and Redo with nothing to cross keep the peek', async ({ page }) => {
    const first = await newestSeq(page)
    await deleteAt(page, 3)
    await peek(page, first)
    // At the newest step: nothing to redo.
    await page.keyboard.press('y')
    await expect(page.getByText('Nothing to redo').first()).toBeVisible()
    expect(await beats(page)).toEqual({ shown: [3, 5, 7, 9], live: [5, 7, 9], peeking: true })

    // Undone back to the first step: nothing to undo.
    await leave(page)
    await page.keyboard.press('z')
    expect((await beats(page)).live).toEqual([3, 5, 7, 9])
    await peek(page, first)
    await page.keyboard.press('z')
    await expect(page.getByText('Nothing to undo').first()).toBeVisible()
    expect(await beats(page)).toEqual({ shown: [3, 5, 7, 9], live: [3, 5, 7, 9], peeking: true })
    await leave(page)
})

/** Makes the open session not durably stored, so that leaving it asks first. */
const markNotStored = (page: Page) =>
    page.evaluate(async () => {
        const { flusher } =
            await window.editorTest.appImport<typeof import('../../src/local/storing')>(
                '/src/local/storing.ts',
            )
        flusher!.session!.stored = false
    })

const notStoredPrompt = (page: Page) => page.getByRole('dialog', { name: 'Changes Not Stored' })

for (const [command, key] of [
    ['Open', 'o'],
    ['New', 'n'],
] as const)
    test(`${command} in a peek asks about unstored changes; Cancel changes nothing`, async ({
        page,
    }) => {
        const first = await newestSeq(page)
        await deleteAt(page, 3)
        await flushStorage(page)
        await peek(page, first)
        await markNotStored(page)
        await stubPicker(page, [])
        const session = await sessionId(page)
        const seq = await newestSeq(page)

        await page.keyboard.press(key)
        await expect(notStoredPrompt(page)).toBeVisible()
        await confirmWhenReady(
            notStoredPrompt(page).getByRole('button', { name: 'Cancel' }),
            notStoredPrompt(page),
        )

        expect(await beats(page)).toEqual({ shown: [3, 5, 7, 9], live: [5, 7, 9], peeking: true })
        expect(await sessionId(page)).toBe(session)
        expect(await newestSeq(page)).toBe(seq)
        expect(await pickerCalls(page)).toBe(0)
        await leave(page)
    })

test('Save from the unstored-changes prompt in a peek saves the live chart, and the peek stays', async ({
    page,
}) => {
    const first = await newestSeq(page)
    await deleteAt(page, 3)
    await flushStorage(page)
    await peek(page, first)
    await markNotStored(page)
    // Without a save picker the file is downloaded.
    await page.evaluate(() => {
        ;(window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined
    })

    await page.keyboard.press('o')
    await confirmWhenReady(
        notStoredPrompt(page).getByRole('button', { name: 'Save' }),
        notStoredPrompt(page),
    )
    const dialog = page.getByRole('dialog', { name: 'Save Project File' })
    await expect(dialog).toBeVisible()
    const download = page.waitForEvent('download')
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    const saved = readFileSync(await (await download).path())

    // The file holds the live chart, not the peeked step.
    const savedBeats = await page.evaluate(
        async (bytes) => {
            const { readProjectFile } =
                (await import('/src/local/open/project.ts')) as typeof import('../../src/local/open/project')
            const read = await readProjectFile(new File([new Uint8Array(bytes)], 'peek.nxsp'))
            if (read.kind !== 'nxsp') throw new Error('Not a project file')
            const { entities } = read.level as {
                entities: { archetype: string; data: { name: string; value?: number }[] }[]
            }
            return entities
                .filter((entity) => entity.archetype === 'NormalTapNote')
                .map((entity) => entity.data.find((field) => field.name === '#BEAT')?.value)
                .sort()
        },
        [...saved],
    )
    expect(savedBeats).toEqual([5, 7, 9])
    // The prompt returns to the user to repeat Open; the peek is as it was.
    expect(await beats(page)).toEqual({ shown: [3, 5, 7, 9], live: [5, 7, 9], peeking: true })
    await leave(page)
})

test('an entry no longer in memory is read from storage, verified', async ({ page }) => {
    await deleteAt(page, 3)
    const dropped = await newestSeq(page)
    await page.keyboard.press('z')
    // A new edit drops the first from redo: its state is held only in storage now.
    await deleteAt(page, 9)
    await flushStorage(page)
    await peek(page, dropped)
    expect(await beats(page)).toEqual({ shown: [5, 7, 9], live: [3, 5, 7], peeking: true })
    await leave(page)
})

test('Copy while peeking, then paste after leaving', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const first = await newestSeq(page)
    await deleteAt(page, 3)
    await peek(page, first)
    const point = await notePoint(page, 3)
    await page.mouse.click(point.x, point.y)
    await page.keyboard.press('c')
    await expect(notice(page)).not.toHaveText('Read-only while viewing history')
    await leave(page)
    await page.keyboard.press('v')
    const target = await page.evaluate(() => window.editorTest.point(0, 11))
    await page.mouse.click(target.x, target.y)
    await expect.poll(async () => (await beats(page)).live.length).toBe(4)
    expect((await beats(page)).live).toContain(11)
    await expect(notice(page)).toHaveText(/^Pasted /)
})

test('entering a peek cancels a drag in progress', async ({ page }) => {
    const first = await newestSeq(page)
    await deleteAt(page, 3)
    const before = await beats(page)
    const from = await notePoint(page, 5)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x, from.y - 60, { steps: 5 })
    await peek(page, first)
    await page.mouse.move(from.x, from.y - 120, { steps: 5 })
    await page.mouse.up()
    await leave(page)
    expect(await beats(page)).toEqual(before)
    expect(await newestSeq(page)).toBe(first + 1)
})

test('leaving a peek cancels a box selection, so no peeked object reaches the live selection', async ({
    page,
}) => {
    const first = await newestSeq(page)
    await deleteAt(page, 3)
    await peek(page, first)
    // The peeked note at beat 3 is selected, then Ctrl adds a box to it.
    const note = await notePoint(page, 3)
    await page.mouse.click(note.x, note.y)
    const from = await page.evaluate(() => window.editorTest.point(-6, 4))
    const to = await page.evaluate(() => window.editorTest.point(6, 8))
    await page.keyboard.down('Control')
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 5 })
    // Leaving switches the tool from view-only Select, which ends the drag.
    await leave(page)
    await page.mouse.move(to.x + 4, to.y + 4, { steps: 2 })
    await page.mouse.up()
    await page.keyboard.up('Control')
    expect(
        await page.evaluate(() => {
            const live = window.editorTest.history.liveState.value
            const notes = new Set<unknown>([...live.store.slides.note.values()].flat())
            return live.selectedEntities.filter(
                (entity) => entity.type === 'note' && !notes.has(entity),
            ).length
        }),
    ).toBe(0)
})

test('entering a peek cancels a scaling session', async ({ page }) => {
    const first = await newestSeq(page)
    await page.evaluate(async () => {
        const { history, appImport } = window.editorTest
        const notes = [...history.state.value.store.slides.note.values()].flat().slice(0, 2)
        history.replaceState({ ...history.state.value, selectedEntities: notes })
        const { beginScalingSession } = await appImport<
            typeof import('../../src/editor/commands/scaleSelection/session')
        >('/src/editor/commands/scaleSelection/session.ts')
        beginScalingSession('beat')
    })
    await peek(page, first)
    expect(
        await page.evaluate(async () => {
            const { scalingSession } = await window.editorTest.appImport<
                typeof import('../../src/editor/commands/scaleSelection/session')
            >('/src/editor/commands/scaleSelection/session.ts')
            return scalingSession.value === undefined
        }),
    ).toBe(true)
    await leave(page)
})

test('the Elevation Editor closes for a peek and reopens after it', async ({ page }) => {
    const first = await newestSeq(page)
    await page.evaluate(() => {
        window.editorTest.settings.elevationEditorSideBySide = 'disallow'
    })
    await page.keyboard.press('t')
    await expect(page.locator('.elevation-editor')).toBeVisible()
    await peek(page, first)
    await expect(page.locator('.elevation-editor')).toHaveCount(0)
    await leave(page)
    await expect(page.locator('.elevation-editor')).toBeVisible()
})

test('side by side, the Elevation Editor shows the peek behind its overlay', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 })
    const first = await newestSeq(page)
    await page.evaluate(() => {
        window.editorTest.settings.elevationEditorSideBySide = 'allow'
    })
    await page.keyboard.press('t')
    await expect(page.locator('.elevation-editor')).toBeVisible()
    await peek(page, first)
    const overlay = page.locator('.elevation-peek-overlay')
    await expect(overlay).toHaveText('Viewing history · read-only')
    await expect(page.locator('.elevation-editor')).toBeVisible()
    // It takes the pointer: nothing under it is pressed.
    const box = (await overlay.boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    expect(
        await page.evaluate(() => window.editorTest.history.state.value.selectedEntities.length),
    ).toBe(0)
    // The wheel still scrolls the pane under the overlay.
    const center = () =>
        page.evaluate(async () => {
            const { elevationViewport } = await window.editorTest.appImport<
                typeof import('../../src/editor/elevation/viewport')
            >('/src/editor/elevation/viewport.ts')
            return elevationViewport.center
        })
    const before = await center()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, 300)
    await expect.poll(center).not.toBe(before)
    await leave(page)
    await expect(overlay).toHaveCount(0)
    await expect(page.locator('.elevation-editor')).toBeVisible()
})

test('the Groups panel is read-only while peeking: visibility works, editing is refused', async ({
    page,
}) => {
    const first = await newestSeq(page)
    await page.evaluate(() => {
        window.editorTest.settings.showGroups = true
    })
    const panel = page.locator('#workspace-panel-groups')
    await expect(panel.locator('.manager-entry').first()).toBeVisible()
    await deleteAt(page, 3)
    await peek(page, first)
    const names = () =>
        page.evaluate(() =>
            [...window.editorTest.history.liveState.value.groups.values()].map(({ name }) => name),
        )
    const before = await names()
    const add = panel.locator('.manager-add').first()
    await expect(add).toHaveAttribute('aria-disabled', 'true')
    await add.click({ force: true })
    await expect(notice(page)).toHaveText('Read-only while viewing history')
    expect(await names()).toEqual(before)
    // An eye still hides and shows.
    const eye = panel.locator('.manager-entry .manager-eye').first()
    await eye.click()
    expect(
        await page.evaluate(() => [...window.editorTest.view.groupVisibility.values()]),
    ).toContain('hidden')
    await leave(page)
})

test('the Groups dialog opens while peeking: the current group changes, edits are refused', async ({
    page,
}) => {
    const first = await newestSeq(page)
    await deleteAt(page, 3)
    await peek(page, first)
    const names = () =>
        page.evaluate(() =>
            [...window.editorTest.history.liveState.value.groups.values()].map(({ name }) => name),
        )
    const before = await names()
    const groupCount = () =>
        page.evaluate(() => window.editorTest.history.liveState.value.groups.size)
    await page.keyboard.press('e')
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('tab', { selected: true })).toHaveText('Groups')

    // The current group is view state: it changes, and the peek stays.
    const other = dialog.locator('.manager-name').filter({ hasText: 'Other group' })
    await other.click()
    await expect.poll(() => page.evaluate(() => window.editorTest.view.groupId)).toBe(2)
    expect((await beats(page)).peeking).toBe(true)

    // Every edit is refused with the notice and changes nothing.
    await other.focus()
    await page.keyboard.press('F2')
    await expect(notice(page)).toHaveText('Read-only while viewing history')
    await expect(dialog.getByRole('textbox')).toHaveCount(0)
    expect(await names()).toEqual(before)
    expect(await groupCount()).toBe(before.length)
    // Enabling dynamic stages from the Stages tab is an edit too.
    await dialog.getByRole('tab', { name: 'Stages' }).click()
    await dialog.getByRole('button', { name: 'Enable Dynamic Stages' }).click()
    await expect(dialog).toHaveCount(1)
    expect(
        await page.evaluate(() => window.editorTest.history.liveState.value.isDynamicStages),
    ).toBe(false)
    expect((await beats(page)).peeking).toBe(true)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    expect((await beats(page)).peeking).toBe(true)
    await leave(page)
})

test('Properties shows the peeked values readable and selectable, and changes nothing', async ({
    page,
}) => {
    const first = await newestSeq(page)
    await page.evaluate(() => {
        window.editorTest.settings.showSidebar = true
    })
    await deleteAt(page, 3)
    await peek(page, first)
    const point = await notePoint(page, 3)
    await page.mouse.click(point.x, point.y)
    const beat = page.getByLabel('Beat', { exact: true }).first()
    await expect(beat).toBeVisible()
    // Beats show from 1.
    await expect(beat).toHaveValue('4')

    // Read-only, not disabled: at full strength, and its text can be selected and copied.
    await expect(beat).toBeEnabled()
    await expect(beat).toHaveAttribute('readonly', '')
    expect(
        await beat.evaluate((input) => {
            let opacity = 1
            for (let el: Element | null = input; el; el = el.parentElement)
                opacity *= Number(getComputedStyle(el).opacity)
            return opacity
        }),
    ).toBe(1)
    await beat.focus()
    expect(await page.evaluate(() => getSelection()?.toString())).toBe('4')

    // Typing and the arrow keys change nothing.
    await page.keyboard.type('9')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Enter')
    await expect(beat).toHaveValue('4')
    expect(await beats(page)).toEqual({ shown: [3, 5, 7, 9], live: [5, 7, 9], peeking: true })
    expect(await newestSeq(page)).toBe(first + 1)

    // Other controls are disabled.
    const selects = page.locator('#properties-section-selection select')
    for (const select of await selects.all()) await expect(select).toBeDisabled()
    await leave(page)
})

test('Group Properties opens while peeking with the peeked values and cannot change them', async ({
    page,
}) => {
    const first = await newestSeq(page)
    // The group is renamed after the first step, so the peek and the live chart differ.
    await page.evaluate(async () => {
        const { history, appImport } = window.editorTest
        const { groupEditOperation } = await appImport<
            typeof import('../../src/editor/headerLabels')
        >('/src/editor/headerLabels.ts')
        const id = 1 as never
        const object = history.state.value.groups.get(id)!
        const groups = new Map(history.state.value.groups)
        groups.set(id, { ...object, name: 'Renamed' })
        history.pushState(groupEditOperation(id, object, 'name', 'Renamed'), {
            ...history.state.value,
            groups,
        })
    })
    await peek(page, first)
    const liveNames = () =>
        page.evaluate(() =>
            [...window.editorTest.history.liveState.value.groups.values()].map(({ name }) => name),
        )
    expect(await liveNames()).toEqual(['Renamed', 'Other group'])

    await page.keyboard.press('e')
    const dialog = page.getByRole('dialog').first()
    const row = dialog.locator('.manager-row').filter({ hasText: 'Default' })
    await row.hover()
    await row.locator('.manager-inline-properties').click()

    const properties = page.getByRole('dialog', { name: 'Group Properties' })
    await expect(properties).toBeVisible()
    const name = properties.getByRole('textbox')
    await expect(name).toHaveValue('Default')
    await expect(name).toBeDisabled()
    expect(await liveNames()).toEqual(['Renamed', 'Other group'])
    expect((await beats(page)).peeking).toBe(true)

    // It follows the peek until the peek ends, and then it closes.
    await page.keyboard.press('Escape')
    await expect(properties).toHaveCount(0)
    await row.hover()
    await row.locator('.manager-inline-properties').click()
    await expect(properties).toBeVisible()
    await leave(page)
    await expect(properties).toHaveCount(0)
    expect(await liveNames()).toEqual(['Renamed', 'Other group'])
})

test('the selection menu holds only viewing actions while peeking', async ({ page }) => {
    const first = await newestSeq(page)
    await deleteAt(page, 3)
    await peek(page, first)
    const point = await notePoint(page, 7)
    await page.mouse.click(point.x, point.y, { button: 'right' })
    await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText([
        /^Copy/,
        'Edit Properties',
        'Find Edits Here',
    ])
    await page.keyboard.press('Escape')
    await leave(page)
})

test('Select Slide Notes in a peek selects the whole slide of the peeked chart only', async ({
    page,
}) => {
    // A chart with connected slides, as its own session.
    const previous = await sessionId(page)
    await page.evaluate(() => {
        window.editorTest.show(window.editorTest.fixtures.connectors, 3)
    })
    await storesNewSession(page, previous)
    const first = await newestSeq(page)
    await peek(page, first)
    const point = await notePoint(page, 3)
    await page.mouse.click(point.x, point.y, { button: 'right' })
    await page.getByRole('menuitem', { name: 'Select Slide Notes' }).click()
    expect(
        await page.evaluate(() => {
            const { history } = window.editorTest
            return [
                history.state.value.selectedEntities.length,
                history.liveState.value.selectedEntities.length,
            ]
        }),
    ).toEqual([3, 0])
    expect(await newestSeq(page)).toBe(first)
    await leave(page)
})

test('Level Info opens read-only while peeking', async ({ page }) => {
    const first = await newestSeq(page)
    await deleteAt(page, 3)
    await peek(page, first)
    await page.evaluate(async () => {
        const { appImport } = window.editorTest
        const [{ commands }, { runCommand }] = await Promise.all([
            appImport<typeof import('../../src/editor/commands')>('/src/editor/commands/index.ts'),
            appImport<typeof import('../../src/editor/commands/runCommand')>(
                '/src/editor/commands/runCommand.ts',
            ),
        ])
        void runCommand(commands.properties, 'button')
    })
    const dialog = page.getByRole('dialog')
    await expect(
        dialog.getByRole('spinbutton', { name: 'Initial Life', exact: true }),
    ).toBeDisabled()
    await expect(dialog.getByRole('textbox', { name: 'Title', exact: true })).toBeDisabled()
    // Nothing to confirm: the footer reads as the other read-only dialogs do.
    await expect(dialog.locator('input[type="submit"]')).toHaveValue('OK')
    // Checking the file stays available.
    await expect(dialog.getByRole('button', { name: 'Check', exact: true })).toBeEnabled()
    await page.keyboard.press('Escape')
    await leave(page)
})

test('Restore pushes the entry as an undoable step, and a matching one changes nothing', async ({
    page,
}) => {
    const first = await newestSeq(page)
    await deleteAt(page, 3)
    await peek(page, first)
    await restore(page, first)
    await expect(notice(page)).toHaveText(/^Restored to \d/)
    expect(await beats(page)).toEqual({ shown: [3, 5, 7, 9], live: [3, 5, 7, 9], peeking: false })
    await expect.poll(() => newestSeq(page)).toBe(first + 2)
    await restore(page, first)
    await expect(notice(page)).toHaveText('Already matches the current chart')
    expect(await newestSeq(page)).toBe(first + 2)
    await page.keyboard.press('z')
    expect((await beats(page)).live).toEqual([5, 7, 9])
})

/** A 12 s mono WAV whose loudness steps every 250 ms in a pattern that repeats every 750 ms. */
const steppedWav = (gain: number) => {
    const rate = 8000
    const samples = 12 * rate
    const data = Buffer.alloc(44 + samples * 2)
    data.write('RIFF', 0)
    data.writeUInt32LE(data.length - 8, 4)
    data.write('WAVEfmt ', 8)
    data.writeUInt32LE(16, 16)
    data.writeUInt16LE(1, 20)
    data.writeUInt16LE(1, 22)
    data.writeUInt32LE(rate, 24)
    data.writeUInt32LE(rate * 2, 28)
    data.writeUInt16LE(2, 32)
    data.writeUInt16LE(16, 34)
    data.write('data', 36)
    data.writeUInt32LE(samples * 2, 40)
    for (let index = 0; index < samples; index++) {
        const level = [0.9, 0.1, 0.5][Math.floor(index / (rate / 4)) % 3]!
        data.writeInt16LE(Math.round(Math.sin(index / 3) * level * gain * 32767), 44 + index * 2)
    }
    return data.toString('base64')
}

/** Picks a BGM with an offset in the BGM dialog. */
const pickBgm = async (page: Page, base64: string, offsetMs: string) => {
    await page.evaluate(async (base64) => {
        const bytes = Uint8Array.from(atob(base64), (value) => value.charCodeAt(0))
        const { changeBgm } = await window.editorTest.appImport<
            typeof import('../../src/editor/commands/bgm')
        >('/src/editor/commands/bgm/index.ts')
        void changeBgm(new File([bytes], 'song.wav', { type: 'audio/wav' }))
    }, base64)
    // Once the file is read: the loading dialog has closed.
    const dialog = page.getByRole('dialog')
    await expect(dialog).toHaveCount(1)
    await expect(dialog.locator('input[type="button"]')).toHaveValue(/\d/)
    await dialog.getByRole('spinbutton', { name: 'Offset (ms)', exact: true }).fill(offsetMs)
    await dialog.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect(dialog).toHaveCount(0)
}

/** The chart pane below the peek bars, notices masked, once two shots in a row agree. */
const chartShot = async (page: Page) => {
    const box = (await page.locator('canvas.editor-chart').boundingBox())!
    const options = {
        clip: { x: box.x + 8, y: box.y + 140, width: box.width - 16, height: box.height - 280 },
        mask: [notice(page)],
    }
    let previous = await page.screenshot(options)
    for (let tries = 0; tries < 20; tries++) {
        await page.evaluate(
            () =>
                new Promise((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(resolve)),
                ),
        )
        const shot = await page.screenshot(options)
        if (shot.equals(previous)) return shot
        previous = shot
    }
    throw new Error('The chart did not settle')
}

test('a step’s peek from before a BGM change draws the live waveform at the live offset', async ({
    page,
}) => {
    await page.evaluate(() => (window.editorTest.settings.waveform = 'volume'))
    await pickBgm(page, steppedWav(0.8), '0')
    const earlier = await newestSeq(page)
    await pickBgm(page, steppedWav(1), '400')
    const current = await newestSeq(page)
    expect(current).toBe(earlier + 1)

    // A step with the current BGM draws it at the step’s offset, here the live one.
    await peek(page, current)
    const live = await chartShot(page)
    // The earlier BGM’s offset does not fit the current audio, so the live offset stays.
    await peek(page, earlier)
    expect((await chartShot(page)).equals(live), 'the waveform moved').toBe(true)
    await leave(page)
})
