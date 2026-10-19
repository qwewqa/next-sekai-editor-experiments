import { expect, type BrowserContext, type Page } from '@playwright/test'

// Drives the real editor for the sample generators: pointer and keyboard input at chart positions,
// and a clock shared by the page (Playwright's) and the storage worker (a Date shim).

const prefix = 'sonolus-next-sekai-editor.'

/** The context's fake time: the page's clock and the storage worker's Date, moved together. */
export class SampleClock {
    /** Fake time minus real time. */
    private offset = 0
    private pages = new Set<Page>()

    constructor(
        readonly context: BrowserContext,
        private readonly start: number,
    ) {}

    get now() {
        return Date.now() + this.offset
    }

    async install() {
        this.offset = this.start - Date.now()
        // The worker's Date, from the offset at its load; jumps reach it through `__sampleOffset`.
        await this.context.route(/storage\.worker\.ts\?worker_file/, async (route) => {
            const response = await route.fetch()
            const shim =
                `{const R=Date;const off=()=>self.__sampleOffset??${this.offset};` +
                'class D extends R{constructor(...a){if(a.length)super(...a);else super(R.now()+off())}' +
                'static now(){return R.now()+off()}};self.Date=D}\n'
            await route.fulfill({ response, body: shim + (await response.text()) })
        })
        await this.context.clock.install({ time: this.start })
    }

    track(page: Page) {
        this.pages.add(page)
        page.on('close', () => this.pages.delete(page))
    }

    /** Moves time on by ms: due timers fire once, as after a laptop lid opens. */
    async pass(ms: number) {
        this.offset += ms
        await this.context.clock.fastForward(Math.round(ms))
        for (const page of this.pages)
            for (const worker of page.workers())
                await worker
                    .evaluate((offset) => {
                        ;(self as unknown as { __sampleOffset: number }).__sampleOffset = offset
                    }, this.offset)
                    .catch(() => undefined)
    }

    /** Moves time on to a wall time (local), for the start of a visit. */
    async passTo(time: number) {
        const ms = time - this.now
        if (ms > 0) await this.pass(ms)
    }
}

/** Seeds every page: the storage hooks, downloads for file actions. */
export const seedContext = (context: BrowserContext) =>
    context.addInitScript(() => {
        performance.setResourceTimingBufferSize(5000)
        // The storage worker for specs (`nseFlushTest`, `nseStorageTest`); `nse.*` keys are not dumped.
        localStorage.setItem('nse.test.storage', '{}')
        // Download browsers' file actions: Open through a file input, Export as a download.
        localStorage.setItem('nse.test.platform', JSON.stringify({ fileSystemAccess: false }))
    })

/** Waits until startup has opened the session this load continues. */
export const waitForStartup = (page: Page) =>
    expect
        .poll(
            () =>
                page.evaluate(async () => {
                    const url =
                        performance
                            .getEntriesByType('resource')
                            .map((entry) => entry.name)
                            .find((name) => new URL(name).pathname === '/src/startup/gate.ts') ??
                        '/src/startup/gate.ts'
                    const { startupGate } = (await import(
                        url
                    )) as typeof import('../../src/startup/gate')
                    return startupGate.phase
                }),
            { timeout: 30_000 },
        )
        .toBe('done')

declare global {
    interface Window {
        sampleApp: {
            point: (lane: number, beat: number) => { x: number; y: number }
            focus: (beat: number) => void
            notes: () => { beat: number; left: number; size: number }[]
            /** The undo stack's length and the head's label. */
            head: () => { length: number; name: string; state: number; seq: number }
            settled: () => boolean
            viewAt: () => string
        }
    }
}

/** Installs `window.sampleApp`: positions and counts read from the app's own modules. */
const installSampleApp = async () => {
    const urls = new Map(
        performance
            .getEntriesByType('resource')
            .map((entry) => [new URL(entry.name).pathname, entry.name]),
    )
    const appImport = <T>(pathname: string): Promise<T> => import(urls.get(pathname) ?? pathname)
    const { view } = await appImport<typeof import('../../src/editor/view')>('/src/editor/view.ts')
    const { settings } = await appImport<typeof import('../../src/settings')>('/src/settings.ts')
    const { bpms } =
        await appImport<typeof import('../../src/history/bpms')>('/src/history/bpms.ts')
    const { beatToTime } = await appImport<typeof import('../../src/state/integrals/bpms')>(
        '/src/state/integrals/bpms.ts',
    )
    const { describeStep } = await appImport<
        typeof import('../../src/history/operationPresentation')
    >('/src/history/operationPresentation/index.ts')
    const { i18n } = await appImport<typeof import('../../src/i18n')>('/src/i18n/index.ts')
    const { headStep, liveState, loadedSlotsForTests } =
        await appImport<typeof import('../../src/history/stack')>('/src/history/stack.ts')
    const { getAllEntities } =
        await appImport<typeof import('../../src/history/store')>('/src/history/store.ts')
    // The live state's identity: every edit, undo and redo gives a new one.
    const ids = new WeakMap<object, number>()
    let count = 0
    window.sampleApp = {
        point: (lane, beat) => ({
            x: view.x + view.w * (0.5 + (lane - view.lane) / settings.width),
            y: view.y + view.h / 2 - (beatToTime(bpms.value, beat) - view.time) * settings.pps,
        }),
        focus: (beat) => {
            // The view only: centred on the beat.
            view.time = beatToTime(bpms.value, beat)
            view.cursorTime = view.time
        },
        notes: () =>
            [...getAllEntities()]
                .filter((entity) => entity.type === 'note')
                .map((entity) => entity as unknown as { beat: number; left: number; size: number })
                .map(({ beat, left, size }) => ({ beat, left, size })),
        head: () => {
            let id = ids.get(liveState.value)
            if (id === undefined) ids.set(liveState.value, (id = ++count))
            const flusher = window.nseFlushTest?.flusher
            const session = flusher?.session
            return {
                length: loadedSlotsForTests().length,
                name: headStep.value
                    ? describeStep(headStep.value, {
                          locale: settings.locale,
                          strings: i18n.value,
                          now: Date.now(),
                      })
                    : '',
                state: id,
                seq: flusher && session ? flusher.newestSeq(session) : 0,
            }
        },
        viewAt: () => `${view.time},${view.lane},${settings.pps}`,
        settled: () => {
            const flusher = window.nseFlushTest?.flusher
            return !!flusher && !flusher.hasPending && !!flusher.session?.stored
        },
    }
}

/** One open editor tab. */
export class Editor {
    constructor(readonly page: Page) {}

    async ready() {
        await expect(this.page.locator('canvas.editor-chart')).toBeVisible({ timeout: 30_000 })
        await waitForStartup(this.page)
        await this.page.evaluate(installSampleApp)
    }

    static async visit(context: BrowserContext, clock: SampleClock) {
        const page = await context.newPage()
        clock.track(page)
        await page.goto('/')
        const editor = new Editor(page)
        await editor.ready()
        return editor
    }

    async reload() {
        await this.page.reload()
        await this.ready()
    }

    /** Waits until the view stops moving (a pan after an add, a zoom). */
    async still() {
        let last = ''
        for (let i = 0; i < 60; i++) {
            const at = await this.page.evaluate(() => window.sampleApp.viewAt())
            if (at === last) return
            last = at
            await this.page.waitForTimeout(40)
        }
    }

    async point(lane: number, beat: number) {
        await this.still()
        return this.page.evaluate(([lane, beat]) => window.sampleApp.point(lane, beat), [
            lane,
            beat,
        ] as const)
    }

    async focus(beat: number) {
        await this.page.evaluate((beat) => {
            window.sampleApp.focus(beat)
        }, beat)
        await this.page.waitForTimeout(100)
    }

    /** A shortcut, with no field focused. */
    async command(key: string) {
        await this.page.evaluate(() => {
            const active = document.activeElement
            if (active instanceof HTMLElement && active !== document.body) active.blur()
        })
        await this.page.keyboard.press(key)
    }

    async key(key: string) {
        await this.page.keyboard.press(key)
    }

    async click(lane: number, beat: number, modifiers: string[] = []) {
        const { x, y } = await this.point(lane, beat)
        for (const modifier of modifiers) await this.page.keyboard.down(modifier)
        await this.page.mouse.click(x, y)
        for (const modifier of modifiers) await this.page.keyboard.up(modifier)
    }

    async drag(from: [number, number], to: [number, number], steps = 8) {
        const a = await this.point(...from)
        const b = await this.point(...to)
        await this.page.mouse.move(a.x, a.y)
        await this.page.mouse.down()
        await this.page.mouse.move(b.x, b.y, { steps })
        await this.page.mouse.up()
    }

    async dragPixels(from: { x: number; y: number }, to: { x: number; y: number }, steps = 8) {
        await this.page.mouse.move(from.x, from.y)
        await this.page.mouse.down()
        await this.page.mouse.move(to.x, to.y, { steps })
        await this.page.mouse.up()
    }

    head() {
        return this.page.evaluate(() => window.sampleApp.head())
    }

    /** Runs an action and waits until it makes an entry; undefined when it never does. */
    async act(fn: () => Promise<unknown>, timeout = 3000) {
        const before = await this.head()
        await fn()
        for (let waited = 0; waited < timeout; waited += 50) {
            const after = await this.head()
            if (after.seq !== before.seq) return after
            await this.page.waitForTimeout(50)
        }
        return undefined
    }

    notes() {
        return this.page.evaluate(() => window.sampleApp.notes())
    }

    /** Waits until everything the tab has is stored. */
    async settled() {
        await expect
            .poll(() => this.page.evaluate(() => window.sampleApp.settled()), { timeout: 30_000 })
            .toBe(true)
    }

    /** Stores everything now, as a hide would. */
    async flush() {
        await this.page.evaluate(async () => {
            await window.nseFlushTest!.flusher.flush({ strict: true })
        })
    }
}

export { prefix }
