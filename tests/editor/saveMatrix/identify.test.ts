import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWorld, flow, settle } from './world'

// Identifying a picked file: a failed owner list, or one
// owner's failed handle read, leaves the pick to the other facts, else it is `unknown`. A later
// owner still places the pick. Here Save As… picks target.nsld, which another chain keeps as its
// Export target: a placed pick is placed as level data and nothing is written, while an unknown
// pick is written over. The owners are listed by chain id: chain-other, chain-own, chain-target.

type World = Awaited<ReturnType<typeof createWorld>>

const run = async (arm: (w: World) => void) => {
    const w = await createWorld({
        own: 'bound',
        storage: 'lacks',
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
        placed: w.dialogs.some((dialog) => dialog.kind === 'notPutBack'),
        written: w.writes.some((write) => write.name === 'target.nsld'),
    }
}

test('identify (control): the owners and their handles answering place the pick as the Export target', async () => {
    assert.deepEqual(await run(() => undefined), { placed: true, written: false })
})

test('identify: a failed owner list leaves the pick unknown, and the Save goes on', async () => {
    const r = await run((w) => w.behaviour.set('listHandleOwners', () => 'throw'))
    assert.deepEqual(r, { placed: false, written: true })
})

test('identify: an earlier owner’s failed handle read leaves the later owner to place the pick', async () => {
    const read: string[] = []
    const r = await run((w) =>
        w.behaviour.set('readHandle', (_n, arg) => {
            const { chainId } = arg as { chainId: string }
            read.push(chainId)
            return chainId === 'chain-other' ? 'throw' : undefined
        }),
    )
    assert.ok(read.includes('chain-other'), 'the failing owner was read')
    assert.deepEqual(r, { placed: true, written: false })
})
