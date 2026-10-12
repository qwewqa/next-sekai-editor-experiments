import { expect, test, type Page } from '@playwright/test'
import type { LevelData } from '@sonolus/core'
import { readFileSync } from 'node:fs'
import { gunzipSync, gzipSync } from 'node:zlib'
import { parseAutoSave } from '../../src/history/autoSave/parse'

const older =
    'This level was made for an older engine revision. It now uses the current revision, so check that it still looks and plays as expected.'
const newer =
    'This level was made for a newer engine revision than this editor supports. Some parts may not show or save as intended.'
const recoveryKey = 'sonolus-next-sekai-editor.autoSave.levelData'

// A tap as the editor saves it.
const tap = (beat: number, lane: number, elevation: number) => ({
    archetype: 'NormalTapNote',
    data: [
        { name: '#TIMESCALE_GROUP', ref: '0' },
        { name: 'stage', ref: '1' },
        { name: '#BEAT', value: beat },
        { name: 'lane', value: lane },
        { name: 'size', value: 1 },
        ...(elevation !== 0 ? [{ name: 'elevation', value: elevation }] : []),
        ...[
            'style',
            'direction',
            'isAttached',
            'isSeparator',
            'connectorEase',
            'segmentKind',
            'segmentAlpha',
            'segmentLayer',
            'effectKind',
            'segmentThroughJudgeLine',
            'segmentPresentation',
        ].map((name) => ({
            name,
            value: ['connectorEase', 'segmentKind', 'segmentAlpha'].includes(name) ? 1 : 0,
        })),
    ],
})

/** Level data saved for `revision` (none when undefined), with one of two taps raised by `elevation`. */
const level = (revision: number | undefined, elevation: number): LevelData => ({
    bgmOffset: 0,
    entities: [
        {
            archetype: 'Initialization',
            data: [
                { name: 'initialLife', value: 1000 },
                ...(revision === undefined ? [] : [{ name: 'revision', value: revision }]),
            ],
        },
        {
            archetype: '#BPM_CHANGE',
            data: [
                { name: '#BEAT', value: 0 },
                { name: '#BPM', value: 60 },
                { name: 'meter', value: 4 },
            ],
        },
        {
            name: '0',
            archetype: '#TIMESCALE_GROUP',
            data: [{ name: 'editorName', ref: 'Default' }],
        },
        {
            name: '1',
            archetype: 'Stage',
            data: [
                { name: 'fromStart', value: 1 },
                { name: 'untilEnd', value: 1 },
                { name: 'generateSimLines', value: 0 },
            ],
        },
        tap(0, 1, 0),
        tap(1, 3, elevation),
    ],
})

const revisionOf = (data: LevelData) =>
    data.entities[0]!.data.find((item) => item.name === 'revision')

const elevations = (data: LevelData) =>
    data.entities.flatMap((entity) =>
        entity.data.flatMap((item) =>
            item.name === 'elevation' && 'value' in item ? [item.value] : [],
        ),
    )

const open = async (page: Page, name: string, buffer: Buffer) => {
    const opening = page.waitForEvent('filechooser')
    await page.keyboard.press('o')
    await (await opening).setFiles({ name, mimeType: 'application/octet-stream', buffer })
    // Set while the file is still loading, so the wait below cannot finish early.
    await expect.poll(() => current(page)).toMatchObject({ filename: name })
}

const current = (page: Page) =>
    page.evaluate(async () => {
        const urls = new Map(
            performance
                .getEntriesByType('resource')
                .map((entry) => [new URL(entry.name).pathname, entry.name]),
        )
        const appImport = <T>(pathname: string): Promise<T> =>
            import(urls.get(pathname) ?? pathname)
        const { state } =
            await appImport<typeof import('../../src/history/index')>('/src/history/index.ts')
        const { filename } = await appImport<typeof import('../../src/history/filename')>(
            '/src/history/filename.ts',
        )
        return {
            filename: filename.value,
            elevations: [...state.value.store.slides.note.values()]
                .flat()
                .map((note) => note.elevation),
        }
    })

/** The messages of the dialogs left once loading finishes; a revision warning opens right after it. */
const dialogsAfterLoading = (page: Page) =>
    page.evaluate(async () => {
        const urls = new Map(
            performance
                .getEntriesByType('resource')
                .map((entry) => [new URL(entry.name).pathname, entry.name]),
        )
        const { modals } = (await import(
            urls.get('/src/modals/index.ts') ?? '/src/modals/index.ts'
        )) as typeof import('../../src/modals')
        const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        while (modals.some((modal) => 'task' in modal.props)) await frame()
        await frame()
        await frame()
        return modals.map((modal) => (modal.props as { message?: () => string }).message?.())
    })

const dismiss = async (page: Page, title: string, message: string) => {
    const dialog = page.getByRole('dialog', { name: title })
    await expect(dialog).toContainText(message)
    await dialog.getByRole('button', { name: 'OK', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
}

const save = async (page: Page) => {
    await page.evaluate(() => {
        // The download path, as in browsers without the File System Access API.
        Object.defineProperty(window, 'showSaveFilePicker', {
            configurable: true,
            value: undefined,
        })
    })
    const downloading = page.waitForEvent('download')
    await page.keyboard.press('p')
    return readFileSync((await (await downloading).path())!)
}

const storedRecovery = (page: Page) =>
    page.evaluate((key) => localStorage.getItem(key), recoveryKey)

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        // The file input path, as in browsers without the File System Access API.
        Object.defineProperty(window, 'showOpenFilePicker', {
            configurable: true,
            value: undefined,
        })
    })
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
})

test('opening an older level with elevation warns, and its save is the latest revision', async ({
    page,
}) => {
    await open(page, 'older', gzipSync(JSON.stringify(level(undefined, 1.5))))
    await expect(page.locator('.notification')).toHaveText('Opened level')
    expect(await dialogsAfterLoading(page)).toEqual([older])
    await dismiss(page, 'Open', older)
    expect((await current(page)).elevations).toEqual([0, 1.5])

    const saved = JSON.parse(gunzipSync(await save(page)).toString()) as LevelData
    expect(revisionOf(saved)).toEqual({ name: 'revision', value: 2 })
    expect(elevations(saved)).toEqual([1.5])

    await open(page, 'resaved', Buffer.from(JSON.stringify(saved)))
    expect(await dialogsAfterLoading(page)).toEqual([])
    expect((await current(page)).elevations).toEqual([0, 1.5])
})

for (const [label, revision, elevation, warning] of [
    ['older with stage-free note elevation', 1, -2, older],
    ['revision 0 with elevation', 0, 3, older],
    ['older without elevation', 1, 0, undefined],
    ['missing a revision, without elevation', undefined, 0, undefined],
    ['the latest revision with elevation', 2, 3, undefined],
    ['newer without elevation', 3, 0, newer],
] as const) {
    test(`opening level data ${label} ${warning ? 'warns' : 'is silent'}`, async ({ page }) => {
        await open(page, 'level', Buffer.from(JSON.stringify(level(revision, elevation))))
        expect(await dialogsAfterLoading(page)).toEqual(warning ? [warning] : [])
        if (warning) await dismiss(page, 'Open', warning)
        expect((await current(page)).elevations).toEqual([0, elevation])
    })
}

test('chart imports carry no revision and never warn', async ({ page }) => {
    // Chart Cyanvas level data, even one naming a newer revision, is a chart to import.
    const chcy = {
        bgmOffset: 0,
        entities: [
            { archetype: 'Initialization', data: [{ name: 'revision', value: 3 }] },
            { archetype: 'InputManager', data: [] },
            { archetype: 'Stage', data: [] },
            {
                name: 'tsg:0',
                archetype: 'TimeScaleGroup',
                data: [
                    { name: 'first', ref: 'tsc:0:0' },
                    { name: 'length', value: 1 },
                    { name: 'next', value: -1 },
                ],
            },
            {
                name: 'tsc:0:0',
                archetype: 'TimeScaleChange',
                data: [
                    { name: '#BEAT', value: 0 },
                    { name: 'timeScale', value: 1 },
                    { name: 'next', value: -1 },
                ],
            },
            {
                archetype: '#BPM_CHANGE',
                data: [
                    { name: '#BEAT', value: 0 },
                    { name: '#BPM', value: 120 },
                ],
            },
            {
                archetype: 'NormalTapNote',
                data: [
                    { name: '#BEAT', value: 1 },
                    { name: 'lane', value: 0 },
                    { name: 'size', value: 1 },
                    { name: 'timeScaleGroup', ref: 'tsg:0' },
                ],
            },
        ],
    }
    const usc = {
        version: 2,
        usc: {
            offset: 0,
            objects: [
                { type: 'bpm', beat: 0, bpm: 120 },
                { type: 'timeScaleGroup', changes: [{ beat: 0, timeScale: 1 }] },
                {
                    type: 'single',
                    beat: 1,
                    timeScaleGroup: 0,
                    lane: 0,
                    size: 1,
                    critical: false,
                    trace: false,
                },
            ],
        },
    }
    const sus = [
        '#REQUEST "ticks_per_beat 480"',
        '#TITLE "Import"',
        '#ARTIST "Test"',
        '#DESIGNER "Test"',
        '#DIFFICULTY 0',
        '#PLAYLEVEL 1',
        '#SONGID "import"',
        '#WAVE "import.mp3"',
        '#WAVEOFFSET 0',
        '#00002:4',
        '#BPM01:120',
        '#00008:01',
        '#00112:11',
    ].join('\n')
    for (const [name, buffer, message] of [
        ['chcy', gzipSync(JSON.stringify(chcy)), 'Imported Chart Cyanvas level'],
        ['usc', Buffer.from(JSON.stringify(usc)), 'Imported USC chart'],
        ['sus', Buffer.from(sus), 'Imported SUS chart'],
    ] as const) {
        await open(page, name, buffer)
        await expect(page.locator('.notification')).toHaveText(message)
        expect(await dialogsAfterLoading(page)).toEqual([])
    }
})

test('pasting copied data from an older revision with elevation never warns', async ({ page }) => {
    const entities = level(undefined, 2).entities
    const pasted = await page.evaluate(async (entities) => {
        const urls = new Map(
            performance
                .getEntriesByType('resource')
                .map((entry) => [new URL(entry.name).pathname, entry.name]),
        )
        const appImport = <T>(pathname: string): Promise<T> =>
            import(urls.get(pathname) ?? pathname)
        const { setClipboardData } =
            await appImport<typeof import('../../src/clipboard')>('/src/clipboard/index.ts')
        const { pasteAtPosition } = await appImport<typeof import('../../src/editor/tools/paste')>(
            '/src/editor/tools/paste/index.ts',
        )
        const { state } =
            await appImport<typeof import('../../src/history/index')>('/src/history/index.ts')
        setClipboardData({ lane: 0, beat: 0, entities })
        await pasteAtPosition(0, 4, { ctrl: false, shift: false })
        return state.value.selectedEntities.flatMap((entity) =>
            entity.type === 'note' ? [entity.elevation] : [],
        )
    }, entities)
    expect(pasted).toEqual([0, 2])
    expect(await dialogsAfterLoading(page)).toEqual([])
})

for (const [label, revision, elevation, warning] of [
    ['older with elevation', undefined, 1.5, older],
    ['older without elevation', 1, 0, undefined],
    ['newer', 3, 0, newer],
] as const) {
    test(`restoring an auto save ${label} ${warning ? 'warns once' : 'is silent'}`, async ({
        page,
    }) => {
        // The unversioned recovery format is the level data itself.
        await page.evaluate(([key, data]) => localStorage.setItem(key, JSON.stringify(data)), [
            recoveryKey,
            level(revision, elevation),
        ] as const)
        await page.reload()
        await expect(page.locator('canvas.editor-chart')).toBeVisible()
        expect(await dialogsAfterLoading(page)).toEqual(warning ? [warning] : [])
        if (warning) await dismiss(page, 'Auto Save', warning)
        expect((await current(page)).elevations).toEqual([0, elevation])

        // Rewritten once at the latest revision, so the next start restores it quietly.
        const stored = await storedRecovery(page)
        expect(stored).not.toBeNull()
        const restored = parseAutoSave(JSON.parse(stored!)).levelData
        expect(revisionOf(restored)).toEqual(
            warning ? { name: 'revision', value: 2 } : revisionOf(level(revision, elevation)),
        )
        await page.reload()
        await expect(page.locator('canvas.editor-chart')).toBeVisible()
        expect(await dialogsAfterLoading(page)).toEqual([])
        expect((await current(page)).elevations).toEqual([0, elevation])
    })
}

for (const [label, primary, aside, choice, warning] of [
    [
        'restoring an older earlier one warns after the choice',
        level(2, 0),
        level(undefined, 1.5),
        'Restore',
        older,
    ],
    [
        'discarding an older earlier one is silent',
        level(2, 0),
        level(undefined, 1.5),
        'Discard',
        undefined,
    ],
    [
        'restoring over an older last one is silent',
        level(undefined, 1.5),
        level(2, 0),
        'Restore',
        undefined,
    ],
] as const) {
    test(`with an earlier recovery set aside, ${label}`, async ({ page }) => {
        await page.evaluate(
            ([key, primary, aside]) => {
                localStorage.setItem(key, JSON.stringify(primary))
                localStorage.setItem(
                    'sonolus-next-sekai-editor.autoSave.unreadable',
                    JSON.stringify(aside),
                )
            },
            [recoveryKey, primary, aside] as const,
        )
        await page.reload()
        const dialog = page.getByRole('dialog')
        await expect(dialog).toContainText('can now restore an unsaved chart')
        // The choice comes alone; the warning waits for it.
        expect(await dialogsAfterLoading(page)).toEqual([undefined])
        await dialog.getByRole('button', { name: choice, exact: true }).click()
        expect(await dialogsAfterLoading(page)).toEqual(warning ? [warning] : [])
        if (warning) await dismiss(page, 'Auto Save', warning)
        const loaded = choice === 'Restore' ? aside : primary
        expect((await current(page)).elevations).toEqual([0, elevations(loaded)[0] ?? 0])
    })
}
