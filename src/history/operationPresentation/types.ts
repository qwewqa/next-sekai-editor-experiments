import type { Zone } from '../../calendar/calendar'
import type {
    AdditiveMetric,
    EntryDescription,
    GroupDescriptor,
    NativeOperationInput,
    StepDescription,
    UndoableStep,
} from '../operations'

export type OperationStrings = typeof import('../../i18n/en/index.json')
export type OperationTextContext = {
    readonly locale: string
    readonly strings: OperationStrings
    readonly now: number
    /** The time zone every date and time in the text is in (the History clock's). */
    readonly zone: Zone
}

export type OperationMember = {
    readonly description: EntryDescription | UndoableStep
    readonly time?: number
    readonly id?: string
}

export type OperationRecipe = {
    readonly kind: 'single' | 'group' | 'undo' | 'redo'
    readonly members: readonly OperationMember[]
    readonly partial: boolean
    readonly group?: GroupDescriptor
    readonly summary?: NativeOperationInput
    readonly metric?: AdditiveMetric
    readonly overflow?: boolean
    readonly uniform?: boolean
}

/** A displayed value. A placeholder (Not set, Varies) is drawn quieter; a shortened name carries the fact. */
export type DetailText = {
    readonly text: string
    readonly placeholder?: true
    readonly shortened?: true
}
/** One row of the record. Counts are one phrase per kind; a change reads before then after. */
export type DetailRow =
    | {
          readonly kind: 'counts'
          readonly key: string
          readonly label: string
          readonly items: readonly string[]
      }
    | {
          readonly kind: 'change'
          readonly key: string
          readonly label: string
          readonly before: DetailText
          readonly after: DetailText
      }
    | {
          readonly kind: 'value'
          readonly key: string
          readonly label: string
          readonly value: DetailText
      }
/** One step of a group, undo or redo parent. */
export type DetailStep = {
    readonly member: OperationMember
    /** The step's own line, without the Undo or Redo prefix inside a prefixless parent. */
    readonly label: string
    /** The captured language of a fallback label, when it is not the current one. */
    readonly lang?: string
    /** Whether the step's own record has rows, facts or a note, so it can be opened. */
    readonly expandable: boolean
}
/** The presentation model of Step Details: only what the title does not already say. */
export type OperationDetails = {
    readonly description: string
    /** The captured language of a fallback description, when it is not the current one. */
    readonly descriptionLang?: string
    /** Why nothing more is shown for a newer or unreadable step. */
    readonly note?: string
    readonly rows: readonly DetailRow[]
    /** Plain sentences after the rows; the shortened-name fact comes last. */
    readonly facts: readonly string[]
    readonly steps?: {
        readonly count: number
        readonly partial: boolean
        /** Newest first. */
        readonly members: readonly DetailStep[]
        /** An undo or redo parent: its steps are listed without the repeated prefix. */
        readonly prefixless?: true
    }
    readonly recovery?: {
        readonly descriptions: readonly StepDescription[]
        readonly headIndex: number
        readonly omitted: number
    }
}
