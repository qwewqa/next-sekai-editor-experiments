import { expect, type Page } from '@playwright/test'
import { wav } from './levelInfoFiles'

export const holdVideoBgm = async (page: Page, fails = false) => {
    await page.evaluate(
        async ({ bytes, fails }) => {
            const { configureHeldBgm, decodeBgmData } = await window.editorTest.appImport<
                typeof import('../../src/editor/media/heldBgm')
            >('/src/editor/media/heldBgm.ts')
            const gate = new Promise<void>((resolve) => {
                Reflect.set(window, 'releaseBgmDecode', resolve)
            })
            configureHeldBgm({
                read: async () => new Uint8Array(bytes).buffer,
                decode: async (data) => {
                    Reflect.set(window, 'bgmDecodeStarted', true)
                    await gate
                    if (fails) throw new Error('BGM decode failed')
                    return decodeBgmData(data)
                },
            })
            const { history } = window.editorTest
            history.replaceState({
                ...history.state.value,
                bgm: {
                    offset: 0.25,
                    meta: {
                        hash: 'a'.repeat(32),
                        filename: 'loading.wav',
                        size: bytes.length,
                        type: 'audio/wav',
                    },
                },
            })
        },
        { bytes: [...wav(12)], fails },
    )
    await expect
        .poll(() => page.evaluate(() => Reflect.get(window, 'bgmDecodeStarted') as boolean))
        .toBe(true)
}

export const requestVideoDialog = async (page: Page, presses = 1, bgmWaitMs?: number) =>
    page.evaluate(
        async ({ presses, bgmWaitMs }) => {
            const { appImport } = window.editorTest
            const { openExportVideo } = await appImport<
                typeof import('../../src/editor/exportVideo/open')
            >('/src/editor/exportVideo/open.ts')
            const { pageEnv } = await appImport<typeof import('../../src/editor/exportVideo/env')>(
                '/src/editor/exportVideo/env.ts',
            )
            const { takeStoppedExports } = await appImport<
                typeof import('../../src/editor/exportVideo/recovery')
            >('/src/editor/exportVideo/recovery.ts')
            const { modals } =
                await appImport<typeof import('../../src/modals')>('/src/modals/index.ts')
            const calls: Promise<void>[] = []
            for (let i = 0; i < presses; i++)
                calls.push(
                    openExportVideo(
                        pageEnv(
                            () =>
                                new Worker('/src/editor/exportVideo/export.worker.ts', {
                                    type: 'module',
                                }),
                        ),
                        undefined,
                        bgmWaitMs,
                    ),
                )
            Reflect.set(window, 'videoOpenCalls', Promise.all(calls))
            // With no stopped exports, this resolves after the opening check.
            await takeStoppedExports()
            return modals.length
        },
        { presses, bgmWaitMs },
    )

export const releaseVideoBgm = (page: Page) =>
    page.evaluate(async () => {
        ;(Reflect.get(window, 'releaseBgmDecode') as () => void)()
        const { settleHeldBgm } = await window.editorTest.appImport<
            typeof import('../../src/editor/media/heldBgm')
        >('/src/editor/media/heldBgm.ts')
        await settleHeldBgm()
    })

type DialogOptions = Parameters<
    (typeof import('../../src/editor/exportVideo/test'))['openExportVideoTest']
>[0]

export const openVideoDialog = async (page: Page, options: DialogOptions = {}) => {
    await page.evaluate(async (options) => {
        const path = '/src/editor/exportVideo/test.ts'
        const { openExportVideoTest } = window.editorTest
            ? await window.editorTest.appImport<typeof import('../../src/editor/exportVideo/test')>(
                  path,
              )
            : ((await import(path)) as typeof import('../../src/editor/exportVideo/test'))
        await openExportVideoTest(options)
    }, options)
    const dialog = videoDialog(page)
    await expect(dialog).toBeVisible()
    return dialog
}

export const videoDialog = (page: Page) => page.locator('dialog:has([data-export-form])')
export const videoPhase = (page: Page) =>
    videoDialog(page).locator('[data-export-phase]').getAttribute('data-export-phase')
export const videoExportButton = (page: Page) => videoDialog(page).locator('[data-export-start]')
/**
 * How long a short clip's export may take. Chromium on the Linux runner has no H.264 encoder, so
 * Automatic makes WebM, encoded in software, with the preview drawn in software too.
 */
export const videoExportTimeout = process.env.CI ? 60_000 : 20_000

/** A clip from 0 at 720p, 0.2 s (6 frames at 30 fps) long by default. */
export const shortVideoClip = async (page: Page, seconds = 0.2) => {
    const dialog = videoDialog(page)
    await dialog.getByRole('combobox', { name: 'Resolution' }).selectOption({ label: '720p' })
    for (const [name, value] of [
        ['In', '0'],
        ['Out', String(seconds)],
    ]) {
        const field = dialog.getByRole('textbox', { name, exact: true })
        await field.fill(value!)
        await field.press('Enter')
    }
    await expect(dialog.locator('[data-export-summary]')).toContainText(
        `00:${seconds.toFixed(3).padStart(6, '0')}`,
    )
}
