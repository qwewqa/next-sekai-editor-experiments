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
    runRawExport,
    setOpeningName,
    setRawExport,
    setStartBlankHandler,
    startBlank,
    startupGate,
    trackStartup,
} from '../../src/startup/gate'
import { rawExportNote } from '../../src/startup/rawExportNote'
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
    setRawExport({ label: () => 'Export Raw Data…', run: () => Promise.resolve(undefined) })
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

test('the error state’s Export Raw Data… shows the line its run returns, and clears it on the next press', async () => {
    const log = console.error
    const notes = ['The stored work could not be read.', undefined]
    setRawExport({ label: () => 'Export Raw Data…', run: () => Promise.resolve(notes.shift()) })
    await runRawExport()
    assert.equal(startupGate.rawExportNote, 'The stored work could not be read.')
    // A press that goes through whole shows no line, not the old one.
    await runRawExport()
    assert.equal(startupGate.rawExportNote, undefined)
    // A run that throws (a bug in it) leaves no stale line and no unhandled rejection.
    console.error = () => undefined
    try {
        notes.push('stale')
        await runRawExport()
        setRawExport({ label: () => 'x', run: () => Promise.reject(new Error('bug')) })
        startupGate.rawExportNote = 'stale'
        await runRawExport()
    } finally {
        console.error = log
    }
    assert.equal(startupGate.rawExportNote, undefined)
    setRawExport(undefined)
})

test('the gate’s line names the file when the download failed, and the stored work when it was left out', () => {
    const texts = {
        downloadFailed: '"{0}" could not be downloaded.',
        unreadable: 'The stored work could not be read.',
    }
    assert.equal(
        rawExportNote({ kind: 'failed', name: 'raw data.zip', error: new Error('x') }, texts),
        '"raw data.zip" could not be downloaded.',
    )
    const done = { kind: 'done', name: 'a.zip', size: 1, started: true } as const
    assert.equal(
        rawExportNote({ ...done, databaseUnreadable: true }, texts),
        'The stored work could not be read.',
    )
    assert.equal(rawExportNote({ ...done, databaseUnreadable: false }, texts), undefined)
})
