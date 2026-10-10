/** A number as fields show it: 4 decimals with a plain minus; a value too small for them keeps 4 digits. */
export const formatNumber = (value: number) => {
    const rounded = +value.toFixed(4)
    return `${rounded === 0 && value !== 0 ? +value.toPrecision(4) : rounded}`
}
