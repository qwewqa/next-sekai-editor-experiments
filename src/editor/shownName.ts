import { i18n } from '../i18n'
import { formatDateTime } from '../i18n/when'
import type { CopyOf } from '../local/names'
import type { ShownName } from '../local/startup/events'
import { interpolateRaw } from '../utils/interpolate'

/** What a separate copy was made from, as shown: a chain with no name of its own by its date. */
export const copySourceName = ({ name, at }: CopyOf) =>
    name || shownName({ name: { kind: 'date' }, ...(at === undefined ? {} : { at }) })

/**
 * A name as shown: the displayed name, or the date fallback, "Untitled · Oct 16, 2:41 PM"; just
 * "Untitled" when the start is not known.
 */
export const shownName = ({ name, at }: ShownName) =>
    name.kind === 'date'
        ? at === undefined
            ? i18n.value.save.placeholder
            : interpolateRaw(i18n.value.session.untitled, formatDateTime(at))
        : name.text
