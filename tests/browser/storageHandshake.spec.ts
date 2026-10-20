import { expect, test, type Page } from '@playwright/test'
import type { StorageStatus, TestFlags } from '../../src/local/worker/core'
import { installCanvasCounters } from './editorFixture'

// The upgrade handshake in a real browser, with two tabs (Part 1 §1.6.1; Step 3a's exit): the
// build opens version 3; a simulated newer tab is the build with the test flag `dbVersion: 4`, a
// frozen tab the flag `ignoreVersionChange`. Each tab's flag is in its own sessionStorage.

// Playwright's Windows WebKit build has no Web Audio, which the editor needs to start; these run
// in WebKit on Linux CI.
test.skip(
    ({ browserName }) => browserName === 'webkit' && process.platform === 'win32',
    'Playwright WebKit on Windows does not provide Web Audio',
)

const boot = async (page: Page, flags: TestFlags = {}) => {
    await page.addInitScript(installCanvasCounters)
    await page.addInitScript((text) => {
        sessionStorage.setItem('nse.test.storage', text)
    }, JSON.stringify(flags))
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
}

const status = (page: Page) =>
    page.evaluate(() => window.nseStorageTest?.status() as StorageStatus | undefined)

const putRow = (page: Page, key: string) =>
    page.evaluate(
        (key) =>
            window.nseStorageTest!.worker.call('testPut', { key, value: key }).then(
                () => 'stored',
                (error: Error) => error.name,
            ),
        key,
    )

/** The database's version and stores, read from the page without a version. */
const database = (page: Page) =>
    page.evaluate(
        () =>
            new Promise<{ version: number; stores: string[] }>((resolve, reject) => {
                const request = indexedDB.open('nse-local-data')
                request.onsuccess = () => {
                    const db = request.result
                    resolve({ version: db.version, stores: Array.from(db.objectStoreNames).sort() })
                    db.close()
                }
                request.onerror = () => reject(request.error ?? new Error('open failed'))
            }),
    )

const pill = (page: Page) => page.locator('.notification-pill')

test('the worker opens nse-local-data at version 3 with every store', async ({ page }) => {
    await boot(page)
    await expect.poll(() => status(page)).toEqual({ mode: 'stored' })
    expect(await database(page)).toEqual({
        version: 3,
        stores: [
            'chains',
            'chunks',
            'entries',
            'handles',
            'media',
            'meta',
            'nodes',
            'recovered',
            'sessions',
            'stackBlocks',
            'tombstones',
            'userAssets',
        ],
    })
    expect(await putRow(page, 'a')).toBe('stored')
    // No load notice: the plain start-up pill.
    await expect(page.locator('.notification')).toHaveText('Next SEKAI Editor\nVersion 0.6.0')
})

test('a newer tab: the current tab closes its connection and pauses storing', async ({
    context,
}) => {
    const old = await context.newPage()
    await boot(old)
    await expect.poll(() => status(old)).toEqual({ mode: 'stored' })
    const next = await context.newPage()
    await boot(next, { dbVersion: 4 })
    await expect.poll(() => status(next)).toEqual({ mode: 'stored' })
    await expect.poll(() => status(old)).toEqual({ mode: 'stored', reason: 'upgrading' })
    expect(await putRow(old, 'late')).toBe('StorageRefusedError')
    expect(await putRow(next, 'x')).toBe('stored')
    expect((await database(next)).version).toBe(4)
    // Pausing says nothing at an arbitrary time.
    await expect(pill(old)).toHaveCount(0)
})

test('upgradeWanted alone closes a current tab’s connection', async ({ context }) => {
    const old = await context.newPage()
    await boot(old)
    await expect.poll(() => status(old)).toEqual({ mode: 'stored' })
    const other = await context.newPage()
    await other.goto('/favicon.ico')
    await other.evaluate(() => {
        new BroadcastChannel('nse-local-data').postMessage({ type: 'upgradeWanted', version: 4 })
    })
    await expect.poll(() => status(old)).toEqual({ mode: 'stored', reason: 'upgrading' })
})

test('onversionchange alone closes a current tab’s connection, so an upgrade is never blocked', async ({
    context,
}) => {
    const old = await context.newPage()
    await boot(old)
    await expect.poll(() => status(old)).toEqual({ mode: 'stored' })
    const other = await context.newPage()
    await other.goto('/favicon.ico')
    const blocked = await other.evaluate(
        () =>
            new Promise<boolean>((resolve, reject) => {
                let wasBlocked = false
                const request = indexedDB.open('nse-local-data', 4)
                request.onblocked = () => (wasBlocked = true)
                request.onsuccess = () => {
                    request.result.close()
                    resolve(wasBlocked)
                }
                request.onerror = () => reject(request.error ?? new Error('open failed'))
            }),
    )
    expect(blocked).toBe(false)
    await expect.poll(() => status(old)).toEqual({ mode: 'stored', reason: 'upgrading' })
})

test('a frozen tab leaves the newer tab with storage unavailable after about 3 s, never hung', async ({
    context,
}) => {
    test.setTimeout(60_000)
    const frozen = await context.newPage()
    await boot(frozen, { ignoreVersionChange: true })
    await expect.poll(() => status(frozen)).toEqual({ mode: 'stored' })

    const next = await context.newPage()
    const started = Date.now()
    await boot(next, { dbVersion: 4 })
    await expect
        .poll(() => status(next), { timeout: 15_000 })
        .toEqual({ mode: 'memory', reason: 'olderTabs' })
    expect(Date.now() - started).toBeLessThan(12_000)
    await expect(pill(next)).toContainText(
        'Close other Next SEKAI Editor tabs to open your stored work.',
    )
    // The load notice is a warning.
    await expect(pill(next).locator('svg[data-severity="warning"]')).toHaveCount(1)
    // Storage unavailable: the tab still works, in memory.
    expect(await putRow(next, 'inMemory')).toBe('stored')

    // Try Again while the frozen tab is still there asks again and says so again.
    await pill(next).getByRole('button', { name: 'Try Again' }).click()
    await expect(pill(next)).toContainText(
        'Close other Next SEKAI Editor tabs to open your stored work.',
        { timeout: 10_000 },
    )
    // Try Again's own result card is a warning too.
    await expect(
        next.locator(
            '[data-notice-card] svg[data-severity="warning"], .notification-pill svg[data-severity="warning"]',
        ),
    ).toHaveCount(1)
    expect(await status(next)).toEqual({ mode: 'memory', reason: 'olderTabs' })
    expect(await status(frozen)).toEqual({ mode: 'stored' })

    // With the frozen tab gone, Try Again opens the stored work.
    await frozen.close()
    await pill(next).getByRole('button', { name: 'Try Again' }).click()
    await expect.poll(() => status(next), { timeout: 10_000 }).toEqual({ mode: 'stored' })
    expect((await database(next)).version).toBe(4)
    expect(await putRow(next, 'stored')).toBe('stored')
})

test('a database newer than this build opens read-only, with its load notice', async ({
    context,
}) => {
    const next = await context.newPage()
    await boot(next, { dbVersion: 4 })
    await expect.poll(() => status(next)).toEqual({ mode: 'stored' })
    expect(await putRow(next, 'fromNext')).toBe('stored')
    await next.close()

    const old = await context.newPage()
    await boot(old)
    await expect.poll(() => status(old)).toEqual({ mode: 'readOnly' })
    // The heading with the product and the version, then a row for the load notice.
    await expect(old.locator('.notification-pill > div')).toHaveText([
        'Next SEKAI Editor · Version 0.6.0',
        'This version is older than your data. Reload, or save your work to files.',
    ])
    await expect(old.locator('.notification-pill svg[data-severity="warning"]')).toHaveCount(1)
    expect(
        await old.evaluate(() => window.nseStorageTest!.worker.call('testGet', 'fromNext')),
    ).toBe('fromNext')
    expect(await putRow(old, 'fromOld')).toBe('StorageRefusedError')
})
