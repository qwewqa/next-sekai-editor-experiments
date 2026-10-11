import { computed, onScopeDispose, provide, shallowRef, watch, type Ref } from 'vue'
import { mergeEases, type Ease } from '../../ease'
import { state as historyState } from '../../history'
import { store } from '../../history/store'
import { numberEditKey } from '../../modals/form/numberEdit'
import { clearPreviewEdit, previewEdit, setPreviewEdit, type PreviewEdit } from '../../preview/edit'
import type { State } from '../../state'
import type { Entity, EntityType } from '../../state/entities'
import type { EditableObject } from '../../state/operations/editable'
import {
    appliesToEditIn,
    fieldAppliesIn,
    noteFieldsApply,
} from '../../state/operations/properties/applicability'
import { getNoteFieldsIn } from '../../state/operations/properties/noteFields'
import { isEditInRange, planEdit, type EachEdit } from '../../state/operations/properties/plan'
import { editSelectedEditableEntities } from '../sidebars/default'
import { aggregateValues, type ValueUsage } from './aggregate'
import type { NoteFields } from './noteFields'

export const useProperties =
    <T>(ref: Ref<T>) =>
    <K extends keyof T>(key: K) =>
        computed({
            get: () => ref.value[key],
            set: (value) => {
                const properties = { ...ref.value }
                if (value === undefined) {
                    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
                    delete properties[key]
                } else {
                    properties[key] = value
                }
                ref.value = properties
            },
        })

export type EntitiesAggregate = ReturnType<typeof aggregateEntities>

/**
 * Models editing a scope of the selection, such as one kind's objects. Edits
 * and their live previews write only to the scope's objects that use them.
 */
export const useEntitiesProperties = (
    entities: Ref<readonly Entity[]>,
    aggregate: Ref<EntitiesAggregate>,
) => {
    const draft = shallowRef<EditableObject>()
    const revision = shallowRef(0)
    let owner: symbol | undefined
    let source: State | undefined
    let ownedPreview: PreviewEdit | undefined
    let previewing = false
    let valid = false
    // A mixed field's preview: the value each value in use changes to, and the one being set.
    let steps: { key?: keyof EditableObject; values: Map<unknown, unknown> } | undefined
    let stepping: { from: unknown } | undefined

    const only = (object: EditableObject, from = store.value) => {
        const scope = new Set(entities.value)
        const applies = appliesToEditIn(from, object)
        return (entity: Entity) => scope.has(entity) && applies(entity)
    }
    const edit = (object: EditableObject, each?: EachEdit) => {
        editSelectedEditableEntities(object, only(object), each)
    }
    // The edit a preview stands for: one value, or each value in use stepped on its own.
    const pending = (): { object: EditableObject; each?: EachEdit } | undefined => {
        if (draft.value) return { object: draft.value }
        const key = steps?.key
        if (!steps || !key || !steps.values.size) return
        const values = steps.values
        return {
            object: { [key]: values.values().next().value },
            each: (entity) => {
                const value = values.get(entity[key as keyof typeof entity])
                return value === undefined ? {} : { [key]: value }
            },
        }
    }

    const clearOwnedPreview = () => {
        if (ownedPreview && previewEdit.value === ownedPreview) clearPreviewEdit()
        ownedPreview = undefined
    }
    const reset = () => {
        clearOwnedPreview()
        owner = undefined
        source = undefined
        draft.value = undefined
        steps = undefined
        valid = false
        revision.value++
    }
    const show = () => {
        const plan = pending()
        if (!plan || !source) {
            clearOwnedPreview()
            return
        }
        const current = source
        const scope = only(plan.object, current.store)
        // A beat past the supported range is invalid, like one past a field's limits.
        if (!isEditInRange(current, current.selectedEntities, plan.object, scope, plan.each)) {
            valid = false
            clearOwnedPreview()
            return
        }
        // The preview is exactly what the commit will do.
        setPreviewEdit(
            current,
            () =>
                planEdit(current, current.selectedEntities, plan.object, {
                    only: scope,
                    each: plan.each,
                }).state,
            undefined,
            { draft: true },
        )
        ownedPreview = previewEdit.value
    }
    const begin = (field: symbol) => {
        if (owner !== undefined && owner !== field) reset()
        owner = field
        source ??= historyState.value
        valid = true
    }

    provide(numberEditKey, {
        revision,
        preview: (field, update) => {
            begin(field)
            steps = undefined
            previewing = true
            try {
                update()
            } finally {
                previewing = false
            }
            if (draft.value) show()
        },
        previewEach: (field, values, update) => {
            begin(field)
            draft.value = undefined
            steps = { values: new Map() }
            previewing = true
            try {
                for (const from of values) {
                    stepping = { from }
                    update(from)
                }
            } finally {
                previewing = false
                stepping = undefined
            }
            show()
        },
        invalidate: (field) => {
            if (owner !== field) return
            valid = false
            clearOwnedPreview()
        },
        commit: (field) => {
            if (owner !== field) return
            const plan = valid && source === historyState.value ? pending() : undefined
            reset()
            if (plan) edit(plan.object, plan.each)
        },
        cancel: (field) => {
            if (owner === field) reset()
        },
    })
    watch(historyState, reset, { flush: 'sync' })
    onScopeDispose(reset)

    return {
        createModel: <K extends keyof EditableObject>(key: K) =>
            computed({
                get: () => draft.value?.[key] ?? aggregate.value.model[key],
                set: (value) => {
                    if (value === undefined) return

                    if (previewing && source) {
                        if (stepping && steps) {
                            steps.key = key
                            if (value !== stepping.from) steps.values.set(stepping.from, value)
                            return
                        }
                        if (aggregate.value.model[key] === value) {
                            draft.value = undefined
                            clearOwnedPreview()
                            return
                        }
                        draft.value = { [key]: value }
                        return
                    }

                    reset()
                    edit({ [key]: value })
                },
            }),
        createEaseModel: (key: 'connectorEase' | 'eventEase' | 'timeScaleEase') =>
            computed({
                // Values in use are those of the objects the ease applies to.
                get: () =>
                    mergeEases(
                        (aggregate.value.usage.get(key)?.values.keys() ?? []) as Iterable<Ease>,
                    ),
                set: (value) => {
                    if (value === undefined) return

                    reset()
                    edit({ [key]: value })
                },
            }),
    }
}

/** Whether an object uses a property; a tail's connector or an attached tick's lane is unused. */
export const fieldApplies = (entity: Entity, key: string) =>
    fieldAppliesIn(store.value, entity, key)

export const aggregateEntities = (entities: readonly Entity[]) => {
    const types: Partial<Record<EntityType, boolean>> = {}
    const noteFields: Partial<NoteFields> = {}
    const noteFieldsOf = new Map<Entity, NoteFields>()
    const current = store.value

    for (const entity of entities) {
        types[entity.type] = true
        if (entity.type !== 'note') continue

        const fields = getNoteFieldsIn(current, entity)
        noteFieldsOf.set(entity, fields)
        aggregate(noteFields, fields)
    }

    // A note's value for a field hidden for it is unused, so it cannot make the field mixed.
    const { model, usage } = aggregateValues(entities, (entity) => {
        const fields = noteFieldsOf.get(entity)
        return fields ? noteFieldsApply(fields) : () => true
    })

    return { model: model as Partial<EditableObject>, usage, types, noteFields }
}

/** One aggregate of several kinds' aggregates, for the keys they share. */
export const mergeAggregates = (
    aggregates: readonly EntitiesAggregate[],
    keys: Iterable<string>,
): EntitiesAggregate => {
    const model: Record<string, unknown> = {}
    const usage = new Map<string, ValueUsage>()
    for (const key of keys) {
        const values = new Map<unknown, number>()
        let covered = 0
        let total = 0
        for (const aggregate of aggregates) {
            const own = aggregate.usage.get(key)
            if (!own) continue
            covered += own.covered
            total += own.total
            for (const [value, count] of own.values)
                values.set(value, (values.get(value) ?? 0) + count)
        }
        if (!total) continue
        usage.set(key, { values, covered, total })
        if (values.size === 1) model[key] = values.keys().next().value
    }
    const types: EntitiesAggregate['types'] = {}
    const noteFields: EntitiesAggregate['noteFields'] = {}
    for (const aggregate of aggregates) {
        Object.assign(types, aggregate.types)
        Object.assign(noteFields, aggregate.noteFields)
    }
    return { model, usage, types, noteFields }
}

const aggregate = <T extends object>(aggregate: Partial<T>, object: T) => {
    for (const key in object) {
        const value = object[key]
        if (key in aggregate) {
            if (aggregate[key] === undefined) continue

            if (aggregate[key] !== value) {
                aggregate[key] = undefined
            }
        } else {
            aggregate[key] = value
        }
    }
}
