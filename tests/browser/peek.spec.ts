import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// Peek (Part 1 §1.4.11) and its gating: an entry's state shown read-only while writers keep the
// live state, commands and tools refused with the notice, Undo leaving first, drags and scaling
// sessions cancelled, the disabled panels, the Elevation Editor closed or behind its overlay,
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
    await page.evaluate(installEditorFixture)
    // Storing follows the fixture's chart: its session is the one peeked.
    await expect
        .poll(() =>
            page.evaluate(async () => {
                const { flusher } =
                    await window.editorTest.appImport<typeof import('../../src/local/storing')>(
                        '/src/local/storing.ts',
                    )
                return flusher?.session?.pending.length ?? 0
            }),
        )
        .toBeGreaterThan(0)
})

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

test('an entry no longer in memory is read from storage, verified', async ({ page }) => {
    await deleteAt(page, 3)
    const dropped = await newestSeq(page)
    await page.keyboard.press('z')
    // A new edit drops the first from redo: its state is held only in storage now.
    await deleteAt(page, 9)
    await page.evaluate(async () => {
        const { flusher } =
            await window.editorTest.appImport<typeof import('../../src/local/storing')>(
                '/src/local/storing.ts',
            )
        await flusher!.flush()
        await flusher!.flush()
        if (flusher!.hasPending) throw new Error('Still pending')
    })
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

test('Properties shows fields disabled while peeking', async ({ page }) => {
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
    await expect(beat).toBeDisabled()
    await leave(page)
})

test('the selection menu holds only Copy and Find Edits Here while peeking', async ({ page }) => {
    const first = await newestSeq(page)
    await deleteAt(page, 3)
    await peek(page, first)
    const point = await notePoint(page, 7)
    await page.mouse.click(point.x, point.y, { button: 'right' })
    await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText([
        /^Copy/,
        'Find Edits Here',
    ])
    await page.keyboard.press('Escape')
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
        void runCommand(commands.properties)
    })
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('spinbutton')).toBeDisabled()
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
    expect(await newestSeq(page)).toBe(first + 2)
    await restore(page, first)
    await expect(notice(page)).toHaveText('Already matches the current chart')
    expect(await newestSeq(page)).toBe(first + 2)
    await page.keyboard.press('z')
    expect((await beats(page)).live).toEqual([5, 7, 9])
})
