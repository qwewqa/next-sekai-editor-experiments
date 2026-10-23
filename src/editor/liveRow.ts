// The open session's name and label for Recent Sessions' row of this tab. `labelText.ts` computes
// them once, with the status bar's label; History files may not import it (it formats a date in
// the engine's zone), so they take them from here, as they take `restoreStored.ts`.
export { liveRow } from './labelText'
