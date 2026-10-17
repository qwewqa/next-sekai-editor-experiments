// The apps' frontend page (Part 2, 2.7.1): no web-only tags or icon, and the product name as its title.
import product from '../src/product.json' with { type: 'json' }

/** The shown product name (Part 4, 4.1), from the one constant in src/product.json. */
export const productName = product.name

/** index.html for native mode: without og:* tags and the icon link, titled with the product name. */
export function nativeIndexHtml(html) {
    const page = html
        .replace(/[ \t]*<meta\b[^>]*\bproperty="og:[^"]*"[^>]*>[ \t]*\r?\n?/g, '')
        .replace(/[ \t]*<link\b[^>]*\brel="icon"[^>]*>[ \t]*\r?\n?/g, '')
        .replace(/<title>[^<]*<\/title>/, `<title>${productName}</title>`)
    if (!page.includes(`<title>${productName}</title>`))
        throw new Error('index.html: the title was not found')
    if (/\bog:|rel="icon"/.test(page)) throw new Error('index.html: a web-only tag remains')
    return page
}
