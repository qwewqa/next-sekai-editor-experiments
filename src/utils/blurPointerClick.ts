/** Blurs a control a pointer clicked, so shortcuts return to the editor; one inside `keepIn` keeps focus. */
export const blurPointerClick = (event: MouseEvent, keepIn?: string) => {
    const target = event.currentTarget as HTMLElement
    if (event.detail > 0 && !(keepIn && target.closest(keepIn))) target.blur()
}
