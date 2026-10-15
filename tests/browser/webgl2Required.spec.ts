import { expect, test } from '@playwright/test'

test('editor, cover and preview reject missing WebGL2 without requesting a legacy context', async ({
    page,
}) => {
    await page.route('**/__webgl2-required', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }),
    )
    await page.goto('/__webgl2-required')
    const result = await page.evaluate(async () => {
        const { RenderingResources } = await import('/src/rendering/resources.ts')
        const { ImageSampler } = await import('/src/rendering/imageSampling.ts')
        const { createPreviewRenderer } = await import('/src/preview/gl.ts')
        const original = HTMLCanvasElement.prototype.getContext
        const requests: { kind: string; antialias: boolean }[] = []
        const targets = new WeakSet<HTMLCanvasElement>()
        const target = () => {
            const canvas = document.createElement('canvas')
            targets.add(canvas)
            return canvas
        }
        let owner = ''
        HTMLCanvasElement.prototype.getContext = function (
            this: HTMLCanvasElement,
            kind: string,
            ...args: unknown[]
        ) {
            if (
                (targets.has(this) || owner === 'cover') &&
                (kind === 'webgl2' || kind === 'webgl')
            ) {
                requests.push({
                    kind,
                    antialias: !!(args[0] as WebGLContextAttributes | undefined)?.antialias,
                })
                // Make the legacy context obtainable so a fallback attempt is
                // distinguishable from correctly rejecting the missing capability.
                return kind === 'webgl' ? {} : null
            }
            return Reflect.apply(original, this, [kind, ...args])
        } as typeof original
        try {
            return (
                [
                    ['editor', () => new RenderingResources(target())],
                    ['cover', () => new ImageSampler()],
                    ['preview', () => createPreviewRenderer(target())],
                    ['previewWithoutAntialias', () => createPreviewRenderer(target(), false)],
                ] as const
            ).map(([name, create]) => {
                requests.length = 0
                owner = name
                let message = ''
                try {
                    create()
                } catch (error) {
                    message = error instanceof Error ? error.message : String(error)
                }
                return { name, message, requests: requests.slice() }
            })
        } finally {
            HTMLCanvasElement.prototype.getContext = original
        }
    })
    expect(result).toEqual([
        {
            name: 'editor',
            message: 'Unable to create the editor WebGL2 context',
            requests: [{ kind: 'webgl2', antialias: true }],
        },
        {
            name: 'cover',
            message: 'Unable to initialize the WebGL2 cover image sampler',
            requests: [{ kind: 'webgl2', antialias: false }],
        },
        {
            name: 'preview',
            message: 'WebGL2 is unavailable or disabled in this browser',
            requests: [
                { kind: 'webgl2', antialias: true },
                { kind: 'webgl2', antialias: false },
            ],
        },
        {
            name: 'previewWithoutAntialias',
            message: 'WebGL2 is unavailable or disabled in this browser',
            requests: [{ kind: 'webgl2', antialias: false }],
        },
    ])
})
