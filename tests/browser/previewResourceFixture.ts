import type { Page, Route } from '@playwright/test'
// The handle's global type.
import { SkinSpriteName } from '@sonolus/core'
import { gzipSync } from 'node:zlib'
import type {} from '../../src/preview/previewTest'
import { rawZip } from '../zip/rawZip'

// Tiny in-memory packages keep these tests independent of optional local skins.
export const archive = (entries: Record<string, Buffer>) =>
    Buffer.from(
        rawZip(Object.entries(entries).map(([name, data]) => ({ name, data, method: 0 as const }))),
    )

const texture = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
    'base64',
)
type Fixture = {
    title?: string
    author?: string
    /** Packs the one-pixel picture as the item's thumbnail. */
    picture?: boolean
}

export const resource = (kind: 'skins' | 'particles', options: Fixture = {}) =>
    archive({
        [`sonolus/${kind}/list`]: Buffer.from(
            JSON.stringify({
                items: [
                    {
                        name: 'fixture',
                        title: options.title ?? 'Fixture',
                        ...(options.author && { author: options.author }),
                        data: { url: '/data' },
                        texture: { url: '/texture' },
                        ...(options.picture && { thumbnail: { url: '/thumbnail' } }),
                    },
                ],
            }),
        ),
        data: gzipSync(
            JSON.stringify({
                width: 1,
                height: 1,
                interpolation: true,
                effects: [],
                sprites:
                    kind === 'particles'
                        ? []
                        : Object.values(SkinSpriteName).map((name) => ({
                              name,
                              x: 0,
                              y: 0,
                              w: 1,
                              h: 1,
                              transform: Object.fromEntries(
                                  ['x1', 'x2', 'x3', 'x4', 'y1', 'y2', 'y3', 'y4'].map((key) => [
                                      key,
                                      { [key]: 1 },
                                  ]),
                              ),
                          })),
            }),
        ),
        texture,
        ...(options.picture && { thumbnail: texture }),
    })

/**
 * Answers a request for part of a package as a host with ranges would: 206 with the bytes and a
 * Content-Range, or the whole file when no range was asked for.
 */
export const serveRanges = async (
    route: Route,
    body: Buffer,
    type = 'application/octet-stream',
): Promise<void> => {
    const range = /^bytes=(\d*)-(\d*)$/.exec((await route.request().allHeaders())['range'] ?? '')
    if (!range) return route.fulfill({ body, contentType: type })
    const size = body.length
    const [first = '', last = ''] = range.slice(1)
    const start = first === '' ? Math.max(0, size - Number(last)) : Number(first)
    const end = first === '' || last === '' ? size - 1 : Math.min(size - 1, Number(last))
    return route.fulfill({
        status: 206,
        body: body.subarray(start, end + 1),
        contentType: type,
        headers: { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' },
    })
}

/** The selection outline's pixels with any alpha, in either preview host. */
export const outlinePixels = (page: Page) =>
    page.evaluate(() => window.nsePreviewTest?.outlinePixels() ?? 0)
