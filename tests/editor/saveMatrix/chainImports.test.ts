import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWorld } from './world'

// The wait for a chain's imports (spec A, `waitForChainImports`): a Save waits for every import of
// its chain that storage lists, not only its own session's, whichever session it is.

const { waitForChainImports } = await import('../../../src/editor/save/imports')
const { startImport } = await import('../../../src/local/open/importLoop')

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const slot = () => ({ name: 'coconut.nxsp', cancel: new AbortController() })

test('an import of another session of the chain, running here, is waited for in "Preparing…"', async () => {
    const w = await createWorld({ own: 'bound', held: true, storage: 'holds' })
    let finish!: () => void
    const gate = new Promise<void>((resolve) => {
        finish = resolve
    })
    w.pendingImports.add('session-before')
    const run = startImport({
        worker: {
            call: async (method: string) => {
                if (method !== 'openBatch') return undefined
                await gate
                return { kind: 'done' }
            },
        } as never,
        sessionId: 'session-before',
        chainId: w.session.chainId,
        id: 'import-before',
        batches: 1,
        source: { file: new Blob([]) } as never,
        locks: w.mock.locks,
        appVersion: '0.6.0',
    } as never)
    void run.then(() => w.pendingImports.delete('session-before'))

    let outcome: string | undefined
    const waited = waitForChainImports(
        { worker: w.worker as never, session: w.session, chainId: w.session.chainId },
        slot(),
    ).then((value) => {
        outcome = value
    })
    await sleep(100)
    assert.equal(outcome, undefined, 'still waiting')
    assert.ok(
        w.preparing.some((entry) => entry.open),
        '"Preparing…" is open',
    )
    finish()
    await run
    await waited
    assert.equal(outcome, 'done')
})

test('an import running nowhere here is polled for the bound, then left to the build’s refusal', async () => {
    const w = await createWorld({ own: 'bound', held: true, storage: 'holds' })
    w.pendingImports.add('session-before')
    const started = Date.now()
    const outcome = await waitForChainImports(
        { worker: w.worker as never, session: w.session, chainId: w.session.chainId },
        slot(),
    )
    const waited = Date.now() - started
    assert.equal(outcome, 'done')
    assert.ok(waited >= 3500 && waited < 8000, `waited ${waited} ms`)
    assert.ok(w.preparing.some((entry) => entry.open))
})

test('an import no tab runs is resumed by the wait, and the Save goes on', async () => {
    const w = await createWorld({ own: 'bound', held: true, storage: 'holds' })
    // Pending in storage, run by no tab: its run threw, or the tab that ran it closed.
    w.pendingImports.add('session-orphan')
    let resumed = 0
    const outcome = await (async () => {
        const started = Date.now()
        const value = await waitForChainImports(
            { worker: w.worker as never, session: w.session, chainId: w.session.chainId },
            slot(),
            async () => {
                resumed++
                // What the next load's resume does: runs the import, which ends and is no longer pending.
                await startImport({
                    worker: { call: async () => ({ kind: 'done' }) } as never,
                    sessionId: 'session-orphan',
                    chainId: w.session.chainId,
                    id: 'import-orphan',
                    batches: 1,
                    source: { file: new Blob([]) } as never,
                    locks: w.mock.locks,
                    appVersion: '0.6.0',
                } as never).then(() => w.pendingImports.delete('session-orphan'))
            },
        )
        return { value, waited: Date.now() - started }
    })()
    assert.equal(resumed, 1)
    assert.equal(outcome.value, 'done')
    assert.ok(outcome.waited < 2000, `waited ${outcome.waited} ms`)
    assert.equal(w.pendingImports.size, 0, 'the import ended instead of blocking the Save')
})
