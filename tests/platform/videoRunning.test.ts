import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FakeLockManager } from '../../src/local/testing/locks'
import { videoLock } from '../../src/platform/videoOutput'
import { markVideoRunning, takeStoppedVideoMarkers } from '../../src/platform/videoRunning'

test('stop markers retain the chosen pair and leave active exports alone', async (t) => {
    const manager = new FakeLockManager()
    const locks = manager.client(manager.scheduler.main)
    const storage = Object.create({
        getItem(this: Record<string, string>, key: string) {
            return this[key] ?? null
        },
        setItem(this: Record<string, string>, key: string, value: string) {
            this[key] = value
        },
        removeItem(this: Record<string, string>, key: string) {
            delete this[key]
        },
    }) as Storage
    const win = new EventTarget()
    for (const [key, value] of Object.entries({
        localStorage: storage,
        window: win,
        navigator: {
            locks: {
                request: (
                    name: string,
                    options: { ifAvailable?: boolean },
                    callback: (lock: { name: string } | null) => unknown,
                ) => locks.request(name, options, async (held) => callback(held ? { name } : null)),
            },
        },
    })) {
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, key)
        Object.defineProperty(globalThis, key, { value, configurable: true })
        t.after(() => {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor)
            else Reflect.deleteProperty(globalThis, key)
        })
    }
    const setting = { resolution: 2160, renderScale: 2, pixels: 7680 * 4320 }
    let release!: () => void
    let acquired!: () => void
    const ready = new Promise<void>((resolve) => {
        acquired = resolve
    })
    const held = locks.request(videoLock('active'), {}, async () => {
        await new Promise<void>((resolve) => {
            release = resolve
            acquired()
        })
    })
    await ready
    const clear = markVideoRunning('active', setting)
    markVideoRunning('abandoned', setting)
    const stops: unknown[] = []
    await takeStoppedVideoMarkers((value) => stops.push(value))
    assert.deepEqual([...stops], [setting])
    assert.equal(storage.getItem('exportVideoRunning.abandoned'), null)
    assert.deepEqual(JSON.parse(storage.getItem('exportVideoRunning.active')!), setting)
    clear()
    release()
    await held
    await takeStoppedVideoMarkers((value) => stops.push(value))
    assert.equal(stops.length, 1, 'a handled end leaves no stop')
    markVideoRunning('pagehide', setting)
    win.dispatchEvent(new Event('pagehide'))
    assert.equal(storage.getItem('exportVideoRunning.pagehide'), null)
})
