import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'

// The release serves the Built-in packages and the static server made from them.
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

test('a Built-in package is served as it was released', async ({ request }) => {
    const manifest = (await (await request.get('/release-manifest.json')).json()) as {
        files: Record<string, string>
    }
    const response = await request.get('/builtin/skin.scp')
    expect(response.ok()).toBe(true)
    expect(sha256(await response.body())).toBe(manifest.files['builtin/skin.scp'])
    // A ZIP: its end record is in the last bytes.
    expect((await response.body()).subarray(0, 2).toString()).toBe('PK')
})

test('the Built-in server lists one skin and serves what it names', async ({ request }) => {
    const info = (await (await request.get('/builtin-server/sonolus/info')).json()) as {
        title: string
        buttons: { type: string }[]
    }
    expect(info.title).toBe('Built-in Items')
    expect(info.buttons.map((button) => button.type)).toEqual([
        'skin',
        'particle',
        'background',
        'effect',
    ])
    const list = (await (await request.get('/builtin-server/sonolus/skins/list')).json()) as {
        pageCount: number
        items: { name: string; texture: { url: string; hash: string } }[]
    }
    expect(list.pageCount).toBe(1)
    expect(list.items.map((item) => item.name)).toEqual(['nse-builtin'])
    const details = await request.get('/builtin-server/sonolus/skins/nse-builtin')
    expect(details.ok()).toBe(true)
    const texture = await request.get(`/builtin-server${list.items[0]!.texture.url}`)
    expect(texture.ok()).toBe(true)
    expect(
        createHash('sha1')
            .update(await texture.body())
            .digest('hex'),
    ).toBe(list.items[0]!.texture.hash)
})

test('a Built-in package answers a range, so the dialog can read its picture alone', async ({
    request,
}) => {
    const response = await request.get('/builtin/effect.scp', {
        headers: { Range: 'bytes=0-1', 'Accept-Encoding': 'identity' },
    })
    expect(response.status()).toBe(206)
    expect((await response.body()).toString()).toBe('PK')
})
