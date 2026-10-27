/** Text around a link, or a link: `lead` and `trail` are the characters touching it, which stay on its line. */
export type LinkPart =
    { text: string } | { link: number; name: string; lead: string; trail: string }

/**
 * Splits a sentence around the names it links, each found once, so a character touching a link on
 * either side (a Japanese 「, a French l’, a Turkish ’nı) never ends a line apart from it. Undefined
 * when a name is missing, repeated or overlaps another: the caller shows the sentence plainly.
 */
export const linkParts = (sentence: string, names: readonly string[]): LinkPart[] | undefined => {
    const found = names.map((name, link) => ({ name, link, at: sentence.indexOf(name) }))
    if (found.some(({ name, at }) => !name || at < 0 || sentence.includes(name, at + name.length)))
        return undefined
    found.sort((a, b) => a.at - b.at)
    const parts: LinkPart[] = []
    let from = 0
    for (const { name, link, at } of found) {
        if (at < from) return undefined
        const before = sentence.slice(from, at)
        const lead = /\S$/u.exec(before)?.[0] ?? ''
        const next = found.find((other) => other.at > at)?.at ?? sentence.length
        const trail = /^\S/u.exec(sentence.slice(at + name.length, next))?.[0] ?? ''
        if (before.length > lead.length)
            parts.push({ text: before.slice(0, before.length - lead.length) })
        parts.push({ link, name, lead, trail })
        from = at + name.length + trail.length
    }
    if (from < sentence.length) parts.push({ text: sentence.slice(from) })
    return parts
}
