import {
    CATEGORIES,
    chartModel,
    ROWS,
    timeTicks,
    type Category,
    type ChartMode,
    type ChartStatistics,
    type Row,
    type StatisticsStrings,
} from '../../levelData/statistics'
import { formatIntegerTime } from '../../utils/format'
import { formatCount } from '../../utils/size'
import { drawChart, yLabel } from './drawing'
import { chartCategoryColors } from './marks'

// The share card: 800 x 450 units drawn at 1600 x 900 px, built like a dialog: a band with the
// cover, the title, the artists, the author and the rating; Combo and the list's rows; the
// dialog's chart in its mode and selection with its key; the link and the product's name.

const WIDTH = 800
const HEIGHT = 450
const SCALE = 2
const PAD = 16

export type Rgb = readonly [number, number, number]
/** The theme's colours; `recess` is the cover tile's background, a CSS colour over the band. */
export type CardTheme = { modal: Rgb; header: Rgb; fg: Rgb; recess: string; dark: boolean }

export type CardInput = {
    info: { title: string; artists: string; author: string; rating?: number }
    cover?: CanvasImageSource & { width: number; height: number }
    link: string
    stats: ChartStatistics
    every: Float64Array
    bgmEnd: number | undefined
    drawable: boolean
    chosen: readonly Category[]
    mode: ChartMode
    glyphs: Partial<Record<Row, CanvasImageSource>>
    theme: CardTheme
    fontFamily: string
    locale: string
    strings: Pick<
        StatisticsStrings,
        'rows' | 'categories' | 'combo' | 'notesPerSecond' | 'noNotes'
    > & {
        untitled: string
        author: string
        rating: string
        product: string
    }
}

const rgba = ([r, g, b]: Rgb, alpha = 1) => `rgb(${r} ${g} ${b} / ${alpha})`

// --- Text: Intl.Segmenter where the browser has it; otherwise code points, and words at spaces
// with each CJK character a word of its own.
const segmenter = (granularity: 'grapheme' | 'word') =>
    typeof Intl.Segmenter === 'function'
        ? new Intl.Segmenter(undefined, { granularity })
        : undefined
const graphemes = (text: string) => {
    const each = segmenter('grapheme')
    return each ? Array.from(each.segment(text), (part) => part.segment) : Array.from(text)
}
const fallbackWords =
    /[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]|[^\s\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]+|\s+/gu
const words = (text: string) => {
    const each = segmenter('word')
    return each
        ? Array.from(each.segment(text), (part) => part.segment)
        : (text.match(fallbackWords) ?? [])
}

/** Lines that fit `width`, at most `max`, the last cut with an ellipsis. */
const wrap = (
    g: CanvasRenderingContext2D,
    text: string,
    width: number,
    max: number,
    byCharacter = false,
) => {
    const lines: string[] = []
    let current = ''
    const push = (piece: string) => {
        if (g.measureText(current + piece).width <= width) {
            current += piece
            return
        }
        if (current.trim()) {
            lines.push(current.trimEnd())
            current = ''
        }
        piece = piece.trimStart()
        if (g.measureText(piece).width <= width) {
            current = piece
            return
        }
        for (const character of graphemes(piece)) {
            if (g.measureText(current + character).width > width) {
                lines.push(current)
                current = ''
            }
            current += character
        }
    }
    for (const piece of byCharacter ? graphemes(text) : words(text)) push(piece)
    if (current.trim()) lines.push(current.trimEnd())
    if (lines.length <= max) return lines
    const kept = lines.slice(0, max)
    const last = graphemes(lines.slice(max - 1).join(' '))
    while (last.length && g.measureText(`${last.join('')}…`).width > width) last.pop()
    kept[max - 1] = `${last.join('').trimEnd()}…`
    return kept
}

/** A rounded rectangle path: `roundRect` where it exists, else four arcs (Firefox before 112). */
const roundRect = (
    g: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
) => {
    g.beginPath()
    if (typeof g.roundRect === 'function') {
        g.roundRect(x, y, width, height, radius)
        return
    }
    const r = Math.max(0, Math.min(radius, width / 2, height / 2))
    g.moveTo(x + r, y)
    g.arcTo(x + width, y, x + width, y + height, r)
    g.arcTo(x + width, y + height, x, y + height, r)
    g.arcTo(x, y + height, x, y, r)
    g.arcTo(x, y, x + width, y, r)
    g.closePath()
}

/** Draws the card on a canvas, which it sizes to 1600 x 900. */
export const drawCard = (canvas: HTMLCanvasElement, input: CardInput) => {
    const { theme, strings, locale } = input
    canvas.width = WIDTH * SCALE
    canvas.height = HEIGHT * SCALE
    const g = canvas.getContext('2d')
    if (!g) throw new Error('No 2D context')
    g.setTransform(SCALE, 0, 0, SCALE, 0, 0)
    const font = (size: number, weight = 400) => `${weight} ${size}px ${input.fontFamily}`
    g.fillStyle = rgba(theme.modal)
    g.fillRect(0, 0, WIDTH, HEIGHT)

    // Each text trimmed at both ends.
    const title = input.info.title.trim()
    const artists = input.info.artists.trim()
    const author = input.info.author.trim()
    const rating = input.info.rating

    // --- The band.
    const coverSize = input.cover ? 88 : 0
    const textX = PAD + (coverSize ? coverSize + PAD : 0)
    const ratingInset = 32
    const ratingSize = 36
    const ratingLabelSize = Math.max(13, Math.round(ratingSize * 0.42))
    let ratingWidth = 0
    if (rating !== undefined) {
        g.font = font(ratingLabelSize, 700)
        const labelWidth = g.measureText(strings.rating).width
        g.font = font(ratingSize, 700)
        ratingWidth =
            Math.max(labelWidth, g.measureText(formatCount(rating, locale)).width) + ratingInset
    }
    const textWidth = WIDTH - PAD - ratingWidth - textX
    g.font = font(26, 700)
    const titleLines = wrap(g, title || strings.untitled, textWidth, 2)
    g.font = font(15)
    const artistLines = artists ? wrap(g, artists, textWidth, 1) : []
    g.font = font(15, 700)
    const authorLabelWidth = author ? g.measureText(`${strings.author} `).width : 0
    g.font = font(15)
    const authorLines = author ? wrap(g, author, textWidth - authorLabelWidth, 1) : []
    const lineHeight = 26 * 1.25
    const metaHeight = 15 * 1.4
    const textHeight =
        titleLines.length * lineHeight +
        (artistLines.length + authorLines.length) * metaHeight +
        (artistLines.length || authorLines.length ? 4 : 0)
    const ratingBlock = 0.72 * ratingLabelSize + 7 + 0.72 * ratingSize
    const bandHeight = Math.max(
        coverSize ? coverSize + 2 * PAD : 0,
        textHeight + 2 * PAD,
        rating !== undefined ? ratingBlock + 2 * PAD : 0,
    )
    g.fillStyle = rgba(theme.header)
    g.fillRect(0, 0, WIDTH, bandHeight)
    if (input.cover) {
        // An inset translucent outline over the cover's edge, with a soft shadow under it in light.
        const x = PAD
        const y = PAD
        g.save()
        if (!theme.dark) {
            g.shadowColor = 'rgb(0 0 0 / 0.1)'
            g.shadowBlur = 6
            g.shadowOffsetY = 4
            roundRect(g, x, y, coverSize, coverSize, 12)
            g.fillStyle = rgba(theme.header)
            g.fill()
        }
        g.restore()
        // A cover that is not square is fitted and centred in its tile, as Level Info shows it.
        g.save()
        roundRect(g, x, y, coverSize, coverSize, 12)
        g.clip()
        g.fillStyle = theme.recess
        g.fillRect(x, y, coverSize, coverSize)
        const fit = coverSize / Math.max(input.cover.width, input.cover.height, 1)
        const width = input.cover.width * fit
        const height = input.cover.height * fit
        g.drawImage(
            input.cover,
            x + (coverSize - width) / 2,
            y + (coverSize - height) / 2,
            width,
            height,
        )
        g.restore()
        g.strokeStyle = theme.dark ? 'rgb(255 255 255 / 0.15)' : 'rgb(0 0 0 / 0.12)'
        g.lineWidth = 1
        roundRect(g, x + 0.5, y + 0.5, coverSize - 1, coverSize - 1, 11.5)
        g.stroke()
    }
    g.fillStyle = rgba(theme.fg)
    g.textBaseline = 'alphabetic'
    g.textAlign = 'left'
    let textY = (bandHeight - textHeight) / 2
    g.font = font(26, 700)
    for (const line of titleLines) {
        textY += lineHeight
        g.fillText(line, textX, textY - lineHeight * 0.22)
    }
    if (artistLines.length || authorLines.length) textY += 4
    g.font = font(15)
    for (const line of artistLines) {
        textY += metaHeight
        g.fillText(line, textX, textY - metaHeight * 0.25)
    }
    const [authorLine] = authorLines
    if (authorLine !== undefined) {
        textY += metaHeight
        g.font = font(15, 700)
        g.fillText(strings.author, textX, textY - metaHeight * 0.25)
        g.font = font(15)
        g.fillText(authorLine, textX + authorLabelWidth, textY - metaHeight * 0.25)
    }
    if (rating !== undefined) {
        // The label over the figure, one block centred on the band's middle.
        const right = WIDTH - ratingInset
        const middle = bandHeight / 2
        g.textAlign = 'right'
        g.font = font(ratingLabelSize, 700)
        g.fillText(strings.rating, right, middle - ratingBlock / 2 + 0.72 * ratingLabelSize)
        g.font = font(ratingSize, 700)
        g.fillText(formatCount(rating, locale), right, middle + ratingBlock / 2)
        g.textAlign = 'left'
    }

    // --- The footer's height: the link's lines, or the product's name alone.
    g.font = font(12)
    const productWidth = g.measureText(strings.product).width + 24
    g.font = font(14)
    const linkLines = input.link ? wrap(g, input.link, WIDTH - 2 * PAD - productWidth, 2, true) : []
    const footerHeight = linkLines.length ? linkLines.length * 18 + 4 : 20

    // --- Combo and the rows: every non-zero Combo row, none cut.
    const top = bandHeight + PAD
    const listWidth = 236
    g.fillStyle = rgba(theme.fg, 0.8)
    g.font = font(14, 700)
    g.fillText(strings.combo, PAD, top + 14)
    g.fillStyle = rgba(theme.fg)
    g.font = font(44, 700)
    g.fillText(formatCount(input.stats.combo, locale), PAD, top + 18 + 44 * 0.95)
    const rowsTop = top + 18 + 44 * 1.1 + 6
    const rowsBottom = HEIGHT - PAD - footerHeight - 8
    const rows = ROWS.filter((row) => row !== 'fakeNote' && input.stats.counts[row])
    const pitch = Math.max(17, Math.min(27, (rowsBottom - rowsTop) / Math.max(1, rows.length)))
    const small = pitch < 19
    g.lineWidth = 1
    rows.forEach((row, i) => {
        const y = rowsTop + i * pitch
        g.strokeStyle = rgba(theme.fg, i ? 0.15 : 0.25)
        g.beginPath()
        g.moveTo(PAD, y + 0.5)
        g.lineTo(PAD + listWidth, y + 0.5)
        g.stroke()
        const middle = y + pitch / 2
        const glyph = input.glyphs[row]
        const glyphSize = small ? 15 : 18
        if (glyph) g.drawImage(glyph, PAD, middle - glyphSize / 2, glyphSize, glyphSize)
        const value = formatCount(input.stats.counts[row], locale)
        g.fillStyle = rgba(theme.fg)
        g.font = font(small ? 13.5 : 15)
        g.textBaseline = 'middle'
        g.textAlign = 'right'
        g.fillText(value, PAD + listWidth, middle)
        const valueWidth = g.measureText(value).width
        g.textAlign = 'left'
        const [name = ''] = wrap(g, strings.rows[row], listWidth - valueWidth - 12 - 26, 1)
        g.fillText(name, PAD + 26, middle)
        g.textBaseline = 'alphabetic'
    })

    // --- Notes per Second: the dialog's chart in its mode, with its key at the right.
    const chartX = PAD + listWidth + 32
    const chartWidth = WIDTH - PAD - chartX
    g.fillStyle = rgba(theme.fg)
    g.font = font(15, 700)
    g.fillText(strings.notesPerSecond, chartX, top + 15)
    // The plot's edges on whole pixels of the 2x canvas, so its tiles and gridlines are crisp.
    const snap = (units: number) => Math.round(units * SCALE) / SCALE
    const plotTop = snap(top + 15 + 14)
    const plotHeight = snap(HEIGHT - top - 29 - 22 - footerHeight - PAD - 8)
    const plotBottom = plotTop + plotHeight
    const ink = input.mode === 'rolling'
    // The key: one line per chosen category that has notes, in stacking order from the baseline.
    const key = CATEGORIES.filter(
        (category) => input.chosen.includes(category) && input.stats.times[category].length,
    )
    const markWidth = ink ? 0 : 11
    const markGap = markWidth ? 6 : 0
    g.font = font(13.5)
    const keyWidth =
        markWidth +
        markGap +
        Math.max(...CATEGORIES.map((category) => g.measureText(strings.categories[category]).width))
    const keyX = chartX + chartWidth - keyWidth
    g.textBaseline = 'middle'
    key.forEach((category, i) => {
        const y = plotBottom - i * 20 - 5
        if (markWidth) {
            roundRect(g, keyX, y - 5.5, 11, 11, 2.5)
            g.fillStyle = chartCategoryColors[category]
            g.fill()
            g.strokeStyle = 'rgb(0 0 0 / 0.3)'
            g.lineWidth = 1
            roundRect(g, keyX + 0.5, y - 5, 10, 10, 2)
            g.stroke()
        }
        g.fillStyle = rgba(theme.fg)
        g.fillText(strings.categories[category], keyX + markWidth + markGap, y)
    })
    g.textBaseline = 'alphabetic'
    const left = chartX + 28
    const right = keyX - 14
    const chosen = CATEGORIES.filter((category) => input.chosen.includes(category))
    const times = chosen.map((category) => input.stats.times[category])
    const hasNotes = times.some((list) => list.length > 0)
    if (input.drawable && !hasNotes) {
        g.fillStyle = rgba(theme.fg, 0.8)
        g.font = font(14)
        g.textAlign = 'center'
        g.textBaseline = 'middle'
        g.fillText(strings.noNotes, (left + right) / 2, plotTop + plotHeight / 2)
        g.textBaseline = 'alphabetic'
        g.textAlign = 'left'
    }
    const model =
        input.drawable && hasNotes
            ? chartModel(
                  input.mode,
                  input.every,
                  times,
                  input.bgmEnd,
                  Math.round((right - left) * 2),
              )
            : undefined
    if (model) {
        // The plot's origin on a whole pixel of the 2x canvas, as the dialog's on the screen.
        const originX = snap(left)
        const drawing = drawChart(model, right - originX, plotHeight, SCALE, 3)
        g.save()
        g.translate(originX, plotTop)
        g.font = font(13)
        g.textBaseline = 'middle'
        g.textAlign = 'right'
        for (const line of drawing.grid) {
            g.strokeStyle = rgba(theme.fg, 0.15)
            g.lineWidth = drawing.gridWidth
            g.beginPath()
            g.moveTo(0, line.y)
            g.lineTo(drawing.width, line.y)
            g.stroke()
            g.fillStyle = rgba(theme.fg, 0.8)
            g.fillText(yLabel(line.value, locale), -6, drawing.py(line.value))
        }
        // The dialog's own paths: Bars' tiles, Rolling's wash and line in ink, or Smooth's layers.
        if (model.bins) {
            for (const tile of drawing.tiles) {
                g.fillStyle = chartCategoryColors[chosen[tile.layer] ?? 'tap']
                g.fillRect(tile.x, tile.y, tile.width, tile.height)
            }
        } else if (model.steps) {
            g.fillStyle = rgba(theme.fg, 0.12)
            g.fill(new Path2D(drawing.wash))
            g.strokeStyle = rgba(theme.fg)
            g.lineWidth = 1
            g.lineJoin = 'round'
            g.stroke(new Path2D(drawing.lines[drawing.lines.length - 1]))
        } else
            drawing.areas.forEach((area, j) => {
                g.fillStyle = chartCategoryColors[chosen[j] ?? 'tap']
                g.fill(new Path2D(area))
            })
        // The time labels: the dialog's steps, at most six.
        g.fillStyle = rgba(theme.fg, 0.8)
        g.font = font(13)
        g.textBaseline = 'top'
        for (const time of timeTicks(model.x1, 6)) {
            const x = drawing.px(time)
            g.textAlign = x > drawing.width - 20 ? 'right' : x < 20 ? 'left' : 'center'
            g.fillText(formatIntegerTime(time), x, plotHeight + 5)
        }
        g.restore()
    }
    g.textBaseline = 'alphabetic'
    g.textAlign = 'left'

    // --- The footer: the link in ink, the product's name in fg/80 at the right.
    const footerY = HEIGHT - PAD
    g.font = font(12)
    g.fillStyle = rgba(theme.fg, 0.8)
    g.textAlign = 'right'
    g.fillText(strings.product, WIDTH - PAD, footerY)
    g.textAlign = 'left'
    g.fillStyle = rgba(theme.fg)
    g.font = font(14)
    linkLines.forEach((line, i) => {
        g.fillText(line, PAD, footerY - (linkLines.length - 1 - i) * 18)
    })
}
