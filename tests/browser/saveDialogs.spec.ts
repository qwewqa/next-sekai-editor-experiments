import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import type {
    ConflictInput,
    DiskVersion,
    RefusedReason,
    SavedFeedback,
} from '../../src/editor/save/dialogs'

// The Save dialogs: the Save and Save As dialog with File Name's rules, the
// History and BGM rows and the size preview, the Preparing dialog, the conflict dialog, the
// not-found, denied and read-only dialogs, and the feedback after a write. They are opened through
// `saveUi`, as the Save flows call them.

const seed = (context: BrowserContext, platform?: object) =>
    context.addInitScript((platform) => {
        localStorage.setItem('nse.test.storage', '{}')
        localStorage.setItem(
            'nse.test.version',
            JSON.stringify({ appVersion: '0.6.0', atTag: true }),
        )
        localStorage.setItem('sonolus-next-sekai-editor.lastAppVersion', JSON.stringify('0.6.0'))
        localStorage.setItem('sonolus-next-sekai-editor.showPreview', 'false')
        localStorage.setItem('sonolus-next-sekai-editor.showSidebar', 'false')
        if (platform) localStorage.setItem('nse.test.platform', JSON.stringify(platform))
    }, platform)

const visit = async (page: Page) => {
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await expect
        .poll(() =>
            page.evaluate(async () => {
                const { startupGate } =
                    (await import('/src/startup/gate.ts')) as typeof import('../../src/startup/gate')
                return startupGate.phase
            }),
        )
        .toBe('done')
    await page.keyboard.press('Escape')
}

declare global {
    interface Window {
        saveSeen: {
            result?: unknown
            done?: boolean
            estimate?: (value: unknown) => void
        } & Record<string, unknown>
    }
}

type Input = Parameters<typeof import('../../src/editor/save/dialogs').defaultSaveUi.saveDialog>[0]

const base: Input = {
    kind: 'save',
    name: 'Coconut (Master)',
    lines: [],
    history: { kind: 'available', ticked: true, locked: false },
    bgm: { kind: 'held', name: 'coconut.mp3', ticked: true },
    peeking: false,
    estimate: { load: () => Promise.resolve(undefined) },
}

/**
 * Opens the Save dialog. The estimate is held until `release`d from the test, or never given;
 * `lines` and `storageLine` are texts.
 */
const openSave = (
    page: Page,
    input: Partial<Omit<Input, 'lines' | 'storageLine' | 'estimate'>> & {
        lines?: string[]
        storageLine?: string
        estimate?: 'held' | 'none' | { cached?: object; value?: object }
    } = {},
) =>
    page.evaluate(
        async ({ base, input }) => {
            const { saveUi } =
                (await import('/src/editor/save/dialogs.ts')) as typeof import('../../src/editor/save/dialogs')
            const { estimate, lines, storageLine, ...rest } = input
            window.saveSeen = {}
            const sizes = (estimate && typeof estimate === 'object' ? estimate : {}) as {
                cached?: never
                value?: never
            }
            void saveUi
                .saveDialog({
                    ...base,
                    ...rest,
                    lines: (lines ?? []).map((line) => () => line),
                    ...(storageLine ? { storageLine: () => storageLine } : {}),
                    estimate: {
                        cached: sizes.cached,
                        load: () =>
                            estimate === 'held'
                                ? new Promise((resolve) => {
                                      window.saveSeen.estimate = resolve as never
                                  })
                                : Promise.resolve(sizes.value),
                    },
                })
                .then((result) => {
                    window.saveSeen.result = result ?? null
                    window.saveSeen.done = true
                })
        },
        { base: { ...base, estimate: undefined }, input },
    )

const result = (page: Page) =>
    page
        .evaluate(() => window.saveSeen.done)
        .then(() => page.evaluate(() => window.saveSeen.result))

const dialog = (page: Page) => page.getByRole('dialog')
const guard = (page: Page) => page.waitForTimeout(400)

const estimateOf = { steps: 1840, history: 3_100_000, bgm: 4_200_000, base: 300_000 }

test.describe('the Save dialog', () => {
    test('opens on File Name with the prefill, and Enter saves with the extension', async ({
        page,
        context,
    }) => {
        await seed(context)
        await visit(page)
        await openSave(page)
        await expect(dialog(page)).toHaveAccessibleName('Save Project File')
        const field = dialog(page).getByRole('textbox', { name: 'File Name' })
        await expect(field).toBeFocused()
        await expect(field).toHaveValue('Coconut (Master)')
        await expect(dialog(page).getByText('.nxsp', { exact: true })).toBeVisible()
        await page.keyboard.press('Enter')
        await expect
            .poll(() => result(page))
            .toEqual({
                action: 'save',
                fileName: 'Coconut (Master).nxsp',
                history: true,
                bgm: true,
            })
    })

    test('Save As is titled so, and an empty field saves Untitled.nxsp', async ({
        page,
        context,
    }) => {
        await seed(context)
        await visit(page)
        await openSave(page, { kind: 'saveAs', name: '' })
        await expect(dialog(page)).toHaveAccessibleName('Save As')
        const field = dialog(page).getByRole('textbox', { name: 'File Name' })
        await expect(field).toHaveValue('')
        await expect(field).toHaveAttribute('placeholder', 'Untitled')
        await guard(page)
        await dialog(page).getByRole('button', { name: 'Save', exact: true }).click()
        await expect.poll(() => result(page)).toMatchObject({ fileName: 'Untitled.nxsp' })
    })

    test('a typed extension is not doubled', async ({ page, context }) => {
        await seed(context)
        await visit(page)
        await openSave(page, { name: '' })
        await dialog(page).getByRole('textbox', { name: 'File Name' }).fill('melt.NXSP')
        await page.keyboard.press('Enter')
        await expect.poll(() => result(page)).toMatchObject({ fileName: 'melt.nxsp' })
    })

    test('names are checked as typed: a space mid-name shows nothing, a colon at once', async ({
        page,
        context,
    }) => {
        await seed(context)
        await visit(page)
        await openSave(page, { name: '' })
        const field = dialog(page).getByRole('textbox', { name: 'File Name' })
        const save = dialog(page).getByRole('button', { name: 'Save', exact: true })
        const problem = dialog(page).locator('[data-save-problem]')

        await field.pressSequentially('Coconut ')
        // The edge reason waits; Save is disabled meanwhile.
        await expect(problem).toHaveCount(0)
        await expect(save).toBeDisabled()
        await field.pressSequentially('(Master)')
        await expect(save).toBeEnabled()
        await expect(problem).toHaveCount(0)

        await field.fill('A:b')
        await expect(problem).toHaveText('A name cannot contain :')
        await expect(save).toBeDisabled()

        // The edge reason shows after a pause.
        await field.fill('Coconut ')
        await expect(problem).toHaveText('A name cannot start or end with a dot or a space')
        await expect(save).toBeDisabled()
        await field.fill('con')
        await expect(problem).toHaveText('A name cannot be "con"')
    })

    test('Enter on an invalid name shows its reason and saves nothing', async ({
        page,
        context,
    }) => {
        await seed(context)
        await visit(page)
        await openSave(page, { name: '' })
        const field = dialog(page).getByRole('textbox', { name: 'File Name' })
        await field.fill('.hidden')
        await page.keyboard.press('Enter')
        await expect(dialog(page).locator('[data-save-problem]')).toBeVisible()
        await expect(dialog(page)).toBeVisible()
        expect(await page.evaluate(() => window.saveSeen.done)).toBeUndefined()
    })

    test('the History row shows no number until the estimate has its steps, then sizes and a total that follows the ticks', async ({
        page,
        context,
    }) => {
        await seed(context)
        await visit(page)
        await openSave(page, { estimate: 'held' })
        const history = dialog(page).locator('[data-save-row="history"]')
        const bgm = dialog(page).locator('[data-save-row="bgm"]')
        // Opens at once; Save works throughout.
        // The page cannot count a chain's steps: the estimate does, and until it has, no number.
        await expect(history).not.toContainText(/\d/)
        await expect(history).not.toContainText(/\d [kM]B/)
        await expect(bgm).toContainText('coconut.mp3')
        await expect(dialog(page).locator('[data-save-total]')).toHaveText('Estimating size…')
        await expect(history.getByText('Anyone with the file can view its history.')).toBeVisible()
        await expect(dialog(page).getByRole('button', { name: 'Save', exact: true })).toBeEnabled()

        await page.evaluate((sizes) => window.saveSeen.estimate!(sizes), estimateOf)
        await expect(history).toContainText('1,840 steps · 3.1 MB')
        await expect(bgm).toContainText('coconut.mp3')
        await expect(bgm).toContainText('4.2 MB')
        await expect(dialog(page).locator('[data-save-total]')).toHaveText('Total: about 7.6 MB')

        // Unticking follows at once, with no new estimate.
        await dialog(page).getByRole('checkbox', { name: 'History' }).uncheck()
        await expect(dialog(page).locator('[data-save-total]')).toHaveText('Total: about 4.5 MB')
        await dialog(page).getByRole('checkbox', { name: 'BGM' }).uncheck()
        await expect(dialog(page).locator('[data-save-total]')).toHaveText('Total: about 300 kB')
        await page.keyboard.press('Enter')
        await expect.poll(() => result(page)).toMatchObject({ history: false, bgm: false })
    })

    test('a cached estimate shows at once', async ({ page, context }) => {
        await seed(context)
        await visit(page)
        await openSave(page, { estimate: { cached: estimateOf, value: estimateOf } })
        await expect(dialog(page).locator('[data-save-total]')).toHaveText('Total: about 7.6 MB')
    })

    test('a ticked BGM of unknown size leaves the total pending, never counted as 0', async ({
        page,
        context,
    }) => {
        await seed(context)
        await visit(page)
        const unsized = {
            steps: estimateOf.steps,
            history: estimateOf.history,
            base: estimateOf.base,
        }
        await openSave(page, { estimate: { cached: unsized, value: unsized } })
        const total = dialog(page).locator('[data-save-total]')
        await expect(total).toHaveText('Estimating size…')
        // Unticked, the total no longer depends on it.
        await dialog(page).getByRole('checkbox', { name: 'BGM' }).uncheck()
        await expect(total).toHaveText('Total: about 3.4 MB')
        await dialog(page).getByRole('checkbox', { name: 'BGM' }).check()
        await expect(total).toHaveText('Estimating size…')
    })

    test('an estimate that fails shows no sizes and no total', async ({ page, context }) => {
        await seed(context)
        await visit(page)
        await openSave(page, { estimate: 'none' })
        await expect(dialog(page).locator('[data-save-row="history"]')).not.toContainText(/\d/)
        await expect(dialog(page).locator('[data-save-total]')).toHaveCount(0)
        await expect(dialog(page).locator('[data-save-row="history"]')).not.toContainText(
            /\d [kM]B/,
        )
    })

    test('a row that cannot be included is disabled with its reason and no size', async ({
        page,
        context,
    }) => {
        await seed(context)
        await visit(page)
        await openSave(page, {
            history: { kind: 'insecure' },
            bgm: { kind: 'none' },
            estimate: { cached: estimateOf },
        })
        const history = dialog(page).getByRole('checkbox', { name: 'History' })
        await expect(history).toBeDisabled()
        await expect(history).not.toBeChecked()
        await expect(dialog(page)).toContainText('History requires a secure connection.')
        await expect(dialog(page).locator('[data-save-row="bgm"]')).toHaveCount(0)
        await expect(dialog(page).locator('[data-save-total]')).toHaveText('Total: about 300 kB')
    })

    test('a BGM that is not loaded is disabled without a size', async ({ page, context }) => {
        await seed(context)
        await visit(page)
        await openSave(page, { bgm: { kind: 'notLoaded' }, estimate: { cached: estimateOf } })
        await expect(dialog(page).getByRole('checkbox', { name: 'BGM' })).toBeDisabled()
        await expect(dialog(page).locator('[data-save-row="bgm"]')).toContainText('BGM not loaded')
        await expect(dialog(page).locator('[data-save-row="bgm"]')).not.toContainText(/\d [kM]B/)
    })

    test('a BGM name with a line break and an override is one isolated line', async ({
        page,
        context,
    }) => {
        await seed(context)
        await visit(page)
        await openSave(page, {
            bgm: { kind: 'held', name: 'a\u202E\u05D0\nb.mp3', ticked: true },
        })
        await expect(dialog(page).locator('[data-save-name-line]')).toHaveText(
            '\u2068a\u05D0 b.mp3\u2069',
        )
    })

    test('a file that holds history locks its row, ticked, with "Already in"; the BGM stays a choice', async ({
        page,
        context,
    }) => {
        await seed(context)
        await visit(page)
        await openSave(page, {
            history: {
                kind: 'available',
                ticked: true,
                locked: true,
                keptIn: 'coconut.nxsp',
            },
        })
        const history = dialog(page).getByRole('checkbox', { name: 'History' })
        await expect(history).toBeDisabled()
        await expect(history).toBeChecked()
        const bgm = dialog(page).getByRole('checkbox', { name: 'BGM' })
        await expect(bgm).toBeEnabled()
        await expect(bgm).toBeChecked()
        await expect(dialog(page).locator('[data-save-kept]')).toHaveText([
            'Already in coconut.nxsp',
        ])
        await bgm.uncheck()
        await page.keyboard.press('Enter')
        await expect.poll(() => result(page)).toMatchObject({ history: true, bgm: false })
    })

    test('the notes: the first lines, Export, the storage line, peeking', async ({
        page,
        context,
    }) => {
        await seed(context)
        await visit(page)
        await openSave(page, {
            lines: ['"coconut.nxsp" was replaced from another tab or window.'],
            storageLine: 'Safari deletes stored work after 7 days without a visit.',
            peeking: true,
        })
        await expect(dialog(page).locator('[data-save-line]')).toHaveText(
            '"coconut.nxsp" was replaced from another tab or window.',
        )
        // File Name's description opens with the situation line, then the Export note.
        await expect(
            dialog(page).getByRole('textbox', { name: 'File Name' }),
        ).toHaveAccessibleDescription(
            /^"coconut\.nxsp" was replaced from another tab or window\..*use Export Level Data…/,
        )
        await expect(dialog(page).locator('[data-save-export] p').first()).toHaveText(
            'Project files (.nxsp) are only for this editor. To create level data for upload to a Sonolus server, use Export Level Data…',
        )
        await expect(dialog(page).locator('[data-save-export-names]')).toHaveText(
            'Level data files may have no extension or end in .nsld or .json.gz.',
        )
        await expect(dialog(page).locator('[data-save-storage-line]')).toBeVisible()
        await expect(dialog(page).locator('[data-save-peeking]')).toHaveText(
            'Saves the current version.',
        )
    })

    test('the Export line shows in Save and Save As…, not in Save… of another session', async ({
        page,
        context,
    }) => {
        await seed(context)
        await visit(page)
        // Not yet exported: the line leads the body, with the info glyph, before File Name.
        for (const kind of ['save', 'saveAs', 'saveToFile'] as const) {
            await openSave(page, { kind })
            const line = dialog(page).locator('[data-save-export]')
            await expect(line).toHaveCount(kind === 'saveToFile' ? 0 : 1)
            if (kind !== 'saveToFile') {
                await expect(line.locator('[data-severity="info"]')).toHaveCount(1)
                await expect(line.locator('[data-save-export-names]')).toHaveCount(1)
                const leads = await line.evaluate(
                    (p) =>
                        !!(
                            p.compareDocumentPosition(
                                p.ownerDocument.querySelector('[data-save-name]')!,
                            ) & Node.DOCUMENT_POSITION_FOLLOWING
                        ),
                )
                expect(leads).toBe(true)
            }
            await page.keyboard.press('Escape')
            await expect(dialog(page)).toHaveCount(0)
        }
    })

    test('after an export the Export line is the small note above the buttons', async ({
        page,
        context,
    }) => {
        await seed(context)
        await context.addInitScript(() => {
            localStorage.setItem('sonolus-next-sekai-editor.exportUsed', 'true')
        })
        await visit(page)
        for (const kind of ['save', 'saveAs', 'saveToFile'] as const) {
            await openSave(page, { kind })
            const line = dialog(page).locator('[data-save-export]')
            await expect(line).toHaveCount(kind === 'saveToFile' ? 0 : 1)
            if (kind !== 'saveToFile') {
                await expect(line.locator('[data-severity]')).toHaveCount(0)
                await expect(line.locator('[data-save-export-names]')).toHaveCount(0)
                await expect(line).toHaveText('For Sonolus, use Export Level Data…')
                const after = await line.evaluate(
                    (p) =>
                        !!(
                            p.ownerDocument
                                .querySelector('[data-save-include]')!
                                .compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING
                        ),
                )
                expect(after).toBe(true)
                await expect(line.locator('xpath=..')).toHaveClass(/text-sm/)
            }
            await page.keyboard.press('Escape')
            await expect(dialog(page)).toHaveCount(0)
        }
    })

    test('File Name is described by the emphasised Export line, and Shift+Tab reaches its link', async ({
        page,
        context,
    }) => {
        await seed(context)
        await visit(page)
        await openSave(page)
        const field = dialog(page).getByRole('textbox', { name: 'File Name' })
        await expect(field).toBeFocused()
        await expect(field).toHaveAccessibleDescription(
            /use Export Level Data….*may have no extension or end in \.nsld or \.json\.gz\./,
        )
        // A validation error joins the description and keeps the hint.
        await field.fill('a/b')
        await expect(field).toHaveAccessibleDescription(
            /use Export Level Data….*\.json\.gz\..*A name cannot contain \//,
        )
        await field.fill('Coconut')
        await page.keyboard.press('Shift+Tab')
        await expect(dialog(page).getByRole('button', { name: 'Export Level Data…' })).toBeFocused()
        await page.keyboard.press('Escape')
        await expect(dialog(page)).toHaveCount(0)

        await page.evaluate(async () => {
            const { markExportUsed } =
                (await import('/src/editor/file/flags.ts')) as typeof import('../../src/editor/file/flags')
            markExportUsed()
        })
        await openSave(page)
        await expect(field).toBeFocused()
        await expect(field).not.toHaveAccessibleDescription(/Export Level Data/)
        await expect(field).not.toHaveAttribute('aria-describedby', /./)
    })

    test('the Export line is a link that closes the dialog for Export', async ({
        page,
        context,
    }) => {
        await seed(context)
        await visit(page)
        await openSave(page)
        await guard(page)
        await dialog(page).getByRole('button', { name: 'Export Level Data…' }).click()
        await expect.poll(() => result(page)).toEqual({ action: 'export' })
    })

    test('in Japanese the Export link keeps its brackets on its line', async ({
        page,
        context,
    }) => {
        await seed(context)
        await visit(page)
        await page.evaluate(async () => {
            const { settings } =
                (await import('/src/settings.ts')) as typeof import('../../src/settings')
            settings.locale = 'ja'
        })
        await openSave(page)
        const line = dialog(page).locator('[data-save-export]')
        await expect(line.locator('p').first()).toHaveText(
            'プロジェクトファイル（.nxsp）はこのエディター専用です。Sonolusサーバーにアップロードするレベルデータを作るには「レベルデータを出力…」を使ってください。',
        )
        // The widths, from a 320 px phone's up, at which 「 ends a line before the link or 」 starts
        // one after it.
        const broken = await line.evaluate((p) => {
            const button = p.querySelector('button')!
            const rectOf = (char: string) => {
                const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
                while (walker.nextNode()) {
                    const node = walker.currentNode as Text
                    const at = node.data.indexOf(char)
                    if (at < 0 || button.contains(node)) continue
                    const range = document.createRange()
                    range.setStart(node, at)
                    range.setEnd(node, at + 1)
                    return range.getBoundingClientRect()
                }
                throw new Error(`no ${char}`)
            }
            const widths: number[] = []
            for (let width = 240; width <= 420; width += 2) {
                p.style.width = `${width}px`
                const link = button.getBoundingClientRect()
                if (rectOf('「').bottom <= link.top || rectOf('」').top >= link.bottom)
                    widths.push(width)
            }
            return widths
        })
        expect(broken).toEqual([])
    })

    test('Cancel and Escape answer nothing', async ({ page, context }) => {
        await seed(context)
        await visit(page)
        await openSave(page)
        await dialog(page).getByRole('button', { name: 'Cancel' }).click()
        await expect.poll(() => result(page)).toBeNull()
    })
})

type DialogRequest =
    | {
          kind: 'conflict'
          input: Omit<ConflictInput, 'replaceDisabled'> & { replaceDisabled?: string }
      }
    | { kind: 'notFound' | 'denied' | 'readOnly'; name: string }
    | { kind: 'failed'; name: string; message: string; saveAs: boolean }
    | { kind: 'refused'; name: string; reason: RefusedReason }

const open = (page: Page, input: DialogRequest) =>
    page.evaluate(async (input) => {
        const { saveUi } =
            (await import('/src/editor/save/dialogs.ts')) as typeof import('../../src/editor/save/dialogs')
        window.saveSeen = {}
        const run = () => {
            switch (input.kind) {
                case 'conflict': {
                    const { replaceDisabled, ...rest } = input.input
                    return saveUi.conflict({
                        ...rest,
                        replaceDisabled: replaceDisabled ? () => replaceDisabled : undefined,
                    })
                }
                case 'notFound':
                    return saveUi.notFound(input.name)
                case 'denied':
                    return saveUi.denied(input.name)
                case 'readOnly':
                    return saveUi.readOnly(input.name)
                case 'failed':
                    return saveUi.failed(input.name, () => input.message, input.saveAs)
                case 'refused':
                    return saveUi.refused(input.name, input.reason)
            }
        }
        void run().then((result) => {
            window.saveSeen.result = result ?? null
            window.saveSeen.done = true
        })
    }, input)

test.describe('the Preparing dialog', () => {
    test('shows the name and size, and its button becomes the new gesture', async ({
        page,
        context,
    }) => {
        await seed(context)
        await visit(page)
        await page.evaluate(async () => {
            const { saveUi } =
                (await import('/src/editor/save/dialogs.ts')) as typeof import('../../src/editor/save/dialogs')
            window.saveSeen = {}
            const preparing = saveUi.preparing('coconut.nxsp')
            window.saveSeen.preparing = preparing
            preparing.signal.addEventListener('abort', () => (window.saveSeen.aborted = true))
        })
        await expect(dialog(page)).toContainText('Preparing coconut.nxsp…')
        await expect(dialog(page).getByRole('button', { name: 'Cancel' })).toBeVisible()
        await page.evaluate(() =>
            (
                window.saveSeen.preparing as {
                    importing: (p: { done: number; total: number } | undefined) => void
                }
            ).importing({ done: 20, total: 80 }),
        )
        await expect(dialog(page).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25')
        // The import is over: the bar slides for the build, and does not stay full.
        await page.evaluate(() =>
            (
                window.saveSeen.preparing as {
                    importing: (p: { done: number; total: number } | undefined) => void
                }
            ).importing(undefined),
        )
        await expect(dialog(page).getByRole('progressbar')).toHaveCount(0)
        await expect(dialog(page).locator('[data-save-progress]')).toBeVisible()
        await page.evaluate(() =>
            (window.saveSeen.preparing as { built: (size: number) => void }).built(12_400_000),
        )
        await expect(dialog(page)).toContainText('Preparing coconut.nxsp… 12.4 MB')
        await page.evaluate(() => {
            void (
                window.saveSeen.preparing as { ready: (a: string, s: number) => Promise<boolean> }
            )
                .ready('download', 12_400_000)
                .then((go) => (window.saveSeen.result = go))
        })
        const button = dialog(page).getByRole('button', { name: 'Download' })
        await expect(button).toBeFocused()
        await expect(dialog(page)).toContainText('Ready: coconut.nxsp · 12.4 MB')
        await expect(dialog(page).locator('[data-save-progress]')).toHaveCount(0)
        await guard(page)
        await button.click()
        await expect.poll(() => page.evaluate(() => window.saveSeen.result)).toBe(true)
    })

    test('Save is the button when the picker is next, and Cancel aborts the build', async ({
        page,
        context,
    }) => {
        await seed(context)
        await visit(page)
        await page.evaluate(async () => {
            const { saveUi } =
                (await import('/src/editor/save/dialogs.ts')) as typeof import('../../src/editor/save/dialogs')
            window.saveSeen = {}
            const preparing = saveUi.preparing('coconut.nxsp')
            window.saveSeen.preparing = preparing
            preparing.signal.addEventListener('abort', () => (window.saveSeen.aborted = true))
            void preparing.ready('save', 3_000_000).then((go) => (window.saveSeen.result = go))
        })
        await expect(dialog(page).getByRole('button', { name: 'Save', exact: true })).toBeFocused()
        await guard(page)
        await dialog(page).getByRole('button', { name: 'Cancel' }).click()
        await expect.poll(() => page.evaluate(() => window.saveSeen.result)).toBe(false)
    })

    test('Cancel before it is ready stops the Save', async ({ page, context }) => {
        await seed(context)
        await visit(page)
        await page.evaluate(async () => {
            const { saveUi } =
                (await import('/src/editor/save/dialogs.ts')) as typeof import('../../src/editor/save/dialogs')
            window.saveSeen = {}
            const preparing = saveUi.preparing('coconut.nxsp')
            window.saveSeen.preparing = preparing
            preparing.signal.addEventListener('abort', () => (window.saveSeen.aborted = true))
        })
        await guard(page)
        await dialog(page).getByRole('button', { name: 'Cancel' }).click()
        await expect.poll(() => page.evaluate(() => window.saveSeen.aborted)).toBe(true)
        // A press asked for once the activation lapsed has nothing to wait for.
        await page.evaluate(() => {
            void (
                window.saveSeen.preparing as { ready: (a: string, s: number) => Promise<boolean> }
            )
                .ready('download', 3_000_000)
                .then((go) => (window.saveSeen.result = go))
        })
        await expect.poll(() => page.evaluate(() => window.saveSeen.result)).toBe(false)
        await expect(dialog(page)).toHaveCount(0)
    })
})

test.describe('the conflict dialog', () => {
    // Built in UTC and drawn in UTC, so the times read the same in any zone the tests run in.
    test.use({ timezoneId: 'UTC' })
    const disk = {
        saved: {
            kind: 'saved',
            device: { id: 'a', label: 'iPad' },
            savedAt: Date.UTC(new Date().getUTCFullYear(), 9, 16, 14, 41),
            notes: 1220,
        },
        web: {
            kind: 'saved',
            device: { id: 'a', label: 'Web (Chrome)' },
            savedAt: Date.UTC(new Date().getUTCFullYear(), 9, 16, 14, 41),
            notes: 1,
        },
        other: { kind: 'otherProject', name: 'Melt' },
        unknown: { kind: 'unknown' },
    } satisfies Record<string, DiskVersion>

    test('offers the four choices, with Save as a Separate File… focused', async ({
        page,
        context,
    }) => {
        await seed(context)
        await visit(page)
        await open(page, { kind: 'conflict', input: { name: 'coconut.nxsp', disk: disk.saved } })
        await expect(dialog(page)).toHaveAccessibleName('"coconut.nxsp" Changed')
        await expect(dialog(page)).toContainText(
            '"coconut.nxsp" changed since you opened or saved it here.',
        )
        await expect(dialog(page)).toContainText('Saved on iPad, Oct 16, 2:41 PM · 1,220 notes.')
        await expect(dialog(page).locator('[data-choice-buttons] button')).toHaveText([
            // Stacked, the safe default on top and Cancel last.
            'Save as a Separate File…',
            'Open the Other Version',
            'Replace',
            'Cancel',
        ])
        await expect(
            dialog(page).getByRole('button', { name: 'Save as a Separate File…' }),
        ).toBeFocused()
        await expect(dialog(page).getByText('Your changes stay in Recent Sessions.')).toBeVisible()
        await expect(
            dialog(page).getByText('The version on disk will be kept in Recent Sessions.'),
        ).toBeVisible()
        await guard(page)
        await dialog(page).getByRole('button', { name: 'Replace' }).click()
        await expect.poll(() => page.evaluate(() => window.saveSeen.result)).toBe('replace')
    })

    test('names a web version, another project, or nothing', async ({ page, context }) => {
        await seed(context)
        await visit(page)
        await open(page, { kind: 'conflict', input: { name: 'coconut.nxsp', disk: disk.web } })
        await expect(dialog(page)).toContainText(
            'Saved in the web editor (Chrome), Oct 16, 2:41 PM · 1 note.',
        )
        await guard(page)
        await dialog(page).getByRole('button', { name: 'Close' }).click()
        // A web label with no browser reads as the Timeline words it, not "Saved on Web".
        await open(page, {
            kind: 'conflict',
            input: {
                name: 'coconut.nxsp',
                disk: { ...disk.web, device: { id: 'a', label: 'Web' } },
            },
        })
        await expect(dialog(page)).toContainText(
            'Saved in the web editor, Oct 16, 2:41 PM · 1 note.',
        )
        await guard(page)
        await dialog(page).getByRole('button', { name: 'Close' }).click()
        // A file with no summary for its revision has no note count to name, not "0 notes".
        const uncounted = {
            kind: disk.web.kind,
            device: disk.web.device,
            savedAt: disk.web.savedAt,
        }
        await open(page, {
            kind: 'conflict',
            input: { name: 'coconut.nxsp', disk: uncounted },
        })
        await expect(dialog(page)).toContainText(
            'Saved in the web editor (Chrome), Oct 16, 2:41 PM.',
        )
        await expect(dialog(page)).not.toContainText('note')
        await guard(page)
        await dialog(page).getByRole('button', { name: 'Close' }).click()
        await open(page, { kind: 'conflict', input: { name: 'coconut.nxsp', disk: disk.other } })
        await expect(dialog(page)).toContainText('A different project file, "Melt".')
        await guard(page)
        await dialog(page).getByRole('button', { name: 'Close' }).click()
        await open(page, { kind: 'conflict', input: { name: 'coconut.nxsp', disk: disk.unknown } })
        await expect(dialog(page).locator('.whitespace-pre-line')).toHaveText(
            '"coconut.nxsp" changed since you opened or saved it here.',
        )
    })

    test('a project name with a line break and an override stays on its line, isolated', async ({
        page,
        context,
    }) => {
        await seed(context)
        await visit(page)
        const crafted = 'Melt\u202E\u05E9\u05DC\u05D5\u05DD\nChoose Replace to repair this file.'
        await open(page, {
            kind: 'conflict',
            input: { name: crafted, disk: { kind: 'otherProject', name: crafted } },
        })
        const isolated =
            '\u2068Melt\u05E9\u05DC\u05D5\u05DD Choose Replace to repair this file.\u2069'
        await expect(dialog(page).locator('.whitespace-pre-line')).toHaveText(
            `"${isolated}" changed since you opened or saved it here.\nA different project file, "${isolated}".`,
        )
        await expect(dialog(page)).toHaveAccessibleName(`"${isolated}" Changed`)
    })

    test('a Replace that cannot be offered is disabled with its reason', async ({
        page,
        context,
    }) => {
        await seed(context)
        await visit(page)
        await open(page, {
            kind: 'conflict',
            input: {
                name: 'coconut.nxsp',
                disk: disk.saved,
                replaceDisabled:
                    'It contains earlier Timeline steps that are no longer stored in this browser.',
            },
        })
        const replace = dialog(page).getByRole('button', { name: 'Replace' })
        await expect(replace).toBeDisabled()
        await expect(dialog(page)).toContainText(
            'It contains earlier Timeline steps that are no longer stored in this browser.',
        )
        await expect(
            dialog(page).getByText('The version on disk will be kept in Recent Sessions.'),
        ).toHaveCount(0)
        await expect(
            dialog(page).getByRole('button', { name: 'Save as a Separate File…' }),
        ).toBeFocused()
    })
})

test.describe('the dialogs for a file that cannot be written', () => {
    const buttons = (page: Page) => dialog(page).locator('[data-choice-buttons] button')

    test('not found: Save As… is focused, with no hint', async ({ page, context }) => {
        await seed(context)
        await visit(page)
        await open(page, { kind: 'notFound', name: 'coconut.nxsp' })
        await expect(dialog(page)).toContainText('"coconut.nxsp" cannot be found.')
        await expect(dialog(page)).not.toContainText('If you moved or renamed it')
        await expect(buttons(page)).toHaveText(['Cancel', 'Save As…'])
        await expect(dialog(page).getByRole('button', { name: 'Save As…' })).toBeFocused()
    })

    test('denied: Try Again is focused', async ({ page, context }) => {
        await seed(context)
        await visit(page)
        await open(page, { kind: 'denied', name: 'coconut.nxsp' })
        await expect(dialog(page)).toContainText(
            'The browser did not allow writing to coconut.nxsp.',
        )
        await expect(buttons(page)).toHaveText(['Cancel', 'Save As…', 'Try Again'])
        await expect(dialog(page).getByRole('button', { name: 'Try Again' })).toBeFocused()
        await guard(page)
        await dialog(page).getByRole('button', { name: 'Try Again' }).click()
        await expect.poll(() => page.evaluate(() => window.saveSeen.result)).toBe('tryAgain')
    })

    test('read-only: Save As… is focused', async ({ page, context }) => {
        await seed(context)
        await visit(page)
        await open(page, { kind: 'readOnly', name: 'coconut.nxsp' })
        await expect(dialog(page)).toContainText('"coconut.nxsp" cannot be written to.')
        await expect(buttons(page)).toHaveText(['Cancel', 'Save As…'])
        await expect(dialog(page).getByRole('button', { name: 'Save As…' })).toBeFocused()
    })

    test('other errors give the plain reason, with Save As… where there is another place', async ({
        page,
        context,
    }) => {
        await seed(context)
        await visit(page)
        await open(page, {
            kind: 'failed',
            name: 'coconut.nxsp',
            message: 'There is not enough space to write coconut.nxsp.',
            saveAs: true,
        })
        await expect(dialog(page)).toContainText('There is not enough space to write coconut.nxsp.')
        await expect(buttons(page)).toHaveText(['Cancel', 'Save As…'])
        await guard(page)
        await dialog(page).getByRole('button', { name: 'Cancel' }).click()
        await open(page, {
            kind: 'failed',
            name: 'coconut.nxsp',
            message: 'The download failed.',
            saveAs: false,
        })
        await expect(buttons(page)).toHaveText(['OK'])
    })

    test('a refused pick: the level data one adds the Export hint and its button', async ({
        page,
        context,
    }) => {
        await seed(context)
        await visit(page)
        await open(page, { kind: 'refused', name: 'LevelData', reason: 'levelData' })
        await expect(dialog(page)).toContainText('"LevelData" is not a project file.')
        await expect(dialog(page)).toContainText('For Sonolus, use Export Level Data…')
        await expect(buttons(page)).toHaveText(['Cancel', 'Export Level Data…', 'Choose Another…'])
        await expect(dialog(page).getByRole('button', { name: 'Choose Another…' })).toBeFocused()
        await guard(page)
        await dialog(page).getByRole('button', { name: 'Export Level Data…' }).click()
        await expect.poll(() => page.evaluate(() => window.saveSeen.result)).toBe('export')
    })

    test('a refused partial open and safe mode name why', async ({ page, context }) => {
        await seed(context)
        await visit(page)
        await open(page, { kind: 'refused', name: 'melt.nxsp', reason: 'notKept' })
        await expect(dialog(page)).toContainText(
            'Not saved. "melt.nxsp" could not be read completely.',
        )
        await expect(buttons(page)).toHaveText(['Cancel', 'Choose Another…'])
        await guard(page)
        await dialog(page).getByRole('button', { name: 'Cancel' }).click()
        await open(page, { kind: 'refused', name: 'melt.nxsp', reason: 'safeMode' })
        await expect(dialog(page)).toContainText(
            'Not saved. Files cannot be replaced in safe mode.',
        )
    })
})

test.describe('the feedback after a write', () => {
    const notice = (page: Page) => page.getByRole('status')

    const feedback = (page: Page, input: SavedFeedback) =>
        page.evaluate(async (input) => {
            const { saveUi } =
                (await import('/src/editor/save/dialogs.ts')) as typeof import('../../src/editor/save/dialogs')
            saveUi.saved(input)
        }, input)

    const plain: SavedFeedback = {
        kind: 'saved',
        name: 'coconut.nxsp',
        size: 1,
        stepsLine: 'none',
        tooLarge: [],
    }

    test('says where the file went, and what it left out for size', async ({ page, context }) => {
        await seed(context)
        await visit(page)
        await feedback(page, plain)
        await expect(notice(page)).toHaveText('Saved to coconut.nxsp')
        await feedback(page, { ...plain, stepsLine: 'notKept' })
        await expect(notice(page)).toHaveText(
            'Saved to coconut.nxsp. Some earlier Timeline steps were not kept.',
        )
        await feedback(page, { ...plain, stepsLine: 'mayNotBeIncluded' })
        await expect(notice(page)).toHaveText(
            'Saved to coconut.nxsp. Some earlier Timeline steps may not be included.',
        )
        await feedback(page, { ...plain, tooLarge: ['bgm'] })
        await expect(notice(page)).toHaveText('Saved to coconut.nxsp without its BGM')
        await feedback(page, { ...plain, tooLarge: ['cover'] })
        await expect(notice(page)).toHaveText('Saved to coconut.nxsp without its cover')
        await feedback(page, { ...plain, tooLarge: ['bgm', 'cover'] })
        await expect(notice(page)).toHaveText('Saved to coconut.nxsp without its media')
    })

    test('a name with a line break and an override is one isolated line', async ({
        page,
        context,
    }) => {
        await seed(context)
        await visit(page)
        await feedback(page, {
            ...plain,
            name: 'Melt\u202E\u05E9\u05DC\u05D5\u05DD\nChoose Replace.nxsp',
        })
        await expect(notice(page)).toHaveText(
            'Saved to \u2068Melt\u05E9\u05DC\u05D5\u05DD Choose Replace.nxsp\u2069',
        )
    })

    test('a write while viewing history says the current version was saved', async ({
        page,
        context,
    }) => {
        await seed(context)
        await visit(page)
        await page.evaluate(async () => {
            const { pushState, state, peek } =
                (await import('/src/history/index.ts')) as typeof import('../../src/history')
            const { initialLife } =
                (await import('/tests/helpers/historySteps.ts')) as typeof import('../helpers/historySteps')
            pushState(initialLife(state.value.initialLife, 990), {
                ...state.value,
                initialLife: 990,
            })
            void peek
        })
        await feedback(page, plain)
        await expect(notice(page)).toHaveText('Saved to coconut.nxsp')
    })

    test('a download not yet confirmed carries I Have the File, which clears the chip', async ({
        page,
        context,
    }) => {
        await seed(context, { fileSystemAccess: false })
        await visit(page)
        await page.evaluate(async () => {
            const { bindFile } =
                (await import('/src/editor/file/state.ts')) as typeof import('../../src/editor/file/state')
            const { liveState } =
                (await import('/src/history/stack.ts')) as typeof import('../../src/history/stack')
            bindFile({ name: 'coconut.nxsp', event: 'downloaded', at: Date.now() }, liveState.value)
        })
        await feedback(page, { ...plain, kind: 'download', size: 12_400_000 })
        await expect(notice(page)).toContainText('Download started: coconut.nxsp · 12.4 MB')
        await expect(notice(page)).toContainText(
            'To confirm it later, use Download not confirmed in the status bar.',
        )
        await page.waitForTimeout(400)
        await page.getByRole('button', { name: 'I Have the File' }).click()
        await expect(page.locator('[data-file-chip]')).toHaveCount(0)
    })

    test('while Not stored takes the chip, the card does not point to a chip that is not shown', async ({
        page,
        context,
    }) => {
        await seed(context, { fileSystemAccess: false })
        await visit(page)
        await page.evaluate(async () => {
            const { bindFile, raised } =
                (await import('/src/editor/file/state.ts')) as typeof import('../../src/editor/file/state')
            const { liveState } =
                (await import('/src/history/stack.ts')) as typeof import('../../src/history/stack')
            bindFile({ name: 'coconut.nxsp', event: 'downloaded', at: Date.now() }, liveState.value)
            raised.notStored.value = true
        })
        await feedback(page, { ...plain, kind: 'download', size: 12_400_000 })
        await expect(notice(page)).toContainText('Download started: coconut.nxsp · 12.4 MB')
        await expect(notice(page)).not.toContainText('To confirm it later')
        await expect(page.getByRole('button', { name: 'I Have the File' })).toBeVisible()
    })

    test('a confirmed download carries no action', async ({ page, context }) => {
        await seed(context, { fileSystemAccess: false })
        await visit(page)
        await page.evaluate(async () => {
            localStorage.setItem('sonolus-next-sekai-editor.downloadConfirmed', 'true')
            const { confirmDownloads } =
                (await import('/src/editor/file/flags.ts')) as typeof import('../../src/editor/file/flags')
            confirmDownloads()
            const { bindFile } =
                (await import('/src/editor/file/state.ts')) as typeof import('../../src/editor/file/state')
            const { liveState } =
                (await import('/src/history/stack.ts')) as typeof import('../../src/history/stack')
            bindFile({ name: 'coconut.nxsp', event: 'downloaded', at: Date.now() }, liveState.value)
        })
        await feedback(page, { ...plain, kind: 'download', size: 1_000, stepsLine: 'notKept' })
        await expect(notice(page)).toContainText('Download started: coconut.nxsp · 1 kB')
        await expect(notice(page)).toContainText('Some earlier Timeline steps were not kept.')
        await expect(page.getByRole('button', { name: 'I Have the File' })).toHaveCount(0)
    })

    test('"No changes" after a download offers Download Again', async ({ page, context }) => {
        await seed(context)
        await visit(page)
        await page.evaluate(async () => {
            const { saveUi } =
                (await import('/src/editor/save/dialogs.ts')) as typeof import('../../src/editor/save/dialogs')
            window.saveSeen = {}
            saveUi.noChanges('coconut.nxsp', 'downloaded', () => (window.saveSeen.again = true))
        })
        await expect(notice(page)).toContainText('No changes since coconut.nxsp was downloaded')
        await page.waitForTimeout(400)
        await page.getByRole('button', { name: 'Download Again' }).click()
        await expect.poll(() => page.evaluate(() => window.saveSeen.again)).toBe(true)
    })
})
