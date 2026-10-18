export type SheetGeometryInput = {
    width: number
    height: number
    peekClearance: number
    rem?: number
}

/** The History sheet's existing frame, before subtracting its own chrome. */
export const getSheetGeometry = ({
    width,
    height,
    peekClearance,
    rem = 16,
}: SheetGeometryInput) => {
    const inset = rem / 2
    if (height < 500 && width > height) {
        const top = Math.max(60, peekClearance + 4)
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

/** Tiny primary bars need an actual measurement because their date can wrap. */
export const prospectivePeekClearance = (width: number, measured = 0, rem = 16) =>
    width < 300 && measured <= 0
        ? undefined
        : Math.max(measured, (92 / 16 + (width < 640 ? 1.75 : 0.5)) * rem)

export const historySheetFits = (input: SheetGeometryInput, chrome: number) =>
    getSheetGeometry(input).height - chrome >= HISTORY_MIN_BODY
