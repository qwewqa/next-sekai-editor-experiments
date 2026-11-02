import assert from 'node:assert/strict'
import test from 'node:test'
import './saveMatrix/env'

const { describeVideoFailure } = await import('../../src/editor/exportVideo/failure')

test('a failed video names an empty picked file when cleanup could not remove it', async () => {
    const handle = {
        name: 'project.nxsp',
        getFile: () => Promise.resolve(new File([], 'project.nxsp')),
    } as FileSystemFileHandle
    const failure = await describeVideoFailure(new Error('Encoding failed'), 'clip.mp4', handle)
    assert.equal(failure.reason, 'encoder')
    assert.match(failure.message(), /project.nxsp/)
    assert.match(failure.message(), /The file is now empty/)
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
