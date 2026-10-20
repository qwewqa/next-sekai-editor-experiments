// TEMPORARY: adapts the model on main to the Step Details model of the proposal (section 5), so that
// the dialog can be built before P2 lands. When P2 is merged, the dialog imports `operationDetails`
// and these types from `history/operationPresentation`, and this file is deleted.
import {
    operationDetails as legacyDetails,
    type OperationMember,
    type OperationRecipe,
    type OperationTextContext,
} from '../../history/operationPresentation'
import type { StepDescription } from '../../history/operations'

export type DetailText = {
    readonly text: string
    readonly placeholder?: true
    readonly shortened?: true
}
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
export type OperationDetails = {
    readonly description: string
    readonly descriptionLang?: string
    readonly note?: string
    readonly rows: readonly DetailRow[]
    readonly facts: readonly string[]
    readonly steps?: {
        readonly count: number
        readonly partial: boolean
        readonly members: readonly { member: OperationMember; expandable: boolean }[]
        readonly prefixless?: true
    }
    readonly recovery?: {
        readonly descriptions: readonly StepDescription[]
        readonly headIndex: number
        readonly omitted: number
    }
}

export const operationDetails = (
    recipe: OperationRecipe,
    context: OperationTextContext,
): OperationDetails => {
    const old = legacyDetails(recipe, context)
    const rows: DetailRow[] = []
    for (const section of old.sections) {
        const [first, second] = section.rows
        if (section.rows.length === 2 && first?.key === 'before' && second?.key === 'after')
            rows.push({
                kind: 'change',
                key: section.key,
                label: section.label,
                before: { text: first.value },
                after: { text: second.value },
            })
        else
            for (const row of section.rows)
                rows.push({
                    kind: 'value',
                    key: `${section.key}.${row.key}`,
                    label: row.label || section.label,
                    value: { text: row.value },
                })
    }
    return {
        description: old.description,
        ...(old.explanation ? { note: old.explanation } : {}),
        rows,
        facts: [],
        ...(old.children.length
            ? {
                  steps: {
                      count: old.stepCount,
                      partial: old.partial,
                      members: [...old.children]
                          .reverse()
                          .map((member) => ({ member, expandable: true })),
                  },
              }
            : {}),
        ...(old.recovery ? { recovery: old.recovery } : {}),
    }
}
