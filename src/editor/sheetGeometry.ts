export type SheetGeometryInput = {
    width: number
    height: number
    peekClearance: number
    rem?: number
}

/**
 * The History sheet's existing frame, before subtracting its own chrome. A short pane at least
 * 31rem wide takes the right sheet, which leaves a notice card about 10rem beside it; a narrower
 * one, such as a phone's under its dock, takes the bottom sheet.
 */
export const getSheetGeometry = ({
    width,
    height,
    peekClearance,
    rem = 16,
}: SheetGeometryInput) => {
    const inset = rem / 2
    if (height < 500 && width > height && width >= 31 * rem) {
        // 8 px under the peek stack, the stack's own rhythm.
        const top = Math.max(60, peekClearance + 8)
        return {
            side: 'right' as const,
            width: Math.min(22 * rem, width * 0.62),
            height: Math.max(0, height - inset - top),
            top,
        }
    }
    const short = peekClearance > 0 && height < 600
    const sheetHeight = short
        ? Math.max(144, Math.min(height * 0.55, Math.max(144, height - peekClearance - 128)))
        : Math.max(15 * rem, Math.min(height * 0.55, 30 * rem))
    return {
        side: 'bottom' as const,
        width: Math.max(0, Math.min(40 * rem, width - rem)),
        height: sheetHeight,
        top: height - inset - sheetHeight,
    }
}

export const HISTORY_MIN_BODY = 116

/**
 * The peek stack's bottom before it is shown: its 84 px under its top inset, the strip's own when
 * known (8 or 28 px), else the inset its width class usually takes. Tiny primary bars need an actual
 * measurement.
 */
export const prospectivePeekClearance = (width: number, measured = 0, rem = 16, inset?: number) =>
    width < 300 && measured <= 0
        ? undefined
        : Math.max(measured, (84 / 16) * rem + (inset ?? (width < 640 ? 1.75 : 0.5) * rem))

export const historySheetFits = (input: SheetGeometryInput, chrome: number) =>
    getSheetGeometry(input).height - chrome >= HISTORY_MIN_BODY
