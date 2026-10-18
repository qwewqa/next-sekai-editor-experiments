import { i18n } from '../../i18n'
import type { PanelId } from './layout'

export const panelTitle = (id: PanelId) =>
    id === 'history' ? i18n.value.history.title : i18n.value.workspace.panels[id]

export const panelTileId = (id: PanelId) => `workspace-panel-${id}`
