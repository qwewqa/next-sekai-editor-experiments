import { interpolateRaw } from '../../utils/interpolate'

// The `recovered` entry's label (§1.6.4 step 4), from the app's messages in the locale at write
// time (§1.10 #7): "Recovered last change", naming the undo steps that weren't kept.

type Messages = { entry: { recovered: string; recoveredDropped: string } }

export const recoveredLabel = (messages: Messages, dropped: number) =>
    dropped
        ? interpolateRaw(messages.entry.recoveredDropped, String(dropped))
        : messages.entry.recovered
