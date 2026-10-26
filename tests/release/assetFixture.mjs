import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

// A coconut-like server for the preview asset scripts: every item has the same resources.

export const hash = (bytes) => createHash('sha1').update(bytes).digest('hex')
export const data = gzipSync(
    JSON.stringify({ width: 1, height: 1, sprites: [], effects: [], clips: [] }),
)
export const texture = Buffer.from('texture fixture')
export const audio = Buffer.from('audio fixture')
export const thumbnail = Buffer.from('thumbnail fixture')

export function server(t, options = {}) {
    const urls = []
    t.mock.method(globalThis, 'fetch', async (input) => {
        const url = new URL(input)
        urls.push(url.href)
        if (url.pathname.endsWith('/data')) return new Response(data)
        if (url.pathname.endsWith('/texture')) return new Response(texture)
        if (url.pathname.endsWith('/audio')) return new Response(audio)
        if (url.pathname.endsWith('/thumbnail')) return new Response(thumbnail)
        return Response.json({
            item: {
                name: 'fixture',
                title: options.title || 'Fixture skin',
                author: 'Fixture author',
                tags: [{ title: options.likes || '100', icon: 'heartHollow' }],
                authorUser: { name: 'author', tags: [{ title: options.authorTag || '#OWNER' }] },
                data: {
                    url: '/data',
                    hash: options.missingHash
                        ? undefined
                        : options.badHash
                          ? '0'.repeat(40)
                          : hash(data),
                },
                texture: { url: 'https://cdn.example/texture', hash: hash(texture) },
                audio: { url: 'https://cdn.example/audio', hash: hash(audio) },
                ...(!options.noThumbnail && {
                    thumbnail: {
                        url: 'https://cdn.example/thumbnail',
                        hash: options.badThumbnail ? '0'.repeat(40) : hash(thumbnail),
                    },
                }),
            },
        })
    })
    return urls
}

export async function temporary(t) {
    const directory = await mkdtemp(join(tmpdir(), 'sekai-assets-test-'))
    t.after(async () => {
        assert.equal(dirname(directory), resolve(tmpdir()))
        assert.ok(directory.startsWith(join(tmpdir(), 'sekai-assets-test-')))
        await rm(directory, { recursive: true, force: true })
    })
    return directory
}
