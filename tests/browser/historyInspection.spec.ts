import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import { readFileSync } from 'node:fs'
import type { GroupId } from '../../src/chart/groups'
import type { EntryDescription } from '../../src/history/operations'
import type { EntryKey } from '../../src/history/peek'
import type english from '../../src/i18n/en/index.json'
import type { State } from '../../src/state'
import { installCanvasCounters, installEditorFixture, waitForStartup } from './editorFixture'

declare global {
    interface Window {
        historyInspectionTest: {
            states: Map<number, State>
            refresh: () => void
            select: (seq: number, previous?: number, members?: number[]) => void
            hold: (seq: number) => Promise<void>
            release: (seq: number, fail?: boolean) => void
            pending: Set<number>
            unchanged: () => boolean
        }
        historyMenuKeys: { key: string; ctrl: boolean; meta: boolean; prevented: boolean }[]
    }
}

const errors = new WeakMap<Page, string[]>()
test.beforeEach(async ({ page }) => {
    const caught: string[] = []
    errors.set(page, caught)
    page.on('pageerror', (error) => caught.push(error.message))
    await page.addInitScript(installCanvasCounters)
    await page.addInitScript(() => {
        localStorage.setItem('sonolus-next-sekai-editor.showPreview', 'false')
        localStorage.setItem('sonolus-next-sekai-editor.showSidebar', 'false')
        localStorage.setItem('nse.test.storage', '{}')
    })
    await page.goto('/')
    await waitForStartup(page)
    const startup = await page.evaluate(async () => {
        const { flusher } = await import('/src/local/storing.ts')
        return flusher?.session?.id
    })
    await page.evaluate(installEditorFixture)
    // The fixture starts a new session with the chart as its first entry. Entries are pending only
    // until the next flush, which a loaded machine can pass before this first looks, so wait for
    // the entry itself.
    await expect
        .poll(() =>
            page.evaluate(async (startup) => {
                const { flusher } =
                    await window.editorTest.appImport<typeof import('../../src/local/storing')>(
                        '/src/local/storing.ts',
                    )
                const session = flusher?.session
                return !!session && session.id !== startup && flusher.newestSeq(session) > 0
            }, startup),
        )
        .toBe(true)
})
test.afterEach(({ page }) => {
    expect(errors.get(page)).toEqual([])
})

// Valid imported metadata supplies historical endpoints; every control still uses real pointer/key events.
const seed = async (
    page: Page,
    mode: 'basic' | 'rows' | 'items' | 'folders' | 'groups' = 'basic',
) => {
    await page.evaluate(async (mode) => {
        const { appImport, history, historySteps, settings } = window.editorTest
        const { captureOperationRecipe } = await appImport<
            typeof import('../../src/history/operationPresentation')
        >('/src/history/operationPresentation/index.ts')
        const [peek, selection] = await Promise.all([
            appImport<typeof import('../../src/history/peek')>('/src/history/peek.ts'),
            appImport<typeof import('../../src/editor/history/selection')>(
                '/src/editor/history/selection.ts',
            ),
        ])
        const live = history.liveState.value
        const defaultEdits = (settings.dimUnchangedObjects = true)
        const before: State = {
            ...live,
            initialLife: 999,
            levelInfo: {
                ...live.levelInfo,
                title: 'Before title',
                description: '  first\n\nlast  ',
                rating: 1.0000001,
                tags: [{ title: 'Tag' }, { title: '' }, { title: '  ' }],
            },
            bgm: {
                ...live.bgm,
                offset: 0.0000001,
                meta: {
                    hash: '1'.repeat(32),
                    filename: 'before.ogg',
                    size: 1024,
                    type: 'audio/ogg',
                    durationMs: 1234,
                },
            },
        }
        const after: State = {
            ...before,
            initialLife: 1001,
            levelInfo: {
                ...before.levelInfo,
                title: 'After title',
                description: '  changed\n\nlast  ',
                rating: 1.0000002,
                tags: [...before.levelInfo.tags, { title: 'Added tag' }],
                cover: {
                    hash: '2'.repeat(32),
                    filename: 'cover.png',
                    size: 4097,
                    type: 'image/png',
                },
            },
            bgm: {
                ...before.bgm,
                offset: 0.0000002,
                meta: {
                    hash: '3'.repeat(32),
                    filename: 'after.ogg',
                    size: 1025,
                    type: 'audio/ogg',
                    durationMs: 1235,
                },
            },
        }
        if (mode === 'rows') {
            before.groups = new Map([
                ...before.groups,
                ...Array.from(
                    { length: 150 },
                    (_, index): [GroupId, { name: string; forceNoteSpeed: number }] => [
                        (index + 1000) as GroupId,
                        { name: `Historical group ${index + 1}`, forceNoteSpeed: 1 },
                    ],
                ),
            ])
            after.groups = new Map(
                [...before.groups].map(([id, group]) => [
                    id,
                    id >= 1000 ? { ...group, forceNoteSpeed: 2 } : group,
                ]),
            )
            after.initialLife = before.initialLife
            after.levelInfo = before.levelInfo
            after.bgm = before.bgm
        } else if (mode === 'folders') {
            // One folder appears and one goes: sections with a single side.
            before.stageFolders = new Map([[600 as never, { name: 'Removed folder', index: 0 }]])
            after.stageFolders = new Map()
            after.groupFolders = new Map([[500 as never, { name: 'Added folder', index: 0 }]])
            after.initialLife = before.initialLife
            after.levelInfo = before.levelInfo
            after.bgm = before.bgm
        } else if (mode === 'groups') {
            // The only group is deleted and a default one takes its place; a BGM file is chosen
            // while the offset already has a value.
            before.groups = new Map([[1 as GroupId, { name: 'Default' }]])
            after.groups = new Map([[9 as GroupId, { name: 'Default', forceNoteSpeed: 1.5 }]])
            before.bgm = { ...live.bgm, offset: 0.25, meta: undefined }
            after.bgm = {
                ...live.bgm,
                offset: -0.12,
                meta: {
                    hash: '4'.repeat(32),
                    filename: 'Opening theme (final mix).wav',
                    size: 2048,
                    type: 'audio/wav',
                },
            }
            after.initialLife = before.initialLife
            after.levelInfo = before.levelInfo
        } else if (mode === 'items') {
            after.levelInfo = {
                ...before.levelInfo,
                tags: Array.from({ length: 205 }, (_, index) => ({
                    title: `Historical tag ${index + 1}`,
                })),
            }
            after.initialLife = before.initialLife
            after.bgm = before.bgm
        }
        const states = new Map([
            [0, before],
            [1, after],
            [2, before],
            [3, before],
            [4, { ...before, initialLife: 1001 }],
            [5, { ...before, initialLife: 1000 }],
            [6, before],
        ])
        const metadata = historySteps.editStep(
            historySteps.futureFixtureOperation('inspection-metadata', {}, 'Imported Metadata'),
        )
        const descriptions = new Map<number, EntryDescription>([
            [
                0,
                {
                    kind: 'init',
                    operation: historySteps.futureFixtureOperation(
                        'inspection-origin',
                        {},
                        'Initial state',
                    ),
                },
            ],
            [1, { kind: 'edit', step: metadata }],
            [2, { kind: 'undo', step: metadata }],
            [
                3,
                {
                    kind: 'edit',
                    step: historySteps.editStep(
                        historySteps.futureFixtureOperation(
                            'inspection-stable',
                            {},
                            'Imported Metadata',
                        ),
                    ),
                },
            ],
            [4, { kind: 'edit', step: historySteps.editStep(historySteps.initialLife(999, 1001)) }],
            [
                5,
                { kind: 'edit', step: historySteps.editStep(historySteps.initialLife(1001, 1000)) },
            ],
            [6, { kind: 'edit', step: historySteps.editStep(historySteps.initialLife(1000, 999)) }],
        ])
        const held = new Set<number>()
        const pending = new Set<number>()
        const releases = new Map<number, (fail: boolean) => void>()
        const source = () =>
            peek.setPeekSource({
                sameSnapshot: (a, b) => a === b,
                load: async (key) => {
                    const seq = Number(key.split(':').at(-1))
                    const state = states.get(seq)
                    if (!state) throw new peek.PeekError('missing')
                    if (held.has(seq)) {
                        pending.add(seq)
                        await new Promise<void>((resolve, reject) =>
                            releases.set(seq, (fail) => {
                                pending.delete(seq)
                                held.delete(seq)
                                if (fail) reject(new peek.PeekError('removed'))
                                else resolve()
                            }),
                        )
                    }
                    return { state, time: 1_720_000_000_000 + seq }
                },
            })
        source()
        window.historyInspectionTest = {
            states,
            pending,
            refresh: source,
            select: (seq, previous = 0, members) =>
                selection.requestPeek({
                    key: `inspection:${seq}`,
                    previous: { key: `inspection:${previous}` },
                    time: 1_720_000_000_000 + seq,
                    recipe: captureOperationRecipe(
                        (members ?? [seq]).map((member) => ({
                            description: descriptions.get(member)!,
                            time: 1_720_000_000_000 + member,
                            id: `inspection:${member}`,
                        })),
                    ),
                    ...(members ? { oldest: `inspection:${members[0]}` as EntryKey } : {}),
                    ...(members
                        ? { members: members.map((member): EntryKey => `inspection:${member}`) }
                        : {}),
                }),
            hold: async (seq) => {
                held.add(seq)
                // Evict cached endpoints through the real LRU without replacing the active source.
                await Promise.all(
                    Array.from({ length: peek.PEEK_LRU + 1 }, (_, index) => {
                        const filler = 100 + index
                        states.set(filler, before)
                        return peek.loadEntryState(`inspection:${filler}`)
                    }),
                )
            },
            release: (seq, fail = false) => {
                const release = releases.get(seq)
                if (!release) throw new Error(`No held load for ${seq}`)
                releases.delete(seq)
                release(fail)
            },
            unchanged: () =>
                history.liveState.value === live && settings.dimUnchangedObjects === defaultEdits,
        }
        window.historyInspectionTest.select(1)
    }, mode)
    await expect(page.locator('[data-property-summary]')).toBeVisible()
}

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Property Changes', exact: true })
const row = (page: Page, field: string) =>
    dialog(page).locator(`[data-property-row="${field}"]`).first()
const select = (page: Page, seq: number, previous = 0, members?: number[]) =>
    page.evaluate(
        ({ seq, previous, members }) => window.historyInspectionTest.select(seq, previous, members),
        { seq, previous, members },
    )
const forcePane = async (page: Page, width: number) => {
    await page.locator('.chart-pane').evaluate((pane, width) => {
        pane.style.flex = `0 0 ${width}px`
        pane.style.width = `${width}px`
    }, width)
    await expect.poll(() => page.evaluate(() => window.editorTest.view.w)).toBe(width)
}
const open = async (page: Page) => {
    await page.locator('[data-property-summary]').click()
    await expect(dialog(page)).toBeVisible()
    await expect(dialog(page).locator('[data-property-row]').first()).toBeVisible()
}

const seedSpatial = async (page: Page, total = 2) => {
    await seed(page)
    await page.locator('[data-peek-back]').click()
    await page.evaluate(async (total) => {
        const { appImport, fixtures, settings, view } = window.editorTest
        const { createState } =
            await appImport<typeof import('../../src/state')>('/src/state/index.ts')
        const chart = structuredClone(fixtures.notes)
        const template = chart.slides[0]![0]!
        chart.slides = Array.from({ length: total }, (_, index) => [
            { ...template, beat: index % 2 ? 60 : 10, left: (index % 6) - 3, size: 1 },
        ])
        const after = structuredClone(chart)
        for (const slide of after.slides) slide[0]!.isCritical = !slide[0]!.isCritical
        after.initialLife++
        const fixture = window.historyInspectionTest
        const before = createState(chart, 0)
        fixture.states.set(0, before)
        fixture.states.set(1, createState(after, 0))
        fixture.states.set(3, before)
        fixture.refresh()
        view.layout = 'basic'
        view.time = 15
        view.lane = 0
        settings.pps = 300
        fixture.select(1)
    }, total)
    await expect(page.locator('[data-change-arrow="up"]')).toHaveAttribute('aria-disabled', 'false')
    await expect(page.locator('[data-change-arrow="down"]')).toHaveAttribute(
        'aria-disabled',
        'false',
    )
}

const expectCounts = async (page: Page, counts?: [number, number]) => {
    for (const [index, direction] of ['up', 'down'].entries()) {
        const arrow = page.locator(`[data-change-arrow="${direction}"]`)
        const count = counts?.[index]
        await expect(arrow.locator('.change-count')).toHaveText(
            count === undefined ? '–' : String(count),
        )
        if (count === undefined) {
            await expect(arrow).not.toHaveAttribute('data-count')
            await expect(arrow).toHaveAccessibleName(
                direction === 'up' ? 'Changes Above' : 'Changes Below',
            )
        } else {
            await expect(arrow).toHaveAttribute('data-count', String(count))
            await expect(arrow).toHaveAccessibleName(
                `${direction === 'up' ? 'Changes Above' : 'Changes Below'}: ${count}`,
            )
        }
    }
}

// A control's hit is its box plus the ::before reach (24 px faces keep 32 px hits). The probes sit
// 1 px inside each edge of the hit, centred on the box, and 1 px outside it: inside, the control
// is the target; outside, it is not.
const expectHit = async (control: Locator, width: number, height: number) => {
    const probes = await control.evaluate(
        (element, { width, height }) => {
            const box = element.getBoundingClientRect()
            const x = box.x + box.width / 2
            const y = box.y + box.height / 2
            const owns = (px: number, py: number) => {
                const target = document.elementFromPoint(px, py)
                return !!target && element.contains(target)
            }
            const left = x - width / 2
            const right = x + width / 2
            const top = y - height / 2
            const bottom = y + height / 2
            return {
                inside: [
                    owns(left + 1, y),
                    owns(right - 1, y),
                    owns(x, top + 1),
                    owns(x, bottom - 1),
                ],
                outside: [
                    owns(left - 1, y),
                    owns(right + 1, y),
                    owns(x, top - 1),
                    owns(x, bottom + 1),
                ],
            }
        },
        { width, height },
    )
    expect(probes).toEqual({
        inside: [true, true, true, true],
        outside: [false, false, false, false],
    })
}

// A passive state line fits its slot in every language.
const expectStateLine = async (line: Locator) => {
    expect(await line.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
}

const captureContours = async (page: Page, testInfo: TestInfo, state: string) => {
    const navigation = page.locator('[data-peek-navigation]')
    try {
        for (const radius of [12, 16]) {
            await navigation.evaluate((element, radius) => {
                element.style.borderRadius = `${radius}px`
            }, radius)
            await page.screenshot({
                path: testInfo.outputPath(`bar-${state}-radius${radius}.png`),
                animations: 'disabled',
            })
        }
    } finally {
        await navigation.evaluate((element) => {
            element.style.removeProperty('border-radius')
        })
    }
}

test('navigation retains arrow and count positions when its last target becomes zero', async ({
    page,
}, testInfo) => {
    await seedSpatial(page)
    await expectCounts(page, [1, 1])
    const geometry = () =>
        page.locator('[data-change-arrow]').evaluateAll((arrows) =>
            arrows.map((arrow) => {
                const rect = (element: Element) => {
                    const { x, y, width, height } = element.getBoundingClientRect()
                    return { x, y, width, height }
                }
                return {
                    button: rect(arrow),
                    icon: rect(arrow.querySelector('svg')!),
                    count: rect(arrow.querySelector('span')!),
                }
            }),
        )
    const before = await geometry()
    const up = page.locator('[data-change-arrow="up"]')
    await up.focus()
    await page.keyboard.press('Enter')
    await expect(up).toHaveAttribute('data-count', '0')
    await expect(up.locator('.change-count')).toHaveText('0')
    await expect(up).toHaveAttribute('aria-disabled', 'true')
    await expect(up).toBeFocused()
    expect(await geometry()).toEqual(before)
    await expect.poll(() => page.evaluate(() => !!window.editorTest.view.scrollingY)).toBe(false)
    const position = () =>
        page.evaluate(() => ({
            time: window.editorTest.view.time,
            lane: window.editorTest.view.lane,
        }))
    const atLast = await position()
    for (const key of ['Enter', 'Space']) {
        await page.keyboard.press(key)
        expect(await position()).toEqual(atLast)
    }
    await page.evaluate(async () => {
        const { changeBand } = await window.editorTest.appImport<
            typeof import('../../src/editor/history/changes')
        >('/src/editor/history/changes.ts')
        changeBand.value = { top: window.editorTest.view.h, bottom: 1 }
    })
    await expectCounts(page)
    for (const direction of ['up', 'down'])
        await expect(page.locator(`[data-change-arrow="${direction}"]`)).toHaveAttribute(
            'aria-disabled',
            'true',
        )
    await page.keyboard.press('Enter')
    expect(await position()).toEqual(atLast)
    expect(await geometry()).toEqual(before)
    await captureContours(page, testInfo, 'covered')
})

test('omitted counts retain real spatial navigation and fixed dash slots', async ({ page }) => {
    await seedSpatial(page, 170)
    await expectCounts(page)
    const up = page.locator('[data-change-arrow="up"]')
    await expect(up).toHaveAttribute('aria-disabled', 'false')
    const before = await page.evaluate(() => window.editorTest.view.time)
    await up.click()
    await expect.poll(() => page.evaluate(() => window.editorTest.view.time)).not.toBe(before)
    await expectCounts(page)
})

for (const scenario of [
    { width: 320, height: 568, locale: 'fr' },
    { width: 390, height: 844, locale: 'ko' },
    { width: 1440, height: 900, locale: 'fr' },
] as const) {
    test(`paired bar contours at ${scenario.width} ${scenario.locale}`, async ({
        page,
    }, testInfo) => {
        await page.setViewportSize({ width: scenario.width, height: scenario.height })
        await seedSpatial(page)
        await page.evaluate((locale) => {
            window.editorTest.settings.locale = locale
        }, scenario.locale)
        const prefix = `${scenario.width}-${scenario.locale}`
        await captureContours(page, testInfo, `${prefix}-positive`)
        const up = page.locator('[data-change-arrow="up"]')
        await up.focus()
        await page.keyboard.press('Enter')
        await expect(up).toHaveAttribute('data-count', '0')
        await expect
            .poll(() => page.evaluate(() => !!window.editorTest.view.scrollingY))
            .toBe(false)
        await page.locator('[data-change-arrow="down"]').hover()
        await captureContours(page, testInfo, `${prefix}-zero`)
        await page.locator('[data-show-edits]').click()
        await expect(page.locator('[data-show-edits]')).toHaveAttribute('aria-pressed', 'false')
        await captureContours(page, testInfo, `${prefix}-off`)
        await page.evaluate(() => window.historyInspectionTest.hold(2))
        await select(page, 2, 1)
        await expect(page.locator('[data-change-arrow="up"] .change-count')).toHaveText('–')
        await expect(page.locator('[data-peek-change]')).not.toHaveText('')
        await captureContours(page, testInfo, `${prefix}-loading`)
        await page.evaluate(() => window.historyInspectionTest.release(2))
    })
}

for (const hasTouch of [false, true]) {
    test.describe(`short bar composition ${hasTouch ? 'coarse' : 'fine'}`, () => {
        test.use({ hasTouch })
        test('keeps the same height and gap', async ({ page }, testInfo) => {
            await page.setViewportSize({ width: 520, height: 320 })
            await seedSpatial(page)
            const geometry = await page.locator('[data-peek-navigation]').evaluate((element) => {
                const bar = element.getBoundingClientRect()
                const main = document.querySelector('[data-peek-main]')!.getBoundingClientRect()
                return {
                    height: bar.height,
                    gap: bar.top - main.bottom,
                    stack: bar.bottom - main.top,
                }
            })
            expect(geometry).toEqual({ height: 32, gap: 8, stack: 84 })
            await captureContours(page, testInfo, `short-${hasTouch ? 'coarse' : 'fine'}`)
        })
    })
}

test('an added or removed entry shows its one value per row, under a singular folder label', async ({
    page,
}, testInfo) => {
    await seed(page, 'folders')
    await open(page)
    const added = dialog(page).locator('[data-property-section="groupFolders:500"]')
    await expect(added.locator('h3 > span').first()).toHaveText('Group Folder')
    await expect(added.locator('[data-property-badge]')).toHaveText('Added')
    await expect(added.locator('[data-property-row]')).toHaveCount(2)
    await expect(added.locator('[data-property-after]')).toHaveCount(2)
    await expect(added.locator('[data-property-before]')).toHaveCount(0)
    await expect(added.locator('[data-property-row="name"] [data-property-value]')).toHaveText(
        'Added folder',
    )
    const removed = dialog(page).locator('[data-property-section="stageFolders:600"]')
    await expect(removed.locator('h3 > span').first()).toHaveText('Stage Folder')
    await expect(removed.locator('[data-property-badge]')).toHaveText('Removed')
    await expect(removed.locator('[data-property-before]')).toHaveCount(2)
    await expect(removed.locator('[data-property-after]')).toHaveCount(0)
    // The empty side is not spelled out, and no Before or After caption stands over one value.
    await expect(dialog(page)).not.toContainText('Not present')
    await expect(added.getByText(/^(Before|After)$/)).toHaveCount(0)
    await expect(removed.getByText(/^(Before|After)$/)).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('property-one-sided.png') })
})

test('an unset value reads Not set, a file with an offset change is not badged, and no name carries an id', async ({
    page,
}) => {
    await seed(page, 'groups')
    await open(page)
    // An unset Force Note Speed is Not set, never 0.
    const removed = dialog(page).locator('[data-property-section="groups:1"]')
    await expect(removed.locator('[data-property-badge]')).toHaveText('Removed')
    await expect(
        removed.locator('[data-property-row="forceNoteSpeed"] [data-property-value]'),
    ).toHaveText('Not set')
    const added = dialog(page).locator('[data-property-section="groups:9"]')
    await expect(
        added.locator('[data-property-row="forceNoteSpeed"] [data-property-value]'),
    ).toHaveText('1.5')
    // The removed and the added group are both "Default", with no id after the name.
    await expect(removed.locator('h3')).toHaveText(/^Group Propertiess*Defaults*Removed$/)
    await expect(added.locator('h3')).toHaveText(/^Group Propertiess*Defaults*Added$/)
    await expect(dialog(page)).not.toContainText('(#')
    // The BGM section has a row on both sides, so it carries no badge and keeps the before.
    const bgm = dialog(page).locator('[data-property-section="bgm:all"]')
    await expect(bgm.locator('[data-property-badge]')).toHaveCount(0)
    await expect(
        bgm.locator('[data-property-row="offset"] [data-property-before] [data-property-value]'),
    ).toHaveText('250')
    await expect(
        bgm.locator('[data-property-row="offset"] [data-property-after] [data-property-value]'),
    ).toHaveText('-120')
    // The file has one name, the one Step Details shows: without its extension.
    await expect(
        bgm.locator('[data-property-row="filename"] [data-property-before] [data-property-value]'),
    ).toHaveText('Not set')
    await expect(
        bgm.locator('[data-property-row="filename"] [data-property-after] [data-property-value]'),
    ).toHaveText('Opening theme (final mix)')
    await expect(dialog(page)).not.toContainText('Not present')
})

test('Property Changes titles a group of steps by its title alone, as Step Details does', async ({
    page,
}) => {
    await seed(page)
    await page.locator('[data-show-edits]').click()
    await select(page, 5, 3, [4, 5])
    await open(page)
    const title = dialog(page).locator('[data-property-description]')
    await expect(title).toHaveText('Changed Initial Life')
    // The strip's own label carries the step count; Step Details lists steps under its own heading.
    await expect(dialog(page)).not.toContainText('2 steps')
})

test('a removed media section keeps only its before value, and a placeholder is quieter', async ({
    page,
}) => {
    await seed(page)
    await page.locator('[data-show-edits]').click()
    await select(page, 2, 1)
    await open(page)
    const cover = dialog(page).locator('[data-property-section="cover:all"]')
    await expect(cover.locator('[data-property-badge]')).toHaveText('Removed')
    await expect(cover.locator('[data-property-before]')).not.toHaveCount(0)
    await expect(cover.locator('[data-property-after]')).toHaveCount(0)
    await expect(dialog(page)).not.toContainText('Not present')
    // A tag with an empty title shows Not set in the muted style.
    const empty = row(page, 'tags').locator('[data-property-before] li').nth(1).locator('span')
    await expect(empty).toHaveText('Not set')
    await expect(empty).toHaveClass(/text-fg\/80/)
})

test('property inspection keeps exact chronological values, whitespace and the live chart', async ({
    page,
}, testInfo) => {
    await seed(page)
    await page.locator('[data-show-edits]').click()
    await open(page)
    await expect(dialog(page).locator('[data-property-context]')).toContainText('Imported Metadata')
    await expect(row(page, 'title').locator('[data-property-before]')).toContainText('Before title')
    await expect(row(page, 'title').locator('[data-property-after]')).toContainText('After title')
    await expect(
        row(page, 'offset').locator('[data-property-before] [data-property-value]'),
    ).toHaveText('0.0001')
    await expect(
        row(page, 'offset').locator('[data-property-after] [data-property-value]'),
    ).toHaveText('0.0002')
    await expect(
        row(page, 'rating').locator('[data-property-before] [data-property-value]'),
    ).toHaveText('1.0000001')
    await expect(
        row(page, 'rating').locator('[data-property-after] [data-property-value]'),
    ).toHaveText('1.0000002')
    expect(
        await row(page, 'description')
            .locator('[data-property-after] [data-property-value]')
            .textContent(),
    ).toBe('  changed\n\nlast  ')
    await expect(row(page, 'size').locator('[data-property-after]')).toContainText('1,025 byte')
    await expect(row(page, 'duration').locator('[data-property-after]')).toContainText('1,235 ms')
    await expect(dialog(page).locator('[data-property-badge]')).toHaveText('Added')
    await expect(dialog(page).locator('input, textarea, select, audio, video')).toHaveCount(0)
    await expect(dialog(page).getByRole('button', { name: /Restore|Apply/ })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('property-inspection.png') })
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)
    await expect(page.locator('[data-property-summary]')).toBeFocused()
    await expect(page.locator('[data-show-edits]')).toHaveAttribute('aria-pressed', 'false')
    expect(await page.evaluate(() => window.historyInspectionTest.unchanged())).toBe(true)
    await page.setViewportSize({ width: 520, height: 320 })
    await forcePane(page, 520)
    await open(page)
    const shortBounds = await dialog(page).boundingBox()
    expect(shortBounds!.y).toBeGreaterThanOrEqual(0)
    expect(shortBounds!.y + shortBounds!.height).toBeLessThanOrEqual(320)
    await expect(dialog(page).getByRole('button', { name: 'Close', exact: true })).toHaveJSProperty(
        'offsetHeight',
        36,
    )
    await page.screenshot({ path: testInfo.outputPath('property-inspection-short-520x320.png') })
    await page.keyboard.press('Escape')
})

for (const width of [160, 179, 180, 240, 319, 320, 390]) {
    test(`secondary History controls keep exact geometry at pane ${width}`, async ({
        page,
    }, testInfo) => {
        await seed(page)
        await forcePane(page, width)
        const navigation = page.locator('[data-peek-navigation]')
        await expect(navigation).toBeVisible()
        await expectCounts(page, [0, 0])
        const boxes = await navigation.evaluate((element) => {
            const box = (node: Element) => {
                const { x, y, width, height, right, bottom } = node.getBoundingClientRect()
                return { x, y, width, height, right, bottom }
            }
            return {
                row: box(element),
                pane: box(element.closest('.chart-pane')!),
                main: box(document.querySelector('[data-peek-main]')!),
                controls: [...element.querySelectorAll('button')].map(box),
            }
        })
        expect(boxes.row.height).toBe(32)
        // The capsule is the strip less 12 px, centred under it; the strip's width is the fit's.
        expect(boxes.row.width).toBe(boxes.main.width - 12)
        expect(boxes.row.x - boxes.main.x).toBe(6)
        expect(boxes.row.width).toBeLessThanOrEqual(Math.min(480, width - 16) - 12)
        expect(boxes.row.y - boxes.main.bottom).toBe(8)
        // Every face is 24 px high, 4 px in from the capsule's edge.
        for (const box of boxes.controls) {
            expect(box.height).toBe(24)
            expect(box.y - boxes.row.y).toBe(4)
            expect(box.x).toBeGreaterThanOrEqual(boxes.pane.x)
            expect(box.right).toBeLessThanOrEqual(boxes.pane.right)
        }
        for (let index = 1; index < boxes.controls.length; index++)
            expect(boxes.controls[index]!.x).toBeGreaterThanOrEqual(
                boxes.controls[index - 1]!.right,
            )
        // An arrow's 24 px high button holds its 24 px face and the count; its hit reaches 4 px
        // past it (2 px at the sides when narrow).
        const arrowWidth = width < 180 ? 44 : 48
        for (const arrow of boxes.controls.slice(-2)) expect(arrow.width).toBe(arrowWidth)
        for (const direction of ['up', 'down'])
            await expectHit(
                page.locator(`[data-change-arrow="${direction}"]`),
                arrowWidth + (width < 180 ? 4 : 8),
                32,
            )
        expect(boxes.controls.at(-1)!.right - boxes.controls.at(-2)!.right).toBe(
            width < 180 ? 48 : 56,
        )
        expect(boxes.row.right - boxes.controls.at(-1)!.right).toBe(4)
        expect(boxes.controls[0]!.width).toBe(24)
        await expectHit(page.locator('[data-show-edits], [data-change-options]'), 32, 32)
        if (width < 320) {
            await expect(page.locator('[data-show-edits], [data-property-summary]')).toHaveCount(0)
        } else {
            await expect(page.locator('[data-change-options]')).toHaveCount(0)
            await expectHit(
                page.locator('[data-property-summary]'),
                boxes.controls[1]!.width + 8,
                32,
            )
            // The summary hugs its words: its padding, the words, the gap and the 12 px chevron.
            const parts = await page.locator('[data-property-summary]').evaluate((summary) => {
                const style = getComputedStyle(summary)
                const words = summary.querySelector('[data-peek-change]')!.getBoundingClientRect()
                const chevron = summary.querySelector('svg')!.getBoundingClientRect()
                return {
                    width: summary.getBoundingClientRect().width,
                    content:
                        parseFloat(style.paddingLeft) +
                        words.width +
                        parseFloat(style.columnGap) +
                        chevron.width +
                        parseFloat(style.paddingRight),
                    chevron: chevron.width,
                    cut: summary.querySelector('[data-peek-change]')!.scrollWidth,
                    room: summary.querySelector('[data-peek-change]')!.clientWidth,
                }
            })
            expect(parts.width).toBeCloseTo(parts.content, 1)
            expect(parts.chevron).toBe(12)
            expect(parts.cut).toBeLessThanOrEqual(parts.room)
        }
        const styles = await navigation.evaluate((element) => {
            const style = getComputedStyle(element)
            const glyph = element.querySelector('[data-change-arrow] svg')!
            // The chevron's ink is centred on its 24 px face, both ways.
            const inkOffsets = [
                ...element.querySelectorAll<SVGPathElement>('[data-change-arrow] path'),
            ].flatMap((path) => {
                const bounds = path.getBBox()
                const centre = new DOMPoint(
                    bounds.x + bounds.width / 2,
                    bounds.y + bounds.height / 2,
                ).matrixTransform(path.getScreenCTM()!)
                const face = path.closest('.change-face')!.getBoundingClientRect()
                return [centre.x - face.x - face.width / 2, centre.y - face.y - face.height / 2]
            })
            const faces = [...element.querySelectorAll('[data-change-arrow]')].map((arrow) => {
                const button = arrow.getBoundingClientRect()
                const face = arrow.querySelector('.change-face')!.getBoundingClientRect()
                const count = arrow.querySelector('.change-count')!.getBoundingClientRect()
                return {
                    width: face.width,
                    height: face.height,
                    x: face.x - button.x,
                    y: face.y - button.y,
                    countAfterFace: count.x >= face.right,
                    countInside: count.right <= button.right,
                }
            })
            // The round control is its own 24 px face; its hit is the ::before.
            const roundControl = element.querySelector('[data-show-edits], [data-change-options]')!
            const face = roundControl.getBoundingClientRect()
            const hit = element.getBoundingClientRect()
            const controlStyles = [
                ...element.querySelectorAll('[data-change-arrow], [data-property-summary]'),
            ].map((control) => {
                const style = getComputedStyle(control)
                return {
                    background: style.backgroundColor,
                    shadow: style.boxShadow,
                    opacity: style.opacity,
                }
            })
            const gapTarget = document.elementFromPoint(
                element.getBoundingClientRect().x + 2,
                element.getBoundingClientRect().y - 4,
            )
            // The hits reach the capsule's edge: a press 2 px in belongs to the strip, never the chart.
            const edgeTarget = document.elementFromPoint(
                element.getBoundingClientRect().x + 2,
                element.getBoundingClientRect().y + 16,
            )
            return {
                radius: style.borderRadius,
                padding: style.paddingLeft,
                font: style.fontSize,
                background: style.backgroundColor,
                glyph: glyph.getBoundingClientRect().width,
                inkOffsets,
                faces,
                face: {
                    width: face.width,
                    height: face.height,
                    x: face.x - hit.x,
                    y: face.y - hit.y,
                },
                controls: controlStyles,
                gapIsChart: !!gapTarget?.closest('.editor'),
                edgeIsStrip:
                    !!edgeTarget &&
                    element.contains(edgeTarget) &&
                    edgeTarget.closest('button') !== null,
            }
        })
        expect(styles).toMatchObject({
            // rounded-full: a pill, the 16 px half-height of the 32 px capsule.
            radius: '9999px',
            padding: '4px',
            font: '12px',
            glyph: 12,
            gapIsChart: true,
            edgeIsStrip: true,
            face: { width: 24, height: 24, x: 4, y: 4 },
        })
        for (const offset of styles.inkOffsets) expect(Math.abs(offset)).toBeLessThan(0.1)
        expect(styles.faces).toEqual(
            Array.from({ length: 2 }, () => ({
                width: 24,
                height: 24,
                x: 0,
                y: 0,
                countAfterFace: true,
                countInside: true,
            })),
        )
        expect(styles.background).not.toBe('rgba(0, 0, 0, 0)')
        for (const style of styles.controls)
            expect(style).toEqual({ background: 'rgba(0, 0, 0, 0)', shadow: 'none', opacity: '1' })
        const beforePress = await page.evaluate(() => ({
            state: window.editorTest.snapshot(),
            time: window.editorTest.view.time,
            lane: window.editorTest.view.lane,
        }))
        // The hits fill the strip's padding, so a press on the strip itself needs a point no hit
        // covers: the room beside the summary or between the options and the arrows. The 320 pane's
        // hits abut, leaving none; its edge probe above still shows the strip owns the press.
        const free = await navigation.evaluate((element) => {
            const row = element.getBoundingClientRect()
            for (let x = 0; x < row.width; x++)
                if (document.elementFromPoint(row.x + x, row.y + 16) === element) return x
            return undefined
        })
        if (width !== 320) expect(free).toBeDefined()
        if (free !== undefined) {
            await navigation.click({ position: { x: free, y: 16 } })
            expect(
                await page.evaluate(() => ({
                    state: window.editorTest.snapshot(),
                    time: window.editorTest.view.time,
                    lane: window.editorTest.view.lane,
                })),
            ).toEqual(beforePress)
        }
        await page.screenshot({ path: testInfo.outputPath(`navigation-${width}.png`) })
        if (width < 320) {
            await page.locator('[data-change-options]').click()
            await expect(page.locator('[data-change-options-menu]')).toBeVisible()
            await page.screenshot({ path: testInfo.outputPath(`navigation-menu-${width}.png`) })
            await page.keyboard.press('Escape')
        }
        if (width === 160) await captureContours(page, testInfo, 'tiny160')
        if (width === 180) {
            await page.evaluate(() => {
                window.editorTest.settings.theme = 'dark'
            })
            await captureContours(page, testInfo, 'tiny180-dark')
        }
    })
}

test('the opaque navigation spacer owns wheel input while the transparent gap scrolls the chart', async ({
    page,
}) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await seed(page)
    await page.evaluate(() => {
        window.editorTest.settings.mouseSmoothScrolling = false
        window.editorTest.view.time = 10
        document.documentElement.dataset.historyWheelCount = '0'
        document.addEventListener(
            'wheel',
            () => {
                const data = document.documentElement.dataset
                data.historyWheelCount = String(Number(data.historyWheelCount) + 1)
            },
            { capture: true },
        )
    })
    const navigation = (await page.locator('[data-peek-navigation]').boundingBox())!
    const before = await page.evaluate(() => window.editorTest.view.time)
    await page.mouse.move(navigation.x + 2, navigation.y + 16)
    await page.mouse.wheel(0, 120)
    await expect(page.locator('html')).toHaveAttribute('data-history-wheel-count', '1')
    expect(await page.evaluate(() => window.editorTest.view.time)).toBe(before)
    await page.mouse.move(navigation.x + 2, navigation.y - 4)
    await page.mouse.wheel(0, 120)
    await expect(page.locator('html')).toHaveAttribute('data-history-wheel-count', '2')
    await expect.poll(() => page.evaluate(() => window.editorTest.view.time)).not.toBe(before)
    expect(await page.evaluate(() => window.historyInspectionTest.unchanged())).toBe(true)
})

test('full-app phone and desktop composition keeps passive states in the same strip', async ({
    page,
}, testInfo) => {
    await seed(page)
    for (const size of [
        { width: 320, height: 568 },
        { width: 390, height: 844 },
        { width: 1440, height: 900 },
    ]) {
        await page.setViewportSize(size)
        await select(page, 1)
        await expect(page.locator('[data-property-summary]')).toBeVisible()
        await expectCounts(page, [0, 0])
        const navigation = page.locator('[data-peek-navigation]')
        await expect
            .poll(() =>
                page.evaluate(async () => {
                    const { workspaceSize } = await window.editorTest.appImport<
                        typeof import('../../src/editor/workspace')
                    >('/src/editor/workspace/index.ts')
                    const pane = document.querySelector('.chart-pane')!.getBoundingClientRect()
                    const strip = document
                        .querySelector('[data-peek-navigation]')!
                        .getBoundingClientRect()
                    const { view } = window.editorTest
                    return (
                        workspaceSize.value.width === innerWidth &&
                        view.x === pane.x &&
                        view.y === pane.y &&
                        view.w === pane.width &&
                        view.h === pane.height &&
                        // The capsule is the main strip less 12 px, within the pane's 16 px margin.
                        strip.width ===
                            document.querySelector('[data-peek-main]')!.getBoundingClientRect()
                                .width -
                                12 &&
                        strip.width <= Math.min(480, pane.width - 16) - 12
                    )
                }),
            )
            .toBe(true)
        const geometry = await navigation.boundingBox()
        expect(geometry!.height).toBe(32)
        await page.screenshot({
            path: testInfo.outputPath(`composition-property-${size.width}.png`),
        })
        await select(page, 3)
        await expect(page.locator('[data-peek-change]')).toHaveText('No changes')
        await expectCounts(page, [0, 0])
        await expect(page.locator('[data-property-summary]')).toHaveCount(0)
        expect(await navigation.boundingBox()).toEqual(geometry)
        await page.screenshot({
            path: testInfo.outputPath(`composition-no-change-${size.width}.png`),
        })
        await page.evaluate(async () => {
            const { requestPeek } = await window.editorTest.appImport<
                typeof import('../../src/editor/history/selection')
            >('/src/editor/history/selection.ts')
            const { captureOperationRecipe } = await window.editorTest.appImport<
                typeof import('../../src/history/operationPresentation')
            >('/src/history/operationPresentation/index.ts')
            requestPeek({
                key: 'inspection:0',
                time: 1_720_000_000_000,
                recipe: captureOperationRecipe([
                    {
                        description: {
                            kind: 'init',
                            operation: window.editorTest.historySteps.futureFixtureOperation(
                                'inspection-origin',
                                {},
                                'Initial state',
                            ),
                        },
                        time: 1_720_000_000_000,
                        id: 'inspection:0',
                    },
                ]),
                initial: true,
            })
        })
        await expect(page.locator('[data-peek-change]')).toHaveText('Initial state')
        await expectCounts(page)
        expect(await navigation.boundingBox()).toEqual(geometry)
        await page.screenshot({
            path: testInfo.outputPath(`composition-initial-${size.width}.png`),
        })
    }
})

test('tiny menu takes keyboard focus, holds browser keys and restores its opener', async ({
    page,
}) => {
    await seed(page)
    await forcePane(page, 240)
    const opener = page.locator('[data-change-options]')
    await opener.focus()
    await page.keyboard.press('ArrowDown')
    const menu = page.getByRole('menu', { name: 'Options for Changes', exact: true })
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Show Edits' })).toBeFocused()
    await menu.evaluate((element) => {
        window.historyMenuKeys = []
        element.addEventListener('keydown', (event) => {
            const key = event as KeyboardEvent
            window.historyMenuKeys.push({
                key: key.key,
                ctrl: key.ctrlKey,
                meta: key.metaKey,
                prevented: key.defaultPrevented,
            })
        })
    })
    await page.keyboard.press('Control+s')
    await page.keyboard.press('Meta+s')
    await page.keyboard.press('x')
    expect(await page.evaluate(() => window.historyMenuKeys)).toEqual(
        expect.arrayContaining([
            { key: 's', ctrl: true, meta: false, prevented: true },
            { key: 's', ctrl: false, meta: true, prevented: true },
            { key: 'x', ctrl: false, meta: false, prevented: true },
        ]),
    )
    await page.keyboard.press('End')
    await expect(menu.getByRole('menuitem', { name: 'View Property Changes' })).toBeFocused()
    await page.keyboard.press('Home')
    await expect(menu.getByRole('menuitemcheckbox')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(opener).toBeFocused()
    expect(await page.evaluate(() => window.historyInspectionTest.unchanged())).toBe(true)
})

test('outside menu press only dismisses before Back to Now can act', async ({ page }) => {
    await seed(page)
    await forcePane(page, 240)
    await page.locator('[data-change-options]').click()
    await expect(page.locator('[data-change-options-menu]')).toBeVisible()
    const time = await page.evaluate(() => window.editorTest.view.time)
    await page.locator('[data-peek-back]').click()
    await expect(page.locator('[data-change-options-menu]')).toHaveCount(0)
    await expect(page.locator('[data-peek-main]')).toBeVisible()
    expect(await page.evaluate(() => window.editorTest.view.time)).toBe(time)
    expect(await page.evaluate(() => window.historyInspectionTest.unchanged())).toBe(true)
    await page.locator('[data-peek-back]').click()
    await expect(page.locator('[data-peek-main]')).toHaveCount(0)
})

test('local Show Edits survives selection and groups, and the next peek keeps it until the setting changes', async ({
    page,
}) => {
    await seed(page)
    const eye = page.locator('[data-show-edits]')
    await eye.click()
    await expect(eye).toHaveAttribute('aria-pressed', 'false')
    await select(page, 2, 1)
    await expect(page.locator('[data-peek-change]')).toHaveText('Undo · Imported Metadata')
    await expect(eye).toHaveAttribute('aria-pressed', 'false')
    await open(page)
    await expect(row(page, 'title').locator('[data-property-before]')).toContainText('After title')
    await expect(row(page, 'title').locator('[data-property-after]')).toContainText('Before title')
    await page.keyboard.press('Escape')
    await select(page, 6, 3, [4, 5, 6])
    await expect(page.locator('[data-peek-change]')).toHaveText('No changes')
    await expect(page.locator('[data-property-summary]')).toHaveCount(0)
    await expect(eye).toHaveAttribute('aria-pressed', 'false')
    await page.locator('[data-peek-back]').click()
    await select(page, 1)
    await expect(eye).toHaveAttribute('aria-pressed', 'false')
    // A changed setting gives the next peek its default.
    await page.locator('[data-peek-back]').click()
    await page.evaluate(() => {
        window.editorTest.settings.dimUnchangedObjects = false
        window.editorTest.settings.dimUnchangedObjects = true
    })
    await select(page, 1)
    await expect(eye).toHaveAttribute('aria-pressed', 'true')
    expect(await page.evaluate(() => window.historyInspectionTest.unchanged())).toBe(true)
})

test('pending comparison keeps the fixed row and an explicit Off choice after settlement', async ({
    page,
}) => {
    await seed(page)
    await forcePane(page, 320)
    const bounds = async () => ({
        main: await page.locator('[data-peek-main]').boundingBox(),
        navigation: await page.locator('[data-peek-navigation]').boundingBox(),
        arrows: await page.locator('[data-change-arrow]').evaluateAll((elements) =>
            elements.map((element) => {
                const { x, y, width, height } = element.getBoundingClientRect()
                return { x, y, width, height }
            }),
        ),
    })
    const before = await bounds()
    await page.locator('[data-show-edits]').click()
    await expect(page.locator('[data-show-edits]')).toHaveAttribute('aria-pressed', 'false')
    await page.evaluate(() => window.historyInspectionTest.hold(2))
    await select(page, 2, 1)
    await expect(page.locator('[data-peek-change]')).toHaveText('Loading…')
    await expectCounts(page)
    await expect(page.locator('[data-peek-change]').locator('..')).toHaveAccessibleName(
        'Loading changes…',
    )
    expect(await bounds()).toEqual(before)
    await expect(page.locator('[data-property-summary]')).toHaveCount(0)
    await expect(page.locator('[data-show-edits]')).toHaveAttribute('aria-pressed', 'false')
    expect(
        await page.evaluate(async () => {
            const changes = await window.editorTest.appImport<
                typeof import('../../src/editor/history/changes')
            >('/src/editor/history/changes.ts')
            return { marks: changes.changeMarks.value, dim: changes.undimmed.value }
        }),
    ).toEqual({ marks: undefined, dim: undefined })
    await page.evaluate(() => window.historyInspectionTest.release(2))
    await expect(page.locator('[data-peek-change]')).toHaveText('Undo · Imported Metadata')
    await expect(page.locator('[data-property-summary]')).toBeVisible()
    await expectCounts(page, [0, 0])
    expect(await bounds()).toEqual(before)
    await expect(page.locator('[data-show-edits]')).toHaveAttribute('aria-pressed', 'false')
})

test('property rows and tag lists disclose exactly 100 items at a time', async ({ page }) => {
    await seed(page, 'rows')
    await open(page)
    await expect(dialog(page).locator('[data-property-row]')).toHaveCount(100)
    await expect(dialog(page).locator('[data-property-count]')).toContainText('Properties: 100/150')
    await expect(dialog(page).getByText('Historical group 150', { exact: true })).toHaveCount(0)
    await dialog(page).locator('[data-property-more]').click()
    await expect(dialog(page).locator('[data-property-row]')).toHaveCount(150)
    // The count is shown only while more remain.
    await expect(dialog(page).locator('[data-property-count]')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await page.locator('[data-peek-back]').click()
    await seed(page, 'items')
    await open(page)
    const tags = row(page, 'tags').locator('[data-property-after]')
    await expect(tags.locator('[data-property-items] > li')).toHaveCount(100)
    await expect(tags).toContainText('Items: 100/205')
    await expect(tags.getByText('Historical tag 205', { exact: true })).toHaveCount(0)
    await tags.locator('[data-property-items-more]').click()
    await expect(tags.locator('[data-property-items] > li')).toHaveCount(200)
    await tags.locator('[data-property-items-more]').click()
    await expect(tags.locator('[data-property-items] > li')).toHaveCount(205)
    await expect(tags.locator('[data-property-items-count]')).toHaveCount(0)
    await expect(tags.locator('[data-property-items-more]')).toHaveCount(0)
})

test('selection invalidates an open inspection without retargeting old values or focus', async ({
    page,
}, testInfo) => {
    await seed(page)
    await open(page)
    await select(page, 2, 1)
    await expect(dialog(page)).toHaveCount(0)
    await expect(page.locator('[data-peek-change]')).toHaveText('Undo · Imported Metadata')
    await page.screenshot({ path: testInfo.outputPath('selection-closed-inspection.png') })
    await open(page)
    await expect(row(page, 'title').locator('[data-property-after]')).toContainText('Before title')
    await page.evaluate(async () => {
        const { backToNow } = await window.editorTest.appImport<
            typeof import('../../src/editor/history/selection')
        >('/src/editor/history/selection.ts')
        backToNow()
    })
    await expect(dialog(page)).toHaveCount(0)
    await expect(page.locator('[data-peek-main]')).toHaveCount(0)
    expect(await page.evaluate(() => window.historyInspectionTest.unchanged())).toBe(true)
})

for (const outcome of ['resolve', 'unavailable', 'superseded'] as const) {
    test(`inspection delayed predecessor ${outcome} keeps the captured request`, async ({
        page,
    }, testInfo) => {
        await seed(page)
        await page.evaluate(() => window.historyInspectionTest.hold(0))
        await page.locator('[data-property-summary]').click()
        await expect(dialog(page)).toBeVisible()
        await expect
            .poll(() => page.evaluate(() => window.historyInspectionTest.pending.has(0)))
            .toBe(true)
        await expect(dialog(page).locator('[data-property-comparison]')).toHaveText(
            'Loading changes…',
        )
        await expect(dialog(page).locator('[data-property-row]')).toHaveCount(0)
        if (outcome === 'superseded') {
            await select(page, 2, 1)
            await expect(dialog(page)).toHaveCount(0)
            await page.evaluate(async () => {
                const { showChoice } =
                    await window.editorTest.appImport<typeof import('../../src/modals/choice')>(
                        '/src/modals/choice.ts',
                    )
                void showChoice({
                    title: () => 'Newer dialog',
                    choices: [{ value: 'keep', label: () => 'Keep Focus', default: true }],
                })
            })
            await expect(
                page.getByRole('button', { name: 'Keep Focus', exact: true }),
            ).toBeFocused()
        }
        await page.evaluate(
            (fail) => window.historyInspectionTest.release(0, fail),
            outcome === 'unavailable',
        )
        if (outcome === 'resolve') {
            await expect(row(page, 'title').locator('[data-property-after]')).toContainText(
                'After title',
            )
        } else if (outcome === 'unavailable') {
            await expect(dialog(page).locator('[data-property-comparison]')).toHaveText(
                'Changes unavailable',
            )
        } else {
            await expect(page.locator('[data-peek-change]')).toHaveText('Undo · Imported Metadata')
            await expect(dialog(page)).toHaveCount(0)
            await expect(
                page.getByRole('button', { name: 'Keep Focus', exact: true }),
            ).toBeFocused()
            await page.screenshot({ path: testInfo.outputPath('newer-dialog-retains-focus.png') })
        }
    })
}

test('inspection close restores the current visible opener after a pane resize', async ({
    page,
}, testInfo) => {
    await seed(page)
    await open(page)
    await forcePane(page, 240)
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-change-options]')).toBeFocused()
    await page.locator('[data-change-options]').click()
    await page.getByRole('menuitem', { name: 'View Property Changes' }).click()
    await expect(dialog(page)).toBeVisible()
    await forcePane(page, 320)
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-property-summary]')).toBeFocused()
    await page.screenshot({ path: testInfo.outputPath('resized-inspection-focus.png') })
})

test('a chart reset closes inspection and cannot leave focus in a removed control', async ({
    page,
}, testInfo) => {
    await seed(page)
    await open(page)
    await page.evaluate(() => {
        const { history, fixtures } = window.editorTest
        history.resetState(false, structuredClone(fixtures.notes), 0)
    })
    await expect(dialog(page)).toHaveCount(0)
    await expect(page.locator('[data-peek-main]')).toHaveCount(0)
    expect(
        await page.evaluate(() => {
            const active = document.activeElement
            return (
                !!active?.isConnected &&
                (active === document.body || !!active.getClientRects().length)
            )
        }),
    ).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('reset-closed-inspection.png') })
})

test('cached header-only comparison waits for its actual displayed entry', async ({ page }) => {
    await page.clock.install()
    await page.clock.pauseAt(new Date(Date.now() + 60_000))
    await page.evaluate(async () => {
        const { appImport, history } = window.editorTest
        const [peek, selection, changes] = await Promise.all([
            appImport<typeof import('../../src/history/peek')>('/src/history/peek.ts'),
            appImport<typeof import('../../src/editor/history/selection')>(
                '/src/editor/history/selection.ts',
            ),
            appImport<typeof import('../../src/editor/history/changes')>(
                '/src/editor/history/changes.ts',
            ),
        ])
        const base = { ...history.liveState.value, initialLife: 1000 }
        const a = { ...base, initialLife: 1100 }
        const b = { ...base, initialLife: 1200 }
        const states = new Map<EntryKey, State>([
            ['readiness:0', base],
            ['readiness:1', a],
            ['readiness:2', b],
        ])
        peek.setPeekSource({
            sameSnapshot: (left, right) => left === right,
            load: async (key) => ({ state: states.get(key)!, time: 1_720_000_000_000 }),
        })
        await Promise.all([...states.keys()].map(peek.loadEntryState))
        const { captureOperationRecipe } = await appImport<
            typeof import('../../src/history/operationPresentation')
        >('/src/history/operationPresentation/index.ts')
        selection.requestPeek({
            key: 'readiness:1',
            previous: { key: 'readiness:0' },
            recipe: captureOperationRecipe([
                {
                    description: {
                        kind: 'edit',
                        step: window.editorTest.historySteps.editStep(
                            window.editorTest.historySteps.futureInitialLife(
                                1000,
                                1100,
                                'Header A',
                            ),
                        ),
                    },
                    time: 1_720_000_000_001,
                    id: 'readiness:1',
                },
            ]),
            time: 1_720_000_000_001,
        })
        await Promise.resolve()
        await Promise.resolve()
        changes.closePropertyInspection()
    })
    await expect
        .poll(() =>
            page.evaluate(async () => {
                const peek =
                    await window.editorTest.appImport<typeof import('../../src/history/peek')>(
                        '/src/history/peek.ts',
                    )
                const changes = await window.editorTest.appImport<
                    typeof import('../../src/editor/history/changes')
                >('/src/editor/history/changes.ts')
                return {
                    displayed: peek.displayedPeekKey.value,
                    shown: changes.shownChange.value?.key,
                }
            }),
        )
        .toEqual({ displayed: 'readiness:1', shown: 'readiness:1' })
    await page.evaluate(async () => {
        const { requestPeek } = await window.editorTest.appImport<
            typeof import('../../src/editor/history/selection')
        >('/src/editor/history/selection.ts')
        const { captureOperationRecipe } = await window.editorTest.appImport<
            typeof import('../../src/history/operationPresentation')
        >('/src/history/operationPresentation/index.ts')
        requestPeek({
            key: 'readiness:2',
            previous: { key: 'readiness:0' },
            recipe: captureOperationRecipe([
                {
                    description: {
                        kind: 'edit',
                        step: window.editorTest.historySteps.editStep(
                            window.editorTest.historySteps.futureInitialLife(
                                1000,
                                1200,
                                'Header B',
                            ),
                        ),
                    },
                    time: 1_720_000_000_002,
                    id: 'readiness:2',
                },
            ]),
            time: 1_720_000_000_002,
        })
    })
    await expect
        .poll(() =>
            page.evaluate(async () => {
                const { appImport, history } = window.editorTest
                const [peek, changes] = await Promise.all([
                    appImport<typeof import('../../src/history/peek')>('/src/history/peek.ts'),
                    appImport<typeof import('../../src/editor/history/changes')>(
                        '/src/editor/history/changes.ts',
                    ),
                ])
                changes.closePropertyInspection()
                changes.openPropertyInspection()
                return {
                    requested: peek.peekedKey.value,
                    displayed: peek.displayedPeekKey.value,
                    computed: changes.peekChange.value?.key,
                    status: changes.comparisonStatus.value,
                    header: changes.peekChange.value?.set.header,
                    sameStore: history.state.value.store === changes.peekChange.value?.state.store,
                    life: history.state.value.initialLife,
                    shown: changes.shownChange.value?.key,
                    inspectable: changes.canInspectProperties.value,
                    inspection: changes.propertyInspection.value?.status,
                }
            }),
        )
        .toEqual({
            requested: 'readiness:2',
            displayed: 'readiness:1',
            computed: 'readiness:2',
            status: 'known',
            header: true,
            sameStore: true,
            life: 1100,
            shown: undefined,
            inspectable: false,
            inspection: undefined,
        })
    // The bar still shows the displayed step's summary for this quick moment, but nothing can open for B.
    await page.clock.runFor(100)
    await expect(page.locator('[data-property-summary]')).toBeVisible()
    await page.clock.resume()
    await open(page)
    await expect(row(page, 'initialLife').locator('[data-property-before]')).toContainText('1,000')
    await expect(row(page, 'initialLife').locator('[data-property-after]')).toContainText('1,200')
})

for (const locale of ['en', 'fr', 'ja', 'ko', 'tr', 'zhs', 'zht']) {
    const messages = JSON.parse(
        readFileSync(new URL(`../../src/i18n/${locale}/index.json`, import.meta.url), 'utf8'),
    ) as typeof english
    test(`${locale} property labels and exact values wrap in equal phone columns`, async ({
        page,
    }, testInfo) => {
        await seed(page)
        await page.setViewportSize({ width: 320, height: 844 })
        await forcePane(page, 320)
        await page.evaluate((locale) => {
            window.editorTest.settings.locale = locale
        }, locale)
        const opener = page.getByRole('button', { name: messages.historyChanges.view, exact: true })
        await expect(opener).toHaveAccessibleDescription('Imported Metadata')
        await opener.click()
        const modal = page.getByRole('dialog', { name: messages.historyChanges.title, exact: true })
        await expect(modal).toBeVisible()
        const rating = modal.locator('[data-property-row="rating"]')
        await expect(rating.getByRole('heading')).toHaveText(messages.historyChanges.fields.rating)
        await expect(rating.locator('[data-property-before] > p')).toHaveText(
            messages.historyChanges.before,
        )
        await expect(rating.locator('[data-property-after] > p')).toHaveText(
            messages.historyChanges.after,
        )
        await expect(rating.locator('[data-property-after] [data-property-value]')).toHaveText(
            ['fr', 'tr'].includes(locale) ? '1,0000002' : '1.0000002',
        )
        const tags = modal.locator('[data-property-row="tags"] [data-property-before]')
        // An empty title reads Not set; a title of spaces is kept as it is.
        await expect(tags.locator('li').nth(1)).toHaveText(messages.historyChanges.notSet)
        expect(await tags.locator('li').nth(2).locator('span').textContent()).toBe('  ')
        for (const field of ['description', 'rating', 'size', 'duration', 'tags']) {
            const comparison = modal.locator(`[data-property-row="${field}"]`).first()
            const geometry = await comparison.evaluate((element) => {
                const before = element
                    .querySelector('[data-property-before]')!
                    .getBoundingClientRect()
                const after = element
                    .querySelector('[data-property-after]')!
                    .getBoundingClientRect()
                return {
                    before: before.width,
                    after: after.width,
                    right: after.right,
                    room: document.documentElement.clientWidth,
                    overflow: [
                        ...element.querySelectorAll<HTMLElement>('[data-property-value]'),
                    ].some((value) => value.scrollWidth > value.clientWidth + 1),
                }
            })
            expect(geometry.before).toBeCloseTo(geometry.after, 1)
            expect(geometry.before).toBeGreaterThan(80)
            expect(geometry.right).toBeLessThanOrEqual(geometry.room)
            expect(geometry.overflow).toBe(false)
        }
        await page.screenshot({ path: testInfo.outputPath(`inspection-phone-${locale}.png`) })
        await page.keyboard.press('Escape')
        await page.setViewportSize({ width: 420, height: 844 })
        await forcePane(page, 320)
        const geometry = await page.locator('[data-peek-navigation]').boundingBox()
        await page.evaluate(() => window.historyInspectionTest.hold(2))
        await select(page, 2, 1)
        const stateLine = page.locator('[data-peek-change]')
        await expect(stateLine).toHaveText(messages.peek.loadingShort)
        await expect(stateLine.locator('..')).toHaveAccessibleName(messages.peek.loadingChanges)
        await expect(stateLine.locator('..')).toHaveAttribute('title', messages.peek.loadingChanges)
        expect(await page.locator('[data-peek-navigation]').boundingBox()).toEqual(geometry)
        await expectStateLine(stateLine)
        await page.screenshot({
            path: testInfo.outputPath(`navigation-loading-${locale}-pane320.png`),
        })
        await page.evaluate(() => window.historyInspectionTest.release(2))
        await expect(stateLine).toHaveText(`${messages.commands.undo.title} · Imported Metadata`)
        await select(page, 1, 99)
        await expect(stateLine).toHaveText(messages.peek.unavailableShort)
        await expect(page.locator('[data-change-arrow="up"] .change-count')).toHaveText('–')
        await expect(page.locator('[data-change-arrow="down"] .change-count')).toHaveText('–')
        for (const direction of ['up', 'down'])
            await expect(page.locator(`[data-change-arrow="${direction}"]`)).not.toHaveAttribute(
                'data-count',
            )
        await expect(stateLine.locator('..')).toHaveAccessibleName(messages.peek.unavailable)
        await expect(stateLine.locator('..')).toHaveAttribute('title', messages.peek.unavailable)
        await expect(page.locator('[data-history-announcement]')).toContainText(
            messages.peek.unavailable,
        )
        expect(await page.locator('[data-peek-navigation]').boundingBox()).toEqual(geometry)
        await expectStateLine(stateLine)
        await page.screenshot({
            path: testInfo.outputPath(`navigation-unavailable-${locale}-pane320.png`),
        })
        await select(page, 3)
        await expect(stateLine).toHaveText(messages.peek.noChanges)
        expect(await page.locator('[data-peek-navigation]').boundingBox()).toEqual(geometry)
        await expectStateLine(stateLine)
        await page.screenshot({
            path: testInfo.outputPath(`navigation-no-change-${locale}-pane320.png`),
        })
    })
}

test('forced colors preserves exposed control state and keyboard focus', async ({
    page,
}, testInfo) => {
    await seed(page)
    await page.emulateMedia({ forcedColors: 'active' })
    await forcePane(page, 320)
    const eye = page.locator('[data-show-edits]')
    await eye.focus()
    expect(await eye.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe('none')
    await page.keyboard.press('Space')
    await expect(eye).toHaveAttribute('aria-pressed', 'false')
    const arrow = page.locator('[data-change-arrow="up"]')
    await expect(arrow).toHaveAttribute('aria-disabled', 'true')
    expect(await arrow.evaluate((element) => getComputedStyle(element).opacity)).toBe('1')
    await page.screenshot({ path: testInfo.outputPath('inspection-forced-colors.png') })
    await page.keyboard.press('Space')
    await expect(eye).toHaveAttribute('aria-pressed', 'true')
    await captureContours(page, testInfo, 'forced-colors')
    await page.keyboard.press('Space')
    await forcePane(page, 160)
    await page.locator('[data-change-options]').focus()
    await page.keyboard.press('ArrowDown')
    await expect(page.getByRole('menuitemcheckbox')).toBeFocused()
    await page.keyboard.press('Space')
    await expect(page.locator('[data-change-options-menu]')).toHaveCount(0)
    await page.locator('[data-change-options]').click()
    await expect(page.getByRole('menuitemcheckbox')).toHaveAttribute('aria-checked', 'true')
    await page.screenshot({ path: testInfo.outputPath('inspection-menu-forced-colors.png') })
})

test.describe('touch inspection controls', () => {
    test.use({ hasTouch: true })
    test('tiny touch menu dismisses without restoring the chart underneath', async ({ page }) => {
        await seed(page)
        await forcePane(page, 160)
        await page.locator('[data-change-options]').tap()
        // A 24 px box with its 32 px hit through ::before.
        await expect(page.locator('[data-change-options]')).toHaveJSProperty('offsetHeight', 24)
        await expectHit(page.locator('[data-change-options]'), 32, 32)
        await expect(page.getByRole('menuitemcheckbox')).toHaveAttribute('aria-checked', 'true')
        await expect(page.getByRole('menuitemcheckbox')).toHaveJSProperty('offsetHeight', 36)
        await page.getByRole('menuitemcheckbox').tap()
        await page.locator('[data-change-options]').tap()
        await expect(page.getByRole('menuitemcheckbox')).toHaveAttribute('aria-checked', 'false')
        await page.locator('[data-peek-restore]').tap()
        await expect(page.locator('[data-change-options-menu]')).toHaveCount(0)
        await expect(page.locator('[data-peek-main]')).toBeVisible()
        expect(await page.evaluate(() => window.historyInspectionTest.unchanged())).toBe(true)
        await page.locator('[data-change-options]').tap()
        await page.getByRole('menuitem', { name: 'View Property Changes', exact: true }).tap()
        await expect(dialog(page)).toBeVisible()
        await expect(
            dialog(page).getByRole('button', { name: 'Close', exact: true }),
        ).toHaveJSProperty('offsetHeight', 36)
        await dialog(page).getByRole('button', { name: 'Close', exact: true }).tap()
        await expect(page.locator('[data-change-options]')).toBeFocused()
    })
})

test('composed old and new change destinations stay identical while Show Edits is Off', async ({
    page,
}, testInfo) => {
    await seed(page)
    await page.locator('[data-peek-back]').click()
    await page.evaluate(async () => {
        const { appImport, fixtures, view, settings } = window.editorTest
        const { createState } =
            await appImport<typeof import('../../src/state')>('/src/state/index.ts')
        const chart = structuredClone(fixtures.events)
        const template = fixtures.notes.slides[0]![0]!
        chart.cameraEvents = []
        chart.stageMaskEvents = []
        chart.stageStyleEvents = []
        chart.stageTransformEvents = []
        chart.timeScales = []
        chart.stagePivotEvents = chart.stagePivotEvents
            .slice(0, 1)
            .map((event) => ({ ...event, beat: 0, pivotLane: 4 }))
        chart.slides = [
            [{ ...template, beat: 2, left: -3, size: 3 }],
            [
                { ...template, beat: 16, left: 1, size: 3 },
                { ...template, beat: 18, left: 2, size: 3 },
            ],
            [{ ...template, beat: 24, left: -1, size: 3 }],
        ]
        const after = structuredClone(chart)
        after.initialLife = chart.initialLife + 1
        after.slides[0]![0]!.beat = 10
        after.slides[0]![0]!.left = 3
        after.slides[1]![0]!.isCritical = !chart.slides[1]![0]!.isCritical
        after.slides.splice(2, 1)
        after.slides.push([{ ...template, beat: 34, left: 1, size: 3 }])
        const fixture = window.historyInspectionTest
        fixture.states.set(0, createState(chart, 0))
        fixture.states.set(1, createState(after, 0))
        fixture.refresh()
        view.layout = 'composed'
        view.time = 3
        view.lane = 0
        settings.width = 16
        settings.pps = 400
        fixture.select(1)
    })
    await expect(page.locator('[data-peek-change]')).not.toHaveText('')
    await expect(page.locator('[data-property-summary]')).toHaveAccessibleDescription(
        /properties changed/i,
    )
    const markKinds = await page.evaluate(async () => {
        const { changeMarks } = await window.editorTest.appImport<
            typeof import('../../src/editor/history/changes')
        >('/src/editor/history/changes.ts')
        const marks = changeMarks.value!
        return {
            added: marks.rings.filter((mark) => mark.added).length,
            changed: marks.rings.filter((mark) => !mark.added).length,
            removed: marks.ghosts.filter((mark) => mark.removed).length,
            movedFrom: marks.ghosts.filter((mark) => !mark.removed).length,
            connector: [...marks.changed].some((entity) => entity.type === 'connector'),
            oldBeat: marks.ghosts.find((mark) => !mark.removed)?.entity.beat,
            newBeat: marks.rings.find((mark) => mark.entity.beat === 10)?.entity.beat,
        }
    })
    expect(markKinds).toMatchObject({
        added: 1,
        removed: 1,
        movedFrom: 1,
        connector: true,
        oldBeat: 2,
        newBeat: 10,
    })
    expect(markKinds.changed).toBeGreaterThan(0)
    const read = () =>
        page.evaluate(async () => {
            const changes = await window.editorTest.appImport<
                typeof import('../../src/editor/history/changes')
            >('/src/editor/history/changes.ts')
            return {
                off: changes.offBand.value,
                line: changes.changeLine.value,
                time: window.editorTest.view.time,
                lane: window.editorTest.view.lane,
                scrolling: !!window.editorTest.view.scrollingY,
                marks: !!changes.changeMarks.value,
                dimmed: !!changes.undimmed.value,
                show: changes.showEdits.value,
            }
        })
    const navigate = async (direction: 'up' | 'down') => {
        await page.evaluate(() => {
            const { view } = window.editorTest
            view.scrollingY = undefined
            view.scrollingX = undefined
            view.time = 3
            view.lane = 0
        })
        await expect(page.locator(`[data-change-arrow="${direction}"]`)).toHaveAttribute(
            'aria-disabled',
            'false',
        )
        const before = await read()
        await page.locator(`[data-change-arrow="${direction}"]`).click()
        await expect.poll(async () => (await read()).scrolling).toBe(false)
        const after = await read()
        expect(after.time).not.toBe(3)
        return {
            before: { off: before.off, line: before.line },
            after: { time: after.time, lane: after.lane, off: after.off },
        }
    }
    const on = { old: await navigate('down'), next: await navigate('up') }
    await page.locator('[data-show-edits]').click()
    await expect(page.locator('[data-show-edits]')).toHaveAttribute('aria-pressed', 'false')
    const off = { old: await navigate('down'), next: await navigate('up') }
    expect(off).toEqual(on)
    expect(await read()).toMatchObject({ marks: false, dimmed: false, show: false })
    await open(page)
    await expect(row(page, 'initialLife')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-show-edits]')).toHaveAttribute('aria-pressed', 'false')
    const opacity = await page.evaluate(async () => {
        const { appImport, history, view, settings } = window.editorTest
        const [{ orderEntities }, { scopeLookup }, changes] = await Promise.all([
            appImport<typeof import('../../src/editor/canvas/ordering')>(
                '/src/editor/canvas/ordering.ts',
            ),
            appImport<typeof import('../../src/editor/scope')>('/src/editor/scope.ts'),
            appImport<typeof import('../../src/editor/history/changes')>(
                '/src/editor/history/changes.ts',
            ),
        ])
        const notes = [...history.state.value.store.slides.note.values()].flat()
        const draw = () =>
            orderEntities(notes, new Set(), {
                scope: scopeLookup.value,
                visibilities: view.visibilities,
                showOtherObjects: settings.showOtherObjects,
                undimmed: changes.undimmed.value,
            })
        const ordinary = draw().map((step) => step.opacity)
        view.visibilities.note = false
        settings.showOtherObjects = true
        const typeDim = draw().map((step) => step.opacity)
        settings.showOtherObjects = false
        const typeHidden = draw().length
        view.visibilities.note = true
        const first = notes[0]!
        view.groupVisibility = new Map([[first.groupId, 'hidden']])
        const groupHidden = draw().filter(
            (step) => step.entity.type === 'note' && step.entity.groupId === first.groupId,
        ).length
        return { ordinary, typeDim, typeHidden, groupHidden }
    })
    expect(opacity.ordinary.length).toBeGreaterThan(0)
    expect(opacity.ordinary.every((value) => value === 1)).toBe(true)
    expect(opacity.typeDim.length).toBe(opacity.ordinary.length)
    expect(opacity.typeDim.every((value) => value === 0.25)).toBe(true)
    expect(opacity).toMatchObject({ typeHidden: 0, groupHidden: 0 })
    await page.screenshot({ path: testInfo.outputPath('composed-navigation-edits-off.png') })
})

test('an outside press that closes Options for Changes gives focus back to its button', async ({
    page,
}) => {
    await seed(page)
    await forcePane(page, 240)
    const opener = page.locator('[data-change-options]')
    await opener.click()
    await expect(page.locator('[data-change-options-menu]')).toBeVisible()
    await page.locator('[data-peek-back]').click()
    await expect(page.locator('[data-change-options-menu]')).toHaveCount(0)
    await expect(page.locator('[data-peek-main]')).toBeVisible()
    await expect(opener).toBeFocused()
})

test.describe('touch Options for Changes', () => {
    test.use({ hasTouch: true })
    test('an outside tap that closes the sheet gives focus back to its button', async ({
        page,
    }) => {
        await seed(page)
        await page.setViewportSize({ width: 300, height: 568 })
        const opener = page.locator('[data-change-options]')
        await expect(opener).toBeVisible()
        await opener.tap()
        await expect(page.locator('[data-change-options-menu]')).toBeVisible()
        // The strip's empty gap, between its two capsules.
        const main = (await page.locator('[data-peek-main]').boundingBox())!
        const navigation = (await page.locator('[data-peek-navigation]').boundingBox())!
        await page.touchscreen.tap(
            main.x + main.width / 2,
            (main.y + main.height + navigation.y) / 2,
        )
        await expect(page.locator('[data-change-options-menu]')).toHaveCount(0)
        await expect(page.locator('[data-peek-main]')).toBeVisible()
        await expect(opener).toBeFocused()
    })
})

test('the Property Changes title is whole in a 304 px dialog in every language', async ({
    page,
}) => {
    await seed(page)
    await page.setViewportSize({ width: 320, height: 568 })
    const cut: string[] = []
    for (const locale of ['en', 'fr', 'ja', 'ko', 'tr', 'zhs', 'zht']) {
        await page.evaluate((locale) => {
            window.editorTest.settings.locale = locale as never
        }, locale)
        await page.locator('[data-property-summary], [data-change-options]').first().click()
        if (await page.locator('[data-change-options-menu]').count())
            await page.locator('[data-change-options-menu] [role="menuitem"]').click()
        const modal = page.locator('dialog[open]').last()
        const title = modal.locator('[data-modal-title]')
        await expect(title).toBeVisible()
        const measure = await title.evaluate((element) => ({
            text: element.textContent ?? '',
            dialog: element.closest('dialog')!.getBoundingClientRect().width,
            whole: element.scrollWidth <= element.clientWidth,
        }))
        expect(measure.dialog).toBeLessThanOrEqual(304)
        if (!measure.whole) cut.push(`${locale}: ${measure.text}`)
        await page.keyboard.press('Escape')
        await expect(modal).toHaveCount(0)
    }
    expect(cut).toEqual([])
})
