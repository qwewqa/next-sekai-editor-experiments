import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The stored file handle probe (D16): an OPFS file handle goes into IndexedDB on a minimal page (no
// editor code), then is read back after a reload and after a browser restart, and used. The result
// is logged as a "PROBE" line per step, since a crash is itself a result.

const url = '/probe/handles.html'

const store = (page: Page) =>
    page.evaluate(async () => {
        const root = await navigator.storage.getDirectory()
        const handle = await root.getFileHandle('probe.txt', { create: true })
        const writable = await handle.createWritable()
        await writable.write('probe')
        await writable.close()
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('probe-direct', 1)
            request.onupgradeneeded = () => request.result.createObjectStore('handles')
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
        })
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('handles', 'readwrite')
            tx.objectStore('handles').put(handle, 'handle')
            tx.oncomplete = () => resolve()
            tx.onerror = () => reject(tx.error)
        })
        db.close()
    })

const readBack = (page: Page) =>
    page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('probe-direct', 1)
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
        })
        const handle = await new Promise<FileSystemFileHandle>((resolve, reject) => {
            const request = db.transaction('handles').objectStore('handles').get('handle')
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
        })
        db.close()
        const file = await handle.getFile()
        const before = await file.text()
        const writable = await handle.createWritable({ keepExistingData: true })
        await writable.seek(file.size)
        await writable.write('+')
        await writable.close()
        return { name: handle.name, before, after: await (await handle.getFile()).text() }
    })

/** A step that may close the page: a crash is reported instead of thrown. */
async function step(label: string, page: Page, run: () => Promise<unknown>) {
    let closed = false
    page.on('close', () => (closed = true))
    page.on('crash', () => (closed = true))
    try {
        const result = await Promise.race([
            run(),
            new Promise<never>((_, reject) =>
                page.once('close', () => reject(new Error('page closed'))),
            ),
        ])
        console.log(`PROBE ${label}: ok ${JSON.stringify(result ?? null)}`)
        return { ok: true as const, result }
    } catch (error) {
        console.log(`PROBE ${label}: FAILED (page closed: ${closed || page.isClosed()}) ${error}`)
        return { ok: false as const }
    }
}

for (const mode of ['persistent', 'plain'] as const)
    test(`a stored OPFS file handle survives a reload and a restart (${mode})`, async ({
        browserName,
        channel,
        browser,
    }, info) => {
        const label = `${channel ?? browserName} ${mode}`
        const dir = mkdtempSync(join(tmpdir(), 'nse-probe-'))
        const baseURL = info.project.use.baseURL
        const launch = async (): Promise<BrowserContext> =>
            mode === 'persistent'
                ? chromium.launchPersistentContext(dir, { channel, baseURL })
                : browser.newContext({ baseURL })

        let context = await launch()
        console.log(`PROBE ${label}: browser ${browser.version()}`)
        let page = await context.newPage()
        await page.goto(url)
        console.log(`PROBE ${label}: ${await page.evaluate(() => navigator.userAgent)}`)
        const stored = await step(`${label} store`, page, () => store(page))
        expect(stored.ok).toBe(true)

        await page.reload()
        const reloaded = await step(`${label} read after reload`, page, () => readBack(page))
        if (mode === 'plain' || !reloaded.ok)
            return void (await context.close().catch(() => undefined))
        await context.close().catch(() => undefined)

        context = await launch()
        page = await context.newPage()
        await page.goto(url)
        const restarted = await step(`${label} read after restart`, page, () => readBack(page))
        await context.close().catch(() => undefined)
        expect(restarted.ok).toBe(true)
    })
