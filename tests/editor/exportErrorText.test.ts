import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { downloadHelps, fileErrorKey } from '../../src/editor/commands/exportLevel/errorText'
import { FileError, type FileErrorCode, type FileErrorStep } from '../../src/platform/types'

const save = (
    JSON.parse(readFileSync(new URL('../../src/i18n/en/index.json', import.meta.url), 'utf8')) as {
        save: Record<string, string>
    }
).save

test('a failed step names the step, whatever its code', () => {
    const steps: Record<Exclude<FileErrorStep, 'create' | 'close'>, string> = {
        build: 'buildFailed',
        read: 'readFailed',
        readBack: 'changedWhileWriting',
        download: 'downloadFailed',
        check: 'openedContentGone',
    }
    for (const [step, key] of Object.entries(steps))
        for (const code of ['io', 'denied'] as const)
            assert.equal(
                fileErrorKey(new FileError(code, 'x', undefined, step as FileErrorStep)),
                key,
            )
})

test('a failure at createWritable() or close() is told by its code, as without a step', () => {
    for (const step of ['create', 'close'] as const)
        for (const code of ['io', 'denied', 'no-space', 'read-only'] as const)
            assert.equal(
                fileErrorKey(new FileError(code, 'x', undefined, step)),
                fileErrorKey(new FileError(code, 'x')),
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
    for (const step of [undefined, 'build', 'read', 'readBack', 'download', 'check'] as const)
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

// Always Download follows a failure of the picked file's write: refused, read-only or failed, at
// any step of the write (Chrome for Android fails at `createWritable()`, step `create`), or a file
// that read back wrong. The others are not the chosen file's to blame.
test('Always Download is offered for each failure of the write to the chosen file, and no other', () => {
    const codes: FileErrorCode[] = [
        'conflict',
        'not-found',
        'denied',
        'not-local',
        'no-space',
        'read-only',
        'io',
    ]
    const steps: (FileErrorStep | undefined)[] = [
        undefined,
        'create',
        'close',
        'readBack',
        'build',
        'read',
        'download',
        'check',
    ]
    const offered = new Set([
        'io at the write',
        'io at create',
        'io at close',
        'read-only at the write',
        'read-only at create',
        'read-only at close',
        'denied at the write',
        'denied at create',
        'denied at close',
        ...codes.map((code) => `${code} at readBack`),
    ])
    for (const code of codes)
        for (const step of steps) {
            const name = `${code} at ${step ?? 'the write'}`
            assert.equal(
                downloadHelps(new FileError(code, 'x', undefined, step)),
                offered.has(name),
                name,
            )
        }
})
