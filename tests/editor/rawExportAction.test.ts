import assert from 'node:assert/strict'
import test from 'node:test'
import type { exportRawData } from '../../src/local/rawExport'
import type { SaveRequest, SaveResult } from '../../src/platform/types'
import { rawExportNote } from '../../src/startup/rawExportNote'
import { runRawExport } from '../../src/startup/rawExportRun'

// Export Raw Data… behind a Loading dialog: closing the dialog (its signal) stops the hand-over.

const built: typeof exportRawData = async (_version, name, save) => {
    await save(name, new Blob(['zip']))
    return { databaseUnreadable: false }
}

const setup = (save: (request: SaveRequest) => Promise<SaveResult>) => {
    const requests: SaveRequest[] = []
    return {
        requests,
        run: {
            exportRawData: built,
            appVersion: '1',
            name: 'raw.zip',
            saveFile: (request: SaveRequest) => {
                requests.push(request)
                return save(request)
            },
        },
    }
}

const started = () => Promise.resolve<SaveResult>({ status: 'download-started', name: 'raw.zip' })

const quiet = async <T>(run: () => Promise<T>) => {
    const original = console.error
    console.error = () => undefined
    try {
        return await run()
    } finally {
        console.error = original
    }
}

test('a cancel before the hand-over hands nothing over and is not a failure', async () => {
    const { run, requests } = setup(started)
    const controller = new AbortController()
    controller.abort()
    const result = await runRawExport(run, controller.signal)
    assert.equal(result.kind, 'cancelled')
    assert.equal(requests.length, 0)
    assert.equal(
        rawExportNote(result, { downloadFailed: 'failed', unreadable: 'unreadable' }),
        undefined,
    )
})

test('a cancel during the hand-over is a cancel, and the request carries the signal', async () => {
    const controller = new AbortController()
    const { run, requests } = setup((request) => {
        controller.abort()
        request.signal?.throwIfAborted()
        return started()
    })
    const result = await runRawExport(run, controller.signal)
    assert.equal(result.kind, 'cancelled')
    assert.equal(requests[0]?.signal, controller.signal)
})

test('an AbortError the user did not cause is a failure', async () => {
    const { run } = setup(() => Promise.reject(new DOMException('blocked', 'AbortError')))
    const result = await quiet(() => runRawExport(run, new AbortController().signal))
    assert.equal(result.kind, 'failed')
})

test('without a signal the export is handed over, as the start-up gate runs it', async () => {
    const { run, requests } = setup(started)
    const result = await runRawExport(run)
    assert.equal(result.kind, 'done')
    assert.equal(requests.length, 1)
    assert.equal(requests[0]?.signal, undefined)
})
