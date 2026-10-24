// The apps' frontend page: no web-only tags, icon or support gate, and the product name as its title.
import product from '../src/product.json' with { type: 'json' }

/** The shown product name, from the one constant in src/product.json. */
export const productName = product.name

/** index.html for native mode: without og:* tags, the icon link and the support gate, titled with the product name. */
export function nativeIndexHtml(html) {
    const page = html
        .replace(/[ \t]*<meta\b[^>]*\bproperty="og:[^"]*"[^>]*>[ \t]*\r?\n?/g, '')
        .replace(/[ \t]*<link\b[^>]*\brel="icon"[^>]*>[ \t]*\r?\n?/g, '')
        .replace(/[ \t]*<!--[^>]*support gate[^>]*-->[ \t]*\r?\n?/g, '')
        .replace(/[ \t]*<script\b[^>]*\bsrc="\/gate\.js"[^>]*><\/script>[ \t]*\r?\n?/g, '')
        .replace(/<title>[^<]*<\/title>/, `<title>${productName}</title>`)
    if (!page.includes(`<title>${productName}</title>`))
        throw new Error('index.html: the title was not found')
    if (/\bog:|rel="icon"|gate\.js/.test(page))
        throw new Error('index.html: a web-only tag remains')
    return page
}
