import assert from 'node:assert/strict'
import { test } from 'node:test'
import '../saveMatrix/env'

// A Save attempt: one reservation at a time, ended exactly once and as the
// landing needs; "Preparing…" closed on every exit; a throw shown; a throw after the file read back
// as ours shown as the success. The fakes are a flusher that logs how each reservation ended and
// the in-memory platform.

const { createMockPlatform } = await import('../../../src/platform/mock')
const { FileError, setPlatformForTests } = await import('../../../src/platform')
const { nxspDiskState } = await import('../../../src/platform/fingerprint')
const { setSaveEnvironment } = await import('../../../src/editor/save/binding')
const { markedSeq, readMarker, removeMarker } = await import('../../../src/editor/save/env')
const { storageKey } = await import('../../../src/storage')
const { Cancelled, withSaveAttempt } = await import('../../../src/editor/save/saveAttempt')
const { ringEntries, resetRingForTests } = await import('../../../src/diagnostics')
const { assembleZip, prepareEntry } = await import('../../../src/zip')

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const nxsp = async (revision: string) =>
    new Blob(
        assembleZip([
            await prepareEntry({
                name: 'project.json',
                method: 'store',
                data: new TextEncoder().encode(JSON.stringify({ revision: { id: revision } })),
            }),
        ]),
    )

type Reservation = { session: Session; seq: number; wall: number }
type Session = { id: string; chainId: string; reserved?: Reservation; nextSeq: number }

const setup = async () => {
    localStorage.clear()
    const mock = createMockPlatform()
    setPlatformForTests(mock)
    resetRingForTests()
    const session: Session = { id: 's1', chainId: 'c1', nextSeq: 5 }
    /** A session the user switched to: New. */
    const fresh: Session = { id: 's2', chainId: 'c2', nextSeq: 1 }
    /** How each reservation ended, in order. */
    const ends: string[] = []
    const flusher = {
        session,
        endThrows: false,
        pending: [] as { sessionId: string; chainId: string }[],
        // As the real one: the flusher's current session, whichever it is now.
        reserveSave() {
            const current = flusher.session
            if (current.reserved) return
            const reservation = { session: current, seq: current.nextSeq++, wall: 1 }
            current.reserved = reservation
            return reservation
        },
        endSave(reservation: Reservation, entry?: unknown, _unit?: unknown, keep = false) {
            if (session.reserved !== reservation) {
                ends.push('ended')
                return Promise.resolve('ended')
            }
            // As the real one: a capture that throws leaves the reservation held.
            if (entry && flusher.endThrows) return Promise.reject(new Error('capture failed'))
            session.reserved = undefined
            const how = entry ? 'added' : keep ? 'kept' : 'letGo'
            ends.push(how)
            return Promise.resolve(how)
        },
        release: (reservation: Reservation) =>
            flusher.endSave(reservation, undefined, undefined, true),
        async reservationEnded(signal?: AbortSignal) {
            while (session.reserved && !signal?.aborted) await sleep(2)
        },
        flush: () => Promise.resolve(),
    }
    const worker = {
        call: (method: string) =>
            Promise.resolve(method === 'openPendingImports' ? flusher.pending : undefined),
    }
    setSaveEnvironment(() => ({
        worker: worker as never,
        flusher: flusher as never,
        session: flusher.session as never,
        chainId: flusher.session.chainId,
    }))
    const env = {
        worker: worker as never,
        flusher: flusher as never,
        session: session as never,
        chainId: 'c1',
    }
    /** Each "Preparing…" the attempt opened. */
    const dialogs: { controller: AbortController; closed: boolean }[] = []
    const ui = {
        preparing: () => {
            const dialog = { controller: new AbortController(), closed: false }
            dialogs.push(dialog)
            return {
                signal: dialog.controller.signal,
                importing: () => undefined,
                built: () => undefined,
                ready: () => Promise.resolve(true),
                close: () => {
                    dialog.closed = true
                },
            }
        },
    }
    const spec = (more: Record<string, unknown> = {}) => ({
        env,
        name: 'a.nxsp',
        surface: 'save' as const,
        ui,
        commitFirst: false,
        importWait: 'none' as const,
        ...more,
    })
    // A file the Save writes back over, with the disk state its write expects.
    mock.writeFile('a.nxsp', await nxsp('rev-1'))
    const handle = mock.createHandle('a.nxsp')
    const expected = await nxspDiskState(await handle.getFile(), 0)
    const next = await nxsp('rev-2')
    const request = () => ({
        kind: 'nxsp' as const,
        suggestedName: 'a.nxsp',
        target: { kind: 'handle' as const, handle },
        expected,
        build: () => Promise.resolve({ kind: 'blob' as const, blob: next }),
    })
    const marker = () =>
        ({
            chainId: 'c1',
            entry: { revisionId: 'rev-2' },
            parent: null,
            unit: { docId: 'doc', file: { hash: '00' } },
        }) as never
    const entry = { wall: 1, operation: {}, state: {}, revisionId: 'rev-2' } as never
    return { mock, session, fresh, flusher, ends, dialogs, spec, request, marker, entry }
}

/** A throw is shown and logged as always; the test keeps the log quiet. */
const quiet = async <T>(body: () => Promise<T>) => {
    const real = console.error
    console.error = (...args: unknown[]) => {
        if (args[0] !== 'A Save failed') real(...args)
    }
    try {
        return await body()
    } finally {
        console.error = real
    }
}

test('a Save that writes ends its one reservation with the entry, and leaves nothing open', async () => {
    const t = await setup()
    const done = await withSaveAttempt(t.spec(), async (attempt) => {
        const reserved = await attempt.reserve()
        assert.ok(reserved)
        const result = await attempt.write(t.request(), t.marker)
        assert.equal(result.status, 'saved')
        return attempt.complete(t.entry, {} as never)
    })
    assert.equal(done, 'added')
    assert.deepEqual(t.ends, ['added'])
    assert.equal(t.session.reserved, undefined)
    assert.ok(t.dialogs.every((dialog) => dialog.closed))
})

test('a write that may have landed keeps its reservation and marker; one that failed its check lets both go', async () => {
    const may = await setup()
    may.mock.fault = (point) => {
        if (point === 'beforeClose') throw new FileError('io', 'The write failed')
    }
    const kept = await withSaveAttempt(may.spec(), async (attempt) => {
        await attempt.reserve()
        try {
            await attempt.write(may.request(), may.marker)
        } catch (error) {
            return (error as Error).message
        }
        return 'written'
    })
    assert.equal(kept, 'The write failed')
    assert.deepEqual(may.ends, ['kept'])
    assert.ok(readMarker('c1'), 'the marker stays for the next Save to recognise')

    const not = await setup()
    not.mock.fault = (point) => {
        if (point === 'checked') throw new FileError('conflict', 'changed', undefined, 'check')
    }
    const failure = await withSaveAttempt(not.spec(), async (attempt) => {
        await attempt.reserve()
        try {
            await attempt.write(not.request(), not.marker)
        } catch (error) {
            return (error as { code: string }).code
        }
        return 'written'
    })
    assert.equal(failure, 'conflict')
    assert.deepEqual(not.ends, ['letGo'])
    assert.equal(readMarker('c1'), undefined, 'a write that certainly did not land keeps no marker')
})

test('a throw before the write is shown as a failure, and the reservation is let go', async () => {
    const t = await setup()
    const ending = await quiet(() =>
        withSaveAttempt(t.spec(), async (attempt) => {
            await attempt.reserve()
            throw new Error('the build broke')
        }),
    )
    assert.deepEqual(
        { ...ending, error: (ending as { error: Error }).error.message },
        { kind: 'failed', name: 'a.nxsp', error: 'the build broke' },
    )
    assert.deepEqual(t.ends, ['letGo'])
})

test('a throw after the file read back as ours is shown as the success, and recorded', async () => {
    const t = await setup()
    t.flusher.endThrows = true
    const shown = await withSaveAttempt(t.spec(), async (attempt) => {
        await attempt.reserve()
        await attempt.write(t.request(), t.marker)
        // The capture of the entry throws: the Save still ends as done.
        await attempt.complete(t.entry, {} as never)
        return 'done'
    })
    assert.equal(shown, 'done')
    assert.deepEqual(t.ends, ['kept'], 'the exit keeps the reservation the write may hold')
    assert.ok(ringEntries().some((each) => each.text.includes('capture failed')))
    assert.ok(readMarker('c1'), 'the marker stays for the next Save to record the binding')
})

test('"Preparing…" closes when the wait for an import is cancelled, and no reservation is taken', async () => {
    const t = await setup()
    t.flusher.pending = [{ sessionId: 'elsewhere', chainId: 'c1' }]
    let ran = false
    const running = withSaveAttempt(t.spec({ importWait: 'chain' }), () => {
        ran = true
        return Promise.resolve('body')
    })
    await sleep(30)
    assert.equal(t.dialogs.length, 1, '"Preparing…" opened for the wait')
    t.dialogs[0]!.controller.abort()
    assert.deepEqual(await running, { kind: 'cancelled' })
    assert.equal(ran, false)
    assert.ok(t.dialogs.every((dialog) => dialog.closed))
    assert.deepEqual(t.ends, [])
})

test('a commit that forks the session writes nothing and asks the caller for the Save dialog', async () => {
    const t = await setup()
    t.flusher.flush = () => {
        t.flusher.session = { id: 's2', chainId: 'c1', nextSeq: 1 }
        return Promise.resolve()
    }
    let ran = false
    const ending = await withSaveAttempt(t.spec({ commitFirst: true }), () => {
        ran = true
        return Promise.resolve('body')
    })
    assert.deepEqual(ending, { kind: 'forked' })
    assert.equal(ran, false)
})

test('a write permission that was not granted fails as denied, before the body', async () => {
    const t = await setup()
    let ran = false
    const ending = await withSaveAttempt(
        t.spec({ permission: Promise.resolve<PermissionState>('prompt') }),
        () => {
            ran = true
            return Promise.resolve('body')
        },
    )
    assert.equal((ending as { error: { code: string } }).error.code, 'denied')
    assert.equal(ran, false)
})

test('a reservation another flow holds is waited for outside a hold, and not inside one', async () => {
    const t = await setup()
    const other = { session: t.session, seq: 99, wall: 0 }
    t.session.reserved = other
    const got = await withSaveAttempt(t.spec(), async (attempt) => {
        assert.equal(await attempt.reserve(false), undefined, 'never waits inside a hold')
        setTimeout(() => {
            t.session.reserved = undefined
        }, 20)
        const reserved = await attempt.reserve()
        return reserved?.reservation.seq
    })
    assert.equal(got, 5, 'taken once the other flow ended')
    assert.deepEqual(t.ends, ['letGo'])
})

test('a Save that waited before its reservation, and met a new session, takes none', async () => {
    const t = await setup()
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
        release = resolve
    })
    const done = withSaveAttempt(t.spec(), async (attempt) => {
        // The wait for `nse-bind` while another tab saves.
        await gate
        return (await attempt.reserve()) === undefined
    })
    // The user chooses New meanwhile.
    t.flusher.session = t.fresh
    release()
    assert.equal(await done, true, 'no reservation')
    assert.equal(t.fresh.reserved, undefined, 'nothing reserved on the new session')
    assert.equal(t.fresh.nextSeq, 1)
    assert.equal(t.session.reserved, undefined)
    assert.deepEqual(t.ends, [])
})

test('a Save waiting for a reservation another flow holds, and meeting a new session, takes none', async () => {
    const t = await setup()
    t.session.reserved = { session: t.session, seq: 99, wall: 0 }
    const got = await withSaveAttempt(t.spec(), async (attempt) => {
        setTimeout(() => {
            t.flusher.session = t.fresh
            t.session.reserved = undefined
        }, 20)
        return attempt.reserve()
    })
    assert.equal(got, undefined)
    assert.equal(t.fresh.reserved, undefined)
    assert.equal(t.fresh.nextSeq, 1)
})

test('a cancel before the write ends the attempt as cancelled and lets the reservation go', async () => {
    const t = await setup()
    const controller = new AbortController()
    const ending = await withSaveAttempt(t.spec({ signal: controller.signal }), async (attempt) => {
        await attempt.reserve()
        controller.abort()
        attempt.checkpoint()
        return 'not reached'
    })
    assert.deepEqual(ending, { kind: 'cancelled' })
    assert.deepEqual(t.ends, ['letGo'])

    // A cancel while the file builds stops the write before its marker.
    const during = await setup()
    const stop = new AbortController()
    const request = {
        ...during.request(),
        build: () => {
            stop.abort()
            return Promise.resolve({ kind: 'blob' as const, blob: new Blob(['x']) })
        },
    }
    const second = await withSaveAttempt(during.spec({ signal: stop.signal }), async (attempt) => {
        await attempt.reserve()
        try {
            await attempt.write(request, during.marker)
        } catch (error) {
            assert.ok(error instanceof Cancelled)
            throw error
        }
        return 'written'
    })
    assert.deepEqual(second, { kind: 'cancelled' })
    assert.deepEqual(during.ends, ['letGo'])
    assert.equal(readMarker('c1'), undefined)
})

test('a throw after the file read back as ours, outside the entry, is recorded and not shown as a failed write', async () => {
    const t = await setup()
    const ending = await quiet(() =>
        withSaveAttempt(t.spec(), async (attempt) => {
            await attempt.reserve()
            await attempt.write(t.request(), t.marker)
            // The bookkeeping after the landing breaks (the label, the feedback).
            throw new Error('the label broke')
        }),
    )
    assert.deepEqual(ending, { kind: 'cancelled' }, 'no "could not be written"')
    assert.ok(ringEntries().some((each) => each.text.includes('the label broke')))
    assert.deepEqual(t.ends, ['kept'])
    assert.ok(readMarker('c1'), 'the marker stays for the next Save to record the binding')
})

test('a marker without its entry or unit is no marker, and the others are still read', () => {
    const valid = { entry: { revisionId: 'r1', sessionId: 's1', seq: 7 }, unit: { docId: 'd1' } }
    for (const malformed of [
        {},
        { unit: { docId: 'd1' } },
        { entry: { revisionId: 'r1' } },
        null,
    ]) {
        // The malformed one first, as a later build or a hand edit might leave it.
        localStorage.clear()
        localStorage.setItem(storageKey('saving.c0'), JSON.stringify(malformed))
        localStorage.setItem(storageKey('saving.c1'), JSON.stringify({ chainId: 'c1', ...valid }))
        assert.equal(readMarker('c0'), undefined)
        assert.equal(markedSeq('s1'), 7, "the session still goes past the valid marker's seq")
        removeMarker('c0')
        assert.equal(localStorage.getItem(storageKey('saving.c0')), null)
    }
})
