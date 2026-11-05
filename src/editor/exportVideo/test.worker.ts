import { installExportWorker } from '../../exportVideo/worker/export.worker'
import { openStagedFile } from '../../exportVideo/worker/target'
import { createTestSink } from '../../exportVideo/worker/testSink'
import { testKeysOpen } from '../../platform/testKeys'

if (testKeysOpen) {
    const target = self.name
    if (target === 'foreground' || target === 'composite') {
        // eslint-disable-next-line @typescript-eslint/unbound-method -- Called with its context below.
        const check = WebGL2RenderingContext.prototype.checkFramebufferStatus
        let calls = 0
        WebGL2RenderingContext.prototype.checkFramebufferStatus = function (attachment) {
            if (++calls === (target === 'foreground' ? 1 : 2))
                return this.FRAMEBUFFER_INCOMPLETE_ATTACHMENT
            return check.call(this, attachment)
        }
    }
    if (target === 'uploadError') {
        const prototype = WebGL2RenderingContext.prototype
        // eslint-disable-next-line @typescript-eslint/unbound-method -- Called with its context below.
        const upload = prototype.texImage2D
        // eslint-disable-next-line @typescript-eslint/unbound-method -- Called with its context below.
        const getError = prototype.getError
        let uploaded = false
        let reported = false
        prototype.texImage2D = function (...args: unknown[]) {
            if (args.some((arg) => arg instanceof ImageBitmap)) uploaded = true
            Reflect.apply(upload, this, args)
        }
        // The first read after the first atlas upload.
        prototype.getError = function () {
            if (!uploaded || reported) return getError.call(this)
            reported = true
            return this.OUT_OF_MEMORY
        }
    }
    installExportWorker(async (start, destination, signal) => {
        if (destination.kind !== 'staged') throw new Error('Test sink requires a staged target')
        const target = await openStagedFile(destination.name, signal)
        const sink = createTestSink(start)
        let position = 0
        return {
            sink: {
                async add(input) {
                    await sink.add(input)
                    if (input.track === 'audioEnd') return
                    await target.write(input.packet.data, position)
                    position += input.packet.data.length
                },
                finalize: () => sink.finalize(),
                abort: () => sink.abort(),
            },
            commit: () => target.close(),
            abort: () => target.abort(),
        }
    })
}
