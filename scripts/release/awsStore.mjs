// The asset store's bucket through the AWS CLI, which GitHub's runners have. `run(args)` resolves to
// { code, stdout, stderr }; the tests pass a fake.

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function runAws(args) {
    return new Promise((resolve, reject) => {
        execFile(
            'aws',
            [...args, '--output', 'json'],
            { maxBuffer: 64 * 1024 * 1024, env: { ...process.env, AWS_PAGER: '' } },
            (error, stdout, stderr) => {
                if (error && typeof error.code !== 'number') reject(error)
                else resolve({ code: error ? error.code : 0, stdout, stderr })
            },
        )
    })
}

const includeBatch = 500
const deleteBatch = 1000

export function awsStore({ bucket, prefix, run = runAws }) {
    const indexKey = `${prefix}/index.json`
    const key = (name) => `${prefix}/${name}`
    async function call(args) {
        const result = await run(args)
        if (result.code !== 0)
            throw new Error(`aws ${args.slice(0, 2).join(' ')} failed: ${result.stderr.trim()}`)
        return result.stdout.trim() ? JSON.parse(result.stdout) : {}
    }
    async function withTemporary(work) {
        const folder = await mkdtemp(join(tmpdir(), 'nse-aws-'))
        try {
            return await work(folder)
        } finally {
            await rm(folder, { recursive: true, force: true })
        }
    }
    const preconditionFailed = (result) => /\bPreconditionFailed\b|\(412\)/.test(result.stderr)

    return {
        readIndex: () =>
            withTemporary(async (folder) => {
                const out = join(folder, 'index.json')
                const result = await run([
                    's3api',
                    'get-object',
                    '--bucket',
                    bucket,
                    '--key',
                    indexKey,
                    out,
                ])
                if (result.code !== 0 && /\bNoSuchKey\b/.test(result.stderr)) return null
                if (result.code !== 0)
                    throw new Error(`aws s3api get-object failed: ${result.stderr.trim()}`)
                return { bytes: await readFile(out), etag: JSON.parse(result.stdout).ETag }
            }),

        async headIndex() {
            const result = await run(['s3api', 'head-object', '--bucket', bucket, '--key', indexKey])
            if (result.code !== 0 && /\(404\)|Not Found/.test(result.stderr)) return null
            if (result.code !== 0)
                throw new Error(`aws s3api head-object failed: ${result.stderr.trim()}`)
            return JSON.parse(result.stdout).ETag
        },

        writeIndex: (bytes, condition) =>
            withTemporary(async (folder) => {
                const body = join(folder, 'index.json')
                await writeFile(body, bytes)
                const args = ['s3api', 'put-object', '--bucket', bucket, '--key', indexKey]
                args.push('--body', body, '--content-type', 'application/json')
                if (condition.ifMatch) args.push('--if-match', condition.ifMatch)
                else if (condition.ifNoneMatch) args.push('--if-none-match', '*')
                else throw new Error('An index write needs a condition')
                const result = await run(args)
                if (result.code !== 0 && preconditionFailed(result))
                    throw new Error(
                        'The asset store index changed since it was read. Only one writer may run at a time.',
                    )
                if (result.code !== 0)
                    throw new Error(`aws s3api put-object failed: ${result.stderr.trim()}`)
            }),

        // The includes are relative to the source folder, so they are the names without assets/.
        async download(names, folder) {
            for (let start = 0; start < names.length; start += includeBatch) {
                const args = ['s3', 'cp', `s3://${bucket}/${prefix}/assets/`, folder]
                args.push('--recursive', '--only-show-errors', '--exclude', '*')
                for (const name of names.slice(start, start + includeBatch)) {
                    if (!name.startsWith('assets/') || /[*?[\]]/.test(name))
                        throw new Error(`Not a stored asset name: ${name}`)
                    args.push('--include', name.slice('assets/'.length))
                }
                await call(args)
            }
        },

        putNew: (name, bytes, sha256) =>
            withTemporary(async (folder) => {
                const body = join(folder, 'body')
                await writeFile(body, bytes)
                const result = await run([
                    's3api',
                    'put-object',
                    '--bucket',
                    bucket,
                    '--key',
                    key(name),
                    '--body',
                    body,
                    '--if-none-match',
                    '*',
                    '--checksum-algorithm',
                    'SHA256',
                    '--checksum-sha256',
                    Buffer.from(sha256, 'hex').toString('base64'),
                ])
                if (result.code !== 0 && preconditionFailed(result)) return 'exists'
                if (result.code !== 0)
                    throw new Error(`aws s3api put-object failed for ${name}: ${result.stderr.trim()}`)
                return 'created'
            }),

        read: (name) =>
            withTemporary(async (folder) => {
                const out = join(folder, 'body')
                await call(['s3api', 'get-object', '--bucket', bucket, '--key', key(name), out])
                return readFile(out)
            }),

        // Each batch's own failures are in its Errors; a batch that fails as a whole fails all its names.
        remove: (names) =>
            withTemporary(async (folder) => {
                const failed = []
                for (let start = 0; start < names.length; start += deleteBatch) {
                    const batch = names.slice(start, start + deleteBatch)
                    const request = join(folder, `delete-${start}.json`)
                    await writeFile(
                        request,
                        JSON.stringify({
                            Objects: batch.map((name) => ({ Key: key(name) })),
                            Quiet: true,
                        }),
                    )
                    const result = await run([
                        's3api',
                        'delete-objects',
                        '--bucket',
                        bucket,
                        '--delete',
                        `file://${request}`,
                    ])
                    if (result.code !== 0) {
                        failed.push(...batch)
                        continue
                    }
                    const errors = result.stdout.trim() ? JSON.parse(result.stdout).Errors : []
                    for (const error of errors ?? [])
                        failed.push(error.Key.slice(prefix.length + 1))
                }
                return failed
            }),
    }
}
