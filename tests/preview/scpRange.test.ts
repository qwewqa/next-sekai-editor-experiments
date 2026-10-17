import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { openRangedScp } from '../../src/preview/assets/scpRange'
import { parseScp } from '../../src/preview/scp'

const file = readFileSync(new URL('../../public/builtin/effect.scp', import.meta.url))

// A server that answers ranges, or ignores them, and counts what it sends.
const serve = (t: test.TestContext, ranges: boolean) => {
    const served = { bytes: 0, requests: 0 }
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
        const range = new Headers(init?.headers).get('Range')
        served.requests++
        const match = ranges && range ? /^bytes=(-)?(\d+)(?:-(\d+))?$/.exec(range) : undefined
        if (!match) {
            served.bytes += file.length
            return new Response(file)
        }
        const start = match[1] ? Math.max(0, file.length - Number(match[2])) : Number(match[2])
        const end = match[1] ? file.length : Number(match[3]) + 1
        served.bytes += end - start
        return new Response(file.subarray(start, end), {
            status: 206,
            headers: { 'Content-Range': `bytes ${start}-${end - 1}/${file.length}` },
        })
    })
    return served
}

const paths = ['sonolus/effects/list', 'sonolus/effects/nse-builtin']

test('entries are read by ranges without the rest of the package', async (t) => {
    const served = serve(t, true)
    const whole = parseScp(file.buffer.slice(file.byteOffset, file.byteOffset + file.length))
    const archive = await openRangedScp('/builtin/effect.scp', new AbortController().signal)
    assert.ok(archive)
    for (const path of paths) assert.deepEqual(await archive.get(path), whole.get(path))
    assert.equal(await archive.get('sonolus/effects/none'), undefined)
    assert.ok(served.bytes < file.length / 2, `${served.bytes} of ${file.length} bytes`)
})

test('a server that ignores ranges sends the whole package, which reads the same', async (t) => {
    const served = serve(t, false)
    const whole = parseScp(file.buffer.slice(file.byteOffset, file.byteOffset + file.length))
    const archive = await openRangedScp('/builtin/effect.scp', new AbortController().signal)
    assert.ok(archive)
    for (const path of paths) assert.deepEqual(await archive.get(path), whole.get(path))
    assert.equal(served.requests, 1)
})

test('a missing package resolves undefined', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 404 }))
    assert.equal(await openRangedScp('/builtin/none.scp', new AbortController().signal), undefined)
})
