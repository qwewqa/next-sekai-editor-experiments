import type { EventEase } from '..'
import type { NoteStyle } from '../../noteStyle'
import type { StageId } from '../../stages'

export type JudgmentLineColor =
    'neutral' | 'red' | 'green' | 'blue' | 'yellow' | 'purple' | 'cyan' | 'black'

export const judgmentLineColors = [
    'neutral',
    'red',
    'green',
    'blue',
    'yellow',
    'purple',
    'cyan',
    'black',
] as const satisfies readonly JudgmentLineColor[]

export type JudgmentLineStyle = 'default' | 'singleLine'

export type BorderStyle = 'default' | 'light' | 'medium' | 'disabled'

export type StageStyleEventObject = {
    stageId: StageId
    beat: number
    editorLane: number
    laneColor: NoteStyle
    judgmentLineColor: JudgmentLineColor
    judgmentLineStyle: JudgmentLineStyle
    leftBorderStyle: BorderStyle
    rightBorderStyle: BorderStyle
    isFullWidth: boolean
    noteAlpha: number
    laneAlpha: number
    judgmentLineAlpha: number
    divisionLineAlpha: number
    eventEase: EventEase
}
