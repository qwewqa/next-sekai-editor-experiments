import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'
import { confirmWhenReady } from './confirmWhenReady'
import { installCanvasCounters, installEditorFixture } from './editorFixture'
import { skipWhereTheEditorCannotStart } from './webkitSupport'

// The support gate, the startup gate and safe mode in a real browser.

skipWhereTheEditorCannotStart()

const prefix = 'sonolus-next-sekai-editor.'

type Seen = { type: string; target: string }
declare global {
    interface Window {
        seen: Seen[]
        asked: number
    }
}

/** Seeds the startup test flags (a tab's own sessionStorage), before any page script runs. */
const startupFlags = (page: Page, flags: Record<string, unknown>) =>
    page.addInitScript(
        (text) => sessionStorage.setItem('nse.test.startup', text),
        JSON.stringify(flags),
    )

/** Records the input that reaches the page, at the document in the bubble phase. */
const recordInput = (page: Page) =>
    page.addInitScript(() => {
        window.seen = []
        for (const type of ['keydown', 'pointerdown', 'wheel'])
            document.addEventListener(type, (event) =>
                window.seen.push({
                    type,
                    target: event.target instanceof Element ? event.target.tagName : '',
                }),
            )
    })

const boot = async (page: Page, url = '/') => {
    await page.addInitScript(installCanvasCounters)
    await page.goto(url)
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
}

/** Boots with the storage test hooks and holds every flush, so an edit is only the journal's. */
const bootStalled = async (page: Page, url = '/') => {
    await page.addInitScript(() => sessionStorage.setItem('nse.test.storage', '{}'))
    await boot(page, url)
    await page.evaluate(installEditorFixture)
    // Safe mode opens the database read-only: nothing is stored, so there's no flusher to hold.
    if (url.includes('safe')) return
    await expect.poll(() => page.evaluate(() => window.nseFlushTest !== undefined)).toBe(true)
    await page.evaluate(() => {
        window.nseFlushTest!.stall = true
    })
}

const gate = (page: Page) => page.locator('dialog[data-startup-gate]')

/** Edits through the app's own modules, as its tools do. */
const addNote = (page: Page) =>
    page.evaluate(async () => {
        const { history, appImport } = window.editorTest
        const { createTransaction } = await appImport<typeof import('../../src/state/transaction')>(
            '/src/state/transaction.ts',
        )
        const { addNote } = await appImport<typeof import('../../src/state/mutations/slides/note')>(
            '/src/state/mutations/slides/note.ts',
        )
        const { createSlideId } = await appImport<typeof import('../../src/state/entities/slides')>(
            '/src/state/entities/slides/index.ts',
        )
        const live = history.liveState.value
        const transaction = createTransaction(live)
        addNote(transaction, createSlideId(), {
            groupId: [...live.groups.keys()][0],
            stageId: [...live.stages.keys()][0],
            beat: 8,
            noteType: 'default',
            isAttached: false,
            left: -2,
            size: 2,
            isCritical: false,
            flickDirection: 'none',
            isFake: false,
            noteStyle: 'default',
            connectorStyle: 'default',
            sfx: 'default',
            isConnectorSeparator: false,
            connectorType: 'active',
            connectorEase: 'linear',
            connectorIsFake: false,
            connectorActiveIsCritical: false,
            connectorGuideAlpha: 1,
            connectorLayer: 'top',
            connectorIsPassThrough: false,
            connectorPresentation: 'default',
            elevation: 0,
        } as never)
        history.pushState(window.editorTest.historySteps.noteAdd(1), transaction.commit([]))
    })

test.describe('the support gate', () => {
    const autoSave = JSON.stringify({ version: 1, filename: 'coconut', levelData: 'H4sIAAAAAAAA' })

    test('a browser without a needed feature gets the plain page, and the bundle never starts', async ({
        page,
    }) => {
        // The bundle's entry stops at once; one that ran on would throw something else.
        const errors: string[] = []
        page.on('pageerror', (error) => errors.push(error.message))
        await page.addInitScript(
            ({ prefix, autoSave }) => {
                Object.defineProperty(Navigator.prototype, 'locks', { get: () => undefined })
                localStorage.setItem(`${prefix}autoSave.levelData`, autoSave)
            },
            { prefix, autoSave },
        )
        await page.goto('/')
        await expect(page.locator('html')).toHaveAttribute('data-gate', 'unsupported')
        await expect(page.getByText('This browser is too old for the editor.')).toBeVisible()
        await expect(
            page.getByRole('button', { name: 'Download Your Last Auto Save' }),
        ).toBeVisible()
        await page.waitForTimeout(500)
        expect(errors).toEqual(['This browser is not supported.'])
        await expect(page.locator('#app')).toBeEmpty()
        // The development server adds a style element for each stylesheet the bundle imports.
        await expect(page.locator('style[data-vite-dev-id]')).toHaveCount(0)
    })

    test('WebKit gets the Safari line', async ({ page }) => {
        await page.addInitScript(() => {
            Object.defineProperty(Navigator.prototype, 'storage', { get: () => undefined })
            Object.defineProperty(Navigator.prototype, 'userAgent', {
                get: () =>
                    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
            })
        })
        await page.goto('/')
        await expect(
            page.getByText(
                'This editor requires Safari 17 or later (iOS 17 or later on iPhone and iPad).',
            ),
        ).toBeVisible()
        await expect(page.getByRole('button')).toHaveCount(0)
    })

    test('a supported browser gets the editor', async ({ page }) => {
        await boot(page)
        await expect(page.locator('html')).not.toHaveAttribute('data-gate', /.*/)
    })
})

test.describe('the startup gate', () => {
    test('input is swallowed until startup ends, then reaches the editor', async ({ page }) => {
        await startupFlags(page, { hold: true })
        await recordInput(page)
        await boot(page)
        await expect(gate(page)).toBeVisible()
        await expect(gate(page).getByRole('status')).toHaveText('Opening…')
        await page.keyboard.press('KeyA')
        await page.keyboard.press('Space')
        await page.mouse.click(800, 500)
        await page.mouse.wheel(0, 200)
        const seen = () => page.evaluate(() => window.seen)
        expect((await seen()).filter((s) => s.type === 'keydown')).toEqual([])
        expect((await seen()).filter((s) => s.target === 'CANVAS')).toEqual([])
        await page.evaluate(() => window.nseStartupRelease?.())
        await expect(gate(page)).toHaveCount(0)
        await page.keyboard.press('KeyA')
        expect((await seen()).filter((s) => s.type === 'keydown')).toHaveLength(1)
    })

    test('the spinner turns, and under reduced motion pulses instead of standing still', async ({
        page,
    }) => {
        await startupFlags(page, { hold: true })
        await boot(page)
        await expect(gate(page).locator('svg')).toHaveCSS('animation-name', 'spin')
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await expect(gate(page).locator('svg')).toHaveCSS('animation-name', 'pulse')
    })

    test('the session’s name is told once it is known', async ({ page }) => {
        await startupFlags(page, { hold: true })
        await boot(page)
        await page.evaluate(installEditorFixture)
        await page.evaluate(async () => {
            const gate =
                await window.editorTest.appImport<typeof import('../../src/startup/gate')>(
                    '/src/startup/gate.ts',
                )
            gate.setOpeningName('Coconut (Master)')
        })
        await expect(gate(page).getByRole('status')).toHaveText('Opening "Coconut (Master)"…')
    })

    test('after a while it adds the slow text with Start Blank and Open in Safe Mode', async ({
        page,
    }) => {
        await startupFlags(page, { hold: true, slowMs: 400 })
        await boot(page)
        await expect(gate(page).getByText('This is taking longer than usual.')).toBeVisible()
        await expect(gate(page).getByRole('button')).toHaveText([
            'Start Blank',
            'Open in Safe Mode',
        ])
        await gate(page).getByRole('button', { name: 'Start Blank' }).click()
        await expect(gate(page)).toHaveCount(0)
    })

    test('Open in Safe Mode reloads with the parameter', async ({ page }) => {
        await startupFlags(page, { hold: true, slowMs: 200 })
        await boot(page)
        await gate(page).getByRole('button', { name: 'Open in Safe Mode' }).click()
        await expect(page).toHaveURL(/\/\?safe$/)
        await expect(page.locator('[data-safe-bar]')).toBeVisible()
    })

    test('a startup that throws shows the error’s own text, and the way out', async ({ page }) => {
        const errors: string[] = []
        page.on('console', (message) => {
            if (message.type() === 'error') errors.push(message.text())
        })
        await startupFlags(page, { fail: 'A row could not be read' })
        await boot(page)
        await expect(gate(page).getByRole('alert')).toHaveText(
            'The editor could not open your stored work.',
        )
        await expect(gate(page).locator('[data-startup-error]')).toHaveText(
            'A row could not be read',
        )
        // No Start Blank on a failure.
        await expect(gate(page).getByRole('button')).toHaveText([
            'Open in Safe Mode',
            'Export Raw Data',
        ])
        expect(errors.some((text) => text.includes('A row could not be read'))).toBe(true)
    })

    type RawDump = {
        format: string
        stores: { name: string; records: { key: unknown }[] }[]
        localStorage: Record<string, string>
    }

    /** dump.json out of an exported ZIP: its first entry, DEFLATE, found through the central directory. */
    const dumpOfZip = (bytes: Buffer) => {
        expect(bytes.subarray(0, 4).toString('latin1')).toBe('PK')
        // The end record is the last 22 bytes when the ZIP has no comment.
        const end = bytes.length - 22
        expect(bytes.readUInt32LE(end)).toBe(0x06054b50)
        const directory = bytes.readUInt32LE(end + 16)
        expect(bytes.readUInt32LE(directory)).toBe(0x02014b50)
        const size = bytes.readUInt32LE(directory + 20)
        const local = bytes.readUInt32LE(directory + 42)
        const nameLength = bytes.readUInt16LE(local + 26)
        const extraLength = bytes.readUInt16LE(local + 28)
        expect(bytes.subarray(local + 30, local + 30 + nameLength).toString()).toBe('dump.json')
        const start = local + 30 + nameLength + extraLength
        return JSON.parse(inflateRawSync(bytes.subarray(start, start + size)).toString()) as RawDump
    }

    test('Export Raw Data waits while its export runs, so a second press starts no second one', async ({
        page,
    }) => {
        await startupFlags(page, { fail: 'A row could not be read' })
        await boot(page)
        const button = gate(page).getByRole('button', { name: 'Export Raw Data' })
        await page.evaluate(async () => {
            const { startupGate } = await import('/src/startup/gate.ts')
            const held = startupGate.rawExport!
            const hold = window as unknown as { releaseExport: () => void; exports: number }
            hold.exports = 0
            startupGate.rawExport = {
                ...held,
                run: async () => {
                    hold.exports++
                    await new Promise<void>((resolve) => (hold.releaseExport = resolve))
                    return undefined
                },
            }
        })
        await button.click()
        await expect(button).toBeDisabled()
        await page.evaluate(() =>
            (window as unknown as { releaseExport: () => void }).releaseExport(),
        )
        await expect(button).toBeEnabled()
        expect(await page.evaluate(() => (window as unknown as { exports: number }).exports)).toBe(
            1,
        )
    })

    test('Export Raw Data on the error state downloads the stored data as one ZIP', async ({
        page,
    }) => {
        await startupFlags(page, { fail: 'A row could not be read' })
        await page.addInitScript(
            (key) => localStorage.setItem(key, '"db-test"'),
            `${prefix}rawExportTest`,
        )
        await boot(page)
        const download = page.waitForEvent('download')
        await gate(page).getByRole('button', { name: 'Export Raw Data' }).click()
        const file = await download
        expect(file.suggestedFilename()).toMatch(
            /^Next SEKAI Editor raw data \d{4}-\d{2}-\d{2}\.zip$/,
        )
        const dump = dumpOfZip(readFileSync(await file.path()))
        expect(dump.format).toBe('nse-local-data-dump')
        expect(dump.localStorage[`${prefix}rawExportTest`]).toBe('"db-test"')
        // The gate stays: exporting is not a way out.
        await expect(gate(page)).toBeVisible()
    })

    test('a download that cannot start says so on the gate, with the file’s name', async ({
        page,
    }) => {
        await startupFlags(page, { fail: 'A row could not be read' })
        await boot(page)
        await page.evaluate(async () => {
            const { platform } = await import('/src/platform/index.ts')
            platform.saveFile = () => Promise.reject(new Error('blocked'))
        })
        await gate(page).getByRole('button', { name: 'Export Raw Data' }).click()
        await expect(gate(page).locator('[data-raw-export-note]')).toHaveText(
            /^"Next SEKAI Editor raw data \d{4}-\d{2}-\d{2}\.zip" could not be downloaded\.$/,
        )
    })

    test('a database that will not open is said so, and the rest is still exported', async ({
        page,
    }) => {
        await startupFlags(page, { fail: 'A row could not be read' })
        await page.addInitScript(
            (key) => localStorage.setItem(key, '"db-test"'),
            `${prefix}rawExportTest`,
        )
        await boot(page)
        // The database is there (the editor opened it); the export's own open is refused.
        await page.evaluate(() => {
            indexedDB.open = () => {
                const request = {} as IDBOpenDBRequest
                setTimeout(() => {
                    Object.defineProperty(request, 'error', {
                        value: new DOMException('disk', 'UnknownError'),
                    })
                    request.onerror?.(new Event('error'))
                })
                return request
            }
        })
        const download = page.waitForEvent('download')
        await gate(page).getByRole('button', { name: 'Export Raw Data' }).click()
        const dump = dumpOfZip(readFileSync(await (await download).path()))
        expect(dump.stores).toEqual([])
        expect(dump.localStorage[`${prefix}rawExportTest`]).toBe('"db-test"')
        await expect(gate(page).locator('[data-raw-export-note]')).toHaveText(
            'The stored work could not be read.',
        )
    })

    test('the export reads a real database, and never creates a missing one', async ({ page }) => {
        // A page of the app's origin that is not the editor, so nothing else opens the database.
        await page.goto('/gate.js')
        const run = () =>
            page.evaluate(async () => {
                const path = '/src/local/rawExport.ts'
                const { buildRawExport } = (await import(
                    path
                )) as typeof import('../../src/local/rawExport')
                const zip = await buildRawExport('0.0.0')
                const names = (await indexedDB.databases()).map((db) => db.name)
                return { bytes: Array.from(new Uint8Array(await zip.arrayBuffer())), names }
            })
        const missing = await run()
        expect(missing.names).not.toContain('nse-local-data')
        expect(dumpOfZip(Buffer.from(missing.bytes)).stores).toEqual([])
        await page.evaluate(
            () =>
                new Promise<void>((resolve, reject) => {
                    const open = indexedDB.open('nse-local-data', 1)
                    open.onupgradeneeded = () => {
                        open.result.createObjectStore('chains', { keyPath: 'chainId' })
                        open.transaction!.objectStore('chains').put({ chainId: 'c1', head: 7 })
                    }
                    open.onsuccess = () => {
                        open.result.close()
                        resolve()
                    }
                    open.onerror = () => reject(open.error)
                }),
        )
        const stored = dumpOfZip(Buffer.from((await run()).bytes))
        expect(stored.stores.map((store) => [store.name, store.records.length])).toEqual([
            ['chains', 1],
        ])
    })

    test('a stored Blob goes into its own STORE entry, byte for byte', async ({ page }) => {
        // Catches an export that reads a stored Blob whole or as base64, or one whose entry an
        // engine cannot read back after the database closes.
        await page.goto('/gate.js')
        const result = await page.evaluate(async () => {
            // Past one 8 MiB slice of the CRC.
            const size = 9 * 1024 * 1024 + 5
            const bytes = new Uint8Array(size)
            for (let i = 0; i < size; i++) bytes[i] = (i * 31 + (i >> 11)) & 0xff
            await new Promise<void>((resolve, reject) => {
                const open = indexedDB.open('nse-local-data', 1)
                open.onupgradeneeded = () => {
                    open.result.createObjectStore('media')
                    open.transaction!.objectStore('media').put(
                        { blob: new Blob([bytes], { type: 'audio/wav' }) },
                        new Uint8Array(16).fill(7).buffer,
                    )
                }
                open.onsuccess = () => {
                    open.result.close()
                    resolve()
                }
                open.onerror = () => reject(open.error)
            })
            const rawPath = '/src/local/rawExport.ts'
            const zipPath = '/src/zip/index.ts'
            const { buildRawExport } = (await import(
                rawPath
            )) as typeof import('../../src/local/rawExport')
            const { ZipReader } = (await import(zipPath)) as typeof import('../../src/zip')
            const reader = await ZipReader.open(await buildRawExport('0.0.0'))
            const text = new TextDecoder().decode(
                await reader.read(reader.get('dump.json')!, { maxSize: 1 << 20 }),
            )
            const dump = JSON.parse(text) as { stores: { records: { value: unknown }[] }[] }
            // The read checks the entry's CRC.
            const held = await reader.read(reader.get('blobs/0')!, { maxSize: size })
            return {
                entries: reader.entries.map((entry) => [entry.name, entry.method]),
                media: dump.stores[0]!.records[0]!.value,
                same: held.length === size && held.every((byte, i) => byte === bytes[i]),
            }
        })
        expect(result.entries).toEqual([
            ['dump.json', 8],
            ['blobs/0', 0],
        ])
        expect(result.media).toEqual({ blob: { $blobEntry: 'blobs/0', type: 'audio/wav' } })
        expect(result.same).toBe(true)
    })

    test('Escape does not close it', async ({ page }) => {
        await startupFlags(page, { hold: true, slowMs: 200 })
        await boot(page)
        await expect(gate(page).getByRole('button', { name: 'Start Blank' })).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(gate(page)).toBeVisible()
    })
})

test.describe('safe mode', () => {
    const seeded = {
        'autoSave.levelData': JSON.stringify({ version: 1, levelData: 'H4sI' }),
        canary: JSON.stringify('db-1'),
        deviceId: JSON.stringify('device-1'),
        'journal.seeded': 'not a journal',
    }

    const seed = (page: Page) =>
        page.addInitScript(
            ({ prefix, seeded }) => {
                for (const [key, value] of Object.entries(seeded))
                    localStorage.setItem(`${prefix}${key}`, value)
            },
            { prefix, seeded },
        )

    const stored = (page: Page) =>
        page.evaluate(() => Object.fromEntries(Object.entries(localStorage)))

    const journals = (all: Record<string, string>) =>
        Object.keys(all).filter((key) => key.startsWith(`${prefix}journal.`))

    const leave = (page: Page) =>
        page.locator('[data-safe-bar]').getByRole('button', { name: 'Leave Safe Mode' })

    test('the bar says nothing is stored, and Leave Safe Mode goes back without the parameter', async ({
        page,
    }) => {
        await boot(page, '/?safe')
        const bar = page.locator('[data-safe-bar]')
        await expect(bar).toContainText('Safe mode: changes are not stored.')
        // The editor sits below the bar, not under it.
        const barBox = await bar.boundingBox()
        const editorBox = await page.locator('canvas.editor-chart').boundingBox()
        expect(editorBox!.y).toBeGreaterThanOrEqual(barBox!.y + barBox!.height - 1)
        await leave(page).click()
        await expect(page).toHaveURL(/\/$/)
        await expect(page.locator('[data-safe-bar]')).toHaveCount(0)
    })

    test('nothing but settings is written to localStorage, an edit and a hide included', async ({
        page,
    }) => {
        await seed(page)
        await bootStalled(page, '/?safe')
        const before = await stored(page)
        await addNote(page)
        await page.evaluate(() => {
            window.editorTest.settings.pps = 150
            window.dispatchEvent(new Event('pagehide'))
            document.dispatchEvent(new Event('visibilitychange'))
        })
        await page.waitForTimeout(1500)
        const after = await stored(page)
        // A setting went through, and every other editor key is as it was.
        expect(after[`${prefix}pps`]).toBe('150')
        const settings = new Set(Object.keys(await settingKeys(page)))
        const changed = Object.keys({ ...before, ...after }).filter(
            (key) => before[key] !== after[key] && !settings.has(key),
        )
        expect(changed).toEqual([])
        for (const [key, value] of Object.entries(seeded))
            expect(after[`${prefix}${key}`]).toBe(value)
        expect(journals(after)).toEqual([`${prefix}journal.seeded`])
    })

    /** The keys the settings module owns, as stored names. */
    const settingKeys = (page: Page) =>
        page.evaluate(async () => {
            const { settings } = window.editorTest
            return Object.fromEntries(
                Object.keys(settings).map((key) => [`sonolus-next-sekai-editor.${key}`, true]),
            )
        })

    test('the same edit and hide do write a journal outside safe mode', async ({ page }) => {
        await bootStalled(page)
        await addNote(page)
        await page.evaluate(() => {
            window.dispatchEvent(new Event('pagehide'))
            document.dispatchEvent(new Event('visibilitychange'))
        })
        await expect
            .poll(async () => journals(await stored(page)).length, { timeout: 10_000 })
            .toBeGreaterThan(0)
    })

    test('Leave Safe Mode with edits shows the not-stored prompt, and Cancel stays', async ({
        page,
    }) => {
        await boot(page, '/?safe')
        await page.evaluate(installEditorFixture)
        await addNote(page)
        await leave(page).click()
        const dialog = page.getByRole('dialog', { name: 'Changes Not Stored' })
        await expect(dialog).toContainText(
            'Your changes are not being stored in this browser. Leaving will discard them.',
        )
        // The safe default is Save, on the right.
        await expect(dialog.getByRole('button', { name: 'Save' })).toBeFocused()
        // A press in the dialog's first moments is not a choice.
        await page.waitForTimeout(400)
        await dialog.getByRole('button', { name: 'Cancel' }).click()
        await expect(page).toHaveURL(/\?safe$/)
        await leave(page).click()
        await confirmWhenReady(dialog.getByRole('button', { name: 'Leave Anyway' }), dialog)
        await expect(page).toHaveURL(/\/$/)
    })

    test('a registered guard, the not-stored prompt’s, is asked instead', async ({ page }) => {
        await boot(page, '/?safe')
        await page.evaluate(installEditorFixture)
        await page.evaluate(async () => {
            const safe =
                await window.editorTest.appImport<typeof import('../../src/safe')>('/src/safe.ts')
            window.asked = 0
            safe.setLeaveSafeModeGuard(() => ++window.asked > 1)
        })
        await leave(page).click()
        await expect.poll(() => page.evaluate(() => window.asked)).toBe(1)
        await expect(page).toHaveURL(/\?safe$/)
        await leave(page).click()
        await expect(page).toHaveURL(/\/$/)
    })
})
