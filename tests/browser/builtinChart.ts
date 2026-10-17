// Reference charts for the Built-in preview shots: every note type, flick directions, slides, guides and styles.
export const buildCharts = () => {
    const note = (beat: number, o: Record<string, unknown> = {}) => ({
        groupId: 1,
        stageId: 1,
        beat,
        noteType: 'default',
        isAttached: false,
        left: -2,
        size: 2,
        isCritical: false,
        flickDirection: 'none',
        isFake: false,
        noteStyle: 'default',
        connectorStyle: 'default',
        sfx: 'default',
        isConnectorSeparator: false,
        connectorType: 'active',
        connectorEase: 'linear',
        connectorIsFake: false,
        connectorActiveIsCritical: false,
        connectorGuideAlpha: 1,
        connectorLayer: 'top',
        connectorIsPassThrough: false,
        connectorPresentation: 'default',
        ...o,
    })
    const blank = () => ({
        initialLife: 1000,
        isDynamicStages: true,
        bpms: [{ beat: 0, bpm: 120 }],
        groups: new Map([[1, { name: 'Default' }]]),
        stages: new Map([
            [
                1,
                { name: 'Center', isFromStart: true, isUntilEnd: true, generateSimLines: 'global' },
            ],
        ]),
        cameraEvents: [
            {
                beat: 0,
                cameraLeft: -6,
                cameraSize: 12,
                cameraZoom: 1,
                cameraZoomTargetLane: 0,
                cameraZoomTargetY: 0,
                cameraZoomVerticalAlign: 'default',
                cameraRotation: 0,
                cameraStageTilt: 1,
                eventEase: 'linear',
            },
        ],
        stageMaskEvents: [
            {
                stageId: 1,
                beat: 0,
                maskLeft: -6,
                maskSize: 12,
                isMaskNotes: false,
                eventEase: 'linear',
            },
        ],
        stagePivotEvents: [
            {
                stageId: 1,
                beat: 0,
                pivotLane: 0,
                divisionSize: 2,
                divisionParity: 'even',
                yOffset: 0,
                yOffsetBeat: 0,
                eventEase: 'linear',
            },
        ],
        stageStyleEvents: [
            {
                stageId: 1,
                beat: 0,
                editorLane: 0,
                judgmentLineColor: 'neutral',
                judgmentLineStyle: 'default',
                leftBorderStyle: 'default',
                rightBorderStyle: 'default',
                isFullWidth: false,
                noteAlpha: 1,
                laneAlpha: 1,
                judgmentLineAlpha: 1,
                divisionLineAlpha: 1,
                eventEase: 'linear',
            },
        ],
        stageTransformEvents: [
            {
                stageId: 1,
                beat: 0,
                rotation: 0,
                xTranslation: 0,
                yTranslation: 0,
                elevation: 0,
                anchor: 'default',
                eventEase: 'linear',
            },
        ],
        timeScales: [],
        slides: [] as unknown[][],
    })
    const dirs = ['up', 'upLeft', 'upRight', 'down', 'downLeft', 'downRight']
    const styles = ['neutral', 'red', 'green', 'blue', 'yellow', 'purple', 'cyan', 'black']
    const charts: Record<string, ReturnType<typeof blank>> = {}

    // Every note type at the default style, with flicks in all six directions.
    {
        const c = blank()
        const one = (beat: number, o: Record<string, unknown>) => c.slides.push([note(beat, o)])
        dirs.forEach((d, i) => one(4, { left: -6 + i * 2, size: 1.8, flickDirection: d }))
        dirs.forEach((d, i) =>
            one(6, { left: -6 + i * 2, size: 1.8, flickDirection: d, isCritical: true }),
        )
        one(8, { left: -6, size: 1 })
        one(8, { left: -4.8, size: 2 })
        one(8, { left: -2.6, size: 3 })
        one(8, { left: 0, size: 1, isCritical: true })
        one(8, { left: 1.2, size: 2, isCritical: true })
        one(8, { left: 3.3, size: 2.7, isCritical: true })
        one(10, { left: -6, size: 1, noteType: 'damage' })
        one(10, { left: -4.8, size: 2, noteType: 'damage' })
        one(10, { left: -2.6, size: 1, noteType: 'trace' })
        one(10, { left: -1.4, size: 2, noteType: 'trace' })
        one(10, { left: 0.8, size: 3, noteType: 'trace' })
        one(10, { left: 4, size: 2, noteType: 'trace', isCritical: true })
        one(12, { left: -6, size: 2, noteType: 'trace', flickDirection: 'up' })
        one(12, { left: -3.6, size: 2, noteType: 'trace', flickDirection: 'downLeft' })
        one(12, { left: -1.2, size: 2, noteType: 'trace', flickDirection: 'up', isCritical: true })
        one(12, {
            left: 1.2,
            size: 2,
            noteType: 'trace',
            flickDirection: 'downRight',
            isCritical: true,
        })
        one(12, { left: 4, size: 2, flickDirection: 'down' })
        charts.types = c
    }

    // Slides with ticks, and guides in every colour.
    {
        const c = blank()
        c.slides.push([
            note(4, { left: -5.5, size: 2 }),
            note(5, { left: -4.8, size: 2, noteType: 'forceTick' }),
            note(6, { left: -4.2, size: 2, noteType: 'forceTick' }),
            note(7.5, { left: -3.5, size: 2, flickDirection: 'up' }),
        ])
        const crit = { isCritical: true, connectorActiveIsCritical: true }
        c.slides.push([
            note(4, { left: 1.5, size: 2, ...crit }),
            note(5.5, { left: 2.5, size: 2, noteType: 'forceTick', ...crit }),
            note(7, { left: 2, size: 2, ...crit }),
        ])
        c.slides.push([
            note(4, { left: -1.2, size: 1, noteType: 'damage', connectorType: 'damage' }),
            note(7, { left: -1.2, size: 1, noteType: 'damage', connectorType: 'damage' }),
        ])
        c.slides.push([
            note(8, { left: 4.5, size: 1.2, noteType: 'trace' }),
            note(9, { left: 4.8, size: 1.2, noteType: 'trace' }),
            note(10, { left: 4.5, size: 1.2, noteType: 'trace', flickDirection: 'up' }),
        ])
        for (const [i, style] of styles.entries()) {
            const left = -6 + i * 1.5
            const g = {
                connectorType: 'guide',
                noteType: 'anchor',
                connectorStyle: style,
                size: 1.2,
            }
            c.slides.push([
                note(10, { ...g, left }),
                note(13, { ...g, left: left + 0.3 }),
                note(16, { ...g, left }),
            ])
        }
        charts.slides = c
    }

    // The eight styles, one column each.
    {
        const c = blank()
        for (const [i, style] of styles.entries()) {
            const base = { left: -6 + i * 1.5, size: 1.4, noteStyle: style, connectorStyle: style }
            c.slides.push([note(4, base)])
            c.slides.push([note(5.5, { ...base, isCritical: true })])
            c.slides.push([note(7, { ...base, flickDirection: 'up' })])
            c.slides.push([note(8.5, { ...base, flickDirection: 'downLeft', isCritical: true })])
            c.slides.push([note(10, { ...base, noteType: 'trace' })])
            c.slides.push([note(11.5, { ...base, noteType: 'trace', flickDirection: 'up' })])
            c.slides.push([note(13, { ...base, noteType: 'damage' })])
            c.slides.push([
                note(14.5, base),
                note(15.5, { ...base, noteType: 'forceTick' }),
                note(16.5, base),
            ])
        }
        charts.styles = c
    }
    ;(window as unknown as { __charts: typeof charts }).__charts = charts
}
