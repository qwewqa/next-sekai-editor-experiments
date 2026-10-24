import { interpolateRaw } from '../../utils/interpolate'
import { formatCount } from '../../utils/size'

/** What the dialog's footer counts: the packages stored on this device. */
export type StoredSummary = { count: number; bytes: number }

/** "Stored: 3 items, 14 MB"; one item reads "Stored: 1 item, 4.2 MB". */
export const storedLine = (
    message: string,
    summary: StoredSummary,
    formatSize: (n: number) => string,
) => interpolateRaw(message, formatCount(summary.count), formatSize(summary.bytes))
