export const formatIntegerTime = (time: number) =>
    `${`${Math.floor(time / 60)}`.padStart(2, '0')}:${`${time % 60}`.padStart(2, '0')}`

// Rounds to the shown millisecond first, so 59.9996 carries to 01:00.000.
export const formatTime = (time: number) => {
    const ms = Math.round(time * 1000)
    return `${`${Math.floor(ms / 60000)}`.padStart(2, '0')}:${((ms % 60000) / 1000).toFixed(3).padStart(6, '0')}`
}

// Rounds as Properties shows numbers.
const round = (value: number) => +value.toFixed(4)

export const formatBpm = (value: number) => `${round(value)}`

export const formatTimeScale = (value: number, skip: number) => {
    let text = `${round(value)}x`

    // A skip that rounds to 0 shows none.
    const shownSkip = round(skip)
    if (shownSkip) {
        if (shownSkip > 0) text += '+'
        text += `${shownSkip}`
    }

    return text
}
