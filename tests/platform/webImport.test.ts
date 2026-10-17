import assert from 'node:assert/strict'
import test from 'node:test'

// Runs in its own process: nothing has imported the platform module yet.
test('#platform resolves in Node to web.ts, which touches no window, navigator or localStorage at import', async () => {
    const touched: string[] = []
    const saved = new Map<string, PropertyDescriptor | undefined>()
    for (const name of ['window', 'document', 'navigator', 'localStorage']) {
        saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
        Object.defineProperty(globalThis, name, {
            configurable: true,
            get: () => {
                touched.push(name)
                return undefined
            },
        })
    }
    try {
        const { platform } = await import('#platform')
        assert.equal(platform.kind, 'web')
        assert.equal(typeof platform.saveFile, 'function')
    } finally {
        for (const [name, descriptor] of saved) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor)
            else delete (globalThis as Record<string, unknown>)[name]
        }
    }
    assert.deepEqual(touched, [])
})
