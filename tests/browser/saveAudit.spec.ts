import { expect, test, type Page } from '@playwright/test'
import { waitForStartup } from './editorFixture'
import {
    chainOf,
    edit,
    flushed,
    notice,
    pressSave,
    projectOf,
    queuePicks,
    rows,
    saveDialog,
    start,
    submitSave,
} from './saveFlows'

// The Save flow's values were checked against what the dialogs say (audit AUD-A): the storage line,
// the BGM row after a reload, the name of the file the picker returned, "Already in" on the BGM
// row, the cached estimate, and "Preparing…" at once for a large download on a touch device. Each
// asserts the text the user reads, never the input the flow built.

type Row = Record<string, unknown>

/** A BGM the session holds: its bytes captured as a picked file's are, pushed as an edit. */
const setBgm = (page: Page, name: string, size: number) =>
    page.evaluate(
        async ({ name, size }) => {
            const { pushState, state } = await import('/src/history/index.ts')
            const { captureMedia } = await import('/src/local/media.ts')
            const { bgmOperation } = await import('/src/editor/headerLabels.ts')
            const bytes = new Uint8Array(size)
            for (let at = 0; at < size; at += 65_536)
                crypto.getRandomValues(bytes.subarray(at, Math.min(size, at + 65_536)))
            const captured = await captureMedia(bytes.buffer, { name, type: 'audio/mpeg' })
            const next = {
                ...state.value.bgm,
                filename: name,
                meta: captured.meta,
                source: captured.source,
            }
            pushState(bgmOperation(state.value.bgm, next), { ...state.value, bgm: next })
        },
        { name, size },
    )

const reload = async (page: Page) => {
    await flushed(page)
    await page.reload()
    await waitForStartup(page)
}

const sizeText = (dialog: ReturnType<typeof saveDialog>, row: 'history' | 'bgm') =>
    dialog.locator(`[data-save-row="${row}"] [data-save-size]`)

/** "Total: about 3.7 MB" in bytes. */
const totalBytes = async (dialog: ReturnType<typeof saveDialog>) => {
    const total = dialog.locator('[data-save-total]')
    await expect(total).toContainText(/about [\d.,]+ (kB|MB)/)
    const [, amount, unit] = /about ([\d.,]+) (kB|MB)/.exec((await total.textContent()) ?? '')!
    return Number(amount!.replaceAll(',', '')) * (unit === 'MB' ? 1_000_000 : 1000)
}

test.describe('the storage line', () => {
    for (const [label, override, line] of [
        [
            'Safari',
            { os: 'macos', engine: 'webkit' },
            'Safari deletes stored work after 7 days without a visit.',
        ],
        [
            'an iPhone or iPad',
            { os: 'ios', engine: 'webkit' },
            'This browser deletes stored work after 7 days without a visit.',
        ],
    ] as const) {
        test(`${label}: the first Save shows its first sentence, and only the first`, async ({
            page,
        }) => {
            await start(page, { fileSystemAccess: false, override })
            await edit(page, 1)
            await pressSave(page)
            const dialog = saveDialog(page)
            const storage = dialog.locator('[data-save-storage-line]')
            await expect(storage).toHaveText(line)
            await expect(storage).not.toContainText('Save to a file')
            const downloading = page.waitForEvent('download')
            await submitSave(page, 'coconut')
            await downloading
            await edit(page, 2)
            await pressSave(page)
            await expect(notice(page).filter({ hasText: 'Download started' })).toBeVisible()
            await edit(page, 3)
            await page.evaluate(async () => {
                const { commands } = await import('/src/editor/commands/index.ts')
                const { runCommand } = await import('/src/editor/commands/runCommand.ts')
                void runCommand(commands.saveAs)
            })
            await expect(saveDialog(page, 'Save As')).toBeVisible()
            await expect(
                saveDialog(page, 'Save As').locator('[data-save-storage-line]'),
            ).toHaveCount(0)
        })
    }

    test('other browsers show no storage line', async ({ page }) => {
        await start(page, { fileSystemAccess: false, override: { os: 'linux', engine: 'firefox' } })
        await edit(page, 1)
        await pressSave(page)
        await expect(saveDialog(page)).toBeVisible()
        await expect(saveDialog(page).locator('[data-save-download-note]')).toBeVisible()
        await expect(saveDialog(page).locator('[data-save-storage-line]')).toHaveCount(0)
    })
})

test('after a reload the BGM row, its size and the total match what the Save writes', async ({
    page,
}) => {
    await start(page, { fileSystemAccess: false })
    await edit(page, 1)
    await setBgm(page, 'song.mp3', 400_000)
    await reload(page)
    await pressSave(page)
    const dialog = saveDialog(page)
    const bgm = dialog.locator('[data-save-row="bgm"]')
    await expect(sizeText(dialog, 'bgm')).toHaveText('song.mp3 · 400 kB')
    await expect(bgm).not.toContainText('not loaded')
    await expect(bgm.getByRole('checkbox')).toBeEnabled()
    await expect(bgm.getByRole('checkbox')).toBeChecked()
    const total = await totalBytes(dialog)
    const downloading = page.waitForEvent('download')
    await submitSave(page, 'coconut')
    const download = await downloading
    const written = (await import('node:fs')).statSync((await download.path())!).size
    expect(written).toBeGreaterThan(400_000)
    expect(total).toBeGreaterThan(written * 0.75)
    expect(total).toBeLessThan(written * 1.25)
})

test('a picked file with another name is the name in the entry and in revision.fileName', async ({
    page,
}) => {
    await start(page)
    await edit(page, 1)
    await queuePicks(page, ['mysave.nxsp'])
    await pressSave(page)
    await submitSave(page, 'coconut')
    await expect(notice(page).filter({ hasText: 'Saved to mysave.nxsp' })).toBeVisible()
    const project = await projectOf(page, 'mysave.nxsp')
    expect((project.revision as Row).fileName).toBe('mysave.nxsp')
    await flushed(page)
    const { entries } = await rows(page, ['entries'])
    const saves = entries!.filter((row) => row.value.kind === 'save')
    expect(saves).toHaveLength(1)
    const text = JSON.stringify(saves[0]!.value)
    expect(text).toContain('mysave.nxsp')
    expect(text).not.toContain('coconut.nxsp')
    // The Timeline's row reads the file written.
    await page.keyboard.press('Shift+H')
    await expect(
        page.locator('[data-history-surface] [role="treegrid"]').getByText('Saved mysave.nxsp'),
    ).toBeVisible()
})

test('Save asks the estimate once per state: a reopen shows it at once, a change asks again', async ({
    page,
}) => {
    await start(page, { fileSystemAccess: false })
    await edit(page, 1)
    await page.evaluate(async () => {
        const { storageWorker } = await import('/src/local/start.ts')
        const worker = storageWorker!
        const call = worker.call.bind(worker)
        ;(window as unknown as { estimates: number }).estimates = 0
        worker.call = ((method: string, ...rest: unknown[]) => {
            if (method === 'estimateSaveSize')
                (window as unknown as { estimates: number }).estimates++
            return (call as (...args: unknown[]) => unknown)(method, ...rest)
        }) as typeof worker.call
    })
    const asked = () => page.evaluate(() => (window as unknown as { estimates: number }).estimates)
    await pressSave(page)
    const dialog = saveDialog(page)
    await totalBytes(dialog)
    expect(await asked()).toBe(1)
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)
    // The same state: no new estimate, and the total is there when the dialog is.
    await pressSave(page)
    await expect(dialog.locator('[data-save-total]')).toContainText('about')
    expect(await asked()).toBe(1)
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)
    await edit(page, 2)
    await pressSave(page)
    await totalBytes(dialog)
    expect(await asked()).toBe(2)
})

test('the file opened by name keeps its BGM: ticked, disabled, "Already in" it', async ({
    page,
}) => {
    await start(page, { fileSystemAccess: false })
    await edit(page, 1)
    await setBgm(page, 'song.mp3', 200_000)
    await pressSave(page)
    const downloading = page.waitForEvent('download')
    await submitSave(page, 'coconut')
    const download = await downloading
    const bytes = [...(await import('node:fs')).readFileSync((await download.path())!)]
    await page.evaluate(async (bytes) => {
        const { openProject } = await import('/src/editor/commands/open/project.ts')
        await openProject(new File([new Uint8Array(bytes)], 'coconut.nxsp'), undefined)
    }, bytes)
    await expect(notice(page).filter({ hasText: 'Opened coconut.nxsp' })).toBeVisible()
    await expect.poll(async () => (await chainOf(page)).file).toMatchObject({ event: 'opened' })
    await pressSave(page)
    const dialog = saveDialog(page)
    const history = dialog.locator('[data-save-row="history"]')
    const bgm = dialog.locator('[data-save-row="bgm"]')
    await expect(history).toContainText('Already in coconut.nxsp')
    await expect(bgm).toContainText('Already in coconut.nxsp')
    await expect(bgm.getByRole('checkbox')).toBeDisabled()
    await expect(bgm.getByRole('checkbox')).toBeChecked()
    await expect(sizeText(dialog, 'bgm')).toContainText('song.mp3 · 200 kB')
})

test('a file without history opened by name: History is unticked and can be ticked (SF-4)', async ({
    page,
}) => {
    await start(page, { fileSystemAccess: false })
    await edit(page, 1)
    await pressSave(page)
    await saveDialog(page).locator('[data-save-row="history"]').getByRole('checkbox').uncheck()
    const downloading = page.waitForEvent('download')
    await submitSave(page, 'coconut')
    const download = await downloading
    const bytes = [...(await import('node:fs')).readFileSync((await download.path())!)]
    await page.evaluate(async (bytes) => {
        const { openProject } = await import('/src/editor/commands/open/project.ts')
        await openProject(new File([new Uint8Array(bytes)], 'coconut.nxsp'), undefined)
    }, bytes)
    await expect(notice(page).filter({ hasText: 'Opened coconut.nxsp' })).toBeVisible()
    await expect.poll(async () => (await chainOf(page)).file).toMatchObject({ event: 'opened' })
    await pressSave(page)
    const history = saveDialog(page).locator('[data-save-row="history"]')
    await expect(history).toBeVisible()
    await expect(history).not.toContainText('Already in')
    await expect(history.getByRole('checkbox')).toBeEnabled()
    await expect(history.getByRole('checkbox')).not.toBeChecked()
})

test.describe('Save to File…', () => {
    const toFile = (page: Page, sessionId: string) =>
        page.evaluate((sessionId) => {
            void import('/src/editor/save/flow.ts').then((flow) => flow.saveToFile(sessionId))
        }, sessionId)

    const earlierSession = async (page: Page, bgm?: number) => {
        await edit(page, 1)
        if (bgm) await setBgm(page, 'song.mp3', bgm)
        await flushed(page)
        const { sessionId } = await page.evaluate(async () => {
            const { session } = await import('/src/history/session.ts')
            return session.value
        })
        await page.evaluate(async () => {
            const { resetState } = await import('/src/history/index.ts')
            resetState(false)
        })
        await edit(page, 2)
        return sessionId
    }

    test('the BGM row names the session’s own BGM, size included in the total', async ({
        page,
    }) => {
        await start(page, { fileSystemAccess: false })
        await toFile(page, await earlierSession(page, 300_000))
        const dialog = saveDialog(page)
        await expect(sizeText(dialog, 'bgm')).toHaveText('song.mp3 · 300 kB')
        expect(await totalBytes(dialog)).toBeGreaterThan(300_000)
        await expect(dialog.locator('[data-save-row="bgm"]').getByRole('checkbox')).toBeChecked()
    })

    test('a session without a BGM says so, and writes none', async ({ page }) => {
        await start(page, { fileSystemAccess: false })
        await toFile(page, await earlierSession(page))
        const dialog = saveDialog(page)
        await expect(sizeText(dialog, 'bgm')).toHaveText('No BGM')
        await expect(dialog.locator('[data-save-row="bgm"]').getByRole('checkbox')).toBeDisabled()
        await expect(
            dialog.locator('[data-save-row="bgm"]').getByRole('checkbox'),
        ).not.toBeChecked()
    })
})

test('a conflict with another project’s file says it is another project, named or not', async ({
    page,
}) => {
    const { executePlan, planNxsp } = await import('../../src/local/nxsp')
    const { fresh } = await import('../local/nxsp/chain')
    const bytes = async (named: boolean) => {
        const { name, ...rest } = fresh().input
        const input = named ? { ...rest, name } : rest
        return [
            ...new Uint8Array(
                await (await executePlan(planNxsp(input).plan, new Map())).arrayBuffer(),
            ),
        ]
    }
    const { writeFile } = await import('./saveFlows')
    await start(page)
    await edit(page, 1)
    await pressSave(page)
    await submitSave(page, 'coconut')
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    await expect.poll(async () => (await chainOf(page)).file).toMatchObject({ event: 'saved' })
    await writeFile(page, 'coconut.nxsp', await bytes(false))
    await edit(page, 2)
    await pressSave(page)
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('"coconut.nxsp" Changed')
    await expect(dialog).toContainText('A different project file.')
    await expect(dialog).not.toContainText('Saved in the web editor')
    await expect(dialog).not.toContainText('"Coconut (Master)"')
})

test('a feedback for a session another tab holds says so to assistive technology', async ({
    page,
}) => {
    await start(page)
    const said = await page.evaluate(async () => {
        const { defaultSaveUi } = await import('/src/editor/save/dialogs.ts')
        const { announcementOf, latestNotice } = await import('/src/editor/notification.ts')
        const feedback = {
            kind: 'saved' as const,
            name: 'restored.nxsp',
            size: 1000,
            someStepsNotKept: false,
            tookOver: false,
            without: [],
            tooLarge: [],
        }
        defaultSaveUi.saved({ ...feedback, committedState: true })
        const committed = announcementOf(latestNotice.value)
        defaultSaveUi.saved(feedback)
        return { committed, plain: announcementOf(latestNotice.value) }
    })
    expect(said.plain).toBe('Saved to restored.nxsp')
    expect(said.committed).toBe(
        'Saved to restored.nxsp This is the last stored state of a session open in another tab.',
    )
})

test.describe('a large download on a touch device', () => {
    test.use({ hasTouch: true })

    test('opens “Preparing…” at once with the estimated size', async ({ page }) => {
        await start(page, { fileSystemAccess: false })
        await edit(page, 1)
        await setBgm(page, 'song.mp3', 2_500_000)
        await flushed(page)
        expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(true)
        // The build is held, so the dialog seen is the one opened before it.
        await page.evaluate(async () => {
            const { storageWorker } = await import('/src/local/start.ts')
            const worker = storageWorker!
            const call = worker.call.bind(worker)
            let release = () => {}
            const gate = new Promise<void>((resolve) => (release = resolve))
            ;(window as unknown as { releaseBuild: () => void }).releaseBuild = release
            worker.call = (async (method: string, ...rest: unknown[]) => {
                if (method === 'buildSave') await gate
                return (call as (...args: unknown[]) => unknown)(method, ...rest)
            }) as typeof worker.call
        })
        await pressSave(page)
        const dialog = saveDialog(page)
        await expect(dialog.locator('[data-save-total]')).toContainText('about 2.')
        await submitSave(page, 'coconut')
        const preparing = page.locator('[data-save-preparing]')
        await expect(preparing).toHaveText(/^Preparing coconut\.nxsp… 2\.\d MB$/)
        await page.evaluate(() =>
            (window as unknown as { releaseBuild: () => void }).releaseBuild(),
        )
    })
})

test('our own file gone back to an older revision says it does not continue ours', async ({
    page,
}) => {
    const { executePlan, planNxsp } = await import('../../src/local/nxsp')
    const { fresh } = await import('../local/nxsp/chain')
    const { writeFile } = await import('./saveFlows')
    await start(page)
    await edit(page, 1)
    await pressSave(page)
    await submitSave(page, 'coconut')
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    await expect.poll(async () => (await chainOf(page)).file).toMatchObject({ event: 'saved' })
    const first = ((await chainOf(page)).revision as { id: string }).id
    await edit(page, 2)
    await pressSave(page)
    await expect
        .poll(async () => ((await chainOf(page)).revision as { id: string }).id)
        .not.toBe(first)
    await expect.poll(async () => (await chainOf(page)).file).toMatchObject({ event: 'saved' })
    // The file goes back to the first Save's revision, as a restored backup would.
    const input = fresh().input
    const older = planNxsp({
        ...input,
        id: (await chainOf(page)).docId as string,
        context: { ...input.context, newId: () => first },
    }).plan
    await writeFile(page, 'coconut.nxsp', [
        ...new Uint8Array(await (await executePlan(older, new Map())).arrayBuffer()),
    ])
    await edit(page, 3)
    await pressSave(page)
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('"coconut.nxsp" Changed')
    await expect(dialog).toContainText(/This version does not continue yours \(.+\)\./)
    await expect(dialog).not.toContainText('Saved in the web editor')
})

test.describe('a picker that renames the file', () => {
    for (const [how, fail] of [
        ['throws', "throw new Error('the rebuild failed')"],
        ['is refused', "return { refused: 'unreadable' }"],
    ] as const) {
        test(`a rebuild that ${how}: the first build is written whole and the Save succeeds`, async ({
            page,
        }) => {
            await start(page)
            await edit(page, 1)
            // Only the build under the picked name fails.
            await page.evaluate(
                async ({ fail }) => {
                    const { storageWorker } = await import('/src/local/start.ts')
                    const worker = storageWorker!
                    const call = worker.call.bind(worker)
                    worker.call = (async (method: string, ...rest: unknown[]) => {
                        const options = (rest[0] as { options?: { fileName?: string } } | undefined)
                            ?.options
                        if (method === 'buildSave' && options?.fileName === 'mysave.nxsp')
                            return new Function(fail)()
                        return (call as (...args: unknown[]) => unknown)(method, ...rest)
                    }) as typeof worker.call
                },
                { fail },
            )
            await queuePicks(page, ['mysave.nxsp'])
            await pressSave(page)
            await submitSave(page, 'coconut')
            await expect(notice(page).filter({ hasText: 'Saved to mysave.nxsp' })).toBeVisible()
            // Whole, readable and bound: the typed name is the one inside it.
            const project = await projectOf(page, 'mysave.nxsp')
            expect((project.revision as Row).fileName).toBe('coconut.nxsp')
            await expect
                .poll(async () => (await chainOf(page)).file)
                .toMatchObject({
                    name: 'mysave.nxsp',
                    event: 'saved',
                })
        })
    }

    test('taking over another tab’s file under a new name writes the picked name into it', async ({
        context,
    }) => {
        const b = await context.newPage()
        await start(b)
        await edit(b, 1)
        await pressSave(b)
        await submitSave(b, 'coconut')
        await expect(notice(b).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
        await expect
            .poll(async () => (await chainOf(b)).file)
            .toMatchObject({ name: 'coconut.nxsp' })
        const a = await context.newPage()
        await start(a)
        await edit(a, 5)
        // A types another name; the picker returns B's file.
        await queuePicks(a, ['coconut.nxsp'])
        await pressSave(a)
        await submitSave(a, 'mine')
        await expect(
            notice(a).filter({
                hasText: 'Saved to coconut.nxsp. Its earlier work is in Recent Sessions.',
            }),
        ).toBeVisible()
        const written = await projectOf(a, 'coconut.nxsp')
        expect((written.revision as Row).fileName).toBe('coconut.nxsp')
        expect(written.id).toBe((await chainOf(a)).docId)
        const { entries } = await rows(a, ['entries'])
        const text = JSON.stringify(entries!.filter((row) => row.value.kind === 'save').at(-1))
        expect(text).toContain('coconut.nxsp')
        expect(text).not.toContain('mine.nxsp')
    })
})
