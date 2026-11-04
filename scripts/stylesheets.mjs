// The editor's page links its own stylesheet (src/index.css and the entry chunk's components)
// before the shared chunks' sheets, the order the dev server has. A build would otherwise link the
// shared chunks first, and a component's rule would lose a tie of specificity to index.css in the
// release only.

const stylesheetLinks = (html) =>
    [...html.matchAll(/<link\b[^>]*>/g)].filter((match) => /\brel="stylesheet"/.test(match[0]))

const hrefOf = (tag) => /\bhref="([^"]*)"/.exec(tag)?.[1] ?? ''

/** Moves the link to one of `entryFiles` (output paths, such as `assets/index-1234abcd.css`) before
 * the page's first stylesheet link; every other tag keeps its place. */
export function entryStylesheetFirst(html, entryFiles) {
    const links = stylesheetLinks(html)
    const entry = links.find((match) => entryFiles.includes(hrefOf(match[0]).replace(/^\//, '')))
    const first = links[0]
    if (!entry || entry === first) return html
    const tag = entry[0]
    const lead = /[ \t]*\r?\n?[ \t]*$/.exec(html.slice(0, entry.index))?.[0] ?? ''
    const without = html.slice(0, entry.index - lead.length) + html.slice(entry.index + tag.length)
    return without.slice(0, first.index) + tag + lead + without.slice(first.index)
}

/** The build step: the editor's page only, so the legal pages keep their one stylesheet as built. */
export const entryStylesheetPlugin = () => ({
    name: 'entry-stylesheet-first',
    apply: 'build',
    transformIndexHtml: {
        order: 'post',
        handler: (html, { path, chunk }) =>
            path === '/index.html' && chunk
                ? entryStylesheetFirst(html, [...(chunk.viteMetadata?.importedCss ?? [])])
                : html,
    },
})

/** Why the editor's page breaks the order, or undefined: its one stylesheet named after its module
 * script must come before every other stylesheet link. */
export function entryStylesheetProblem(html) {
    const script = /<script\b[^>]*\btype="module"[^>]*\bsrc="\/assets\/([^"]+)-[\w-]{8}\.js"/.exec(
        html,
    )
    if (!script) return 'it has no module script'
    const links = stylesheetLinks(html).map((match) => hrefOf(match[0]))
    const named = new RegExp(
        `^/assets/${script[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[\\w-]{8}\\.css$`,
    )
    const entries = links.filter((href) => named.test(href))
    if (entries.length !== 1)
        return `it links ${entries.length} stylesheets named after its module script`
    if (links[0] !== entries[0]) return `${links[0]} comes before ${entries[0]}`
    return undefined
}
