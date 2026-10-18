import { i18n } from '../i18n'
import { formatDateTime } from '../i18n/when'
import type { ShownName } from '../local/startup/events'
import { interpolateRaw } from '../utils/interpolate'

/** A name as shown: the displayed name, or the date fallback, "Untitled · Oct 16, 2:41 PM". */
export const shownName = ({ name, at }: ShownName) =>
    name.kind === 'date'
        ? interpolateRaw(i18n.value.session.untitled, formatDateTime(at))
        : name.text
