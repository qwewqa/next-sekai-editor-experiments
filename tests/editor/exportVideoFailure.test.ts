import assert from 'node:assert/strict'
import test from 'node:test'
import './saveMatrix/env'

const { describeVideoFailure } = await import('../../src/editor/exportVideo/failure')
const { FileError } = await import('../../src/platform/types')

test('a failed video adds that the picked file is now empty when cleanup could not remove it', async () => {
    const handle = {
        name: 'project.nxsp',
        getFile: () => Promise.resolve(new File([], 'project.nxsp')),
    } as FileSystemFileHandle
    const failure = await describeVideoFailure(new Error('Encoding failed'), 'clip.mp4', handle)
    assert.equal(failure.reason, 'encoder')
    assert.equal(failure.message(), 'The video could not be created. The file is now empty.')
})

test('a removed, unreadable or changed video target keeps the original failure', async () => {
    for (const getFile of [
        () => Promise.reject(new DOMException('', 'NotFoundError')),
        () => Promise.reject(new DOMException('', 'NotAllowedError')),
        () => Promise.resolve(new File(['other writer'], 'project.nxsp')),
    ]) {
        const handle = { name: 'project.nxsp', getFile } as FileSystemFileHandle
        const failure = await describeVideoFailure(new Error('Encoding failed'), 'clip.mp4', handle)
        assert.equal(failure.reason, 'encoder')
        assert.doesNotMatch(failure.message(), /The file is now empty/)
    }
})

test('a file failure without a name names the picked file, not the suggested one', async () => {
    const handle = {
        name: 'Picked.mp4',
        getFile: () => Promise.reject(new DOMException('', 'NotAllowedError')),
    } as FileSystemFileHandle
    const failure = await describeVideoFailure(
        new FileError('denied', 'Access was revoked'),
        'clip.mp4',
        handle,
    )
    assert.equal(failure.reason, 'denied')
    assert.match(failure.message(), /Picked\.mp4/)
    assert.doesNotMatch(failure.message(), /clip\.mp4/)
})

test('a failed rerun leads with its own error, and Error Details add the refusal and the cleanup', async () => {
    const { withFailureDetails, serializeExportError, restoreExportError } =
        await import('../../src/exportVideo/error')
    const refusal = new DOMException('Write refused', 'NotAllowedError')
    const cleanup = new FileError('io', 'clip.webm could not be removed')
    const rerun = withFailureDetails(new Error('Encoding failed'), [refusal, cleanup])
    const restored = restoreExportError(structuredClone(serializeExportError(rerun)))
    const failure = await describeVideoFailure(restored, 'clip.webm')
    assert.equal(failure.reason, 'encoder')
    assert.equal(failure.message(), 'The video could not be created.')
    assert.equal(
        failure.detail,
        [
            'Error: Encoding failed',
            'NotAllowedError: Write refused',
            'FileError: clip.webm could not be removed',
        ].join('\n'),
    )
})
