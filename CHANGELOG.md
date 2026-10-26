# Changelog

## Unreleased

- Sonolus Next SEKAI Editor is now named “Next SEKAI Editor”.
- Safari 17 or later is required. On iPhone and iPad, iOS 17 or later is required.
- Save (P) now saves a project file (.nxsp) instead of level data. The file contains the chart and Level Info, and can include the history and BGM. Ctrl/Cmd+S also saves. Use Open… (O) to open project files.
- To export level data for Sonolus, use Export Level Data… (Shift+P).
- In Chrome and Edge on desktop, and in Chrome 132 or later on Android, later saves and exports update their respective files. Other browsers download a new file each time.
- The editor stores your work in this browser as sessions and resumes your last session when you return. On the first launch after this update, it opens your old auto save. Save a project file to keep your work.
- Reset is now New (N). New asks for confirmation when the chart has unsaved changes. The previous session remains in Recent Sessions. Use Reopen in the notice to return to it.
- History (Shift+H) has two tabs, Timeline and Recent Sessions. Timeline lists each change. You can view the chart at any Timeline step and choose Restore to restore it.
- Recent Sessions lists earlier sessions. Select one to view or restore it, or use its menu to save it as a project file or delete it. You can undo the deletion.
- To delete several sessions at once, use the Delete Sessions… button in Recent Sessions, marked with a trash can and clock.
- Find Edits Here in the chart’s menu filters the Timeline to steps that changed the selected beats or the beats in view.
- Undo now goes back up to 1,000 steps, even after you reload the page. Earlier Timeline steps remain available in History.
- When browser storage runs low, the editor deletes audio and cover images used only by earlier Timeline steps. Once storage is full, new changes are not stored until you free up space, for example with Delete Sessions… in Settings › Local Data.
- The editor asks for confirmation when you close a tab with unsaved changes, even after an export, except on iPhone and iPad. To turn this off, use Settings › Local Data › Ask Before Closing with Unsaved Changes. Settings › Local Data replaces the Auto Save settings.
- Level Properties is now Level Info, with title, artists, author, rating, tags, description, cover and preview audio. These are saved in the project file.
- The BGM dialog now has a Download BGM button. If the BGM is not loaded, use Choose Audio… in the notice to attach an audio file.
- Use Check in Level Info to check the project file and the history stored in this browser. It uses the file to repair damaged history where possible and reports any remaining damage. The command is listed as Check File and History in Settings › Toolbar and Settings › Keyboard Shortcuts.
- Preview Assets is now available in the toolbar and the Preview panel’s menu. Use it to choose the skin, particle effects, background and sound effects. The web editor includes the Next SEKAI 02 skin and sound effects.
- Added a Minimap strip beside the chart. It shows the whole chart and marks the changes made at the History step you are viewing. Click or drag within it to scroll, or drag its left edge to resize it. It is shown by default in wide windows. Show or hide it with the Minimap tool or Settings › Editor › Show Minimap.
- Stage style events now support Lane Color. Color transitions use the event’s easing. The judgment line’s opacity remains unchanged during color transitions.
- You can now middle-click in the chart or the Elevation Editor and move the mouse to scroll. Click again to stop.
- With Settings › Toolbar › Quick Switch enabled, press and hold a tool button, then drag along its toolbar row to select another tool.
- Ctrl/Cmd+R now reloads the page and Ctrl/Cmd+F opens the browser’s find bar. Previously, these shortcuts ran the commands assigned to R and F. You can assign either shortcut to a command in Settings › Keyboard Shortcuts.
- Added an About section in Settings with the editor version and a Copy Diagnostic Info… button.
- (Web) The editor now sends usage statistics unless Do Not Track or Global Privacy Control is enabled in your browser. To turn this off, use Settings › About › Send Usage Statistics. The privacy page lists what is sent and how long it is kept.
- The preview now renders in parallel with the rest of the editor. This makes chart rendering smoother during playback and editing, especially with dense charts. If the preview looks wrong or does not appear, turn off Settings › Preview › Parallel Rendering.
- In the preview, hit effects now stay on their notes when the camera moves, and notes attached across stages line up as they do in Sonolus.
- On iPhone and iPad, audio now plays in silent mode.
- Session names and suggested file names containing dots, such as “feat. Miku”, are no longer cut off at the first dot.
- If the editor does not start, add ?safe to its address to open it in safe mode.

## 0.5.22 (2026-10-17)

- Version numbers now follow release tags.
