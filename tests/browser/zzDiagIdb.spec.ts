import { test } from '@playwright/test'

const probe = async () => {
    const out: string[] = []
    const open = () =>
        new Promise<IDBDatabase>((resolve, reject) => {
            const r = indexedDB.open('diag-' + Math.random(), 1)
            r.onupgradeneeded = () => r.result.createObjectStore('s')
            r.onsuccess = () => resolve(r.result)
            r.onerror = () => reject(r.error)
        })
    const req = <T,>(r: IDBRequest<T>) =>
        new Promise<T>((resolve, reject) => {
            r.onsuccess = () => resolve(r.result)
            r.onerror = () => reject(r.error)
        })
    for (const [name, make] of [
        ['blob', () => new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' })],
        ['bytes', () => new Uint8Array([1, 2, 3])],
        ['file', () => new File([new Uint8Array([1, 2, 3])], 'a.wav')],
    ] as const) {
        try {
            const db = await open()
            const tx = db.transaction('s', 'readwrite')
            await req(tx.objectStore('s').put({ v: make() }, 1))
            await new Promise((resolve, reject) => {
                tx.oncomplete = resolve
                tx.onerror = () => reject(tx.error)
                tx.onabort = () => reject(tx.error)
            })
            const row = (await req(db.transaction('s').objectStore('s').get(1))) as { v: unknown }
            let read = ''
            if (row.v instanceof Blob)
                read = String(new Uint8Array(await row.v.arrayBuffer()))
            out.push(`${name}: ok ${read}`)
        } catch (e) {
            out.push(`${name}: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`)
        }
    }
    return out.join(' | ')
}

test('diag idb blobs', async ({ page }) => {
    await page.goto('about:blank')
    await page.goto('/')
    console.log('DIAG page', await page.evaluate(probe))
    console.log(
        'DIAG worker',
        await page.evaluate(async (source) => {
            const url = URL.createObjectURL(
                new Blob([`const probe = ${source}; probe().then((r) => postMessage(r))`], {
                    type: 'text/javascript',
                }),
            )
            const worker = new Worker(url)
            return new Promise<string>((resolve) => {
                worker.onmessage = (e) => resolve(e.data as string)
                worker.onerror = (e) => resolve(`error ${e.message}`)
            })
        }, probe.toString()),
    )
})
