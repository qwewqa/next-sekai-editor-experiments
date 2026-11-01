// The stage's form and fit, chosen by the dialog from the room it has.

export type StageLayout = {
    form: 'two' | 'one' | 'land' | 'short'
    /** 1: names; 2: icons, with Set In and Set Out also in the menu; 3: only in the menu. */
    transportFit: 1 | 2 | 3
    /** Length beside the fields, on its own line (Ready), or left to the footer. */
    length: 'inline' | 'line' | 'none'
    stacked: boolean
    /** The frame view's box height, or undefined where it fills the room left. */
    frameHeight?: number
    compactStrip: boolean
    hideRuler: boolean
}
