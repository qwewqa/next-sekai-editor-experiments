import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { load } from '../browser/historyJourney'

// Untracked scratch: renders the owner sheet's families through the real dialog, from real
// operations, and compares box geometry with the static prototype in the same browser.
const OUT = 'D:/sonolus/nse-next/work/history-redesign/details/shots/p3'
mkdirSync(OUT, { recursive: true })
const PROTO = 'file:///D:/sonolus/nse-next/work/history-redesign/details/proto/details-proto.html'

type Spec = { input: unknown }
const op = (id: string, data: unknown): Spec => ({ input: { id, data } })
const lane = (before: unknown, after: unknown): Spec =>
    op('nse.property.set', {
        subject: 'note',
        changed: { note: 2 },
        assignments: [{ field: 'left', before, after }],
    })
const uni = (value: unknown) => ({ mode: 'uniform', value })

type Family = {
    proto: string
    specs: Spec[]
    flags?: { removed: boolean; damaged: boolean }
    open?: boolean
    langs?: string[]
    raw?: boolean
}
const FAMILIES: Record<string, Family> = {
    bpmMove: {
        proto: 'bpmMove',
        specs: [op('nse.object.move', { subject: 'bpm', changed: { bpm: 1 } })],
    },
    move: {
        proto: 'move',
        specs: [
            op('nse.object.move', {
                subject: 'objects',
                changed: { note: 6, bpm: 2, cameraEvent: 1 },
                displaced: { bpm: 2 },
                retainedInitialBpm: true,
            }),
        ],
    },
    property: {
        proto: 'property',
        langs: ['en', 'fr', 'ja'],
        specs: [
            op('nse.property.set', {
                subject: 'timeScale',
                changed: { timeScale: 2 },
                assignments: [
                    { field: 'hideNotes', before: uni(false), after: uni(true) },
                    { field: 'timeScale', before: { mode: 'varying' }, after: uni(2.25) },
                    {
                        field: 'timeScaleTransition',
                        before: uni('timeScale'),
                        after: uni('scroll'),
                    },
                ],
            }),
        ],
    },
    ownerMove: {
        proto: 'ownerMove',
        specs: [
            op('nse.owner.move', {
                target: { kind: 'group', id: 3, name: { text: 'Alpha' } },
                destination: null,
                category: 'reorder',
                fromIndex: 2,
                toIndex: 0,
            }),
        ],
    },
    paste: {
        proto: 'paste',
        langs: ['en', 'fr', 'ja'],
        specs: [
            op('nse.object.paste', {
                placed: { note: 3, bpm: 1, timeScale: 2 },
                displaced: { bpm: 1, timeScale: 1 },
                variant: 'composed',
                flipped: true,
                at: 'position',
            }),
        ],
    },
    ownerDelete: {
        proto: 'ownerDelete',
        langs: ['en', 'fr', 'ja'],
        flags: { removed: true, damaged: false },
        specs: [
            op('nse.owner.delete', {
                domain: 'group',
                removed: { group: 1 },
                target: { kind: 'group', id: 3, name: { text: 'Alpha' } },
                objects: { note: 800, timeScale: 12 },
                replacement: { kind: 'group', id: 4, name: { text: 'Group 1' } },
            }),
        ],
    },
    unknown: { proto: 'unknown', raw: true, specs: [] },
    group: {
        proto: 'group',
        open: true,
        specs: [lane(uni(0), uni(1)), lane(uni(1), uni(2)), lane(uni(2), uni(3))],
    },
    groupAdd: {
        proto: 'groupAdd',
        specs: [
            op('nse.note.add', { created: 2 }),
            op('nse.note.add', { created: 2 }),
            op('nse.note.add', { created: 2 }),
        ],
    },
}

const rects = (root: Element, sel: Record<string, string>) => {
    const base = (root as HTMLElement).getBoundingClientRect()
    const r = (el: Element) => {
        const b = el.getBoundingClientRect()
        return [b.x - base.x, b.y - base.y, b.width, b.height]
    }
    const out: Record<string, number[][]> = { dialog: [[0, 0, base.width, base.height]] }
    for (const [key, css] of Object.entries(sel)) out[key] = [...root.querySelectorAll(css)].map(r)
    return out
}
const APP = {
    band: '.bg-header',
    title: '[data-operation-description]',
    meta: '[data-operation-time]',
    note: '[data-operation-unsupported]',
    dt: '[data-operation-record] dt',
    dd: '[data-operation-record] dd',
    fact: '[data-operation-fact]',
    h3: '[data-operation-count]',
    step: '[data-operation-children] > div > *',
    stime:
        '[data-operation-children] summary > span:last-child, [data-operation-step] > span:last-child',
}
const PROTO_SEL = {
    band: '.band',
    title: '.head .title',
    meta: '.head .meta',
    note: '.content > p',
    dt: '.facts dt',
    dd: '.facts dd',
    fact: '.lines li',
    h3: '.steps h3',
    step: '.steps .step',
    stime: '.steps .time',
}

const matrix: {
    f: string
    lang: string
    theme: 'light' | 'dark'
    w: 'desktop' | 'phone' | 'phone320'
}[] = []
for (const [f, family] of Object.entries(FAMILIES))
    for (const lang of family.langs ?? ['en'])
        for (const theme of ['light', 'dark'] as const)
            for (const w of ['desktop', 'phone', 'phone320'] as const)
                if (lang === 'en' || theme === 'light') matrix.push({ f, lang, theme, w })

test('fidelity', async ({ page, browser }) => {
    test.setTimeout(0)
    const report: string[] = []
    await load(page)
    const proto = await browser.newPage()
    for (const w of ['desktop', 'phone', 'phone320'] as const) {
        const size =
            w === 'desktop'
                ? { width: 1600, height: 1000 }
                : { width: w === 'phone' ? 390 : 320, height: 844 }
        await page.setViewportSize(size)
        await proto.setViewportSize(size)
        for (const m of matrix.filter((m) => m.w === w)) {
            const family = FAMILIES[m.f]!
            await page.evaluate(
                async ({ m, family, time }) => {
                    const { settings, appImport, historySteps } = window.editorTest
                    settings.locale = m.lang as never
                    settings.theme = m.theme as never
                    const [{ openOperationDetails }, { captureOperationRecipe }, operations] =
                        await Promise.all([
                            appImport<typeof import('../../src/editor/history/operationDetails')>(
                                '/src/editor/history/operationDetails.ts',
                            ),
                            appImport<typeof import('../../src/history/operationPresentation')>(
                                '/src/history/operationPresentation/index.ts',
                            ),
                            appImport<typeof import('../../src/history/operations')>(
                                '/src/history/operations/index.ts',
                            ),
                        ])
                    const members = family.raw
                        ? [
                              {
                                  description: {
                                      kind: 'edit',
                                      step: operations.captureStep({
                                          kind: 'edit',
                                          operation: operations.captureOperation({
                                              id: 'nse.future.thing',
                                              version: 1,
                                              data: {},
                                              fallback: {
                                                  text: 'Did a future thing',
                                                  locale: 'en',
                                              },
                                          } as never),
                                      }),
                                  } as never,
                                  time,
                                  id: 'm0',
                              },
                          ]
                        : family.specs.map((spec, i) => ({
                              description: {
                                  kind: 'edit',
                                  step: historySteps.editStep(
                                      (() => {
                                          try {
                                              return historySteps.nativeOperation(
                                                  spec.input as never,
                                                  'fixture',
                                              )
                                          } catch (error) {
                                              throw new Error(
                                                  m.f + JSON.stringify(spec.input) + String(error),
                                              )
                                          }
                                      })(),
                                  ),
                              } as never,
                              time: time - (family.specs.length - 1 - i) * 7000,
                              id: `m${i}`,
                          }))
                    void openOperationDetails(
                        captureOperationRecipe(members),
                        time,
                        undefined,
                        undefined,
                        { row: family.flags, members: new Map() },
                    )
                },
                { m, family, time: new Date(2026, 9, 19, 5, 34, 56).getTime() },
            )
            const dialog = page.locator('dialog[open]')
            await expect(dialog).toBeVisible()
            await expect(dialog.locator('[data-operation-details]').first()).toBeVisible()
            if (family.open) {
                await dialog.locator('summary').first().click()
                await expect(dialog.locator('[data-nested]')).toBeVisible()
            }
            const name = `${m.f}-${m.lang}-${m.w}-${m.theme}${family.open ? '-open' : ''}`
            await page.waitForTimeout(250)
            await dialog.screenshot({ path: `${OUT}/${name}.png` })
            const a = await dialog.evaluate(rects, APP)
            const q = new URLSearchParams({
                v: '2',
                c: family.proto,
                t: m.theme,
                w: m.w === 'desktop' ? 'desktop' : 'phone',
                lang: m.lang,
                open: family.open ? '1' : '0',
            })
            await proto.goto(`${PROTO}?${q}`)
            const p = await proto.locator('[data-dialog]').evaluate(rects, PROTO_SEL)
            for (const key of Object.keys(a)) {
                const A = a[key]!
                const P = p[key]!
                if (A.length !== P.length)
                    report.push(`${name} ${key}: count app ${A.length} proto ${P.length}`)
                for (let i = 0; i < Math.min(A.length, P.length); i++)
                    for (let k = 0; k < 4; k++)
                        if (Math.abs(A[i]![k]! - P[i]![k]!) > 1)
                            report.push(
                                `${name} ${key}[${i}] ${['x', 'y', 'w', 'h'][k]} app ${A[i]![k]!.toFixed(1)} proto ${P[i]![k]!.toFixed(1)}`,
                            )
            }
            await page.keyboard.press('Escape')
            await expect(dialog).toHaveCount(0)
        }
    }
    console.log(report.length ? report.join('\n') : 'NO DEVIATIONS')
})
