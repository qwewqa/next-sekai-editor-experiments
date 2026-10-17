import { expect, test, type BrowserContext } from '@playwright/test'

// IndexedDB commit-on-unload, measured (Part 1 §1.13.5): whether a transaction a dedicated worker
// has committed survives the page closing at once. It decides how often the journal is needed,
// not whether it's written. A bare worker on a blank page of the origin, so every engine runs it
// (Playwright's WebKit on Windows can't start the editor); the figures go to the annotations.

const TRIALS = 10

// A worker that writes one 64 KB row and commits; it answers on complete, or right after commit().
const WORKER = `
onmessage = (event) => {
    const { key, wait } = event.data
    const request = indexedDB.open('nse-commit-probe', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('rows')
    request.onsuccess = () => {
        const tx = request.result.transaction(['rows'], 'readwrite')
        tx.objectStore('rows').put(new Uint8Array(64 * 1024).fill(7), key)
        tx.oncomplete = () => postMessage('complete')
        tx.commit()
        if (!wait) postMessage('committing')
    }
}`

const write = async (context: BrowserContext, key: string, wait: boolean) => {
    const page = await context.newPage()
    await page.goto('/favicon.ico')
    await page.evaluate(
        ({ source, key, wait }) =>
            new Promise<void>((resolve) => {
                const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
                const worker = new Worker(url)
                worker.onmessage = () => resolve()
                worker.postMessage({ key, wait })
            }),
        { source: WORKER, key, wait },
    )
    await page.close()
}

const count = async (context: BrowserContext, keys: string[]) => {
    const page = await context.newPage()
    await page.goto('/favicon.ico')
    const found = await page.evaluate(
        (keys) =>
            new Promise<number>((resolve, reject) => {
                const request = indexedDB.open('nse-commit-probe', 1)
                request.onupgradeneeded = () => request.result.createObjectStore('rows')
                request.onsuccess = () => {
                    const tx = request.result.transaction(['rows'], 'readonly')
                    const store = tx.objectStore('rows')
                    let n = 0
                    for (const key of keys) {
                        const get = store.getKey(key)
                        get.onsuccess = () => {
                            if (get.result !== undefined) n++
                        }
                    }
                    tx.oncomplete = () => resolve(n)
                }
                request.onerror = () => reject(request.error ?? new Error('open failed'))
            }),
        keys,
    )
    await page.close()
    return found
}

test('a committed transaction survives the page closing; one still committing is measured', async ({
    context,
    browserName,
}) => {
    test.setTimeout(120_000)
    const acknowledged = Array.from({ length: TRIALS }, (_, i) => `ack${i}`)
    const committing = Array.from({ length: TRIALS }, (_, i) => `commit${i}`)
    for (const key of acknowledged) await write(context, key, true)
    for (const key of committing) await write(context, key, false)
    const survived = {
        acknowledged: await count(context, acknowledged),
        committing: await count(context, committing),
    }
    const line = `${browserName}: acknowledged ${survived.acknowledged}/${TRIALS}, committing ${survived.committing}/${TRIALS}`
    test.info().annotations.push({ type: 'commit-on-unload', description: line })
    console.log(`commit-on-unload ${line}`)
    expect(survived.acknowledged).toBe(TRIALS)
})
