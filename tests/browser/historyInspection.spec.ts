import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import type { GroupId } from '../../src/chart/groups'
import type english from '../../src/i18n/en/index.json'
import type { EntryKey } from '../../src/history/peek'
import type { State } from '../../src/state'
import { installCanvasCounters, installEditorFixture, waitForStartup } from './editorFixture'

declare global {
    interface Window {
        historyInspectionTest: {
            states: Map<number, State>
            refresh: () => void
            select: (seq: number, previous?: number, members?: number[]) => void
            hold: (seq: number) => void
            release: (seq: number, fail?: boolean) => void
            pending: Set<number>
            unchanged: () => boolean
        }
        historyMenuKeys: { key: string; prevented: boolean }[]
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
    await page.evaluate(installEditorFixture)
    await expect.poll(() => page.evaluate(async () => {
        const { flusher } = await window.editorTest.appImport<typeof import('../../src/local/storing')>('/src/local/storing.ts')
        return flusher?.session?.pending.length ?? 0
    })).toBeGreaterThan(0)
})
test.afterEach(({ page }) => { expect(errors.get(page)).toEqual([]) })

// Valid imported metadata supplies historical endpoints; every control still uses real pointer/key events.
const seed = async (page: Page, mode: 'basic' | 'rows' | 'items' = 'basic') => {
    await page.evaluate(async (mode) => {
        const { appImport, history, settings } = window.editorTest
        const [peek, selection] = await Promise.all([
            appImport<typeof import('../../src/history/peek')>('/src/history/peek.ts'),
            appImport<typeof import('../../src/editor/history/selection')>('/src/editor/history/selection.ts'),
        ])
        const live = history.liveState.value
        const defaultEdits = settings.dimUnchangedObjects = true
        const before: State = {
            ...live,
            initialLife: 999,
            levelInfo: { ...live.levelInfo, title: 'Before title', description: '  first\n\nlast  ', rating: 1.0000001,
                tags: [{ title: 'Absent icon' }, { title: 'Empty icon', icon: '' }, { title: 'Whitespace icon', icon: '  ' }] },
            bgm: { ...live.bgm, offset: 0.0000001, meta: { hash: '1'.repeat(32), filename: 'before.ogg', size: 1024, type: 'audio/ogg', durationMs: 1234 } },
        }
        const after: State = {
            ...before,
            initialLife: 1001,
            levelInfo: { ...before.levelInfo, title: 'After title', description: '  changed\n\nlast  ', rating: 1.0000002,
                tags: [...before.levelInfo.tags, { title: 'Added tag', icon: 'new' }],
                cover: { hash: '2'.repeat(32), filename: 'cover.png', size: 4097, type: 'image/png' } },
            bgm: { ...before.bgm, offset: 0.0000002, meta: { hash: '3'.repeat(32), filename: 'after.ogg', size: 1025, type: 'audio/ogg', durationMs: 1235 } },
        }
        if (mode === 'rows') {
            before.groups = new Map([...before.groups, ...Array.from({ length: 150 }, (_, index): [GroupId, { name: string; forceNoteSpeed: number }] => [(index + 1000) as GroupId, { name: `Historical group ${index + 1}`, forceNoteSpeed: 1 }])])
            after.groups = new Map([...before.groups].map(([id, group]) => [id, id >= 1000 ? { ...group, forceNoteSpeed: 2 } : group]))
            after.initialLife = before.initialLife
            after.levelInfo = before.levelInfo
            after.bgm = before.bgm
        } else if (mode === 'items') {
            after.levelInfo = { ...before.levelInfo, tags: Array.from({ length: 205 }, (_, index) => ({ title: `Historical tag ${index + 1}` })) }
            after.initialLife = before.initialLife
            after.bgm = before.bgm
        }
        const states = new Map([[0, before], [1, after], [2, before], [3, before]])
        const held = new Set<number>()
        const pending = new Set<number>()
        const releases = new Map<number, (fail: boolean) => void>()
        const source = () => peek.setPeekSource({
            sameSnapshot: (a, b) => a === b,
            load: async (key) => {
                const seq = Number(key.split(':').at(-1))
                const state = states.get(seq)
                if (!state) throw new peek.PeekError('missing')
                if (held.has(seq)) {
                    pending.add(seq)
                    await new Promise<void>((resolve, reject) => releases.set(seq, (fail) => {
                        pending.delete(seq)
                        held.delete(seq)
                        if (fail) reject(new peek.PeekError('removed'))
                        else resolve()
                    }))
                }
                return { state, time: 1_720_000_000_000 + seq }
            },
        })
        source()
        window.historyInspectionTest = {
            states, pending, refresh: source,
            select: (seq, previous = 0, members) => selection.requestPeek({
                key: `inspection:${seq}`,
                previous: { key: `inspection:${previous}` },
                time: 1_720_000_000_000 + seq,
                label: seq === 2 ? 'Undid Metadata' : members ? 'Grouped Metadata' : 'Imported Metadata',
                ...(members ? { members: members.map((member): EntryKey => `inspection:${member}`) } : {}),
            }),
            hold: (seq) => { held.add(seq); source() },
            release: (seq, fail = false) => {
                const release = releases.get(seq)
                if (!release) throw new Error(`No held load for ${seq}`)
                releases.delete(seq)
                release(fail)
            },
            unchanged: () => history.liveState.value === live && settings.dimUnchangedObjects === defaultEdits,
        }
        window.historyInspectionTest.select(1)
    }, mode)
    await expect(page.locator('[data-property-summary]')).toBeVisible()
}

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Property Changes', exact: true })
const row = (page: Page, field: string) => dialog(page).locator(`[data-property-row="${field}"]`).first()
const select = (page: Page, seq: number, previous = 0, members?: number[]) => page.evaluate(({ seq, previous, members }) => window.historyInspectionTest.select(seq, previous, members), { seq, previous, members })
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

test('property inspection keeps exact chronological values, whitespace and the live chart', async ({ page }, testInfo) => {
    await seed(page)
    await page.locator('[data-show-edits]').click()
    await open(page)
    await expect(dialog(page).locator('[data-property-context]')).toContainText('Imported Metadata')
    await expect(row(page, 'title').locator('[data-property-before]')).toContainText('Before title')
    await expect(row(page, 'title').locator('[data-property-after]')).toContainText('After title')
    await expect(row(page, 'offset').locator('[data-property-before] [data-property-value]')).toHaveText('0.0001')
    await expect(row(page, 'offset').locator('[data-property-after] [data-property-value]')).toHaveText('0.0002')
    await expect(row(page, 'rating').locator('[data-property-before] [data-property-value]')).toHaveText('1.0000001')
    await expect(row(page, 'rating').locator('[data-property-after] [data-property-value]')).toHaveText('1.0000002')
    expect(await row(page, 'description').locator('[data-property-after] [data-property-value]').textContent()).toBe('  changed\n\nlast  ')
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
})

for (const width of [160, 167, 168, 240, 319, 320, 360, 390]) {
    test(`secondary History controls keep exact geometry at pane ${width}`, async ({ page }, testInfo) => {
        await seed(page)
        await forcePane(page, width)
        const navigation = page.locator('[data-peek-navigation]')
        await expect(navigation).toBeVisible()
        const boxes = await navigation.evaluate((element) => {
            const box = (node: Element) => {
                const { x, y, width, height, right, bottom } = node.getBoundingClientRect()
                return { x, y, width, height, right, bottom }
            }
            return { row: box(element), pane: box(element.closest('.chart-pane')!), main: box(document.querySelector('[data-peek-main]')!), controls: [...element.querySelectorAll('button')].map(box) }
        })
        expect(boxes.row.height).toBe(32)
        expect(boxes.row.width).toBe(Math.min(384, width - 16))
        expect(boxes.row.y).toBe(boxes.main.bottom)
        for (const box of boxes.controls) {
            expect(box.height).toBe(32)
            expect(box.x).toBeGreaterThanOrEqual(boxes.pane.x)
            expect(box.right).toBeLessThanOrEqual(boxes.pane.right)
        }
        for (let index = 1; index < boxes.controls.length; index++) expect(boxes.controls[index]!.x).toBeGreaterThanOrEqual(boxes.controls[index - 1]!.right)
        const arrowWidth = width < 168 ? 44 : 56
        for (const arrow of boxes.controls.slice(-2)) expect(arrow.width).toBe(arrowWidth)
        if (width < 320) {
            await expect(page.locator('[data-show-edits], [data-property-summary]')).toHaveCount(0)
            expect(boxes.controls[0]!.width).toBe(32)
        } else {
            await expect(page.locator('[data-change-options]')).toHaveCount(0)
            expect(boxes.controls[0]!.width).toBe(32)
            expect(boxes.controls[1]!.width).toBe(width === 320 ? 144 : Math.min(384, width - 16) - 160)
        }
        await page.screenshot({ path: testInfo.outputPath(`navigation-${width}.png`) })
    })
}

test('tiny menu takes keyboard focus, holds browser keys and restores its opener', async ({ page }) => {
    await seed(page)
    await forcePane(page, 240)
    const opener = page.locator('[data-change-options]')
    await opener.focus()
    await page.keyboard.press('ArrowDown')
    const menu = page.getByRole('menu', { name: 'Change Options', exact: true })
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Show Edits' })).toBeFocused()
    await menu.evaluate((element) => {
        window.historyMenuKeys = []
        element.addEventListener('keydown', (event) => {
            const key = event as KeyboardEvent
            window.historyMenuKeys.push({ key: key.key, prevented: key.defaultPrevented })
        })
    })
    await page.keyboard.press('Control+s')
    await page.keyboard.press('Meta+s')
    await page.keyboard.press('x')
    expect(await page.evaluate(() => window.historyMenuKeys)).toEqual(expect.arrayContaining([
        { key: 's', prevented: true }, { key: 'x', prevented: true },
    ]))
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

test('local Show Edits survives selection and groups, then reads the default on a new peek', async ({ page }) => {
    await seed(page)
    const eye = page.locator('[data-show-edits]')
    await eye.click()
    await expect(eye).toHaveAttribute('aria-pressed', 'false')
    await select(page, 2, 1)
    await expect(page.locator('[data-peek-change]')).toHaveText('Undid Metadata')
    await expect(eye).toHaveAttribute('aria-pressed', 'false')
    await open(page)
    await expect(row(page, 'title').locator('[data-property-before]')).toContainText('After title')
    await expect(row(page, 'title').locator('[data-property-after]')).toContainText('Before title')
    await page.keyboard.press('Escape')
    await select(page, 3, 0, [1, 2, 3])
    await expect(page.locator('[data-peek-change]')).toHaveText('No changes')
    await expect(page.locator('[data-property-summary]')).toHaveCount(0)
    await expect(eye).toHaveAttribute('aria-pressed', 'false')
    await page.locator('[data-peek-back]').click()
    await select(page, 1)
    await expect(eye).toHaveAttribute('aria-pressed', 'true')
    expect(await page.evaluate(() => window.historyInspectionTest.unchanged())).toBe(true)
})

test('pending comparison keeps the fixed row and an explicit Off choice after settlement', async ({ page }) => {
    await seed(page)
    await forcePane(page, 320)
    const bounds = async () => ({
        main: await page.locator('[data-peek-main]').boundingBox(),
        navigation: await page.locator('[data-peek-navigation]').boundingBox(),
        arrows: await page.locator('[data-change-arrow]').evaluateAll((elements) => elements.map((element) => {
            const { x, y, width, height } = element.getBoundingClientRect()
            return { x, y, width, height }
        })),
    })
    const before = await bounds()
    await page.locator('[data-show-edits]').click()
    await page.evaluate(() => window.historyInspectionTest.hold(2))
    await select(page, 2, 1)
    await expect(page.locator('[data-peek-change]')).toHaveText('Loading changes…')
    expect(await bounds()).toEqual(before)
    await expect(page.locator('[data-property-summary]')).toHaveCount(0)
    await expect(page.locator('[data-show-edits]')).toHaveAttribute('aria-pressed', 'false')
    expect(await page.evaluate(async () => {
        const changes = await window.editorTest.appImport<typeof import('../../src/editor/history/changes')>('/src/editor/history/changes.ts')
        return { marks: changes.changeMarks.value, dim: changes.undimmed.value }
    })).toEqual({ marks: undefined, dim: undefined })
    await page.evaluate(() => window.historyInspectionTest.release(2))
    await expect(page.locator('[data-peek-change]')).toHaveText('Undid Metadata')
    await expect(page.locator('[data-property-summary]')).toBeVisible()
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
    await expect(dialog(page).locator('[data-property-count]')).toHaveText('Properties: 150/150')
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
    await expect(tags).toContainText('Items: 205/205')
    await expect(tags.locator('[data-property-items-more]')).toHaveCount(0)
})

test('selection invalidates an open inspection without retargeting old values or focus', async ({ page }, testInfo) => {
    await seed(page)
    await open(page)
    await select(page, 2, 1)
    await expect(dialog(page)).toHaveCount(0)
    await expect(page.locator('[data-peek-change]')).toHaveText('Undid Metadata')
    await page.screenshot({ path: testInfo.outputPath('selection-closed-inspection.png') })
    await open(page)
    await expect(row(page, 'title').locator('[data-property-after]')).toContainText('Before title')
    await page.evaluate(async () => {
        const { backToNow } = await window.editorTest.appImport<typeof import('../../src/editor/history/selection')>('/src/editor/history/selection.ts')
        backToNow()
    })
    await expect(dialog(page)).toHaveCount(0)
    await expect(page.locator('[data-peek-main]')).toHaveCount(0)
    expect(await page.evaluate(() => window.historyInspectionTest.unchanged())).toBe(true)
})

for (const outcome of ['resolve', 'unavailable', 'superseded'] as const) {
    test(`inspection delayed predecessor ${outcome} keeps the captured request`, async ({ page }, testInfo) => {
        await seed(page)
        await page.evaluate(() => window.historyInspectionTest.hold(0))
        await page.locator('[data-property-summary]').click()
        await expect(dialog(page)).toBeVisible()
        await expect.poll(() => page.evaluate(() => window.historyInspectionTest.pending.has(0))).toBe(true)
        await expect(dialog(page).locator('[data-property-comparison]')).toHaveText('Loading changes…')
        await expect(dialog(page).locator('[data-property-row]')).toHaveCount(0)
        if (outcome === 'superseded') {
            await select(page, 2, 1)
            await expect(dialog(page)).toHaveCount(0)
            await page.evaluate(async () => {
                const { showChoice } = await window.editorTest.appImport<typeof import('../../src/modals/choice')>('/src/modals/choice.ts')
                void showChoice({ title: () => 'Newer dialog', choices: [{ value: 'keep', label: () => 'Keep Focus', default: true }] })
            })
            await expect(page.getByRole('button', { name: 'Keep Focus', exact: true })).toBeFocused()
        }
        await page.evaluate((fail) => window.historyInspectionTest.release(0, fail), outcome === 'unavailable')
        if (outcome === 'resolve') {
            await expect(row(page, 'title').locator('[data-property-after]')).toContainText('After title')
        } else if (outcome === 'unavailable') {
            await expect(dialog(page).locator('[data-property-comparison]')).toHaveText('Changes unavailable')
        } else {
            await expect(page.locator('[data-peek-change]')).toHaveText('Undid Metadata')
            await expect(dialog(page)).toHaveCount(0)
            await expect(page.getByRole('button', { name: 'Keep Focus', exact: true })).toBeFocused()
            await page.screenshot({ path: testInfo.outputPath('newer-dialog-retains-focus.png') })
        }
    })
}

test('inspection close restores the current visible opener after a pane resize', async ({ page }, testInfo) => {
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

test('a chart reset closes inspection and cannot leave focus in a removed control', async ({ page }, testInfo) => {
    await seed(page)
    await open(page)
    await page.evaluate(() => {
        const { history, fixtures } = window.editorTest
        history.resetState(false, structuredClone(fixtures.notes), 0)
    })
    await expect(dialog(page)).toHaveCount(0)
    await expect(page.locator('[data-peek-main]')).toHaveCount(0)
    expect(await page.evaluate(() => {
        const active = document.activeElement
        return !!active?.isConnected && (active === document.body || !!active.getClientRects().length)
    })).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('reset-closed-inspection.png') })
})

test('cached header-only comparison waits for its actual displayed entry', async ({ page }) => {
    await page.clock.install()
    await page.clock.pauseAt(new Date(Date.now() + 60_000))
    await page.evaluate(async () => {
        const { appImport, history } = window.editorTest
        const [peek, selection, changes] = await Promise.all([
            appImport<typeof import('../../src/history/peek')>('/src/history/peek.ts'),
            appImport<typeof import('../../src/editor/history/selection')>('/src/editor/history/selection.ts'),
            appImport<typeof import('../../src/editor/history/changes')>('/src/editor/history/changes.ts'),
        ])
        const base = { ...history.liveState.value, initialLife: 1000 }
        const a = { ...base, initialLife: 1100 }
        const b = { ...base, initialLife: 1200 }
        const states = new Map<EntryKey, State>([['readiness:0', base], ['readiness:1', a], ['readiness:2', b]])
        peek.setPeekSource({ sameSnapshot: (left, right) => left === right, load: async (key) => ({ state: states.get(key)!, time: 1_720_000_000_000 }) })
        await Promise.all([...states.keys()].map(peek.loadEntryState))
        selection.requestPeek({ key: 'readiness:1', previous: { key: 'readiness:0' }, label: 'Header A', time: 1_720_000_000_001 })
        await Promise.resolve()
        await Promise.resolve()
        changes.closePropertyInspection()
    })
    await expect.poll(() => page.evaluate(async () => {
        const peek = await window.editorTest.appImport<typeof import('../../src/history/peek')>('/src/history/peek.ts')
        const changes = await window.editorTest.appImport<typeof import('../../src/editor/history/changes')>('/src/editor/history/changes.ts')
        return { displayed: peek.displayedPeekKey.value, shown: changes.shownChange.value?.key }
    })).toEqual({ displayed: 'readiness:1', shown: 'readiness:1' })
    await page.evaluate(async () => {
        const { requestPeek } = await window.editorTest.appImport<typeof import('../../src/editor/history/selection')>('/src/editor/history/selection.ts')
        requestPeek({ key: 'readiness:2', previous: { key: 'readiness:0' }, label: 'Header B', time: 1_720_000_000_002 })
    })
    await expect.poll(() => page.evaluate(async () => {
        const { appImport, history } = window.editorTest
        const [peek, changes] = await Promise.all([
            appImport<typeof import('../../src/history/peek')>('/src/history/peek.ts'),
            appImport<typeof import('../../src/editor/history/changes')>('/src/editor/history/changes.ts'),
        ])
        changes.closePropertyInspection()
        changes.openPropertyInspection()
        return { requested: peek.peekedKey.value, displayed: peek.displayedPeekKey.value,
            computed: changes.peekChange.value?.key, status: changes.comparisonStatus.value,
            header: changes.peekChange.value?.set.header,
            sameStore: history.state.value.store === changes.peekChange.value?.state.store,
            life: history.state.value.initialLife, shown: changes.shownChange.value?.key,
            inspectable: changes.canInspectProperties.value, inspection: changes.propertyInspection.value?.status }
    })).toEqual({ requested: 'readiness:2', displayed: 'readiness:1', computed: 'readiness:2', status: 'known', header: true,
        sameStore: true, life: 1100, shown: undefined, inspectable: false, inspection: undefined })
    expect(await page.locator('[data-property-summary]').count()).toBe(0)
    await page.clock.runFor(100)
    await expect(page.locator('[data-property-summary]')).toBeVisible()
    await page.clock.resume()
    await open(page)
    await expect(row(page, 'initialLife').locator('[data-property-before]')).toContainText('1,000')
    await expect(row(page, 'initialLife').locator('[data-property-after]')).toContainText('1,200')
})

for (const locale of ['en', 'fr', 'ja', 'ko', 'tr', 'zhs', 'zht']) {
    const messages = JSON.parse(readFileSync(new URL(`../../src/i18n/${locale}/index.json`, import.meta.url), 'utf8')) as typeof english
    test(`${locale} property labels and exact values wrap in equal phone columns`, async ({ page }, testInfo) => {
        await seed(page)
        await page.setViewportSize({ width: 390, height: 844 })
        await forcePane(page, 390)
        await page.evaluate((locale) => { window.editorTest.settings.locale = locale }, locale)
        const opener = page.getByRole('button', { name: messages.historyChanges.view, exact: true })
        await expect(opener).toHaveAccessibleDescription('Imported Metadata')
        await opener.click()
        const modal = page.getByRole('dialog', { name: messages.historyChanges.title, exact: true })
        await expect(modal).toBeVisible()
        const rating = modal.locator('[data-property-row="rating"]')
        await expect(rating.getByRole('heading')).toHaveText(messages.historyChanges.fields.rating)
        await expect(rating.locator('[data-property-before] > p')).toHaveText(messages.historyChanges.before)
        await expect(rating.locator('[data-property-after] > p')).toHaveText(messages.historyChanges.after)
        await expect(rating.locator('[data-property-after] [data-property-value]')).toHaveText(['fr', 'tr'].includes(locale) ? '1,0000002' : '1.0000002')
        const tags = modal.locator('[data-property-row="tags"] [data-property-before]')
        await expect(tags.locator('li').nth(0)).toContainText(messages.historyChanges.notSet)
        await expect(tags.locator('li').nth(1)).toContainText(messages.historyChanges.empty)
        expect(await tags.locator('li').nth(2).locator('[data-property-value]').textContent()).toBe('  ')
        for (const field of ['description', 'rating', 'size', 'duration', 'tags']) {
            const comparison = modal.locator(`[data-property-row="${field}"]`).first()
            const geometry = await comparison.evaluate((element) => {
                const before = element.querySelector('[data-property-before]')!.getBoundingClientRect()
                const after = element.querySelector('[data-property-after]')!.getBoundingClientRect()
                return { before: before.width, after: after.width, right: after.right, room: document.documentElement.clientWidth,
                    overflow: [...element.querySelectorAll<HTMLElement>('[data-property-value]')].some((value) => value.scrollWidth > value.clientWidth + 1) }
            })
            expect(geometry.before).toBeCloseTo(geometry.after, 1)
            expect(geometry.before).toBeGreaterThan(80)
            expect(geometry.right).toBeLessThanOrEqual(geometry.room)
            expect(geometry.overflow).toBe(false)
        }
        await page.screenshot({ path: testInfo.outputPath(`inspection-phone-${locale}.png`) })
    })
}

test('forced colors preserves exposed control state and keyboard focus', async ({ page }, testInfo) => {
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
        await expect(page.getByRole('menuitemcheckbox')).toHaveAttribute('aria-checked', 'true')
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
        await dialog(page).getByRole('button', { name: 'Close', exact: true }).tap()
        await expect(page.locator('[data-change-options]')).toBeFocused()
    })
})

test('composed old and new change destinations stay identical while Show Edits is Off', async ({ page }, testInfo) => {
    await seed(page)
    await page.locator('[data-peek-back]').click()
    await page.evaluate(async () => {
        const { appImport, fixtures, view, settings } = window.editorTest
        const { createState } = await appImport<typeof import('../../src/state')>('/src/state/index.ts')
        const chart = structuredClone(fixtures.events)
        const template = fixtures.notes.slides[0]![0]!
        chart.cameraEvents = []
        chart.stageMaskEvents = []
        chart.stageStyleEvents = []
        chart.stageTransformEvents = []
        chart.timeScales = []
        chart.stagePivotEvents = chart.stagePivotEvents.slice(0, 1).map((event) => ({ ...event, beat: 0, pivotLane: 4 }))
        chart.slides = [[{ ...template, beat: 2, left: -3, size: 3 }],
            [{ ...template, beat: 16, left: 1, size: 3 }, { ...template, beat: 18, left: 2, size: 3 }],
            [{ ...template, beat: 24, left: -1, size: 3 }]]
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
    await expect(page.locator('[data-property-summary]')).toHaveAccessibleDescription(/settings changed/i)
    const markKinds = await page.evaluate(async () => {
        const { changeMarks } = await window.editorTest.appImport<typeof import('../../src/editor/history/changes')>('/src/editor/history/changes.ts')
        const marks = changeMarks.value!
        return { added: marks.rings.filter((mark) => mark.added).length,
            changed: marks.rings.filter((mark) => !mark.added).length,
            removed: marks.ghosts.filter((mark) => mark.removed).length,
            movedFrom: marks.ghosts.filter((mark) => !mark.removed).length,
            connector: [...marks.changed].some((entity) => entity.type === 'connector'),
            oldBeat: marks.ghosts.find((mark) => !mark.removed)?.entity.beat,
            newBeat: marks.rings.find((mark) => mark.entity.beat === 10)?.entity.beat }
    })
    expect(markKinds).toMatchObject({ added: 1, removed: 1, movedFrom: 1, connector: true, oldBeat: 2, newBeat: 10 })
    expect(markKinds.changed).toBeGreaterThan(0)
    const read = () => page.evaluate(async () => {
        const changes = await window.editorTest.appImport<typeof import('../../src/editor/history/changes')>('/src/editor/history/changes.ts')
        return { off: changes.offBand.value, line: changes.changeLine.value,
            time: window.editorTest.view.time, lane: window.editorTest.view.lane,
            scrolling: !!window.editorTest.view.scrollingY, marks: !!changes.changeMarks.value,
            dimmed: !!changes.undimmed.value, show: changes.showEdits.value }
    })
    const navigate = async (direction: 'up' | 'down') => {
        await page.evaluate(() => {
            const { view } = window.editorTest
            view.scrollingY = undefined
            view.scrollingX = undefined
            view.time = 3
            view.lane = 0
        })
        await expect(page.locator(`[data-change-arrow="${direction}"]`)).toHaveAttribute('aria-disabled', 'false')
        const before = await read()
        await page.locator(`[data-change-arrow="${direction}"]`).click()
        await expect.poll(async () => (await read()).scrolling).toBe(false)
        const after = await read()
        expect(after.time).not.toBe(3)
        return { before: { off: before.off, line: before.line }, after: { time: after.time, lane: after.lane, off: after.off } }
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
            appImport<typeof import('../../src/editor/canvas/ordering')>('/src/editor/canvas/ordering.ts'),
            appImport<typeof import('../../src/editor/scope')>('/src/editor/scope.ts'),
            appImport<typeof import('../../src/editor/history/changes')>('/src/editor/history/changes.ts'),
        ])
        const notes = [...history.state.value.store.slides.note.values()].flat()
        const draw = () => orderEntities(notes, new Set(), { scope: scopeLookup.value, visibilities: view.visibilities,
            showOtherObjects: settings.showOtherObjects, undimmed: changes.undimmed.value })
        const ordinary = draw().map((step) => step.opacity)
        view.visibilities.note = false
        settings.showOtherObjects = true
        const typeDim = draw().map((step) => step.opacity)
        settings.showOtherObjects = false
        const typeHidden = draw().length
        view.visibilities.note = true
        const first = notes[0]!
        view.groupVisibility = new Map([[first.groupId, 'hidden']])
        const groupHidden = draw().filter((step) => step.entity.type === 'note' && step.entity.groupId === first.groupId).length
        return { ordinary, typeDim, typeHidden, groupHidden }
    })
    expect(opacity.ordinary.length).toBeGreaterThan(0)
    expect(opacity.ordinary.every((value) => value === 1)).toBe(true)
    expect(opacity.typeDim.length).toBe(opacity.ordinary.length)
    expect(opacity.typeDim.every((value) => value === 0.25)).toBe(true)
    expect(opacity).toMatchObject({ typeHidden: 0, groupHidden: 0 })
    await page.screenshot({ path: testInfo.outputPath('composed-navigation-edits-off.png') })
})
