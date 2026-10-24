import { expect, test } from '@playwright/test'

// The post-deploy smoke test of our own static server, which the apps
// connect to: the live site's /builtin-server/ serves its info, its list and what the list names.
// It runs against the deployed site and is skipped otherwise:
//   PRODUCTION_TEST_URL=https://nse.qwewqa.dev npm run test:production -- builtinServer
const hosted = process.env.PRODUCTION_TEST_URL

test.describe('the live /builtin-server/', () => {
    test.skip(!hosted, 'Set PRODUCTION_TEST_URL to run it against the deployed site')

    test('serves its info, and what its list names', async ({ request }) => {
        const info = await request.get('/builtin-server/sonolus/info')
        expect(info.ok()).toBe(true)
        const list = (await (await request.get('/builtin-server/sonolus/skins/list')).json()) as {
            items: { name: string; texture: { url: string } }[]
        }
        expect(list.items.map((item) => item.name)).toEqual(['nse-builtin'])
        const texture = await request.get(`/builtin-server${list.items[0]!.texture.url}`)
        expect(texture.ok()).toBe(true)
    })
})
