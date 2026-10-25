import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { fromRaw, isValidEvent } from '../../src/analytics/catalogue'
import * as tally from '../../src/analytics/tally'
import { recordDiagnostic, resetRingForTests } from '../../src/diagnostics'
import type { Command, CommandName } from '../../src/editor/commands'
import { nameBuiltInCommands } from '../../src/editor/commands/names'
import { dropOpen, endOpen, openFormat, startOpen } from '../../src/editor/commands/open/report'
import { runCommand } from '../../src/editor/commands/runCommand'
import { finishSave, savedSize, startSave, startWrite, tracked } from '../../src/editor/save/report'
import { peek, resetStates } from '../../src/history/stack'
import { FileError } from '../../src/platform/types'
import type { State } from '../../src/state'
import { initialStep, originOperation } from '../helpers/historySteps'

// The hooks that feed the usage statistics, each with what it must count. The tally's own rules
// are in analyticsTally.test.ts.

Object.assign(globalThis, {
    window: { addEventListener: () => undefined, removeEventListener: () => undefined },
    document: { visibilityState: 'visible' },
})

const fakeCommand = (readOnly = false) => {
    let runs = 0
    const command: Command = {
        title: () => '',
        icon: { is: {} },
        execute: () => {
            runs++
        },
        ...(readOnly && { readOnly: true }),
    }
    return { command, runs: () => runs }
}

const save = fakeCommand()
const zoom = fakeCommand(true)
const stranger = fakeCommand()
// The registry names the built-in commands once; these stand in for two of them.
nameBuiltInCommands({ save: save.command, zoomXIn: zoom.command } as Record<CommandName, Command>)

const counts = () => Object.fromEntries(tally.collect().counts)
type Made = { name: string } & Record<string, string | number | boolean | undefined>
const recorded = () => tally.collect().recorded.map(({ name, data }) => ({ ...data, name }) as Made)

beforeEach(() => {
    tally.enable()
    resetStates({ isDirty: false, step: initialStep(originOperation()), state: {} as State })
})

afterEach(() => {
    peek.value = undefined
    tally.disable()
})

test('a command run counts once under its name and source; a command added later does not count', () => {
    runCommand(save.command, 'toolbar')
    runCommand(save.command, 'key')
    runCommand(zoom.command, 'wheel')
    runCommand(stranger.command, 'key')
    assert.equal(stranger.runs(), 1, 'it ran')
    assert.deepEqual(counts(), {
        'usage.save.toolbar': 1,
        'usage.save.key': 1,
        'usage.zoomXIn.wheel': 1,
    })
})

test('a command another command runs, and a held key’s repeat, are not presses', () => {
    const before = save.runs()
    runCommand(save.command, 'nested')
    runCommand(save.command, 'repeat')
    assert.equal(save.runs(), before + 2, 'both ran')
    assert.deepEqual(counts(), {})
})

test('a command refused while peeking counts as a refusal, not as a use', () => {
    peek.value = { source: 'test', state: {} as State }
    const before = save.runs()
    runCommand(save.command, 'key')
    runCommand(zoom.command, 'key')
    assert.equal(save.runs(), before, 'refused')
    assert.deepEqual(counts(), { 'features.peekRefused': 1, 'usage.zoomXIn.key': 1 })
})

test('each recorded diagnostic counts under its kind, a repeat of the last once', () => {
    resetRingForTests()
    recordDiagnostic('error', 'A failed')
    recordDiagnostic('error', 'A failed')
    recordDiagnostic('csp', 'blocked')
    recordDiagnostic('error', 'B failed')
    assert.deepEqual(counts(), { 'errors.error': 2, 'errors.csp': 1 })
})

test('a Save records its action, options, target, size, outcome and time, and ends once', () => {
    startSave('save', { history: true, bgm: false })
    startWrite('picker')
    savedSize(1_500_000)
    finishSave({ kind: 'done' })
    // The follow-up flows of one action end it no second time.
    finishSave({ kind: 'cancelled' })
    const [made, ...rest] = recorded()
    assert.equal(rest.length, 0)
    assert.deepEqual(
        { ...made, took: typeof made?.took },
        {
            name: 'save',
            action: 'save',
            history: true,
            bgm: false,
            target: 'picker',
            size: 1_500_000,
            outcome: 'done',
            took: 'number',
        },
    )
    // Sent as ranges, and valid.
    const { name, ...data } = made as Made
    assert.equal(name, 'save')
    const sent = fromRaw('save', data)
    assert.equal(sent.size, '1M-4M')
    assert.ok(isValidEvent('save', sent))
})

test('a Save that fails or is refused says why; one that only reached a dialog is cancelled', () => {
    startSave('saveAs')
    startWrite('writeBack')
    finishSave({ kind: 'failed', error: new FileError('denied', '', undefined, 'read'), name: 'a' })
    startSave('saveToFile')
    finishSave({ kind: 'refused', name: 'a', reason: 'notProject' })
    startSave('downloadAgain')
    finishSave()
    assert.deepEqual(
        recorded().map(({ action, outcome, reason, step, target }) => ({
            action,
            outcome,
            reason,
            step,
            target,
        })),
        [
            {
                action: 'saveAs',
                outcome: 'failed',
                reason: 'denied',
                step: 'read',
                target: 'writeBack',
            },
            {
                action: 'saveToFile',
                outcome: 'refused',
                reason: 'notProject',
                step: undefined,
                target: undefined,
            },
            {
                action: 'downloadAgain',
                outcome: 'cancelled',
                reason: undefined,
                step: undefined,
                target: undefined,
            },
        ],
    )
})

test('a tracked Save ends when its body returns, even if it throws', async () => {
    await tracked('save', () => Promise.resolve())
    await assert.rejects(
        tracked('saveAs', () => Promise.reject(new Error('x'))),
        /x/,
    )
    assert.deepEqual(
        recorded().map(({ action, outcome }) => [action, outcome]),
        [
            ['save', 'cancelled'],
            ['saveAs', 'cancelled'],
        ],
    )
    // And it leaves the long-frame flag off.
    assert.equal(tally.isBusy(), false)
})

test('a Save marks the page busy from its start to its end', () => {
    startSave('save')
    assert.equal(tally.isBusy(), true)
    startSave('save', { history: false, bgm: true })
    finishSave({ kind: 'done' })
    assert.equal(tally.isBusy(), false)
})

test('an Open records its format, size, outcome and reason; audio and archives record nothing', () => {
    const file = (size: number) => ({ size }) as File
    startOpen(file(300_000))
    openFormat('sus')
    endOpen('refused', 'unsupported')
    startOpen(file(20_000))
    openFormat('nxsp')
    endOpen('done')
    endOpen('cancelled')
    startOpen(file(1))
    dropOpen()
    endOpen('done')
    assert.deepEqual(
        recorded().map(({ name, format, size, outcome, reason, via }) => ({
            name,
            format,
            size,
            outcome,
            reason,
            via,
        })),
        [
            {
                name: 'open',
                format: 'sus',
                size: 300_000,
                outcome: 'refused',
                reason: 'unsupported',
                via: 'picker',
            },
            {
                name: 'open',
                format: 'nxsp',
                size: 20_000,
                outcome: 'done',
                reason: undefined,
                via: 'picker',
            },
        ],
    )
    assert.equal(tally.isBusy(), false)
})
