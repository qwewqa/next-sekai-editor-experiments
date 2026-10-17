import { expect, test, type Page } from '@playwright/test'
import type { StorageStatus } from '../../src/local/worker/core'
import { installCanvasCounters } from './editorFixture'

// The storage worker's crash and restart on the dev server (Part 1 §1.6.5): here it restarts from
// its URL, since a module worker can't import from a blob: base; the production config checks the
// Blob copy (tests/production/csp.spec.ts).

// Playwright's Windows WebKit build has no Web Audio, which the editor needs to start; these run
// in WebKit on Linux CI.
test.skip(
    ({ browserName }) => browserName === 'webkit' && process.platform === 'win32',
    'Playwright WebKit on Windows does not provide Web Audio',
)

const boot = async (page: Page, flags: object) => {
    await page.addInitScript(installCanvasCounters)
    await page.addInitScript((text) => {
        sessionStorage.setItem('nse.test.storage', text)
    }, JSON.stringify(flags))
    await page.goto('/')
    await expect
        .poll(() =>
            page.evaluate(() => window.nseStorageTest?.status() as StorageStatus | undefined),
        )
        .toEqual({ mode: 'stored' })
}

test('a worker killed inside a transaction commits nothing and is restarted', async ({ page }) => {
    await boot(page, { crashAt: 'test:beforeCommit' })
    const failed = await page.evaluate(() =>
        window
            .nseStorageTest!.worker.call('testPutThrough', {
                key: 'lost',
                point: 'test:beforeCommit',
            })
            .then(
                () => 'stored',
                (error: Error) => error.name,
            ),
    )
    expect(failed).toBe('WorkerRestartedError')
    await expect
        .poll(() => page.evaluate(() => window.nseStorageTest!.worker.started.length))
        .toBe(2)
    await expect
        .poll(() => page.evaluate(() => window.nseStorageTest!.status()))
        .toEqual({ mode: 'stored' })
    expect(await page.evaluate(() => window.nseStorageTest!.worker.call('testGet', 'lost'))).toBe(
        undefined,
    )
    await page.evaluate(() =>
        window.nseStorageTest!.worker.call('testPut', { key: 'after', value: 1 }),
    )
    expect(await page.evaluate(() => window.nseStorageTest!.worker.call('testGet', 'after'))).toBe(
        1,
    )
})

test('an uncaught error in the worker restarts it, and storing goes on', async ({ page }) => {
    await boot(page, {})
    await page.evaluate(() => window.nseStorageTest!.worker.call('testCrash'))
    await expect
        .poll(() => page.evaluate(() => window.nseStorageTest!.worker.started.length))
        .toBe(2)
    await page.evaluate(() =>
        window.nseStorageTest!.worker.call('testPut', { key: 'after', value: 2 }),
    )
    expect(await page.evaluate(() => window.nseStorageTest!.worker.call('testGet', 'after'))).toBe(
        2,
    )
})
