# Changelog

## Unreleased

- (Web) The editor now requires Safari 17 or later, or iOS 17 or later on iPhone and iPad.
- (Web) By default, the editor now sends usage statistics unless Do Not Track or Global Privacy Control is enabled in your browser. To stop sending them, turn off Settings › About › Send Usage Statistics. The privacy page lists what is sent and how long it is kept.
- (Web) Before you first use the editor, it asks you to agree to the Terms of Service in a welcome window that also has Language, Theme and the Send Usage Statistics setting. It asks again after some changes to the Terms of Service or the Privacy Notice. Usage statistics from the editor are sent only after you agree. The unsupported-browser page may send a browser report before you agree.
- (Web) Added the Terms of Service, linked from Settings › About, Help and the privacy page.
- Some settings now have an info button that shows what the setting does.
- Save (P or Ctrl/Cmd+S) now saves a project file (.nxsp) instead of level data. The file contains the chart and Level Info, and can include the history and BGM. Open… (O) opens project files.
- Project files now include Sonolus package metadata and a gzipped chart, with references to the Next SEKAI engine.
- The Sonolus package in a project file now includes a black cover and silent BGM when those media are left out. These assets are used only by the Sonolus package.
- Export Level Data… (Shift+P) exports level data for Sonolus.
- (Web) In desktop Chrome and Edge, and in Chrome 132 or later on Android, saving again updates the project file and exporting again updates the exported file. Other browsers download a new file each time.
- (Web) The editor stores your work in your browser as sessions and resumes your last session when you return. On the first launch after this update, it opens your old auto save. Save a project file to keep your work.
- Reset is now New (N). New asks for confirmation when the chart has unsaved changes. The previous session stays in Recent Sessions. The notice shown after New has a Reopen button to return to it.
- Added History (Shift+H), with Timeline and Recent Sessions tabs. Timeline lists each change. You can view the chart at any Timeline step and choose Restore to return to that version.
- Recent Sessions lists earlier sessions. Select one to view or restore it, or use its menu to save it as a project file or delete it. You can undo the deletion.
- Recent Sessions has a Delete Sessions… button (trash can and clock icon) for deleting several sessions at once.
- Added Find Edits Here to the chart’s context menu. It filters the Timeline to steps that changed the selected beats or the beats in view.
- Undo now supports up to 1,000 steps, even after you reload the page. Earlier Timeline steps are available in History.
- (Web) When browser storage runs low, the editor deletes audio and cover images used only by earlier Timeline steps. Once storage is full, new changes are not stored until you free up space, for example with Delete Sessions… in Settings › Local Data.
- Settings › Local Data replaces the Auto Save settings.
- (Web) Except on iPhone and iPad, the editor asks for confirmation when you close a tab with unsaved changes. This also applies after an export. To turn this off, use Settings › Local Data › Ask Before Closing with Unsaved Changes.
- Level Properties is now Level Info, with title, artists, author, rating, tags, description, cover and preview audio. These are saved in the project file.
- The BGM dialog now has a Download BGM button. When the BGM is not loaded, a notice offers Choose Audio… to load an audio file.
- Level Info now has a Check button for the project file and the history stored in your browser. It uses the file to repair damaged history where possible and reports any remaining damage. In Settings › Toolbar and Settings › Keyboard Shortcuts, the command is named Check File and History.
- Added Preview Assets to the toolbar and the Preview panel’s menu for choosing the skin, particle effects, background and sound effects.
- (Web) The editor now also includes the Next SEKAI 02 skin and sound effects.
- Added a Minimap beside the chart. It shows the whole chart and marks the changes made at the Timeline step you are viewing. Click or drag in it to scroll, or drag its left edge to resize it. It is shown by default in wide windows; show or hide it with the Minimap tool or Settings › Editor › Show Minimap.
- When Preview, Groups and Stages are all shown in the left panels or all in the right panels, and those panels are wide, Groups and Stages are now shown side by side below Preview. To widen the panels, drag the edge between the panels and the chart. To use this in narrower panels or turn it off, use Settings › Panels › Groups and Stages Side by Side.
- Stage style events now support Lane Color. Color transitions use the event’s easing. The judgment line keeps its opacity during color transitions.
- You can now middle-click in the chart or the Elevation Editor and move the mouse to scroll. Click again to stop.
- With Settings › Toolbar › Quick Switch enabled, you can now press and hold a tool button, then drag along its toolbar row to select another tool.
- (Web) Ctrl/Cmd+R now reloads the page and Ctrl/Cmd+F opens the browser’s find bar. Previously, these shortcuts ran the commands assigned to R and F. You can assign either shortcut to a command in Settings › Keyboard Shortcuts.
- Added an About section in Settings with the editor version and a Copy Diagnostic Info… button.
- The preview now renders in parallel with the rest of the editor. This makes chart rendering smoother during playback and editing, especially with dense charts. If the preview looks wrong or does not appear, turn off Settings › Preview › Parallel Rendering.
- When nothing on the screen changes, the editor no longer redraws, so it uses less power.
- Scrolling a zoomed-out chart and playback on phones are smoother.
- Dragging to the top or bottom edge of the chart now scrolls at an even speed.
- Settings opens faster.
- Large level files open faster, especially on phones.
- In the preview, hit effects now stay on their notes when the camera moves, and notes attached across stages line up as they do in Sonolus.
- On iPhone and iPad, audio now plays in silent mode.
- Session names and suggested file names containing dots, such as “feat. Miku”, are no longer cut off at the first dot.
- (Web) If a session did not finish opening last time, the editor asks whether to try again or start blank. The session stays in Recent Sessions.
- Audio files can be up to 90 minutes long.
- Opening a project file larger than 256 MB asks for confirmation first. Level files larger than 256 MB are not opened.
- (Web) Added safe mode. If the editor does not start, add ?safe to its address.

## 0.5.22 (2026-10-17)

- Version numbers now match release tags.
