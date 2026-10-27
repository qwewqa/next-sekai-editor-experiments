import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { before, test } from 'node:test'
import { buildAll, renderSpec } from '../../builtin-assets/build.mjs'
import { omittedSprites, skinSprites } from '../../builtin-assets/manifest.mjs'
import { renderSvg } from '../../builtin-assets/svg.mjs'
import { readBuiltinItem, readFixture } from './helpers.mjs'
import { decode, pixelAt } from './pngDecode.mjs'

let first
let skin
let skinTexture

before(async () => {
    first = await buildAll()
    skin = readBuiltinItem('skin')
    skinTexture = decode(skin.resource('texture'))
})

test("the committed outputs are the build's outputs", () => {
    for (const [path, bytes] of first.files)
        assert.ok(
            readFileSync(new URL(`../../${path}`, import.meta.url)).equals(bytes),
            `${path} is stale; run npm run build:builtin-assets`,
        )
})

test('building twice gives the same bytes', async () => {
    const second = await buildAll()
    assert.deepEqual([...second.files.keys()], [...first.files.keys()])
    for (const [path, bytes] of first.files) assert.ok(second.files.get(path).equals(bytes), path)
})

test('the lock records every output with its sha256', () => {
    const lock = JSON.parse(first.files.get('builtin-assets/builtin-assets.lock.json'))
    for (const [path, bytes] of first.files) {
        if (path.endsWith('.lock.json')) continue
        assert.equal(
            lock.files[path].sha256,
            createHash('sha256').update(bytes).digest('hex'),
            path,
        )
    }
    assert.equal(lock.counts.skinNames, 1331)
    assert.equal(lock.counts.particleEffects, 505)
    assert.equal(lock.counts.clips, 15)
})

test('the skin has every engine sprite except those the set omits', () => {
    const fixture = readFixture()
    const names = new Set(skin.json('data').sprites.map((sprite) => sprite.name))
    assert.deepEqual(
        fixture.sprites.filter((name) => !names.has(name)),
        [...omittedSprites].sort(),
    )
    assert.equal(names.size, fixture.sprites.length - omittedSprites.length)
})

test('the particle and effect have every engine name', () => {
    const fixture = readFixture()
    const particle = readBuiltinItem('particle').json('data')
    const effects = new Set(particle.effects.map((effect) => effect.name))
    assert.deepEqual(
        fixture.particles.filter((name) => !effects.has(name)),
        [],
    )
    const clips = readBuiltinItem('effect')
        .json('data')
        .clips.map((clip) => clip.name)
    assert.deepEqual(
        fixture.clips.filter((name) => !clips.includes(name)),
        [],
    )
})

test('each package is a standard single-item SCP', () => {
    for (const type of ['skin', 'particle', 'background', 'effect']) {
        const { entries, item } = readBuiltinItem(type)
        assert.equal(item.name, 'nse-builtin')
        assert.equal(item.title, 'Editor')
        assert.equal(item.subtitle, 'Next SEKAI Editor')
        assert.ok(entries.has('sonolus/info'))
        assert.ok(entries.has(`sonolus/${type}s/info`))
        const list = JSON.parse(entries.get(`sonolus/${type}s/list`))
        assert.equal(list.items.length, 1)
        for (const field of ['thumbnail', 'data', 'texture', 'image', 'configuration', 'audio']) {
            if (!item[field]) continue
            const bytes = entries.get(item[field].url.slice(1))
            assert.equal(createHash('sha1').update(bytes).digest('hex'), item[field].hash)
        }
    }
})

test('the PNG matches the renderer for three sprites and the 32 px icon', async () => {
    const { sprites } = skinSprites()
    const rects = new Map(skin.json('data').sprites.map((sprite) => [sprite.name, sprite]))
    for (const name of [
        'Sekai Normal Note Left Neutral',
        'Sekai Flick Arrow Up 3',
        'Sekai Normal Slide Slot Glow',
    ]) {
        const rendered = await renderSpec(sprites.get(name))
        const { x, y, w, h } = rects.get(name)
        assert.equal(w, rendered.width)
        assert.equal(h, rendered.height)
        for (let row = 0; row < h; row++)
            for (let column = 0; column < w; column++)
                assert.deepEqual(
                    pixelAt(skinTexture, x + column, y + row),
                    [...rendered.data.subarray((row * w + column) * 4, (row * w + column) * 4 + 4)],
                    `${name} at ${column},${row}`,
                )
    }
    const icon = decode(first.files.get('builtin-assets/out/icon/app-icon-32.png'))
    const rendered = await renderSvg(
        readFileSync(
            new URL('../../builtin-assets/svg/app-icon-small.svg', import.meta.url),
            'utf8',
        ),
        32,
    )
    assert.equal(icon.width, 32)
    for (let i = 0; i < 32 * 32; i++)
        assert.deepEqual(pixelAt(icon, i % 32, Math.floor(i / 32)), [
            ...rendered.data.subarray(i * 4, i * 4 + 4),
        ])
})

test('un-premultiplying gives straight alpha and the expected colour', async () => {
    const rendered = await renderSvg(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><rect width="2" height="2" fill="#ff8000" fill-opacity="0.5"/></svg>',
    )
    const [r, g, b, a] = rendered.data
    assert.equal(a, 128)
    assert.equal(r, 255)
    assert.ok(Math.abs(g - 128) <= 1)
    assert.equal(b, 0)
})

test('stretch sprites extrude their edges into the gutter and the others have a clear gutter', () => {
    const { rects } = first.report.skin
    const seen = new Set()
    let stretch = 0
    let plain = 0
    for (const { x, y, w, h, stretch: stretches } of Object.values(rects)) {
        if (seen.has(`${x},${y}`)) continue
        seen.add(`${x},${y}`)
        if (stretches) stretch++
        else plain++
        for (let gy = -2; gy < h + 2; gy++)
            for (let gx = -2; gx < w + 2; gx++) {
                if (gx >= 0 && gx < w && gy >= 0 && gy < h) continue
                const got = pixelAt(skinTexture, x + gx, y + gy)
                if (stretches)
                    assert.deepEqual(
                        got,
                        pixelAt(
                            skinTexture,
                            x + Math.min(w - 1, Math.max(0, gx)),
                            y + Math.min(h - 1, Math.max(0, gy)),
                        ),
                    )
                else assert.deepEqual(got, [0, 0, 0, 0])
            }
    }
    assert.ok(stretch > 10 && plain > 10)
})

test('the textures and files stay within their budgets', () => {
    const skinData = skin.json('data')
    assert.ok(skinData.width <= 2048 && skinData.height <= 2048)
    // The arrow images, one per direction and width, are counted in.
    assert.ok(skinData.sprites.some((sprite) => sprite.name === 'Sekai Flick Arrow Up Left 6'))
    const particle = readBuiltinItem('particle').json('data')
    assert.ok(particle.width <= 512 && particle.height <= 512)
    const background = readBuiltinItem('background')
    // The background's soft detail costs more than a plain gradient (pass 7).
    const image = background.resource('image').length
    assert.ok(image <= 640 * 1024, `the background image is ${image} bytes`)
    let total = 0
    for (const [path, bytes] of first.files)
        if (path.startsWith('public/builtin/')) total += bytes.length
    assert.ok(total <= 2.5 * 1024 * 1024, `the set is ${total} bytes`)
})
