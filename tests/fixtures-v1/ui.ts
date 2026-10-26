import { expect, type Locator, type Page } from '@playwright/test'
import { confirmWhenReady } from '../browser/confirmWhenReady'
import { png, wav } from '../browser/levelInfoFiles'
import { queuePicks } from '../browser/saveFlows'
import type { Tab } from './world'

// What a person does in the editor, as the steps use it: each helper makes the entries it names and
// waits until they exist.

export { png, wav }

/** Runs an action that makes an entry and waits for it; fails when it makes none. */
export const made = async (tab: Tab, what: string, fn: () => Promise<unknown>) => {
    const after = await tab.act(fn, 8000)
    if (!after) throw new Error(`No entry after: ${what}`)
    return after
}

const toolsInfo = (page: Page) =>
    page.evaluate(async () => {
        const { toolName } = await import('/src/editor/tools/index.ts')
        return toolName.value as string
    })

/** Presses a tool's key and waits until the tool is the one named (event tools cycle on one key). */
export const selectTool = async (tab: Tab, key: string, name: string) => {
    if ((await toolsInfo(tab.page)) === name) return
    for (let i = 0; i < 6; i++) {
        await tab.command(key)
        await tab.page.waitForTimeout(60)
        if ((await toolsInfo(tab.page)) === name) return
    }
    throw new Error(`Tool ${name} not reached with ${key}`)
}

/** A tap at a lane and beat with the Note tool's first preset. */
export const placeNote = async (tab: Tab, lane: number, beat: number) => {
    await tab.focus(beat)
    await made(tab, `note at ${beat}`, () => tab.click(lane, beat))
}

/** The BGM dialog's file chooser: picks a file and confirms. */
export const pickBgm = async (tab: Tab, name: string, buffer: Buffer) => {
    const { page } = tab
    await tab.command('m')
    const modal = page.getByRole('dialog')
    const field = modal.locator('input[type="button"]')
    const choosing = page.waitForEvent('filechooser')
    await field.click()
    await (await choosing).setFiles({ name, mimeType: 'audio/wav', buffer })
    await expect(field).toHaveValue(/^00:/)
    await made(tab, 'BGM', () =>
        modal.getByRole('button', { name: 'Confirm', exact: true }).click(),
    )
    await expect(modal).toHaveCount(0)
}

export const levelInfoDialog = (page: Page) =>
    page.getByRole('dialog', { name: 'Level Info', exact: true })

export const openLevelInfo = async (page: Page) => {
    await page.locator('[data-status-label]').click()
    const dialog = levelInfoDialog(page)
    await expect(dialog).toBeVisible()
    return dialog
}

const typeInto = async (input: Locator, value: string) => {
    await input.fill(value)
    await input.press('Tab')
}

const chooseFile = async (
    page: Page,
    button: Locator,
    file: { name: string; mimeType: string; buffer: Buffer },
) => {
    const chooser = page.waitForEvent('filechooser')
    await button.click()
    await (await chooser).setFiles(file)
}

export type LevelInfoEdit = {
    title?: string
    artists?: string
    author?: string
    description?: string
    cover?: { name: string; buffer: Buffer }
    preview?: { name: string; buffer: Buffer }
}

/** Level Info: the fields typed, a cover and a preview picked, Confirm: one step. */
export const editLevelInfo = async (tab: Tab, edit: LevelInfoEdit) => {
    const { page } = tab
    const form = await openLevelInfo(page)
    const field = (name: string) => form.getByRole('textbox', { name, exact: true })
    if (edit.title !== undefined) await typeInto(field('Title'), edit.title)
    if (edit.artists !== undefined) await typeInto(field('Artists'), edit.artists)
    if (edit.author !== undefined) await typeInto(field('Author'), edit.author)
    if (edit.description !== undefined) await typeInto(field('Description'), edit.description)
    if (edit.cover) {
        await chooseFile(page, form.locator('[data-level-info-cover-choose]'), {
            name: edit.cover.name,
            mimeType: 'image/png',
            buffer: edit.cover.buffer,
        })
        await expect(form.locator('[data-level-info-thumbnail]')).toBeVisible()
    }
    if (edit.preview) {
        await chooseFile(page, form.locator('[data-level-info-preview-choose]'), {
            name: edit.preview.name,
            mimeType: 'audio/wav',
            buffer: edit.preview.buffer,
        })
        await expect(form.locator('[data-level-info-preview-play]')).toBeVisible()
    }
    await made(tab, 'Level Info', () =>
        form.getByRole('button', { name: 'Confirm', exact: true }).click(),
    )
    await expect(levelInfoDialog(page)).toHaveCount(0)
}

/** Shows a side panel by its tab's title (Groups, Stages) and returns it. */
export const showPanel = async (page: Page, which: 'Groups' | 'Stages') => {
    const panel = page.locator(`#workspace-panel-${which.toLowerCase()}`)
    if (!(await panel.isVisible())) await page.getByTitle(`Show ${which}`).click()
    await expect(panel).toBeVisible()
    return panel
}

/** Adds a group or stage named `name` through its panel's Add button. */
export const addNamed = async (tab: Tab, which: 'Groups' | 'Stages', name: string) => {
    const panel = await showPanel(tab.page, which)
    await made(tab, `add ${which}`, () =>
        panel.getByRole('button', { name: `Add ${which.slice(0, -1)}` }).click(),
    )
    const input = panel.getByRole('textbox')
    await input.fill(name)
    await made(tab, `name ${name}`, () => input.press('Enter'))
}

/** Moves an entry of the panel into a new folder, which gets `folder` as its name. */
export const moveIntoNewFolder = async (
    tab: Tab,
    which: 'Groups' | 'Stages',
    entry: string,
    folder: string,
) => {
    const panel = await showPanel(tab.page, which)
    const menu = tab.page.getByRole('menu')
    await panel.getByRole('button', { name: `More Actions for ${entry}`, exact: true }).click()
    await menu.getByRole('menuitem', { name: 'Move to Folder…' }).click()
    await made(tab, `new folder ${folder}`, () =>
        menu.getByRole('menuitem', { name: 'New Folder' }).click(),
    )
    const input = panel.getByRole('textbox')
    await expect(input).toBeFocused()
    await input.fill(folder)
    await made(tab, `name folder ${folder}`, () => input.press('Enter'))
}

/** Stages panel: Enable Dynamic Stages and its confirm. */
export const enableDynamicStages = async (tab: Tab) => {
    const stages = await showPanel(tab.page, 'Stages')
    const dialog = tab.page.getByRole('dialog', { name: 'Dynamic Stages', exact: true })
    await stages.getByRole('button', { name: 'Enable Dynamic Stages' }).click()
    await expect(dialog).toBeVisible()
    await made(tab, 'dynamic stages', () =>
        confirmWhenReady(dialog.getByRole('button', { name: 'Confirm', exact: true }), dialog),
    )
}

/** Undo or Redo with its key; waits for the entry it makes. */
export const undo = (tab: Tab, times = 1) => repeatKey(tab, 'z', times, 'Undo')
export const redo = (tab: Tab, times = 1) => repeatKey(tab, 'y', times, 'Redo')

const repeatKey = async (tab: Tab, key: string, times: number, what: string) => {
    for (let i = 0; i < times; i++) await made(tab, what, () => tab.command(key))
}

/** The Timeline's list, opened with its key. */
export const openTimeline = async (page: Page) => {
    const list = page.locator('[data-history-list]')
    if (!(await list.isVisible())) {
        await page.evaluate(() => {
            const active = document.activeElement
            if (active instanceof HTMLElement && active !== document.body) active.blur()
        })
        await page.keyboard.press('Shift+H')
    }
    await list.waitFor()
    return list
}

export const closeTimeline = async (page: Page) => {
    if (await page.locator('[data-history-list]').isVisible()) {
        await page.evaluate(() => {
            const active = document.activeElement
            if (active instanceof HTMLElement && active !== document.body) active.blur()
        })
        await page.keyboard.press('Shift+H')
        await expect(page.locator('[data-history-list]')).toHaveCount(0)
    }
}

/** Timeline Restore: a right click on a row (the list is windowed: wheel until it is drawn), then Restore. */
export const restoreRow = async (tab: Tab, label: string | RegExp, nth = 0) => {
    const { page } = tab
    const list = await openTimeline(page)
    await made(tab, `restore ${String(label)}`, async () => {
        const row = list.getByRole('row').filter({ hasText: label }).nth(nth)
        const box = await list.boundingBox()
        if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        for (let i = 0; i < 200 && !(await row.count()); i++) {
            await page.mouse.wheel(0, 300)
            await page.waitForTimeout(40)
        }
        if (!(await row.count())) throw new Error(`No Timeline row ${String(label)}`)
        await row.scrollIntoViewIfNeeded()
        await row.click({ button: 'right' })
        await page.getByRole('menuitem', { name: 'Restore' }).click()
    })
    await closeTimeline(page)
}

/** A tap with the Note tool, the view centred on the beat first unless `focus` is false. */
export const tapAt = async (tab: Tab, lane: number, beat: number, focus = true) => {
    if (focus) await tab.focus(beat)
    return made(tab, `note at ${beat}`, () => tab.click(lane, beat))
}

/**
 * Taps in a region past the level's last note until the open session holds more than `target`
 * entries: three lanes that never overlap, two beats a row.
 */
export const fillEntries = async (tab: Tab, target: number, from = 400) => {
    for (let i = 0; ; i++) {
        if (i % 24 === 0) {
            if ((await tab.head()).seq > target) return
            await tab.focus(from + (i / 24) * 16 + 6)
        }
        await tapAt(tab, [-5, -1, 3][i % 3]!, from + Math.floor(i / 3) * 2, false)
    }
}

/** Export Level Data (Shift+P): the dialog's File Name, then Enter; one `export` entry. */
export const exportLevel = async (tab: Tab, name: string) => {
    await tab.command('Shift+P')
    const field = tab.page.getByRole('dialog').getByRole('textbox', { name: 'File Name' })
    await field.fill(name)
    await made(tab, 'export', () => field.press('Enter'))
    await expect(tab.page.getByRole('dialog')).toHaveCount(0)
}

export type SaveAsOptions = {
    /** The file the picker returns (the override's pick), in the device's OPFS. */
    pick?: string
    /** History and BGM rows: true or false sets the box; undefined leaves it. */
    history?: boolean
    bgm?: boolean
    /** The File Name; the dialog's own suggestion when left out. */
    name?: string
}

/**
 * Save As… (a new `docId`) or, with `plain`, Save of a chain with no file (the same dialog, titled
 * Save Project File, and the chain's own `docId`): the dialog with its rows set, then Save.
 */
export const saveAs = async (tab: Tab, options: SaveAsOptions & { plain?: boolean } = {}) => {
    const { page } = tab
    if (options.plain) await page.keyboard.press('p')
    else await tab.saveAs()
    const dialog = tab.saveDialog(options.plain ? 'Save Project File' : 'Save As')
    await expect(dialog).toBeVisible()
    if (options.history !== undefined)
        await dialog.locator('[data-save-row="history"] input').setChecked(options.history)
    if (options.bgm !== undefined)
        await dialog.locator('[data-save-row="bgm"] input').setChecked(options.bgm)
    if (options.name !== undefined) await dialog.getByRole('textbox').fill(options.name)
    if (options.pick !== undefined) await queuePicks(page, [options.pick])
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
}

/** The History dialog on Recent Sessions. */
export const openRecent = async (page: Page) => {
    await openTimeline(page)
    await page.getByRole('tab', { name: 'Recent Sessions' }).click()
    await expect(page.locator('[data-recent-sessions]')).toBeVisible()
    await expect(page.locator('[data-sessions-loading]')).toHaveCount(0)
}

export const recentRow = (page: Page, chainId: unknown) =>
    page.locator(`[data-sessions-row][data-chain="${String(chainId)}"]`)

/** A Recent Sessions row's ⋯ menu item (Restore Session, Restore as a Copy, Save…, Delete). */
export const rowAction = async (tab: Tab, chainId: unknown, item: string) => {
    const { page } = tab
    await openRecent(page)
    const row = recentRow(page, chainId)
    await expect(row).toBeVisible()
    await row.locator('[data-sessions-more]').click()
    await page.getByRole('menu').getByRole('menuitem', { name: item, exact: true }).click()
}

/** Preview Assets › Particle › Choose › From a File: one package picked and used (a `userAssets` row). */
export const addPreviewPackage = async (tab: Tab, name: string, bytes: Uint8Array) => {
    const { page } = tab
    await page.evaluate(async () => {
        const { commands } = await import('/src/editor/commands/index.ts')
        const { runCommand } = await import('/src/editor/commands/runCommand.ts')
        void runCommand(commands.previewAssets)
    })
    const dialog = page.locator('dialog[open]')
    await expect(dialog).toHaveAccessibleName('Preview Assets')
    await dialog.locator('[data-preview-assets-tab="particle"]').click()
    await dialog.locator('[data-asset-choose]').click()
    const chooser = dialog.locator('[data-asset-chooser]')
    await expect(chooser).toBeVisible()
    const chosen = page.waitForEvent('filechooser')
    await chooser.locator('[data-chooser-select-file]').click()
    await (
        await chosen
    ).setFiles({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) })
    await expect(chooser.locator('[data-chooser-use]')).toBeEnabled()
    await chooser.locator('[data-chooser-use]').click()
    await expect(chooser).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
}

/** Settings › Local Data › Export Raw Data: the ZIP the browser downloads. */
export const exportRawData = async (tab: Tab) => {
    const { page } = tab
    await tab.command(',')
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await expect(settings).toBeVisible()
    const button = settings.locator('#settings-localData [data-export-raw]')
    await button.scrollIntoViewIfNeeded()
    const download = page.waitForEvent('download')
    await button.click()
    const file = await download
    const path = await file.path()
    await expect(page.getByRole('dialog', { name: 'Export Raw Data' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(settings).toHaveCount(0)
    return { name: file.suggestedFilename(), path }
}
