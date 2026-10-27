import ts from 'typescript'

/** Replaces the characters from `from` to `to` with spaces, keeping line breaks. */
const blank = (chars: string[], from: number, to: number) => {
    for (let i = from; i < to; i++) if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' '
}

/**
 * Script text without its comments, and with the inside of its strings too when `strings` is
 * set. Offsets and line breaks stay, so a match lies where it did.
 */
const scriptWithout = (text: string, strings: boolean) => {
    const file = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true)
    // The literals come first, since a `//` inside one is not a comment.
    const literals: { from: number; to: number; inner: [number, number] }[] = []
    const visit = (node: ts.Node) => {
        const from = node.getStart(file)
        const to = node.getEnd()
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
            literals.push({ from, to, inner: [from + 1, to - 1] })
        else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node))
            literals.push({ from, to, inner: [from + 1, to - 2] })
        else if (ts.isTemplateTail(node)) literals.push({ from, to, inner: [from + 1, to - 1] })
        else if (ts.isRegularExpressionLiteral(node)) literals.push({ from, to, inner: [to, to] })
        ts.forEachChild(node, visit)
    }
    visit(file)
    literals.sort((a, b) => a.from - b.from)
    const chars = text.split('')
    if (strings) for (const { inner } of literals) blank(chars, inner[0], inner[1])
    let next = 0
    for (let i = 0; i < text.length;) {
        const literal = literals[next]
        if (literal && i >= literal.from) {
            i = Math.max(i, literal.to)
            next++
        } else if (text.startsWith('//', i)) {
            const end = text.indexOf('\n', i)
            const stop = end < 0 ? text.length : end
            blank(chars, i, stop)
            i = stop
        } else if (text.startsWith('/*', i)) {
            const end = text.indexOf('*/', i + 2)
            const stop = end < 0 ? text.length : end + 2
            blank(chars, i, stop)
            i = stop
        } else i++
    }
    return chars.join('')
}

const blankAll = (text: string) => text.replace(/[^\r\n]/g, ' ')

/** A component without its HTML and CSS comments, and with its scripts cleaned as above. */
const componentWithout = (text: string, strings: boolean) =>
    text
        .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/g, (block, body: string) =>
            block.replace(body, () => scriptWithout(body, strings)),
        )
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, (block) =>
            block.replace(/\/\*[\s\S]*?\*\//g, blankAll),
        )
        .replace(/<!--[\s\S]*?-->/g, blankAll)

/**
 * The text of a `.ts`, `.js`, `.mjs` or `.vue` source without its comments, and with the inside
 * of its strings blanked too when `strings` is set.
 */
export const sourceWithout = (path: string, text: string, strings: boolean) =>
    path.endsWith('.vue') ? componentWithout(text, strings) : scriptWithout(text, strings)
