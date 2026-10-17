import assert from 'node:assert/strict'
import test from 'node:test'
import {
    leaveSafeMode,
    registerSettingKeys,
    safeModeMayWrite,
    safeModeUrl,
    setLeaveSafeModeGuard,
} from '../../src/safe'
import {
    failStartup,
    finishStartup,
    setOpeningName,
    setRawExport,
    setStartBlankHandler,
    startBlank,
    startupGate,
    trackStartup,
} from '../../src/startup/gate'
import { storageKey } from '../../src/storage'

// Safe mode's rule and the startup gate's state (Part 1 §1.4.2).

test('safe mode writes only settings and keys outside the editor’s own', () => {
    registerSettingKeys(['theme', 'locale'])
    for (const key of ['theme', 'locale', 'toolbarExportMigrated'])
        assert.equal(safeModeMayWrite(storageKey(key)), true, key)
    for (const key of [
        'legacyRecovery',
        'canary',
        'deviceId',
        'lastAppVersion',
        'lastPersistFailure',
        'journal.1f0c',
        'revoke.chain',
        'diagnostics',
        'autoSave.levelData',
        'autoSave.unreadable',
        'notASetting',
    ])
        assert.equal(safeModeMayWrite(storageKey(key)), false, key)
    // A key the editor doesn’t own, such as a test flag, isn’t its to refuse.
    assert.equal(safeModeMayWrite('nse.test.platform'), true)
})

test('the safe-mode address adds or removes only the parameter', () => {
    assert.equal(safeModeUrl(true, 'https://nse.qwewqa.dev/'), '/?safe')
    assert.equal(safeModeUrl(true, 'https://nse.qwewqa.dev/?x=1#a'), '/?x=1&safe#a')
    assert.equal(safeModeUrl(false, 'https://nse.qwewqa.dev/?safe'), '/')
    assert.equal(safeModeUrl(false, 'https://nse.qwewqa.dev/?safe&x=1#a'), '/?x=1#a')
    assert.equal(safeModeUrl(false, 'https://nse.qwewqa.dev/?x=1&safe'), '/?x=1')
    assert.equal(safeModeUrl(false, 'https://nse.qwewqa.dev/'), '/')
})

test('Leave Safe Mode asks the registered guard first and stays on false', async () => {
    const assigned: string[] = []
    const location = {
        href: 'https://nse.qwewqa.dev/?safe',
        assign: (url: string) => assigned.push(url),
    }
    Object.assign(globalThis, { location })
    try {
        let asked = 0
        setLeaveSafeModeGuard(() => (asked++, false))
        await leaveSafeMode()
        assert.deepEqual([asked, assigned], [1, []])
        setLeaveSafeModeGuard(() => Promise.resolve(true))
        await leaveSafeMode()
        assert.deepEqual(assigned, ['/'])
        setLeaveSafeModeGuard(undefined)
        await leaveSafeMode()
        assert.deepEqual(assigned, ['/', '/'])
    } finally {
        Reflect.deleteProperty(globalThis, 'location')
    }
})

test('the startup gate lifts when startup resolves and says so when it fails', async () => {
    assert.equal(startupGate.phase, 'opening')
    setOpeningName('Coconut (Master)')
    assert.equal(startupGate.name, 'Coconut (Master)')
    // A failure keeps the gate, with the error’s own text.
    const log = console.error
    console.error = () => undefined
    try {
        failStartup(new Error('A row could not be read'))
    } finally {
        console.error = log
    }
    assert.deepEqual([startupGate.phase, startupGate.error], ['error', 'A row could not be read'])
    // Export Raw Data… registers when it is built.
    const rawExport = () => startupGate.rawExport
    assert.equal(rawExport(), undefined)
    setRawExport({ label: () => 'Export Raw Data…', run: () => undefined })
    assert.equal(rawExport()?.label(), 'Export Raw Data…')
    finishStartup()
    assert.equal(startupGate.phase, 'done')
    // Done stays done: a late failure doesn’t close the editor again.
    console.error = () => undefined
    try {
        failStartup(new Error('late'))
    } finally {
        console.error = log
    }
    assert.equal(startupGate.phase, 'done')
})

test('tracked startup resolves to done, rejects to the error, and Start Blank runs its handler', async () => {
    const log = console.error
    console.error = () => undefined
    try {
        startupGate.phase = 'opening'
        trackStartup(Promise.resolve())
        await new Promise((resolve) => setTimeout(resolve))
        assert.equal(startupGate.phase, 'done')
        startupGate.phase = 'opening'
        trackStartup(Promise.reject(new Error('The migration failed')))
        await new Promise((resolve) => setTimeout(resolve))
        assert.deepEqual([startupGate.phase, startupGate.error], ['error', 'The migration failed'])
        startupGate.phase = 'opening'
        const events: string[] = []
        setStartBlankHandler(() => {
            events.push(`handler ${startupGate.phase}`)
        })
        await startBlank()
        assert.deepEqual([events, startupGate.phase], [['handler opening'], 'done'])
        // A handler that throws still lifts the gate.
        startupGate.phase = 'opening'
        setStartBlankHandler(() => {
            throw new Error('x')
        })
        await startBlank()
        assert.equal(startupGate.phase, 'done')
    } finally {
        console.error = log
    }
})
