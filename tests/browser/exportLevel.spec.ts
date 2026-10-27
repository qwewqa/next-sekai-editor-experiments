import { expect, test, type Page } from '@playwright/test'
import type { PlatformOverride } from '../../src/platform/detect'
import { installCanvasCounters, installEditorFixture, installTestPlatform } from './editorFixture'

// Export Level Data…: Chromium's pickers run on OPFS handles through the
// platform override; download browsers are simulated with fileSystemAccess: false.

const errors = new WeakMap<Page, string[]>()

const start = async (page: Page, override: PlatformOverride) => {
    const collected: string[] = []
    errors.set(page, collected)
    page.on('pageerror', (error) => collected.push(error.message))
    await page.addInitScript(installCanvasCounters)
    await page.addInitScript(installTestPlatform, override)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    // A new chart, which has no name: the date fallback.
    await page.evaluate(() => {
        window.editorTest.history.resetState(false)
    })
}

test.afterEach(({ page }) => {
    expect(errors.get(page) ?? []).toEqual([])
})

type LevelChange = { bgmOffset?: number; archetype?: string; raw?: number[] }

/** Writes an OPFS file: this blank chart's level data, gzipped, with a change, or raw bytes. */
const writeFile = (page: Page, name: string, change: LevelChange = {}) =>
    page.evaluate(
        async ({ name, change }) => {
            let bytes: ArrayBuffer
            if (change.raw) bytes = new Uint8Array(change.raw).buffer
            else {
                const { buildLevelData } = await window.editorTest.appImport<
                    typeof import('../../src/editor/commands/exportLevel/build')
                >('/src/editor/commands/exportLevel/build.ts')
                const stream = (await buildLevelData())
                    .stream()
                    .pipeThrough(new DecompressionStream('gzip'))
                const json = JSON.parse(await new Response(stream).text()) as {
                    bgmOffset: number
                    entities: { archetype: string; data: unknown[] }[]
                }
                if (change.bgmOffset !== undefined) json.bgmOffset = change.bgmOffset
                if (change.archetype) json.entities.push({ archetype: change.archetype, data: [] })
                bytes = await new Response(
                    new Blob([JSON.stringify(json)])
                        .stream()
                        .pipeThrough(new CompressionStream('gzip')),
                ).arrayBuffer()
            }
            const root = await navigator.storage.getDirectory()
            const handle = await root.getFileHandle(name, { create: true })
            const writable = await handle.createWritable()
            await writable.write(bytes)
            await writable.close()
        },
        { name, change },
    )

/** An OPFS file: its level data's bgmOffset, 'zip' for a ZIP, or undefined when missing. */
const readFile = (page: Page, name: string) =>
    page.evaluate(async (name) => {
        const root = await navigator.storage.getDirectory()
        let file: File
        try {
            file = await (await root.getFileHandle(name)).getFile()
        } catch {
            return undefined
        }
        const head = new Uint8Array(await file.slice(0, 2).arrayBuffer())
        if (head[0] === 0x50 && head[1] === 0x4b) return 'zip'
        const stream = file.stream().pipeThrough(new DecompressionStream('gzip'))
        return (JSON.parse(await new Response(stream).text()) as { bgmOffset: number }).bgmOffset
    }, name)

const opfsNames = (page: Page) =>
    page.evaluate(async () => {
        const names: string[] = []
        const root = await navigator.storage.getDirectory()
        for await (const name of (root as unknown as { keys: () => AsyncIterable<string> }).keys())
            names.push(name)
        return names.sort()
    })

/** Queues the names the next picks return; null dismisses one. */
const queuePicks = (page: Page, picks: (string | null)[]) =>
    page.evaluate((picks) => {
        localStorage.setItem('nse.test.picks', JSON.stringify(picks))
    }, picks)

const pickerCalls = (page: Page) =>
    page.evaluate(
        () =>
            JSON.parse(localStorage.getItem('nse.test.pickerCalls') ?? '[]') as {
                picker: string
                id?: string
                suggestedName?: string
                types?: { accept: Record<string, string[]> }[]
            }[],
    )

// The notice region only: a Loading dialog's line is a status too.
const notice = (page: Page) => page.locator('[data-notice-region]')

/** Opens an OPFS file with Open, as Chromium's picker would. */
const openFile = async (page: Page, name: string) => {
    await queuePicks(page, [name])
    await page.keyboard.press('o')
    await expect(notice(page)).toHaveText('Opened level')
}

const dialog = (page: Page) => page.getByRole('dialog')

const opfs: PlatformOverride = { fileSystemAccess: 'opfs' }

/** Opens Export with Shift+P, once the dialog has placed its focus. */
const openExport = async (page: Page) => {
    await page.keyboard.press('Shift+P')
    // The field, or Export with a target; showModal() first focuses the close button.
    await expect(
        dialog(page).locator('[data-export-name]:focus, button[type="submit"]:focus'),
    ).toHaveCount(1)
}

test('Export names a new chart LevelData, from an empty field with the placeholder', async ({
    page,
}) => {
    await start(page, opfs)
    await openExport(page)
    await expect(dialog(page)).toHaveAccessibleName('Export Level Data')
    const field = dialog(page).getByRole('textbox', { name: 'File Name' })
    await expect(field).toHaveValue('')
    await expect(field).toHaveAttribute('placeholder', 'LevelData')
    await expect(field).toBeFocused()
    await expect(dialog(page).getByText('.nsld', { exact: true })).toBeVisible()
    await expect(dialog(page).getByText('To', { exact: true })).toHaveCount(0)

    await page.keyboard.press('Enter')
    await expect(notice(page)).toHaveText('Exported to LevelData.nsld')
    await expect(dialog(page)).toHaveCount(0)
    const [call] = await pickerCalls(page)
    expect(call).toMatchObject({ picker: 'save', id: 'levelData', suggestedName: 'LevelData.nsld' })
    expect(call?.types?.[0]?.accept).toEqual({ 'application/octet-stream': ['.nsld'] })
    expect(await readFile(page, 'LevelData.nsld')).toBe(0)

    // The pick is the target now.
    await openExport(page)
    await expect(dialog(page).locator('[data-export-target-name]')).toHaveText(
        'LevelData.nsld (your last export)',
    )
})

/** Opens the Save dialog, which stays open, and says if its Export line leads the body. */
const saveLineLeads = (page: Page) =>
    page.evaluate(async () => {
        const { saveUi } = await window.editorTest.appImport<
            typeof import('../../src/editor/save/dialogs')
        >('/src/editor/save/dialogs.ts')
        void saveUi.saveDialog({
            kind: 'save',
            name: 'Coconut',
            lines: [],
            history: { kind: 'available', ticked: true, locked: false },
            bgm: { kind: 'none' },
            peeking: false,
            estimate: { load: () => Promise.resolve(undefined) },
        })
        let line: Element | null = null
        for (let i = 0; i < 50 && !line; i++) {
            line = document.querySelector('[data-save-export]')
            if (!line) await new Promise((resolve) => setTimeout(resolve, 20))
        }
        const leads = !!line?.querySelector('[data-severity="info"]')
        return leads
    })

test('a finished Export makes the next Save dialog’s line plain; a cancelled one does not', async ({
    page,
}) => {
    await start(page, opfs)
    const flag = () =>
        page.evaluate(() => localStorage.getItem('sonolus-next-sekai-editor.exportUsed'))
    expect(await saveLineLeads(page)).toBe(true)
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)

    await openExport(page)
    await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog(page)).toHaveCount(0)
    expect(await flag()).toBeNull()
    expect(await saveLineLeads(page)).toBe(true)
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)

    await openExport(page)
    await page.keyboard.press('Enter')
    await expect(notice(page)).toHaveText('Exported to LevelData.nsld')
    expect(await flag()).toBe('true')
    expect(await saveLineLeads(page)).toBe(false)
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)
})

test('Export suggests the displayed name: the title before the BGM’s', async ({ page }) => {
    await start(page, opfs)
    await page.evaluate(() => {
        const { history, historySteps } = window.editorTest
        const state = history.state.value
        history.pushState(historySteps.futureInitialLife(state.initialLife, 990, 'Life 990'), {
            ...state,
            initialLife: 990,
            levelInfo: { ...state.levelInfo, title: 'Coconut (Master)' },
            bgm: { ...state.bgm, filename: 'song.mp3' },
        })
    })
    await openExport(page)
    await expect(dialog(page).getByRole('textbox', { name: 'File Name' })).toHaveValue(
        'Coconut (Master)',
    )
})

test('a prefilled name is selected when Export opens by keyboard, so typing replaces it', async ({
    page,
}) => {
    await start(page, opfs)
    await page.evaluate(() => {
        const { history, historySteps } = window.editorTest
        const state = history.state.value
        history.pushState(historySteps.futureInitialLife(state.initialLife, 990, 'Life 990'), {
            ...state,
            initialLife: 990,
            levelInfo: { ...state.levelInfo, title: 'kiwi' },
        })
    })
    await openExport(page)
    const field = dialog(page).getByRole('textbox', { name: 'File Name' })
    await expect(field).toHaveValue('kiwi')
    await page.keyboard.type('kiwi-hard')
    await expect(field).toHaveValue('kiwi-hard')
})

test('a typed name is checked, and a forbidden character disables Export at once', async ({
    page,
}) => {
    await start(page, opfs)
    await openExport(page)
    const field = dialog(page).getByRole('textbox', { name: 'File Name' })
    const exporting = dialog(page).getByRole('button', { name: 'Export' })
    await field.fill('Re:Zero')
    await expect(dialog(page).getByRole('alert')).toHaveText('A name cannot contain :')
    await expect(exporting).toBeDisabled()
    await field.fill('Coconut ')
    // The edge reason waits for a pause.
    await expect(dialog(page).getByRole('alert')).toHaveText(
        'A name cannot start or end with a dot or a space',
    )
    await expect(exporting).toBeDisabled()
    await field.fill('Coconut (Master)')
    await expect(dialog(page).getByRole('alert')).toHaveCount(0)
    await exporting.click()
    await expect(notice(page)).toHaveText('Exported to Coconut (Master).nsld')
    expect(await opfsNames(page)).toEqual(['Coconut (Master).nsld'])
})

test('an opened gzipped LevelData is the target, and the dialog shows only the To row', async ({
    page,
}) => {
    await start(page, opfs)
    await writeFile(page, 'LevelData')
    await openFile(page, 'LevelData')
    await openExport(page)
    await expect(dialog(page).locator('[data-export-target]')).toContainText('To')
    await expect(dialog(page).locator('[data-export-target-name]')).toHaveText(
        'LevelData (the file you opened)',
    )
    await expect(dialog(page).getByRole('textbox')).toHaveCount(0)
    await expect(dialog(page).getByRole('button', { name: 'Export' })).toBeFocused()

    await writeFile(page, 'LevelData', { bgmOffset: 0 })
    await page.keyboard.press('Enter')
    await expect(notice(page)).toHaveText('Exported to LevelData')
    expect(await pickerCalls(page)).toEqual([{ picker: 'open', id: 'nse-open' }])
    expect(await opfsNames(page)).toEqual(['LevelData'])
})

test('a changed target meets the conflict dialog’s Export form; Replace keeps nothing', async ({
    page,
}) => {
    await start(page, opfs)
    await writeFile(page, 'LevelData')
    await openFile(page, 'LevelData')
    // Another program changes the file.
    await writeFile(page, 'LevelData', { bgmOffset: 3 })

    await openExport(page)
    await page.keyboard.press('Enter')
    const conflict = dialog(page)
    await expect(conflict).toHaveAccessibleName('"LevelData" Changed')
    await expect(conflict).toContainText('“LevelData” has changed since you opened it here.')
    await expect(conflict).toContainText(/[\d.]+\skB.* · /)
    const buttons = conflict.locator('[data-choice-buttons] button')
    await expect(buttons).toHaveText(['Cancel', 'Replace', 'Choose Another…'])
    await expect(conflict.getByRole('button', { name: 'Choose Another…' })).toBeFocused()
    expect(await readFile(page, 'LevelData')).toBe(3)

    await page.waitForTimeout(350)
    await conflict.getByRole('button', { name: 'Replace' }).click()
    await expect(notice(page)).toHaveText('Exported to LevelData')
    expect(await readFile(page, 'LevelData')).toBe(0)
    expect(await opfsNames(page)).toEqual(['LevelData'])

    // After an export, a change is "since your last export".
    await writeFile(page, 'LevelData', { bgmOffset: 4 })
    await openExport(page)
    await expect(dialog(page).locator('[data-export-target-name]')).toHaveText(
        'LevelData (your last export)',
    )
    await page.keyboard.press('Enter')
    await expect(dialog(page)).toContainText('“LevelData” has changed since your last export.')
    await page.waitForTimeout(350)
    await dialog(page).getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog(page)).toHaveCount(0)
    expect(await readFile(page, 'LevelData')).toBe(4)
})

test('Choose Another… in the conflict dialog exports to the picked file', async ({ page }) => {
    await start(page, opfs)
    await writeFile(page, 'LevelData')
    await openFile(page, 'LevelData')
    await writeFile(page, 'LevelData', { bgmOffset: 3 })
    await openExport(page)
    await page.keyboard.press('Enter')
    await expect(dialog(page)).toHaveAccessibleName('"LevelData" Changed')
    await queuePicks(page, ['Copy.nsld'])
    await page.waitForTimeout(350)
    await page.keyboard.press('Enter')
    await expect(notice(page)).toHaveText('Exported to Copy.nsld')
    expect(await readFile(page, 'LevelData')).toBe(3)
    expect(await readFile(page, 'Copy.nsld')).toBe(0)
})

test('Export refuses to write over a .nxsp in its target’s place', async ({ page }) => {
    await start(page, opfs)
    await writeFile(page, 'LevelData')
    await openFile(page, 'LevelData')
    await writeFile(page, 'LevelData', { raw: [0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0] })
    await openExport(page)
    await page.keyboard.press('Enter')
    await expect(dialog(page)).toContainText('"LevelData" is not level data.')
    await expect(dialog(page).locator('[data-choice-buttons] button')).toHaveText([
        'Cancel',
        'Choose Another…',
    ])
    await expect(dialog(page).getByRole('button', { name: 'Choose Another…' })).toBeFocused()
    await page.waitForTimeout(350)
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)
    expect(await readFile(page, 'LevelData')).toBe('zip')
})

/** Opens level data with parts this build does not read, through its report dialog. */
const openPartial = async (page: Page, name: string) => {
    await writeFile(page, name, { archetype: 'Unheard' })
    await queuePicks(page, [name])
    await page.keyboard.press('o')
    // The dialog follows the open, in place of its notice.
    await expect(dialog(page)).toContainText(
        'This level has parts that this version of the editor does not support. They were left out.',
    )
    await dialog(page).getByRole('button', { name: 'OK' }).click()
    await expect(dialog(page)).toHaveCount(0)
}

/** An OPFS file's level data archetypes, or undefined when it is empty. */
const archetypes = (page: Page, name: string) =>
    page.evaluate(async (name) => {
        const root = await navigator.storage.getDirectory()
        const file = await (await root.getFileHandle(name)).getFile()
        if (!file.size) return undefined
        const stream = file.stream().pipeThrough(new DecompressionStream('gzip'))
        const json = JSON.parse(await new Response(stream).text()) as {
            entities: { archetype: string }[]
        }
        return json.entities.map(({ archetype }) => archetype)
    }, name)

test('level data with an unknown archetype gets no Export target', async ({ page }) => {
    await start(page, opfs)
    await openPartial(page, 'LevelData')

    await openExport(page)
    await expect(dialog(page).locator('[data-export-target]')).toHaveCount(0)
    // An unlinked copy: never the original's own name.
    const field = dialog(page).getByRole('textbox', { name: 'File Name' })
    await expect(field).toHaveValue('LevelData (2)')
    await expect(dialog(page).getByText('.nsld', { exact: true })).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(notice(page)).toHaveText('Exported to LevelData (2).nsld')
    // The original, with its unknown entity, is untouched.
    expect(await opfsNames(page)).toEqual(['LevelData', 'LevelData (2).nsld'])
    expect(await archetypes(page, 'LevelData')).toContain('Unheard')
})

test('a partial level picked anyway is refused and put back, through Export and p', async ({
    page,
}) => {
    await start(page, opfs)
    await openPartial(page, 'LevelData')

    await openExport(page)
    await queuePicks(page, ['LevelData'])
    await page.keyboard.press('Enter')
    await expect(dialog(page)).toContainText(
        '"LevelData" has parts that this version of the editor does not support.',
    )
    expect(await archetypes(page, 'LevelData')).toContain('Unheard')
    await page.waitForTimeout(350)
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)

    // p saves a project file: its picker refuses the opened level data too, and puts it back
    // with the Export hint.
    await queuePicks(page, ['LevelData'])
    await page.keyboard.press('p')
    await saveProjectFile(page)
    await expect(dialog(page)).toContainText('"LevelData" is not a project file.')
    await expect(dialog(page)).toContainText('For Sonolus, use Export Level Data…')
    expect((await pickerCalls(page)).at(-1)).toMatchObject({ picker: 'save', id: 'nse-project' })
    expect(await archetypes(page, 'LevelData')).toContain('Unheard')
    expect(await opfsNames(page)).toEqual(['LevelData'])
})

/** Presses Save in the Save dialog p opens on an unbound session. */
const saveProjectFile = async (page: Page) => {
    const save = dialog(page).filter({ hasText: 'Save Project File' })
    await expect(save).toBeVisible()
    await save.getByRole('button', { name: 'Save', exact: true }).click()
}

type Writes = { held?: boolean; release?: () => void; aborted?: boolean; failing?: boolean }

/** Holds each OPFS write() until released, or fails it while `failing`; records an abort. */
const holdWrites = (page: Page, mode: 'hold' | 'fail') =>
    page.evaluate((mode) => {
        const writes: Writes = ((window as unknown as { writes: Writes }).writes = {})
        const proto = FileSystemWritableFileStream.prototype
        const { write, abort } = proto
        writes.failing = mode === 'fail'
        proto.write = async function (this: FileSystemWritableFileStream, ...args) {
            if (writes.failing) throw new DOMException('Disk error', 'InvalidStateError')
            writes.held = true
            await new Promise<void>((resolve) => (writes.release = resolve))
            return write.apply(this, args)
        } as typeof write
        proto.abort = function (this: FileSystemWritableFileStream, ...args) {
            writes.aborted = true
            return abort.apply(this, args)
        } as typeof abort
    }, mode)

const writes = (page: Page) =>
    page.evaluate(() => {
        const { held, aborted } = (window as unknown as { writes: Writes }).writes
        return { held, aborted }
    })

test('Escape after a pick is accepted lets the write finish, then closes', async ({ page }) => {
    await start(page, opfs)
    // An earlier export, which the picker empties when it is picked.
    await writeFile(page, 'Coconut.nsld', { bgmOffset: 5 })
    await openExport(page)
    await dialog(page).getByRole('textbox', { name: 'File Name' }).fill('Coconut')
    await queuePicks(page, ['Coconut.nsld'])
    await holdWrites(page, 'hold')
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await writes(page)).held).toBe(true)

    await page.keyboard.press('Escape')
    await page.waitForTimeout(100)
    await expect(dialog(page)).toHaveAccessibleName('Export Level Data')
    await page.evaluate(() => (window as unknown as { writes: Writes }).writes.release?.())
    await expect(notice(page)).toHaveText('Exported to Coconut.nsld')
    await expect(dialog(page)).toHaveCount(0)
    expect(await readFile(page, 'Coconut.nsld')).toBe(0)
})

test('Cancel during a write to the target closes at once and leaves the target', async ({
    page,
}) => {
    await start(page, opfs)
    await writeFile(page, 'LevelData', { bgmOffset: 3 })
    await openFile(page, 'LevelData')
    await page.evaluate(() => {
        window.editorTest.history.pushState(
            window.editorTest.historySteps.nativeOperation(
                {
                    id: 'nse.header.set',
                    data: {
                        field: 'bgmOffset',
                        before: window.editorTest.history.state.value.bgm.offset,
                        after: 2,
                    },
                },
                'Set BGM Offset to 2',
            ),
            {
                ...window.editorTest.history.state.value,
                bgm: { ...window.editorTest.history.state.value.bgm, offset: 2 },
            },
        )
    })
    await holdWrites(page, 'hold')
    for (const close of ['Cancel', 'Close'] as const) {
        await openExport(page)
        await page.keyboard.press('Enter')
        await expect.poll(async () => (await writes(page)).held).toBe(true)
        await dialog(page).getByRole('button', { name: close, exact: true }).click()
        await expect(dialog(page)).toHaveCount(0)
        await page.evaluate(() => {
            const held = (window as unknown as { writes: Writes }).writes
            held.held = false
            held.release?.()
        })
        await expect.poll(async () => (await writes(page)).aborted).toBe(true)
        await page.evaluate(
            () => ((window as unknown as { writes: Writes }).writes.aborted = false),
        )
        expect(await readFile(page, 'LevelData')).toBe(3)
        await expect(dialog(page)).toHaveCount(0)
    }
})

test('p’s failed download of a refused pick’s bytes says so in its own words', async ({ page }) => {
    await start(page, opfs)
    await openPartial(page, 'LevelData')
    // Putting the bytes back fails, so the file stays as the picker left it.
    await holdWrites(page, 'fail')
    await queuePicks(page, ['LevelData'])
    await page.keyboard.press('p')
    await saveProjectFile(page)
    await expect(
        page.getByText('"LevelData" was emptied and its contents could not be restored.'),
    ).toBeVisible()
    await page.evaluate(() => {
        URL.createObjectURL = () => {
            throw new TypeError('Failed to execute createObjectURL')
        }
    })
    await page.waitForTimeout(350)
    await page.getByRole('button', { name: 'Download' }).click()
    await expect(page.getByText('"LevelData" could not be downloaded.')).toBeVisible()
    await expect(page.getByText(/createObjectURL/)).toHaveCount(0)
})

test('Choose Another… on an opened LevelData suggests its own name, "All files" alone', async ({
    page,
}) => {
    await start(page, opfs)
    await writeFile(page, 'LevelData')
    await openFile(page, 'LevelData')
    await openExport(page)
    await queuePicks(page, ['LevelData'])
    await dialog(page).getByRole('button', { name: 'Choose Another…' }).click()
    await expect(notice(page)).toHaveText('Exported to LevelData')
    // Chromium appends "All files" after any listed type, so it is first only when alone.
    expect((await pickerCalls(page)).at(-1)).toEqual({
        picker: 'save',
        id: 'levelData',
        suggestedName: 'LevelData',
    })
})

test('Export shows one name: the field and the picker agree, for the source and for an edit', async ({
    page,
}) => {
    await start(page, opfs)
    await writeFile(page, 'LevelData')
    await openFile(page, 'LevelData')
    // No target (as after another chain took it): the dialog shows the field.
    await page.evaluate(async () => {
        const { exportMemory } = await window.editorTest.appImport<
            typeof import('../../src/editor/commands/exportLevel/memory')
        >('/src/editor/commands/exportLevel/memory.ts')
        delete exportMemory.target
    })
    await openExport(page)
    const field = dialog(page).getByRole('textbox', { name: 'File Name' })
    await expect(field).toHaveValue('LevelData')
    await expect(dialog(page).getByText('.nsld', { exact: true })).toHaveCount(0)
    await queuePicks(page, ['Elsewhere'])
    await page.keyboard.press('Enter')
    await expect(notice(page)).toHaveText('Exported to Elsewhere')
    // "All files" alone, so the source's own name is suggested as it is.
    expect((await pickerCalls(page)).at(-1)).toMatchObject({
        picker: 'save',
        id: 'levelData',
        suggestedName: 'LevelData',
    })

    // The pick became the target; forget it again, then edit the name.
    await page.evaluate(async () => {
        const { exportMemory } = await window.editorTest.appImport<
            typeof import('../../src/editor/commands/exportLevel/memory')
        >('/src/editor/commands/exportLevel/memory.ts')
        delete exportMemory.target
    })
    await openExport(page)
    await field.fill('Coconut Expert')
    await expect(dialog(page).getByText('.nsld', { exact: true })).toBeVisible()
    await queuePicks(page, ['Elsewhere 2'])
    await page.keyboard.press('Enter')
    await expect(notice(page)).toHaveText('Exported to Elsewhere 2')
    const call = (await pickerCalls(page)).at(-1)
    expect(call).toMatchObject({ picker: 'save', suggestedName: 'Coconut Expert.nsld' })
    // The `.nsld` type first, which a typed name keeps.
    expect(JSON.stringify(call?.types)).toContain('.nsld')
})

test('both gzip paths carry the same level data, and a browser without streams uses level 9', async ({
    page,
}) => {
    await start(page, opfs)
    const result = await page.evaluate(async () => {
        const { buildLevelData, buildLevelDataVariants } = await window.editorTest.appImport<
            typeof import('../../src/editor/commands/exportLevel/build')
        >('/src/editor/commands/exportLevel/build.ts')
        const { gunzipBlob } = await window.editorTest.appImport<
            typeof import('../../src/utils/gzipStream')
        >('/src/utils/gzipStream.ts')
        const text = async (blob: Blob) => {
            const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'))
            return new Response(stream).text()
        }
        const bytes = async (blob: Blob) => Array.from(new Uint8Array(await blob.arrayBuffer()))
        const variants = await buildLevelDataVariants()
        const texts = await Promise.all(variants.map(text))
        const built = await buildLevelData()
        const type = built.type
        const same =
            JSON.stringify(await bytes(built)) === JSON.stringify(await bytes(variants[0]!))

        // Without streams: the script's level 9 bytes, and its own reader.
        const streams = { c: window.CompressionStream, d: window.DecompressionStream }
        Object.assign(window, { CompressionStream: undefined, DecompressionStream: undefined })
        try {
            const without = await buildLevelData()
            const only = await buildLevelDataVariants()
            const read = new TextDecoder().decode(await gunzipBlob(without))
            return {
                count: variants.length,
                equal: texts.every((value) => value === texts[0]),
                type,
                nativeIsFirst: same,
                level9:
                    JSON.stringify(await bytes(without)) ===
                    JSON.stringify(await bytes(variants[1]!)),
                onlyOne: only.length,
                read: read === texts[0],
                nonEmpty: texts[0]!.includes('"entities"'),
            }
        } finally {
            Object.assign(window, { CompressionStream: streams.c, DecompressionStream: streams.d })
        }
    })
    expect(result).toEqual({
        count: 2,
        equal: true,
        type: 'application/octet-stream',
        nativeIsFirst: true,
        level9: true,
        onlyOne: 1,
        read: true,
        nonEmpty: true,
    })
})

test('plain-JSON level data gets no Export target', async ({ page }) => {
    await start(page, opfs)
    const json = await page.evaluate(async () => {
        const { buildLevelData } = await window.editorTest.appImport<
            typeof import('../../src/editor/commands/exportLevel/build')
        >('/src/editor/commands/exportLevel/build.ts')
        const stream = (await buildLevelData())
            .stream()
            .pipeThrough(new DecompressionStream('gzip'))
        return Array.from(new Uint8Array(await new Response(stream).arrayBuffer()))
    })
    await writeFile(page, 'LevelData.json', { raw: json })
    await openFile(page, 'LevelData.json')
    await openExport(page)
    await expect(dialog(page).locator('[data-export-target]')).toHaveCount(0)
    await expect(dialog(page).getByRole('textbox', { name: 'File Name' })).toBeVisible()
})

test('while peeking, Export says it exports the current version', async ({ page }) => {
    await start(page, opfs)
    await openExport(page)
    await expect(dialog(page).getByText('Exports the current version.')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)
    await page.evaluate(async () => {
        const { peek, state } =
            await window.editorTest.appImport<typeof import('../../src/history/stack')>(
                '/src/history/stack.ts',
            )
        peek.value = { source: 'test', state: state.value }
    })
    await openExport(page)
    await expect(dialog(page).getByText('Exports the current version.')).toBeVisible()
})

test('an opened gzipped LevelData: p saves a project file, and Shift+P exports to the target', async ({
    page,
}) => {
    await start(page, opfs)
    await writeFile(page, 'LevelData')
    await openFile(page, 'LevelData')
    await page.evaluate(() => {
        window.editorTest.history.pushState(
            window.editorTest.historySteps.nativeOperation(
                {
                    id: 'nse.header.set',
                    data: {
                        field: 'bgmOffset',
                        before: window.editorTest.history.state.value.bgm.offset,
                        after: 2,
                    },
                },
                'Set BGM Offset to 2',
            ),
            {
                ...window.editorTest.history.state.value,
                bgm: { ...window.editorTest.history.state.value.bgm, offset: 2 },
            },
        )
    })
    // p never writes level data: its picker suggests a project file.
    await queuePicks(page, ['coconut.nxsp'])
    await page.keyboard.press('p')
    await saveProjectFile(page)
    await expect(notice(page)).toHaveText('Saved to coconut.nxsp')
    expect(await readFile(page, 'LevelData')).toBe(0)

    await openExport(page)
    await page.keyboard.press('Enter')
    await expect(notice(page)).toHaveText('Exported to LevelData')
    await expect(dialog(page)).toHaveCount(0)
    expect(await readFile(page, 'LevelData')).toBe(2)
})

test('on a download browser, an imported LevelData keeps its own name', async ({ page }) => {
    await start(page, { fileSystemAccess: false })
    const level = await page.evaluate(async () => {
        const { buildLevelData } = await window.editorTest.appImport<
            typeof import('../../src/editor/commands/exportLevel/build')
        >('/src/editor/commands/exportLevel/build.ts')
        return Array.from(new Uint8Array(await (await buildLevelData()).arrayBuffer()))
    })
    const chooser = page.waitForEvent('filechooser')
    await page.keyboard.press('o')
    await (
        await chooser
    ).setFiles({
        name: 'LevelData',
        mimeType: 'application/octet-stream',
        buffer: Buffer.from(level),
    })
    await expect(notice(page)).toHaveText('Opened level')

    await openExport(page)
    const field = dialog(page).getByRole('textbox', { name: 'File Name' })
    await expect(field).toHaveValue('LevelData')
    await expect(dialog(page).getByText('.nsld', { exact: true })).toHaveCount(0)
    let download = page.waitForEvent('download')
    await page.keyboard.press('Enter')
    expect((await download).suggestedFilename()).toBe('LevelData')
    await expect(notice(page)).toHaveText(/^Download started: LevelData · [\d.]+\skB/)

    // An edited name gets the extension.
    await openExport(page)
    await field.fill('Coconut')
    await expect(dialog(page).getByText('.nsld', { exact: true })).toBeVisible()
    download = page.waitForEvent('download')
    await page.keyboard.press('Enter')
    expect((await download).suggestedFilename()).toBe('Coconut.nsld')
})

test('a build that outlasted the gesture asks for one more tap', async ({ page }) => {
    await start(page, { fileSystemAccess: false, activation: false })
    await openExport(page)
    await page.keyboard.press('Enter')
    const preparing = dialog(page).locator('[data-export-preparing]')
    await expect(preparing).toHaveText(/^Ready: LevelData\.nsld · [\d.]+\skB/)
    const button = dialog(page).getByRole('button', { name: 'Download' })
    await expect(button).toBeFocused()
    const download = page.waitForEvent('download')
    await button.click()
    expect((await download).suggestedFilename()).toBe('LevelData.nsld')
    await expect(dialog(page)).toHaveCount(0)
    await expect(notice(page)).toHaveText(/^Download started: LevelData\.nsld/)
})

test('a dropped file opens nothing and leaves the page where it is', async ({ page }) => {
    await start(page, opfs)
    const url = page.url()
    const result = await page.evaluate(() => {
        const data = new DataTransfer()
        data.items.add(new File(['{"entities":[]}'], 'LevelData.json'))
        const fire = (type: string) => {
            const event = new DragEvent(type, {
                dataTransfer: data,
                bubbles: true,
                cancelable: true,
            })
            document.querySelector('canvas.editor-chart')?.dispatchEvent(event)
            return event.defaultPrevented
        }
        return { dragover: fire('dragover'), drop: fire('drop') }
    })
    expect(result).toEqual({ dragover: true, drop: true })
    await expect(notice(page)).toHaveText('To open a file, use Open…')
    expect(page.url()).toBe(url)
    await expect(dialog(page)).toHaveCount(0)
})

test('a link dragged onto a checkbox is held; only text fields take it', async ({ page }) => {
    await start(page, opfs)
    const result = await page.evaluate(() => {
        const fire = (target: Element) => {
            const data = new DataTransfer()
            data.setData('text/uri-list', 'https://example.com/')
            const event = new DragEvent('dragover', {
                dataTransfer: data,
                bubbles: true,
                cancelable: true,
            })
            target.dispatchEvent(event)
            return event.defaultPrevented
        }
        const checkbox = document.createElement('input')
        checkbox.type = 'checkbox'
        const text = document.createElement('input')
        document.body.append(checkbox, text)
        const held = { checkbox: fire(checkbox), text: fire(text) }
        checkbox.remove()
        text.remove()
        return held
    })
    expect(result).toEqual({ checkbox: true, text: false })
})

test('Shift+P exports; p with Caps Lock still saves', async ({ page }) => {
    await start(page, opfs)
    // Caps Lock reports an uppercase key without Shift.
    await page.keyboard.press('P')
    await expect(dialog(page).filter({ hasText: 'Save Project File' })).toBeVisible()
    expect(await pickerCalls(page)).toEqual([])
})

test('the P default stays unbound where the user already took the key', async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem(
            'sonolus-next-sekai-editor.keyboardShortcuts',
            JSON.stringify({ open: 'o', save: 'p', flip: 'P' }),
        )
    })
    await start(page, opfs)
    expect(
        await page.evaluate(() => window.editorTest.settings.keyboardShortcuts.exportLevel),
    ).toBe('')
})

test('the toolbar step adds Export Level Data before Save once', async ({ page }) => {
    await page.addInitScript(() => {
        if (sessionStorage.getItem('seeded')) return
        sessionStorage.setItem('seeded', '1')
        localStorage.setItem(
            'sonolus-next-sekai-editor.toolbar',
            JSON.stringify([['undo', 'save'], ['play']]),
        )
        localStorage.removeItem('sonolus-next-sekai-editor.toolbarExportMigrated')
    })
    await start(page, opfs)
    const toolbar = () => page.evaluate(() => window.editorTest.settings.toolbar)
    expect((await toolbar())[0]).toEqual(['undo', 'exportLevel', 'save'])
    expect(
        await page.evaluate(() =>
            localStorage.getItem('sonolus-next-sekai-editor.toolbarExportMigrated'),
        ),
    ).toBe('true')

    // Removing it afterwards is a customisation, kept across a reload.
    await page.evaluate(() => {
        const { settings } = window.editorTest
        settings.toolbar = settings.toolbar.map((group) =>
            group.filter((name) => name !== 'exportLevel'),
        )
    })
    await page.reload()
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    expect((await toolbar())[0]).toEqual(['undo', 'save'])
})

test('the toolbar step adds Save As and History to the old default groups once', async ({
    page,
}) => {
    const file = ['utilities', 'properties', 'reset', 'exportLevel', 'save', 'open']
    const undo = ['paste', 'cut', 'copy', 'redo', 'undo']
    await page.addInitScript(
        ([file, undo]) => {
            if (sessionStorage.getItem('seeded')) return
            sessionStorage.setItem('seeded', '1')
            localStorage.setItem(
                'sonolus-next-sekai-editor.toolbar',
                JSON.stringify([file, ['play'], undo, ['select']]),
            )
            localStorage.removeItem('sonolus-next-sekai-editor.toolbarSessionRestoreMigrated')
            // The earlier steps are done, so only this one is seen.
            for (const flag of [
                'toolbarEditorLayoutMigrated',
                'toolbarExportMigrated',
                'toolbarPreviewAssetsMigrated',
            ])
                localStorage.setItem(`sonolus-next-sekai-editor.${flag}`, 'true')
        },
        [file, undo],
    )
    await start(page, opfs)
    const toolbar = () => page.evaluate(() => window.editorTest.settings.toolbar)
    expect(await toolbar()).toEqual([
        ['utilities', 'properties', 'reset', 'exportLevel', 'saveAs', 'save', 'open'],
        ['play'],
        ['paste', 'cut', 'copy', 'history', 'redo', 'undo'],
        ['select'],
    ])
    expect(
        await page.evaluate(() =>
            localStorage.getItem('sonolus-next-sekai-editor.toolbarSessionRestoreMigrated'),
        ),
    ).toBe('true')

    // Removing Save As afterwards is a customisation, kept across a reload.
    await page.evaluate(() => {
        const { settings } = window.editorTest
        settings.toolbar = settings.toolbar.map((group) =>
            group.filter((name) => name !== 'saveAs'),
        )
    })
    await page.reload()
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    expect((await toolbar())[0]).toEqual(file)
})
