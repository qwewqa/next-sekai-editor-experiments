import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWorld, flow, settle } from './world'

// Save writes the requested project even when ownership cannot be read.

type World = Awaited<ReturnType<typeof createWorld>>

const run = async (arm: (w: World) => void) => {
    const w = await createWorld({
        own: 'bound',
        held: true,
        other: true,
        target: true,
    })
    arm(w)
    w.pick('target.nsld')
    w.answers.saveDialog.push({ action: 'save', fileName: 'out.nxsp', history: true, bgm: true })
    await flow.saveAs()
    await settle()
    return {
        revoked: !(await w.storedChains()).find((row) => row.chainId === 'chain-target')
            ?.exportTarget,
        written: w.writes.some((write) => write.name === 'target.nsld'),
    }
}

test('Save revokes an export destination and writes a project', async () => {
    assert.deepEqual(await run(() => undefined), { revoked: true, written: true })
})

test('Save writes when the list of owners cannot be read', async () => {
    const r = await run((w) => w.behaviour.set('listHandleOwners', () => 'throw'))
    assert.deepEqual(r, { revoked: false, written: true })
})

test('Save checks later owners after an earlier handle read fails', async () => {
    const read: string[] = []
    const r = await run((w) =>
        w.behaviour.set('readHandle', (_n, arg) => {
            const { chainId } = arg as { chainId: string }
            read.push(chainId)
            return chainId === 'chain-other' ? 'throw' : undefined
        }),
    )
    assert.ok(read.includes('chain-other'), 'the failing owner was read')
    assert.deepEqual(r, { revoked: true, written: true })
})
