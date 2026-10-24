import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import '../../editor/saveMatrix/env'

// The two reads of an open that go through the `storedRead` gate (Part 1 §1.5.4): the earlier
// chains, whose failure is a value the open passes over, never a rejection; and the binding
// check, which answers 'yes', 'no' or 'unknown'.

// The Save core's Node stubs (Vue files and the like) are installed by the import above.
const { boundInAnotherTab, earlierChains } = await import('../../../src/local/open/project')
const { setSessionContext } = await import('../../../src/local/startup/api')

const failure = () => {
    const error = new Error('The storage worker stopped answering (open test)')
    error.name = 'TimeoutError'
    return error
}

type Calls = Record<string, (arg: unknown) => unknown>

const install = (
    calls: Calls,
    held: string[] = [],
    journals: () => Promise<{ sessionId: string }[]> = () => Promise.resolve([]),
) => {
    const worker = {
        call: async (method: string, arg?: unknown) => {
            const answer = calls[method]
            if (!answer) throw new Error(`unexpected ${method}`)
            return answer(arg)
        },
    }
    Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: {
            query: () => Promise.resolve({ held: [] }),
            request: () => Promise.resolve(undefined),
        },
    })
    setSessionContext(
        {
            worker,
            client: {
                heldElsewhere: () => Promise.resolve(false),
                id: () => Promise.resolve('me'),
            },
            locks: {
                query: () =>
                    Promise.resolve({
                        held: held.map((id) => ({
                            name: `nse-session:${id}`,
                            mode: 'exclusive' as const,
                            clientId: 'other',
                        })),
                        pending: [],
                    }),
            },
        } as never,
        { journal: { read: journals } } as never,
    )
}

afterEach(() => {
    Reflect.deleteProperty(navigator, 'locks')
})

const file = { isSameEntry: (other: unknown) => Promise.resolve(other === file) }
const other = { isSameEntry: () => Promise.resolve(false) }

test('earlierChains: a read that finds none is a value', async () => {
    install({ openEarlierChains: () => [] })
    assert.deepEqual(await earlierChains('doc', 'chain-new'), {
        storedRead: 'value',
        storedValue: [],
    })
})

test('earlierChains: a read that fails resolves as failed, never as a rejection the open reports', async () => {
    install({
        openEarlierChains: () => {
            throw failure()
        },
    })
    const read = await earlierChains('doc', 'chain-new')
    assert.equal(read.storedRead, 'failed')
})

test('earlierChains: journals that cannot be listed count as none, and the chains still come back', async () => {
    const stored = [
        { chainId: 'a', sessionId: 'sa', bound: { handle: true }, changed: false, updatedAt: 2 },
        { chainId: 'b', sessionId: 'sb', bound: { handle: true }, changed: true, updatedAt: 1 },
    ]
    install({ openEarlierChains: () => stored }, [], () => Promise.reject(failure()))
    const read = await earlierChains('doc', 'chain-new')
    assert.equal(read.storedRead, 'value')
    assert.deepEqual(
        read.storedRead === 'value' &&
            read.storedValue.map(({ chainId, changed }) => [chainId, changed]),
        [
            ['a', false],
            ['b', true],
        ],
    )
})

test('boundInAnotherTab: no other tab holds a session is "no"', async () => {
    install({})
    assert.equal(await boundInAnotherTab(file as never), 'no')
})

test('boundInAnotherTab: yes, no and unknown', async () => {
    const bound = (file: unknown) => ({
        readBindings: () => [{ chainId: 'other-chain', file: { name: 'a.nxsp' } }],
        readHandle: () => file,
    })
    install(bound(file), ['other-session'])
    assert.equal(await boundInAnotherTab(file as never), 'yes')
    install(bound(other), ['other-session'])
    assert.equal(await boundInAnotherTab(file as never), 'no')
    // No handle stored for the other chain: not bound to this file.
    install(bound(undefined), ['other-session'])
    assert.equal(await boundInAnotherTab(file as never), 'no')
})

test('boundInAnotherTab: a failed read, a handle this page cannot hold or a throw is "unknown"', async () => {
    const failing = (name: 'readBindings' | 'readHandle') => ({
        readBindings: () => {
            if (name === 'readBindings') throw failure()
            return [{ chainId: 'other-chain', file: { name: 'a.nxsp' } }]
        },
        readHandle: () => {
            throw failure()
        },
    })
    install(failing('readBindings'), ['other-session'])
    assert.equal(await boundInAnotherTab(file as never), 'unknown')
    install(failing('readHandle'), ['other-session'])
    assert.equal(await boundInAnotherTab(file as never), 'unknown')
    // A stored value that is no handle here (a token this page does not hold).
    install(
        {
            readBindings: () => [{ chainId: 'other-chain', file: { name: 'a.nxsp' } }],
            readHandle: () => ({ testHandle: 'a.nxsp' }),
        },
        ['other-session'],
    )
    assert.equal(await boundInAnotherTab(file as never), 'unknown')
    // The comparison itself throws.
    install(
        {
            readBindings: () => [{ chainId: 'other-chain', file: { name: 'a.nxsp' } }],
            readHandle: () => ({
                getFile: () => undefined,
                isSameEntry: () => Promise.reject(failure()),
            }),
        },
        ['other-session'],
    )
    assert.equal(await boundInAnotherTab(file as never), 'unknown')
})

for (const [name, first] of [
    ['a failed read', () => Promise.reject(failure())],
    ['a handle this page cannot hold', () => Promise.resolve({ testHandle: 'a.nxsp' })],
] as const)
    test(`boundInAnotherTab: a definite "yes" outranks an earlier unknown (${name})`, async () => {
        install(
            {
                readBindings: () => [
                    { chainId: 'a', file: { name: 'a.nxsp' } },
                    { chainId: 'b', file: { name: 'a.nxsp' } },
                ],
                readHandle: (arg) =>
                    (arg as { chainId: string }).chainId === 'a' ? first() : file,
            },
            ['sa', 'sb'],
        )
        assert.equal(await boundInAnotherTab(file as never), 'yes')
    })
