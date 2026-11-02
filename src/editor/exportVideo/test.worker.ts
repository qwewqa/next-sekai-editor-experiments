import { installExportWorker } from '../../exportVideo/worker/export.worker'
import { createTestSink } from '../../exportVideo/worker/testSink'
import { testKeysOpen } from '../../platform/testKeys'
import { openStagedFile } from './worker/target'

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
