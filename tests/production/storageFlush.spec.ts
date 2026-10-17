import { expect, test, type Page } from '@playwright/test'
import { chart, instrumentRendering, stereoWav } from './fixtures'

// The flush in the release build (Part 1 §1.6.4): the classic (iife) worker deflates, verifies,
// hashes and stores an import at once and a BGM pick with its bytes, under the web policy, and
// goes on storing after a restart from its Blob copy.

type Row = { key: unknown; value: Record<string, unknown> }

const rows = (page: Page, stores: string[]) =>
    page.evaluate(
        (stores) =>
            window.nseStorageTest!.worker.call('testRows', stores) as Promise<
                Record<string, Row[]>
            >,
        stores,
    )

const settled = (page: Page) =>
    expect
        .poll(() =>
            page.evaluate(async () => {
                const test = window.nseFlushTest!
                await test.flusher.flush()
                return !test.flusher.hasPending && !test.flusher.failed
            }),
        )
        .toBe(true)

test('the release build stores an import at once, a BGM pick with its bytes, and goes on after a restart', async ({
    page,
}) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(() => {
        sessionStorage.setItem('nse.test.storage', '{}')
    })
    await page.addInitScript(instrumentRendering)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.nseFlushTest !== undefined)).toBe(true)

    const opening = page.waitForEvent('filechooser')
    await page.keyboard.press('o')
    await (
        await opening
    ).setFiles({ name: 'stored.usc', mimeType: 'application/json', buffer: chart })
    await expect(page.locator('.notification')).toHaveText('Imported USC chart')
    await settled(page)
    let stored = await rows(page, ['sessions', 'chains', 'entries'])
    expect(stored.sessions).toHaveLength(1)
    expect(stored.sessions![0]!.value.origin).toBe('import')
    expect(stored.chains![0]!.value.sourceName).toBe('stored')
    expect(stored.entries!.map(({ value }) => value.kind)).toEqual(['init'])

    await page.keyboard.press('m')
    const modal = page.getByRole('dialog')
    const field = modal.locator('input[type="button"]')
    const choosing = page.waitForEvent('filechooser')
    await field.click()
    await (
        await choosing
    ).setFiles({ name: 'song.wav', mimeType: 'audio/wav', buffer: stereoWav() })
    await expect(field).toHaveValue(/^00:/)
    await modal.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect(modal).toHaveCount(0)
    await settled(page)
    stored = await rows(page, ['entries', 'media'])
    expect(stored.entries!.map(({ value }) => value.kind)).toEqual(['init', 'edit'])
    expect(stored.media).toHaveLength(1)
    expect(stored.media![0]!.value).toMatchObject({
        kind: 'bgm',
        type: 'audio/wav',
        filename: 'song.wav',
    })

    // A restart from the Blob copy, then another change is stored.
    await page.route('**/assets/storage.worker-*.js', (route) => route.fulfill({ status: 404 }))
    await page.evaluate(() => window.nseStorageTest!.worker.call('testCrash'))
    await expect
        .poll(() => page.evaluate(() => window.nseStorageTest!.worker.started.length))
        .toBe(2)
    await page.keyboard.press('z')
    await settled(page)
    stored = await rows(page, ['entries'])
    expect(stored.entries!.map(({ value }) => value.kind)).toEqual(['init', 'edit', 'undo'])
    expect(await page.evaluate(() => window.nseFlushTest!.errors.map(String))).toEqual([])
    expect(errors).toEqual([])
})

test('the release build ignores the dbVersion test flag, so it can’t upgrade the real database', async ({
    page,
}) => {
    await page.addInitScript(() => {
        sessionStorage.setItem('nse.test.storage', '{"dbVersion":2}')
    })
    await page.goto('/')
    await expect
        .poll(() => page.evaluate(() => window.nseStorageTest?.status()))
        .toEqual({ mode: 'stored' })
    const version = await page.evaluate(
        () =>
            new Promise<number>((resolve, reject) => {
                const request = indexedDB.open('nse-local-data')
                request.onsuccess = () => {
                    resolve(request.result.version)
                    request.result.close()
                }
                request.onerror = () => reject(request.error ?? new Error('open failed'))
            }),
    )
    expect(version).toBe(1)
})
