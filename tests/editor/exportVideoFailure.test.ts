import assert from 'node:assert/strict'
import test from 'node:test'
import './saveMatrix/env'

const { describeVideoFailure } = await import('../../src/editor/exportVideo/failure')
const { FileError } = await import('../../src/platform/types')
const sound = { bgm: true, sfx: true }

test('a failed video adds that the picked file is now empty when cleanup could not remove it', async () => {
    const handle = {
        name: 'project.nxsp',
        getFile: () => Promise.resolve(new File([], 'project.nxsp')),
    } as FileSystemFileHandle
    const failure = await describeVideoFailure(
        new Error('Encoding failed'),
        'clip.mp4',
        sound,
        handle,
    )
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
        const failure = await describeVideoFailure(
            new Error('Encoding failed'),
            'clip.mp4',
            sound,
            handle,
        )
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
        sound,
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
    const failure = await describeVideoFailure(restored, 'clip.webm', sound)
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

test('Error Details list each failure once, without the error they explain', async () => {
    const { withFailureDetails, failureDetails } = await import('../../src/exportVideo/error')
    // A failed write whose cleanup left the pick empty; the worker's own cleanup then fails with
    // the stream's stored error and the same failed removal.
    const removal = new FileError('denied', 'clip.mp4 was left empty')
    const write = withFailureDetails(new FileError('no-space', 'Full'), [removal])
    const reported = withFailureDetails(write, [write, removal])
    assert.equal(reported, write)
    assert.deepEqual(failureDetails(reported), ['FileError: clip.mp4 was left empty'])
})

test('a sound failure keeps its reason across the worker, and only a sound failure has it', async () => {
    const { AudioFailure, serializeExportError, restoreExportError } =
        await import('../../src/exportVideo/error')
    const error = new AudioFailure(new DOMException('Encoding failed', 'EncodingError'))
    const restored = restoreExportError(structuredClone(serializeExportError(error)))
    assert.ok(restored instanceof AudioFailure)
    const failure = await describeVideoFailure(restored, 'clip.mp4', sound)
    assert.equal(failure.reason, 'audio')
    assert.equal(
        failure.message(),
        'The sound could not be created. Try again, or turn off BGM and SFX.',
    )
    // Words in a message do not make a failure the sound's.
    const other = await describeVideoFailure(
        new Error('Unexpected audio packet'),
        'clip.mp4',
        sound,
    )
    assert.equal(other.reason, 'encoder')
})
