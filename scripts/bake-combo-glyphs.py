"""Bakes the preview combo's glyphs from Outfit into src/preview/engine/comboGlyphs.ts.

Usage:
    uv run --with fonttools==4.68.0 --with skia-pathops==0.9.2 --with uharfbuzz==0.57.0 \
        python scripts/bake-combo-glyphs.py <Outfit[wght].ttf>

The font is Outfit 1.100 from google/fonts at commit FONT_COMMIT, ofl/outfit/Outfit[wght].ttf
(https://raw.githubusercontent.com/google/fonts/<FONT_COMMIT>/ofl/outfit/Outfit%5Bwght%5D.ttf).
It is not committed: this script and its pinned hash are enough to make the module again.

The outlines are written as instancing and overlap removal leave them, with no rounding, so
every coordinate is the shortest decimal that reads back to the same double. The bounds, flat
edges, areas and centroids are measured on the written path data, parsed back, so they describe
what Path2D draws.
"""

import hashlib
import io
import re
import sys
from pathlib import Path

import uharfbuzz as hb
from fontTools.pens.basePen import BasePen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.statisticsPen import StatisticsPen
from fontTools.ttLib import TTFont
from fontTools.ttLib.removeOverlaps import removeOverlaps
from fontTools.varLib import instancer

FONT_COMMIT = '5f246070882b903ed95a911dba83d9d4a6836152'
FONT_SHA256 = 'fc7287273e66929776e2ba54f144fe699080bec29f61bf649d70d871468aeade'
WEIGHT = 600
LABEL_WEIGHT = 700
DIGITS = '0123456789'
LETTERS = 'COMB'
LABEL = 'COMBO'

OUT = Path(__file__).resolve().parent.parent / 'src/preview/engine/comboGlyphs.ts'


def number(value):
    """The shortest decimal that reads back to the same double, without a trailing .0."""
    value = float(value)
    if value == 0:
        return '0'
    if value.is_integer() and abs(value) < 1e15:
        return str(int(value))
    return repr(value)


class SvgPen(BasePen):
    """SVG path data with absolute M, L, Q and Z only. Implied on-curve points become explicit."""

    def __init__(self, glyphSet):
        super().__init__(glyphSet)
        self.parts = []

    def point(self, pt):
        return f'{number(pt[0])} {number(pt[1])}'

    def _moveTo(self, pt):
        self.parts.append('M' + self.point(pt))

    def _lineTo(self, pt):
        self.parts.append('L' + self.point(pt))

    def _qCurveToOne(self, pt1, pt2):
        self.parts.append('Q' + self.point(pt1) + ' ' + self.point(pt2))

    def _curveToOne(self, pt1, pt2, pt3):
        raise ValueError('The outlines must be quadratic')

    def _closePath(self):
        self.parts.append('Z')

    def _endPath(self):
        raise ValueError('Every contour must be closed')

    def data(self):
        return ''.join(self.parts)


TOKEN = re.compile(r'[MLQZ]|-?[0-9.]+(?:e-?[0-9]+)?')


def segments(d):
    """The contours of written path data, as lists of segments, each a list of points."""
    tokens = TOKEN.findall(d)
    if ''.join(tokens) != d.replace(' ', ''):
        raise ValueError('Unexpected path data')
    contours = []
    i = 0
    current = None
    start = None

    def take(n):
        nonlocal i
        values = [float(v) for v in tokens[i : i + n]]
        i += n
        return [(values[k], values[k + 1]) for k in range(0, n, 2)]

    while i < len(tokens):
        command = tokens[i]
        i += 1
        if command == 'M':
            (current,) = take(2)
            start = current
            contours.append([])
        elif command == 'L':
            (end,) = take(2)
            contours[-1].append([current, end])
            current = end
        elif command == 'Q':
            control, end = take(4)
            contours[-1].append([current, control, end])
            current = end
        elif command == 'Z':
            if current != start:
                contours[-1].append([current, start])
            current = start
        else:
            raise ValueError(f'Unexpected token {command}')
    return contours


def replay(contours, pen):
    for contour in contours:
        pen.moveTo(contour[0][0])
        for segment in contour:
            if len(segment) == 2:
                pen.lineTo(segment[1])
            else:
                pen.qCurveTo(segment[1], segment[2])
        pen.closePath()


def measure(d):
    contours = segments(d)
    bounds_pen = BoundsPen(None)
    replay(contours, bounds_pen)
    stats = StatisticsPen(None)
    replay(contours, stats)
    x_min, y_min, x_max, y_max = bounds_pen.bounds

    # A flat edge: a segment whose points all lie on the bound.
    def flat(y):
        return any(all(p[1] == y for p in s) for c in contours for s in c)

    return {
        'bounds': [x_min, y_min, x_max, y_max],
        'flatTop': flat(y_max),
        'flatBottom': flat(y_min),
        'area': abs(stats.area),
        'centroidX': stats.meanX,
    }


def tnum_map(font):
    out = {}
    gsub = font['GSUB'].table
    for record in gsub.FeatureList.FeatureRecord:
        if record.FeatureTag != 'tnum':
            continue
        for index in record.Feature.LookupListIndex:
            lookup = gsub.LookupList.Lookup[index]
            for table in lookup.SubTable:
                if lookup.LookupType == 7:
                    table = table.ExtSubTable
                if hasattr(table, 'mapping'):
                    out.update(table.mapping)
    return out


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    source = Path(sys.argv[1]).read_bytes()
    digest = hashlib.sha256(source).hexdigest()
    if digest != FONT_SHA256:
        sys.exit(f'The font is not the pinned Outfit[wght].ttf: SHA-256 {digest}')

    variable = TTFont(io.BytesIO(source))
    copyright_line = variable['name'].getDebugName(0)
    tnum = tnum_map(variable)
    cmap = variable.getBestCmap()
    names = {}
    for ch in DIGITS:
        names[ch] = tnum.get(cmap[ord(ch)], cmap[ord(ch)])
    for ch in LETTERS:
        names[ch] = cmap[ord(ch)]

    # The digits at WEIGHT, and the label's letters at LABEL_WEIGHT.
    font = instancer.instantiateVariableFont(variable, {'wght': WEIGHT})
    label_font = instancer.instantiateVariableFont(variable, {'wght': LABEL_WEIGHT})
    glyphs = {}
    for instance, chars in ((font, DIGITS), (label_font, LETTERS)):
        removeOverlaps(instance, [names[ch] for ch in chars])
        glyph_set = instance.getGlyphSet()
        hmtx = instance['hmtx']
        for ch in chars:
            pen = SvgPen(glyph_set)
            glyph_set[names[ch]].draw(pen)
            d = pen.data()
            glyphs[ch] = {'d': d, 'advance': hmtx[names[ch]][0], **measure(d)}

    upm = font['head'].unitsPerEm
    cap_height = label_font['OS/2'].sCapHeight
    advances = {glyphs[ch]['advance'] for ch in DIGITS}
    if len(advances) != 1:
        sys.exit('The tnum digits differ in advance')
    (tabular,) = advances
    # The nominal figure height: the flat tops of 1, 4 and 7.
    tops = {glyphs[ch]['bounds'][3] for ch in '147'}
    if len(tops) != 1 or not all(glyphs[ch]['flatTop'] for ch in '147'):
        sys.exit('1, 4 and 7 do not share a flat top')
    (figure_height,) = tops
    if not all(glyphs[ch]['flatTop'] and glyphs[ch]['bounds'][3] == cap_height for ch in 'MB'):
        sys.exit('M and B do not have flat tops at the cap height')
    side_left = sum(glyphs[ch]['bounds'][0] for ch in DIGITS) / len(DIGITS)
    side_right = sum(tabular - glyphs[ch]['bounds'][2] for ch in DIGITS) / len(DIGITS)

    face = hb.Face(source)
    hb_font = hb.Font(face)
    hb_font.set_variations({'wght': LABEL_WEIGHT})
    buffer = hb.Buffer()
    buffer.add_str(LABEL)
    buffer.guess_segment_properties()
    hb.shape(hb_font, buffer, {'kern': True, 'liga': False})
    label_advances = [p.x_advance for p in buffer.glyph_positions]
    if [buffer.glyph_infos[i].codepoint for i in range(len(LABEL))] != [
        label_font.getGlyphID(names[ch]) for ch in LABEL
    ]:
        sys.exit('HarfBuzz shaped the label into other glyphs')

    def glyph_ts(ch):
        g = glyphs[ch]
        b = ', '.join(number(v) for v in g['bounds'])
        return (
            f'    {ch if ch in LETTERS else repr(ch)}: {{\n'
            f'        d: \'{g["d"]}\',\n'
            f'        advance: {number(g["advance"])},\n'
            f'        bounds: [{b}],\n'
            f'        flatTop: {str(g["flatTop"]).lower()},\n'
            f'        flatBottom: {str(g["flatBottom"]).lower()},\n'
            f'        area: {number(g["area"])},\n'
            f'        centroidX: {number(g["centroidX"])},\n'
            f'    }},\n'
        )

    lines = [
        f'// {copyright_line}\n',
        '// SPDX-License-Identifier: OFL-1.1\n',
        '// Generated by scripts/bake-combo-glyphs.py; do not edit.\n',
        '\n',
        '/** A glyph in font units, y up: SVG path data, its advance and what its ink covers. */\n',
        'export type ComboGlyph = {\n',
        '    d: string\n',
        '    advance: number\n',
        '    /** The ink\'s bounds, overshoots included: left, bottom, right, top. */\n',
        '    bounds: readonly [number, number, number, number]\n',
        '    /** Whether the top and bottom bounds are horizontal segments of the outline. */\n',
        '    flatTop: boolean\n',
        '    flatBottom: boolean\n',
        '    area: number\n',
        '    centroidX: number\n',
        '}\n',
        '\n',
        f'/** Outfit in font units: the digits at weight {WEIGHT}, the label at {LABEL_WEIGHT}. */\n',
        'export const COMBO_FONT = {\n',
        f'    unitsPerEm: {number(upm)},\n',
        f'    figureHeight: {number(figure_height)},\n',
        '    /** The label\'s cap height. */\n',
        f'    capHeight: {number(cap_height)},\n',
        f'    tabularAdvance: {number(tabular)},\n',
        '    /** The mean side bearings of the ten digits. */\n',
        f'    sideBearingLeft: {number(side_left)},\n',
        f'    sideBearingRight: {number(side_right)},\n',
        f'    /** The advances of {LABEL} with the font\'s kerning. */\n',
        f'    labelAdvances: [{", ".join(number(a) for a in label_advances)}],\n',
        '} as const\n',
        '\n',
        '/** The tabular digits, by character. */\n',
        'export const COMBO_DIGITS: Readonly<Record<string, ComboGlyph>> = {\n',
        *[glyph_ts(ch) for ch in DIGITS],
        '}\n',
        '\n',
        'export const COMBO_LETTERS = {\n',
        *[glyph_ts(ch) for ch in LETTERS],
        '} as const satisfies Record<string, ComboGlyph>\n',
    ]
    OUT.write_text(''.join(lines), encoding='utf-8', newline='\n')
    print(f'Wrote {OUT} ({OUT.stat().st_size} bytes)')


if __name__ == '__main__':
    main()
