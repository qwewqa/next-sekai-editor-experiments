import { openStagedTarget } from '../../src/editor/exportVideo/worker/target'

self.onmessage = async ({
    data,
}: MessageEvent<{ handle: FileSystemFileHandle; cancel: boolean }>) => {
    try {
        const target = await openStagedTarget(data.handle)
        await target.write(new Uint8Array([1, 2, 3, 4]), 0)
        await target.write(new Uint8Array([8, 9]), 1)
        if (data.cancel) await target.abort()
        else await target.close()
        self.postMessage({ ok: true })
    } catch (error) {
        self.postMessage({ error: String(error) })
    }
}
