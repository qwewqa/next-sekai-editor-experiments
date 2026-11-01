import { installExportWorker } from '../../exportVideo/worker/export.worker'
import { createTestSink } from '../../exportVideo/worker/testSink'
import { testKeysOpen } from '../../platform/testKeys'
import { openStagedTarget } from './worker/target'

if (testKeysOpen)
    installExportWorker(async (start, destination, signal) => {
        if (destination.kind !== 'staged') throw new Error('Test sink requires a staged target')
        const { handle } = destination
        const target = await openStagedTarget(handle, signal)
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
