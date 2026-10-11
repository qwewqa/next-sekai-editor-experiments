export type Modifiers = {
    ctrl: boolean
    shift: boolean
}

export type Pointer = {
    isActive: boolean
    st: number
    sx: number
    sy: number
    t: number
    x: number
    y: number
    modifiers: Modifiers
}

/** Where a pointer's point reaches the tool, such as held at its pane's edge. */
export type HoldPoint = (id: number, x: number, y: number) => { x: number; y: number }
