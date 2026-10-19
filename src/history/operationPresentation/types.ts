import type {
    AdditiveMetric,
    GroupDescriptor,
    NativeOperationInput,
    OwnerKind,
    StepDescription,
    UndoableStep,
} from '../operations'

export type OperationStrings = typeof import('../../i18n/en/index.json')
export type OwnerIdentity = { readonly kind: OwnerKind; readonly id: number }
export type OperationTextContext = {
    readonly locale: string
    readonly strings: OperationStrings
    readonly now: number
    readonly qualifiers?: readonly OwnerIdentity[]
}

export type OperationMember = {
    readonly step: UndoableStep
    readonly time?: number
    readonly id?: string
}

export type OperationRecipe = {
    readonly kind: 'single' | 'group' | 'undo' | 'redo'
    readonly members: readonly OperationMember[]
    readonly partial: boolean
    readonly qualifiers: readonly OwnerIdentity[]
    readonly group?: GroupDescriptor
    readonly summary?: NativeOperationInput
    readonly metric?: AdditiveMetric
    readonly overflow?: boolean
    readonly uniform?: boolean
}

export type OperationDetailRow = {
    readonly key: string
    readonly label: string
    readonly value: string
    readonly nameShortened?: boolean
}
export type OperationDetailSection = {
    readonly key: string
    readonly label: string
    readonly rows: readonly OperationDetailRow[]
}
export type OperationDetails = {
    readonly description: string
    readonly stepCount: number
    readonly partial: boolean
    readonly explanation?: string
    readonly sections: readonly OperationDetailSection[]
    readonly children: readonly OperationMember[]
    readonly recovery?: {
        readonly descriptions: readonly StepDescription[]
        readonly headIndex: number
        readonly omitted: number
    }
}
