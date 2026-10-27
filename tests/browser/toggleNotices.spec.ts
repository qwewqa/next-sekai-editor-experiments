import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import type english from '../../src/i18n/en/index.json'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// A toggle's notice names the state it left, not the action.

const messages = JSON.parse(
    readFileSync(new URL('../../src/i18n/en/index.json', import.meta.url), 'utf8'),
) as typeof english

const { toggleVolume, visibilities } = messages.commands
const fill = (template: string, value: string) => template.replace('{0}', value)

const runtimeErrors = new WeakMap<Page, string[]>()

test.beforeEach(async ({ page }) => {
    const errors: string[] = []
    runtimeErrors.set(page, errors)
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

test.afterEach(({ page }) => {
    expect(runtimeErrors.get(page)).toEqual([])
})

const run = (
    page: Page,
    name: 'toggleBgmVolume' | 'toggleSfxVolume' | 'cycleVisibilities' | 'noteVisibility',
) =>
    page.evaluate(async (name) => {
        const commands = await window.editorTest.appImport<
            typeof import('../../src/editor/commands')
        >('/src/editor/commands/index.ts')
        await commands.commands[name].execute()
    }, name)

const notice = (page: Page) => page.locator('.notification')

test.describe('volume', () => {
    for (const [name, key, label] of [
        ['toggleBgmVolume', 'bgm', toggleVolume.type.bgm],
        ['toggleSfxVolume', 'sfx', toggleVolume.type.sfx],
    ] as const) {
        test(`${key} says muted, then unmuted`, async ({ page }) => {
            await run(page, name)
            await expect(notice(page)).toHaveText(fill(toggleVolume.muted, label))
            await run(page, name)
            await expect(notice(page)).toHaveText(fill(toggleVolume.unmuted, label))
        })
    }
})

test('a type visibility says off, then on', async ({ page }) => {
    const label = visibilities.toggle.types.note
    await run(page, 'noteVisibility')
    await expect(notice(page)).toHaveText(fill(visibilities.toggle.off, label))
    await run(page, 'noteVisibility')
    await expect(notice(page)).toHaveText(fill(visibilities.toggle.on, label))
})

const groupTypes = {
    note: ['note', 'connector'],
    bpm: ['bpm'],
    timeScale: ['timeScale'],
    cameraEvent: ['cameraEventJoint', 'cameraEventConnection'],
    stageMaskEvent: ['stageMaskEventJoint', 'stageMaskEventConnection'],
    stagePivotEvent: ['stagePivotEventJoint', 'stagePivotEventConnection'],
    stageStyleEvent: ['stageStyleEventJoint', 'stageStyleEventConnection'],
    stageTransformEvent: ['stageTransformEventJoint', 'stageTransformEventConnection'],
} as const

type Group = keyof typeof groupTypes

for (const [mode, dynamic, groups] of [
    ['without dynamic stages', false, ['note', 'bpm', 'timeScale']],
    [
        'with dynamic stages',
        true,
        [
            'note',
            'bpm',
            'timeScale',
            'cameraEvent',
            'stageMaskEvent',
            'stagePivotEvent',
            'stageStyleEvent',
            'stageTransformEvent',
        ],
    ],
] as [string, boolean, Group[]][]) {
    test(`the cycle names each visible group in turn, then all, ${mode}`, async ({ page }) => {
        if (dynamic) {
            await page.evaluate(() => {
                const { history } = window.editorTest
                history.replaceState({ ...history.state.value, isDynamicStages: true })
            })
        }
        const flags = () => page.evaluate(() => ({ ...window.editorTest.view.visibilities }))

        for (const group of groups) {
            await run(page, 'cycleVisibilities')
            await expect(notice(page)).toHaveText(
                fill(visibilities.cycle.only, visibilities.toggle.types[group]),
            )
            const shown = new Set<string>(groupTypes[group])
            const current = await flags()
            for (const other of groups) {
                for (const type of groupTypes[other]) {
                    expect(current[type as keyof typeof current], `${group}: ${type}`).toBe(
                        shown.has(type),
                    )
                }
            }
        }

        await run(page, 'cycleVisibilities')
        await expect(notice(page)).toHaveText(visibilities.cycle.all)
        const current = await flags()
        for (const other of groups) {
            for (const type of groupTypes[other]) {
                expect(current[type as keyof typeof current], type).toBe(true)
            }
        }
    })
}

test.describe('fullscreen', () => {
    const settle = (page: Page) =>
        page.evaluate(async () => {
            await window.editorTest.nextTick()
            await new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            )
        })

    const runFullscreen = (page: Page, works: boolean) =>
        page.evaluate(async (works) => {
            document.body.requestFullscreen = () =>
                works ? Promise.resolve() : Promise.reject(new Error('unsupported'))
            const commands = await window.editorTest.appImport<
                typeof import('../../src/editor/commands')
            >('/src/editor/commands/index.ts')
            await commands.commands.fullscreen.execute()
        }, works)

    test('a toggle that works shows no notice', async ({ page }) => {
        await runFullscreen(page, true)
        await settle(page)
        // The startup notice may still show; no notice may mention Fullscreen.
        await expect(notice(page).filter({ hasText: /fullscreen/i })).toHaveCount(0)
    })

    test('a toggle that fails says it is unsupported', async ({ page }) => {
        await runFullscreen(page, false)
        await expect(notice(page)).toHaveText(messages.commands.fullscreen.unsupported)
    })
})
