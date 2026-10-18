import { expect, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

export const editCount = 500
export const wholeChartEditCount = 50

/** The JS heap in use after forcing garbage collection, through CDP (Chromium only). */
export const measureHeap = async (page: Page) => {
    const client = await page.context().newCDPSession(page)
    try {
        await client.send('HeapProfiler.enable')
        // A collection can leave weakly held objects for the next one.
        for (let i = 0; i < 3; i++) await client.send('HeapProfiler.collectGarbage')
        const { usedSize } = await client.send('Runtime.getHeapUsage')
        return usedSize
    } finally {
        await client.detach()
    }
}

/** Opens the editor with the file input path, as the import specs do. */
export const openEditor = async (page: Page) => {
    await page.addInitScript(installCanvasCounters)
    await page.addInitScript(() => {
        Object.defineProperty(window, 'showOpenFilePicker', {
            configurable: true,
            value: undefined,
        })
    })
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
}

/** Imports level data through Open, as a user does. */
export const importLevelData = async (
    page: Page,
    name: string,
    buffer: Buffer,
    acknowledgeRevision = false,
) => {
    const opening = page.waitForEvent('filechooser')
    await page.keyboard.press('o')
    await (await opening).setFiles({ name, mimeType: 'application/json', buffer })
    // The open's notice offers Reopen on the session it replaced (§1.4.1), so only its text counts.
    await expect(page.locator('.notification').filter({ hasText: /^Opened level/ })).toBeVisible({
        timeout: 60_000,
    })
    // Level data from an older engine revision, such as coconut, opens with a warning.
    if (acknowledgeRevision)
        await page.getByRole('dialog').getByRole('button', { name: 'OK' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
}

/**
 * Makes `edits` undoable edits, every tenth a whole-chart one (select everything and move it),
 * the rest on one note each. Returns the counts and the time they took.
 */
export const makeEdits = (
    page: Page,
    edits = editCount,
    wholeEvery = edits / wholeChartEditCount,
) =>
    page.evaluate(
        async ({ edits, wholeEvery }) => {
            const { history, store, appImport } = window.editorTest
            const { editSelectedEditableEntities } = await appImport<
                typeof import('../../src/editor/sidebars/default')
            >('/src/editor/sidebars/default/index.ts')
            const { translateSelection } = await appImport<
                typeof import('../../src/state/operations/translateSelection')
            >('/src/state/operations/translateSelection.ts')
            const { isEditableEntity } = await appImport<
                typeof import('../../src/state/operations/editable')
            >('/src/state/operations/editable.ts')
            const notes = () =>
                [...history.state.value.store.slides.note.values()]
                    .flat()
                    .filter((note) => !note.isAttached)
            // One property at a time, each moving by a quarter and back.
            const properties = ['left', 'size', 'elevation', 'left'] as const

            const start = performance.now()
            let whole = 0
            let single = 0
            for (let i = 0; i < edits; i++) {
                const before = history.state.value
                if (i % wholeEvery === wholeEvery - 1) {
                    const all = [...store.getAllEntities()].filter(isEditableEntity)
                    const sign = whole % 2 ? -1 : 1
                    const moved = translateSelection(before, all, 'width', sign * 0.25)
                    if (moved === before) throw new Error('The whole-chart move changed nothing')
                    history.pushState(() => 'Move', moved)
                    whole++
                    continue
                }
                const candidates = notes()
                for (let tries = 0; ; tries++) {
                    if (tries > 20) throw new Error('No note accepted an edit')
                    const note = candidates[(i * 7919 + tries * 104729) % candidates.length]!
                    const property = properties[single % properties.length]!
                    const sign = Math.floor(single / properties.length) % 2 ? -1 : 1
                    history.replaceState({ ...history.state.value, selectedEntities: [note] })
                    const value = note[property]
                    editSelectedEditableEntities({ [property]: value + sign * 0.25 })
                    if (history.state.value !== before) break
                    history.replaceState({ ...history.state.value, selectedEntities: [] })
                }
                single++
            }
            return { whole, single, ms: performance.now() - start }
        },
        { edits, wholeEvery },
    )
