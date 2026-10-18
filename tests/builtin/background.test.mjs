import assert from 'node:assert/strict'
import { test } from 'node:test'
import { color } from '../../builtin-assets/background.mjs'
import { readBuiltinItem } from './helpers.mjs'
import { decode, pixelAt } from './pngDecode.mjs'

const background = readBuiltinItem('background')
const image = decode(background.resource('image'))
const fill = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16))
const luma = (x, y) => {
    const [r, g, b] = pixelAt(image, x, y)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

test('the image is 16:9, covers, and fills around with the colour its margins fade to', () => {
    const data = background.json('data')
    assert.equal(data.fit, 'cover')
    assert.equal(data.color, color)
    assert.equal(image.width * 9, image.height * 16)
    assert.ok(image.height >= 1080)
    // Every edge pixel is the fill, so a zoomed-out camera shows no edge.
    for (let x = 0; x < image.width; x++)
        for (const y of [0, image.height - 1])
            pixelAt(image, x, y)
                .slice(0, 3)
                .forEach((value, i) => assert.ok(Math.abs(value - fill[i]) <= 1, `${x}, ${y}`))
    for (let y = 0; y < image.height; y++)
        for (const x of [0, image.width - 1])
            pixelAt(image, x, y)
                .slice(0, 3)
                .forEach((value, i) => assert.ok(Math.abs(value - fill[i]) <= 1, `${x}, ${y}`))
})

test('the middle has detail at several scales, at low contrast', () => {
    // Differences between points a step apart over the middle half: specks show in short steps,
    // clouds and mottle in long ones. A plain gradient (main's, before pass 7) has a mean under
    // 0.6 at 24 pixels and a most of 2 at 3; the base's picture has means of 4 to 16 and a most of 80.
    const { width, height } = image
    const differences = (step) => {
        let sum = 0
        let count = 0
        let most = 0
        for (let y = height / 4; y < (height * 3) / 4 - step; y += 7)
            for (let x = width / 4; x < (width * 3) / 4 - step; x += 7) {
                const d = Math.abs(luma(x, y) - luma(x + step, y + step))
                sum += d
                most = Math.max(most, d)
                count++
            }
        return { mean: sum / count, most }
    }
    const [fine, middle, broad] = [3, 24, 160].map(differences)
    assert.ok(fine.most > 8, `specks: most ${fine.most}`)
    assert.ok(middle.mean > 1.5, `mottle: mean ${middle.mean}`)
    assert.ok(broad.mean > 2, `clouds: mean ${broad.mean}`)
    for (const { mean, most } of [fine, middle, broad]) assert.ok(mean < 8 && most < 64)
    let total = 0
    for (let y = 0; y < height; y += 5) for (let x = 0; x < width; x += 5) total += luma(x, y)
    const mean = total / Math.ceil(height / 5) / Math.ceil(width / 5)
    assert.ok(mean > 20 && mean < 50, `mean luma ${mean}`)
})
