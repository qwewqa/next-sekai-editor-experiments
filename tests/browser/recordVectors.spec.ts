import { expect, test } from '@playwright/test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Formats v1's vectors in a browser engine: the hand-written canonical vectors,
// the golden and edge snapshots, the round trip, and the synchronous SHA-256 against
// crypto.subtle. Chromium here; Firefox and WebKit in the compatibility config, since engines
// may differ in a float's last digit.

const golden = join(import.meta.dirname, '..', 'local', 'records', 'golden-v1')

const readSet = (dir: string) => ({
    manifest: JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8')) as {
        root: string
        header: string
        nodes: { hash: string }[]
        chunks: { hash: string }[]
    },
    records: Object.fromEntries(
        readdirSync(join(dir, 'records')).map((name) => [
            name.slice(0, -'.canonical'.length),
            readFileSync(join(dir, 'records', name)).toString('base64'),
        ]),
    ),
})

test.beforeEach(async ({ page }) => {
    // A blank page: the vectors need the modules, not the editor.
    await page.route('**/__record-vectors', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }),
    )
    await page.goto('/__record-vectors')
})

test('the canonical vectors, golden snapshots and SHA-256 hold in this engine', async ({
    page,
}) => {
    const sets = [readSet(golden), readSet(join(golden, 'edge'))]
    const failures = await page.evaluate(async (sets) => {
        const { canonical, canonicalBytes } = await import('/src/local/records/canonical.ts')
        const { hash16, sha256Sync, toHex } = await import('/src/local/hash.ts')
        const { stateFromRecords, toRecords } = await import('/src/local/records/records.ts')
        const { encodeSnapshot } = await import('/src/local/records/snapshot.ts')
        const { canonicalVectors } =
            (await import('/tests/local/records/vectors.ts')) as typeof import('../local/records/vectors')
        const charts =
            (await import('/tests/local/records/charts.ts')) as typeof import('../local/records/charts')

        const failures: string[] = []
        for (const [name, value, text] of canonicalVectors)
            if (canonical(value) !== text) failures.push(`canonical ${name}: ${canonical(value)}`)

        const bytesOf = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
        const same = (a: Uint8Array, b: Uint8Array) =>
            a.length === b.length && a.every((byte, i) => byte === b[i])
        for (const [i, make] of [charts.goldenChart, charts.edgeChart].entries()) {
            const { manifest, records } = sets[i]!
            const state = charts.stateOf(make())
            const snapshot = encodeSnapshot(toRecords(state))
            if (toHex(snapshot.root.hash) !== manifest.root) failures.push(`set ${i} root`)
            for (const record of [
                snapshot.root,
                snapshot.header,
                ...snapshot.nodes,
                ...snapshot.chunks,
            ]) {
                const pinned = records[toHex(record.hash)]
                if (!pinned || !same(record.bytes, bytesOf(pinned)))
                    failures.push(`set ${i} record ${toHex(record.hash)}`)
            }
            const rebuilt = toRecords(stateFromRecords(toRecords(state)))
            if (charts.recordsText(rebuilt) !== charts.recordsText(toRecords(state)))
                failures.push(`set ${i} round trip`)
            for (const [hash, base64] of Object.entries(records)) {
                const bytes = bytesOf(base64)
                const subtle = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
                if (toHex(sha256Sync(bytes)) !== toHex(subtle)) failures.push(`sha256 ${hash}`)
                if (toHex(subtle.slice(0, 16)) !== hash) failures.push(`hash ${hash}`)
                if (toHex(await hash16(bytes)) !== hash) failures.push(`hash16 ${hash}`)
            }
        }
        if (
            toHex(sha256Sync(canonicalBytes([]))) !==
            toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', canonicalBytes([]))))
        )
            failures.push('sha256 of []')
        return failures
    }, sets)
    expect(failures).toEqual([])
})
