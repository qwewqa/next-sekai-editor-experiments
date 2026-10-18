import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileErrorKey } from '../../src/editor/commands/exportLevel/errorText'
import { FileError, type FileErrorCode, type FileErrorStep } from '../../src/platform/types'

const save = (
    JSON.parse(readFileSync(new URL('../../src/i18n/en/index.json', import.meta.url), 'utf8')) as {
        save: Record<string, string>
    }
).save

test('a failed step names the step, whatever its code', () => {
    const steps: Record<FileErrorStep, string> = {
        build: 'buildFailed',
        read: 'readFailed',
        readBack: 'changedWhileWriting',
        download: 'downloadFailed',
    }
    for (const [step, key] of Object.entries(steps))
        for (const code of ['io', 'denied'] as const)
            assert.equal(
                fileErrorKey(new FileError(code, 'x', undefined, step as FileErrorStep)),
                key,
            )
})

test('a failure without a step is told by its code', () => {
    const codes: Record<FileErrorCode, string> = {
        denied: 'denied',
        'not-found': 'notFound',
        conflict: 'changedWhileWriting',
        'not-local': 'notLocal',
        'no-space': 'noSpace',
        'read-only': 'writeFailed',
        io: 'writeFailed',
    }
    for (const [code, key] of Object.entries(codes))
        assert.equal(fileErrorKey(new FileError(code as FileErrorCode, 'x')), key)
})

test('every message is a save message naming its file', () => {
    const keys = new Set<string>()
    for (const step of [undefined, 'build', 'read', 'readBack', 'download'] as const)
        for (const code of [
            'denied',
            'not-found',
            'conflict',
            'not-local',
            'no-space',
            'io',
        ] as const)
            keys.add(fileErrorKey(new FileError(code, 'x', undefined, step)))
    for (const key of keys) assert.match(save[key] ?? '', /\{0\}/, key)
})
