import assert from 'node:assert/strict'
import test from 'node:test'
import { computed, shallowRef } from 'vue'
import {
    createChangePaint,
    createPropertyInspection,
    createShowEdits,
    type InspectionComparison,
} from '../../src/editor/history/inspection'
import { captureOperationRecipe } from '../../src/history/operationPresentation'
import { entryKey, loadEntryState, resetPeekForTests, setPeekSource } from '../../src/history/peek'
import type { State } from '../../src/state'
import { editStep, futureFixtureOperation } from '../helpers/historySteps'
import { goldenChart, stateOf } from '../local/records/charts'

const state = (title: string) => {
    const value = stateOf(goldenChart())
    value.levelInfo = { ...value.levelInfo, title }
    return value
}
const comparison = (after = state('After'), before = 1): InspectionComparison => ({
    request: {
        key: entryKey('session', 4),
        time: 1,
        recipe: captureOperationRecipe([
            { description: editStep(futureFixtureOperation('property-inspection')) },
        ]),
        oldest: entryKey('session', 2),
    },
    previous: { key: entryKey('session', before), snapshot: `snapshot-${before}` },
    state: after,
    set: { header: true },
})
const deferred = <T>() => {
    let resolve!: (value: T) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<T>((yes, no) => {
        resolve = yes
        reject = no
    })
    return { promise, resolve, reject }
}
const settle = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
}

test('inspection stays lazy, loads the resolved group predecessor, and keeps chronological raw endpoints', async () => {
    const current = shallowRef<InspectionComparison | undefined>(comparison())
    const before = state('Before')
    const calls: string[] = []
    const controller = createPropertyInspection(current, async (key) => {
        calls.push(key)
        return before
    })
    try {
        await settle()
        assert.deepEqual(calls, [])
        assert.equal(controller.available.value, true)
        controller.open()
        assert.equal(controller.inspection.value?.status, 'loading')
        await settle()
        assert.deepEqual(calls, [entryKey('session', 1)])
        const result = controller.inspection.value
        assert.equal(result?.status, 'known')
        assert.deepEqual(result?.changes?.sections[0]?.rows[0], {
            field: 'title',
            before: { kind: 'text', value: 'Before' },
            after: { kind: 'text', value: 'After' },
        })
        controller.close()
        assert.equal(controller.inspection.value, undefined)
        current.value = { ...comparison(), set: { header: false } }
        controller.open()
        assert.equal(controller.available.value, false)
        assert.equal(controller.inspection.value, undefined)
        await settle()
        assert.equal(calls.length, 1)
    } finally {
        controller.dispose()
    }
})

test('slow loading text appears only after 250ms and failure permits a fresh reopen', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const pending = deferred<State>()
    const current = shallowRef(comparison())
    let calls = 0
    const controller = createPropertyInspection(current, () =>
        ++calls === 1 ? pending.promise : Promise.resolve(state('Before')),
    )
    try {
        controller.open()
        await settle()
        t.mock.timers.tick(249)
        assert.equal(controller.inspection.value?.delayed, false)
        t.mock.timers.tick(1)
        assert.equal(controller.inspection.value?.delayed, true)
        pending.reject(new Error('historical entry unavailable'))
        await settle()
        assert.equal(controller.inspection.value?.status, 'unavailable')
        assert.equal(controller.inspection.value?.delayed, false)
        assert.equal(calls, 1)
        controller.open()
        await settle()
        assert.equal(calls, 2)
        assert.equal(controller.inspection.value?.status, 'known')
    } finally {
        controller.dispose()
    }
})

test('close and reopen generations cannot accept the previous request result', async () => {
    const old = deferred<State>(),
        fresh = deferred<State>()
    let calls = 0
    const current = shallowRef(comparison())
    const controller = createPropertyInspection(current, () =>
        ++calls === 1 ? old.promise : fresh.promise,
    )
    try {
        controller.open()
        await settle()
        controller.close()
        controller.open()
        await settle()
        old.resolve(state('Obsolete before'))
        await settle()
        assert.equal(controller.inspection.value?.status, 'loading')
        fresh.resolve(state('Correct before'))
        await settle()
        assert.equal(controller.inspection.value?.status, 'known')
        assert.deepEqual(controller.inspection.value?.changes?.sections[0]?.rows[0]?.before, {
            kind: 'text',
            value: 'Correct before',
        })
    } finally {
        controller.dispose()
    }
})

test('same selected key with a new comparison or predecessor invalidates pending inspection', async () => {
    const old = deferred<State>()
    const current = shallowRef<InspectionComparison | undefined>(comparison())
    const controller = createPropertyInspection(current, () => old.promise)
    try {
        controller.open()
        await settle()
        current.value = comparison(state('New after'), 3)
        assert.equal(controller.inspection.value, undefined)
        old.resolve(state('Stale before'))
        await settle()
        assert.equal(controller.inspection.value, undefined)
        controller.open()
        current.value = undefined
        await settle()
        assert.equal(controller.inspection.value, undefined)
    } finally {
        controller.dispose()
    }
})

for (const identity of ['request', 'previous', 'snapshot', 'state'] as const)
    test(`inspection guards captured ${identity} even if a comparison is mutated in place`, async () => {
        const pending = deferred<State>()
        const value = comparison()
        const controller = createPropertyInspection(shallowRef(value), () => pending.promise)
        try {
            controller.open()
            await settle()
            if (identity === 'request') value.request = { ...value.request }
            else if (identity === 'previous') value.previous = { ...value.previous }
            else if (identity === 'snapshot') value.previous.snapshot = 'different-snapshot'
            else value.state = state('Different after')
            pending.resolve(state('Before'))
            await settle()
            assert.notEqual(controller.inspection.value?.status, 'known')
        } finally {
            controller.dispose()
        }
    })

test('an alleged header difference with equal canonical endpoints is unavailable', async () => {
    const after = state('Equal')
    const controller = createPropertyInspection(shallowRef(comparison(after)), async () => after)
    try {
        controller.open()
        await settle()
        assert.equal(controller.inspection.value?.status, 'unavailable')
        assert.equal(controller.inspection.value?.changes, undefined)
    } finally {
        controller.dispose()
    }
})

test('coalesced historical loading is retained without accepting an obsolete comparison', async () => {
    resetPeekForTests()
    const pending = deferred<State>()
    let loads = 0
    setPeekSource({
        load: async () => {
            loads++
            return { state: await pending.promise, time: 1 }
        },
        sameSnapshot: (a, b) => a === b,
    })
    const current = shallowRef(comparison())
    const controller = createPropertyInspection(current, loadEntryState)
    try {
        controller.open()
        await settle()
        current.value = comparison(state('New after'))
        controller.open()
        await settle()
        assert.equal(loads, 1)
        pending.resolve(state('Before'))
        await settle()
        assert.equal(controller.inspection.value?.comparison, current.value)
        assert.deepEqual(controller.inspection.value?.changes?.sections[0]?.rows[0]?.after, {
            kind: 'text',
            value: 'New after',
        })
    } finally {
        controller.dispose()
        resetPeekForTests()
    }
})

test('Show Edits is local across entry changes; settings only choose the next peek default', () => {
    const peeking = shallowRef(false),
        setting = shallowRef(true),
        selection = shallowRef(1)
    let reads = 0
    const controller = createShowEdits(peeking, () => {
        reads++
        return setting.value
    })
    try {
        assert.equal(controller.showEdits.value, false)
        controller.set(true)
        assert.equal(controller.showEdits.value, false)
        peeking.value = true
        assert.equal(controller.showEdits.value, true)
        controller.toggle()
        assert.equal(controller.showEdits.value, false)
        selection.value++
        setting.value = false
        setting.value = true
        assert.equal(controller.showEdits.value, false)
        assert.equal(reads, 1)
        assert.equal(setting.value, true)
        controller.set(true)
        setting.value = false
        assert.equal(controller.showEdits.value, true)
        peeking.value = false
        assert.equal(controller.showEdits.value, false)
        peeking.value = true
        assert.equal(controller.showEdits.value, false)
        assert.equal(reads, 2)
        controller.set(true)
        controller.reset()
        assert.equal(controller.showEdits.value, false)
        assert.equal(setting.value, false)
    } finally {
        controller.dispose()
    }
})

test('Off gates every painted mark and dim while raw old/new geometry remains available', () => {
    const raw = shallowRef({
        changed: new Set(['note', 'connector']),
        rings: ['new-note'],
        ghosts: ['old-note'],
        ghostState: { oldSlide: 1 },
    })
    const peeking = shallowRef(true),
        show = shallowRef(true)
    const status = shallowRef<'known' | 'loading' | 'unavailable'>('known')
    const hasObjects = shallowRef(true)
    const paint = createChangePaint(raw, peeking, show, status, hasObjects)
    const geometry = computed(() => [raw.value.rings, raw.value.ghosts, raw.value.ghostState])
    try {
        const oldGeometry = geometry.value
        assert.equal(paint.marks.value, raw.value)
        assert.equal(paint.undimmed.value, raw.value.changed)
        show.value = false
        assert.equal(paint.marks.value, undefined)
        assert.equal(paint.undimmed.value, undefined)
        assert.equal(geometry.value, oldGeometry)
        raw.value = { ...raw.value, rings: ['next-note'], ghosts: ['older-note'] }
        assert.equal(paint.marks.value, undefined)
        assert.equal(paint.undimmed.value, undefined)
        show.value = true
        assert.equal(paint.marks.value, raw.value)
        assert.deepEqual(geometry.value[0], ['next-note'])
        peeking.value = false
        assert.equal(paint.marks.value, undefined)
        assert.equal(paint.undimmed.value, undefined)
    } finally {
        paint.dispose()
    }
})

test('Off immediately clears held dim; asynchronous comparison completion cannot restore it', () => {
    const marked = { changed: new Set(['changed']) }
    const raw = shallowRef<typeof marked | undefined>(marked)
    const peeking = shallowRef(true),
        show = shallowRef(true),
        hasObjects = shallowRef(true)
    const status = shallowRef<'known' | 'loading' | 'unavailable'>('known')
    const paint = createChangePaint(raw, peeking, show, status, hasObjects)
    try {
        assert.equal(paint.undimmed.value, marked.changed)
        status.value = 'loading'
        raw.value = undefined
        assert.equal(paint.undimmed.value?.size, 0)
        show.value = false
        assert.equal(paint.undimmed.value, undefined)
        show.value = true
        assert.equal(paint.undimmed.value, undefined)
        show.value = false
        raw.value = marked
        status.value = 'known'
        assert.equal(paint.marks.value, undefined)
        assert.equal(paint.undimmed.value, undefined)
        show.value = true
        assert.equal(paint.undimmed.value, marked.changed)
        raw.value = undefined
        status.value = 'unavailable'
        assert.equal(paint.undimmed.value, undefined)
    } finally {
        paint.dispose()
    }
})
