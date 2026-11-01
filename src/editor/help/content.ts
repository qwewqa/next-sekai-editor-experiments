import { i18n } from '../../i18n'
import { settings } from '../../settings'
import { interpolateRaw } from '../../utils/interpolate'
import { commands, type CommandName } from '../commands'
import { isCoarsePointer } from '../workspace'

/** A line of an entry: one text, or a tap and a click form chosen by the primary pointer. */
export type HelpLine = {
    /** A line that follows a setting is not shown while the setting is off. */
    shown?: () => boolean
} & ({ text: () => string } | { tap: () => string; click: () => string })

export type HelpEntryDef = {
    id: string
    /** The pointer an input entry describes; the current pointer's entries come first. */
    input?: 'touch' | 'pointer'
    /** The commands the entry explains, shown by their icons, names and shortcuts. */
    commands?: readonly CommandName[]
    /** The heading of an entry that has no command. */
    title?: () => string
    /** Hidden while this is false; an entry with no line to show is hidden too. */
    shown?: () => boolean
    lines: readonly HelpLine[]
}

export type HelpSectionDef = {
    id: string
    title: () => string
    entries: readonly HelpEntryDef[]
}

const secondaryIsContextMenu = () => settings.mouseSecondaryTool === 'selectContextMenu'

// Touch has a panel tab menu only through the long press, and a mouse always has the right button.
const panelTabShown = () => !isCoarsePointer.value || settings.touchLongPressContextMenu

/** The sections in the order Help shows them, About last. */
export const helpSections = [
    {
        id: 'controls',
        title: () => i18n.value.help.sections.controls,
        entries: [
            {
                id: 'touch',
                input: 'touch',
                title: () => i18n.value.help.modal.touchscreen.title,
                lines: [
                    {
                        text: () => i18n.value.help.modal.touchscreen.longPress,
                        shown: () => settings.touchLongPressContextMenu,
                    },
                    { text: () => i18n.value.help.modal.touchscreen.scroll },
                    {
                        text: () => i18n.value.help.modal.touchscreen.quickScroll,
                        shown: () => settings.touchQuickScrollWidth > 0,
                    },
                    { text: () => i18n.value.help.modal.touchscreen.gestures },
                ],
            },
            {
                id: 'mouse',
                input: 'pointer',
                title: () => i18n.value.help.modal.mouse.title,
                lines: [
                    {
                        text: () => i18n.value.help.modal.mouse.contextMenu,
                        shown: () => secondaryIsContextMenu(),
                    },
                    {
                        text: () => {
                            const tool = settings.mouseSecondaryTool
                            return tool === 'selectContextMenu'
                                ? ''
                                : interpolateRaw(
                                      i18n.value.help.modal.mouse.secondary,
                                      commands[tool].title(),
                                  )
                        },
                        shown: () => !secondaryIsContextMenu(),
                    },
                    {
                        text: () => i18n.value.help.mouse.deselect,
                        shown: () => secondaryIsContextMenu(),
                    },
                    { text: () => i18n.value.help.modal.mouse.scrollX },
                    { text: () => i18n.value.help.modal.mouse.zoom },
                    { text: () => i18n.value.help.modal.mouse.autoscroll },
                ],
            },
            {
                id: 'keyboard',
                input: 'pointer',
                title: () => i18n.value.help.modal.keyboard.title,
                lines: [{ text: () => i18n.value.help.modal.keyboard.settings }],
            },
            {
                id: 'adding',
                title: () => i18n.value.help.basics.title,
                lines: [
                    {
                        tap: () => i18n.value.help.modal.adding.add,
                        click: () => i18n.value.help.modal.adding.addClick,
                    },
                    {
                        tap: () => i18n.value.help.modal.adding.edit,
                        click: () => i18n.value.help.modal.adding.editClick,
                    },
                    { text: () => i18n.value.help.modal.adding.move },
                    { text: () => i18n.value.help.modal.adding.resize },
                    {
                        tap: () => i18n.value.help.modal.adding.modifiers,
                        click: () => i18n.value.help.modal.adding.modifiersClick,
                    },
                ],
            },
            {
                id: 'toolbarPanels',
                title: () => i18n.value.help.toolbarPanels.title,
                lines: [
                    { text: () => i18n.value.help.toolbarPanels.toolbar },
                    {
                        tap: () => i18n.value.help.toolbarPanels.panelTab,
                        click: () => i18n.value.help.toolbarPanels.panelTabClick,
                        shown: () => panelTabShown(),
                    },
                ],
            },
        ],
    },
    {
        id: 'file',
        title: () => i18n.value.help.sections.file,
        entries: [
            {
                id: 'open',
                commands: ['open'],
                lines: [{ text: () => i18n.value.help.open.formats }],
            },
            {
                id: 'save',
                commands: ['save'],
                lines: [
                    { text: () => i18n.value.help.save.projectFile },
                    { text: () => i18n.value.help.recentSessions },
                ],
            },
            {
                id: 'exportLevel',
                commands: ['exportLevel'],
                lines: [{ text: () => i18n.value.help.exportLevel.contents }],
            },
            {
                id: 'utilities',
                commands: ['utilities'],
                lines: [{ text: () => i18n.value.help.utilities.levelInfo }],
            },
        ],
    },
    {
        id: 'playback',
        title: () => i18n.value.help.sections.playback,
        entries: [
            {
                id: 'play',
                commands: ['play', 'stop'],
                lines: [
                    { text: () => i18n.value.help.play.startPosition },
                    { text: () => i18n.value.help.play.stop },
                ],
            },
            {
                id: 'bgm',
                commands: ['bgm'],
                lines: [{ text: () => i18n.value.help.bgm.load }],
            },
            {
                id: 'offset',
                commands: ['offset'],
                lines: [{ text: () => i18n.value.help.modal.offset.drag }],
            },
            {
                id: 'previewAssets',
                commands: ['previewAssets'],
                lines: [{ text: () => i18n.value.help.previewAssets.browser }],
            },
            {
                id: 'preview',
                title: () => i18n.value.workspace.panels.preview,
                lines: [
                    {
                        tap: () => i18n.value.help.preview.drag,
                        click: () => i18n.value.help.preview.dragClick,
                    },
                ],
            },
        ],
    },
    {
        id: 'editing',
        title: () => i18n.value.help.sections.editing,
        entries: [
            {
                id: 'history',
                commands: ['history', 'showChange', 'editsHere'],
                lines: [
                    {
                        tap: () => i18n.value.help.history.view,
                        click: () => i18n.value.help.history.viewClick,
                    },
                    { text: () => i18n.value.help.history.showChange },
                    { text: () => i18n.value.help.history.editsHere },
                ],
            },
            {
                id: 'paste',
                commands: ['paste'],
                lines: [
                    {
                        tap: () => i18n.value.help.modal.pasteTool.paste,
                        click: () => i18n.value.help.modal.pasteTool.pasteClick,
                    },
                    { text: () => i18n.value.help.pasteTool.clipboardHistory },
                ],
            },
            {
                id: 'select',
                commands: ['select'],
                lines: [
                    {
                        tap: () => i18n.value.help.modal.selectTool.select,
                        click: () => i18n.value.help.modal.selectTool.selectClick,
                    },
                    { text: () => i18n.value.help.modal.selectTool.selectMultiple },
                    { text: () => i18n.value.help.modal.selectTool.move },
                    { text: () => i18n.value.help.selectTool.resizeSelection },
                    { text: () => i18n.value.help.modal.selectTool.modifiers },
                ],
            },
            {
                id: 'deselect',
                commands: ['deselect'],
                shown: () => settings.deselectSwitchesToSelect,
                lines: [{ text: () => i18n.value.help.deselect.select }],
            },
            {
                id: 'eraser',
                commands: ['eraser'],
                lines: [
                    {
                        tap: () => i18n.value.help.modal.eraserTool.erase,
                        click: () => i18n.value.help.modal.eraserTool.eraseClick,
                    },
                    {
                        tap: () => i18n.value.help.modal.eraserTool.selection,
                        click: () => i18n.value.help.modal.eraserTool.selectionClick,
                    },
                ],
            },
            {
                id: 'brush',
                commands: ['brush'],
                lines: [
                    { text: () => i18n.value.help.modal.brushTool.properties },
                    {
                        tap: () => i18n.value.help.modal.brushTool.brush,
                        click: () => i18n.value.help.modal.brushTool.brushClick,
                    },
                    { text: () => i18n.value.help.modal.brushTool.shift },
                ],
            },
        ],
    },
    {
        id: 'transform',
        title: () => i18n.value.help.sections.transform,
        entries: [
            {
                id: 'flip',
                commands: ['flip'],
                lines: [{ text: () => i18n.value.help.flip.mirror }],
            },
            {
                id: 'flipVertical',
                commands: ['flipVertical'],
                lines: [{ text: () => i18n.value.help.flipVertical.reverse }],
            },
            {
                id: 'splitCombine',
                commands: ['splitHold', 'combineNotes'],
                lines: [{ text: () => i18n.value.help.modal.slideTool.splitCombine }],
            },
            {
                id: 'makeVertical',
                commands: ['makeVertical'],
                lines: [{ text: () => i18n.value.help.makeVertical.elevation }],
            },
            {
                id: 'scale',
                commands: ['scaleBeat', 'scaleElevation', 'scaleWidth'],
                lines: [{ text: () => i18n.value.help.scale.drag }],
            },
            {
                id: 'elevation',
                commands: ['elevation'],
                lines: [{ text: () => i18n.value.help.elevation.beat }],
            },
            {
                id: 'editorLayout',
                commands: ['editorLayout'],
                lines: [{ text: () => i18n.value.help.editorLayout.layouts }],
            },
        ],
    },
    {
        id: 'notes',
        title: () => i18n.value.help.sections.notes,
        entries: [
            {
                id: 'note',
                commands: ['note', 'note0', 'note1', 'note2', 'note3'],
                lines: [
                    { text: () => i18n.value.help.modal.noteTool.presets },
                    {
                        tap: () => i18n.value.help.modal.noteTool.quickEdit,
                        click: () => i18n.value.help.modal.noteTool.quickEditClick,
                    },
                ],
            },
            {
                id: 'slide',
                commands: ['slide', 'slide0', 'slide1', 'slide2', 'slide3', 'slide4'],
                lines: [
                    {
                        tap: () => i18n.value.help.modal.slideTool.connect,
                        click: () => i18n.value.help.modal.slideTool.connectClick,
                    },
                    { text: () => i18n.value.help.modal.slideTool.presets },
                    {
                        tap: () => i18n.value.help.slideTool.quickEditPanel,
                        click: () => i18n.value.help.slideTool.quickEditPanelClick,
                    },
                ],
            },
            {
                id: 'generateSlideNotes',
                commands: ['generateSlideNotes'],
                lines: [
                    {
                        tap: () => i18n.value.help.modal.generateSlideNotesTool.generate,
                        click: () => i18n.value.help.modal.generateSlideNotesTool.generateClick,
                    },
                    {
                        tap: () => i18n.value.help.generateSlideNotesTool.fillSelection,
                        click: () => i18n.value.help.generateSlideNotesTool.fillSelectionClick,
                    },
                ],
            },
        ],
    },
    {
        id: 'timing',
        title: () => i18n.value.help.sections.timing,
        entries: [
            {
                id: 'bpm',
                commands: ['bpm'],
                lines: [
                    { text: () => i18n.value.help.modal.bpmTool.first },
                    { text: () => i18n.value.help.modal.bpmTool.replace },
                ],
            },
            {
                id: 'timeScale',
                commands: ['timeScale'],
                lines: [
                    { text: () => i18n.value.help.modal.timeScaleTool.markers },
                    { text: () => i18n.value.help.modal.timeScaleTool.ease },
                ],
            },
        ],
    },
    {
        id: 'groupsStages',
        title: () => i18n.value.help.sections.groupsStages,
        entries: [
            {
                id: 'groups',
                commands: ['manageGroups', 'groupPrev', 'groupNext', 'groupAll'],
                lines: [
                    {
                        tap: () => i18n.value.help.groups.current,
                        click: () => i18n.value.help.groups.currentClick,
                    },
                ],
            },
            {
                id: 'stages',
                commands: ['manageStages', 'stagePrev', 'stageNext', 'stageAll'],
                lines: [
                    {
                        tap: () => i18n.value.help.stages.current,
                        click: () => i18n.value.help.stages.currentClick,
                    },
                ],
            },
        ],
    },
    {
        id: 'events',
        title: () => i18n.value.help.sections.events,
        entries: [
            {
                id: 'events',
                commands: [
                    'event',
                    'cameraEvent',
                    'stageMaskEvent',
                    'stagePivotEvent',
                    'stageStyleEvent',
                    'stageTransformEvent',
                ],
                lines: [
                    { text: () => i18n.value.help.event.camera },
                    { text: () => i18n.value.help.event.mask },
                    { text: () => i18n.value.help.event.pivot },
                    { text: () => i18n.value.help.event.style },
                    { text: () => i18n.value.help.event.transform },
                    { text: () => i18n.value.help.modal.event.next },
                    { text: () => i18n.value.help.modal.event.defaults },
                    { text: () => i18n.value.help.event.width },
                    {
                        tap: () => i18n.value.help.event.easeStep,
                        click: () => i18n.value.help.event.easeStepClick,
                    },
                ],
            },
        ],
    },
    {
        id: 'view',
        title: () => i18n.value.help.sections.view,
        entries: [
            {
                id: 'minimap',
                commands: ['minimap'],
                lines: [{ text: () => i18n.value.help.minimap.changes }],
            },
            {
                id: 'snapping',
                commands: ['snapping', 'laneSnapping'],
                lines: [{ text: () => i18n.value.help.snapping.modes }],
            },
        ],
    },
    { id: 'about', title: () => i18n.value.settings.about.title, entries: [] },
] as const satisfies readonly HelpSectionDef[]

export type HelpSectionId = (typeof helpSections)[number]['id']
export type HelpEntryId = (typeof helpSections)[number]['entries'][number]['id']

/**
 * The built-in commands that have no entry: each is named by its label, or is covered by an entry
 * for the gesture or setting that uses it. A new command needs an entry or a place here.
 */
export const NO_ENTRY = [
    // The label says it, and the context menu's gestures are in Controls.
    'openContextMenu',
    'settings',
    'help',
    'fullscreen',
    // The label says it, and each asks first where it must.
    'saveAs',
    'reset',
    // Each opens a dialog whose fields name what they show or set.
    'properties',
    'statistics',
    // The label and the notice say it.
    'speedDown',
    'speedUp',
    'toggleBgmVolume',
    'toggleSfxVolume',
    // The label says it, and Undo's notice covers its limit.
    'undo',
    'redo',
    // The label says it.
    'checkProject',
    'copy',
    'cut',
    'deleteSelection',
    // It is the Settings action for local data, with its own dialog.
    'deleteSessions',
    // The notice and the Size field in View show it.
    'increaseNoteSize',
    'decreaseNoteSize',
    // The label says it, and the gestures are in Controls.
    'scrollLeft',
    'scrollRight',
    'scrollUp',
    'scrollDown',
    'scrollPageUp',
    'scrollPageDown',
    'jumpDown',
    'jumpUp',
    'zoomXIn',
    'zoomXOut',
    'zoomYIn',
    'zoomYOut',
    // The label and the notice say it.
    'cycleVisibilities',
    'noteVisibility',
    'bpmVisibility',
    'timeScaleVisibility',
    'cameraEventVisibility',
    'stageMaskEventVisibility',
    'stagePivotEventVisibility',
    'stageStyleEventVisibility',
    'stageTransformEventVisibility',
    // The label says it.
    'division1',
    'division2',
    'division3',
    'division4',
    'division6',
    'division8',
    'division12',
    'division16',
    'divisionCustom',
    'laneDivision1',
    'laneDivision2',
    'laneDivision3',
    'laneDivision4',
    'laneDivision6',
    'laneDivision8',
    'laneDivision12',
    'laneDivision16',
    'laneDivisionCustom',
    'laneLimitNone',
    'laneLimitSix',
    'laneLimitCustom',
] as const satisfies readonly CommandName[]

type EntryCommands = Extract<
    (typeof helpSections)[number]['entries'][number],
    { commands: readonly CommandName[] }
>['commands'][number]

/** Fails the type check when a command is in neither an entry nor NO_ENTRY. */
export const everyCommandPlaced: [
    Exclude<CommandName, EntryCommands | (typeof NO_ENTRY)[number]>,
] extends [never]
    ? true
    : false = true
