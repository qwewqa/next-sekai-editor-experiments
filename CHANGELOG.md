# Changelog

## Unreleased

- **Save (P) now saves a project file (.nxsp), not level data.** It holds the chart and Level Info, and can include the history and BGM. Ctrl/Cmd+S also saves. Open (O) opens project files.
- **For Sonolus, use Export Level Data… (Shift+P).**
- On Chrome and Edge on a computer, and Chrome 132 or later on Android, later saves and exports write to the same file. Other browsers download a new file each time. **Save As…** saves to a new file.
- **Opening the editor continues where you left off,** as auto save did. The first time after this update, it continues your old auto save. Work is stored in this browser as sessions; to keep it, save it to a file.
- **History (Shift+H)** has two tabs. Timeline lists each change; you can view the chart at any step and Restore it. Recent Sessions lists earlier sessions; select one to view or restore it, or use its menu to Save to File… or Delete. Delete can be undone.
- When browser storage runs low, the editor deletes audio and images used only by earlier Timeline steps. When it is full, new changes are not stored until you free space, for example with **Settings › Local Data › Delete Sessions…**
- Except on iPhone and iPad, closing the tab asks first when changes are not saved to a project file, even after an export. To turn this off, use **Settings › Local Data › Ask Before Closing with Unsaved Changes**. Settings › Local Data replaces the Auto Save settings.
- **Reset is now New (N).** It asks first when the chart has unsaved changes. The previous level stays in Recent Sessions; Reopen in the notice goes back to it.
- **Level Properties is now Level Info**, with title, artists, author, rating, tags, description, cover and preview audio. These are saved in the project file.
- The BGM dialog has **Download BGM**. When the BGM is not loaded, **Choose Audio…** in the notice attaches the audio file.
- **Check…** in Level Info (Check File and History…) checks the project file and the history stored in this browser. It repairs what it can from the file and lists what is still damaged.
- **Preview Assets…** chooses the skin, particle, background and sound effects for the preview and playback. It is in the toolbar and the Preview panel’s menu.
- **Minimap:** a strip beside the chart shows the whole chart. Click or drag in it to scroll. While you view a step in History, it marks that step’s changes. It is shown in wide windows; turn it on or off with the Minimap tool or **Settings › Editor › Show Minimap**. Drag its left edge to resize it.
- With **Settings › Toolbar › Quick Switch** on, you can hold a tool and slide along its toolbar row to pick another one.
- On iPhone and iPad, playback is heard in silent mode.
- Names with dots, such as "feat. Miku", are no longer cut at the first dot.
- Settings has an About section with the version and **Copy Diagnostic Info…**, for reporting a problem.
- The editor is now named "Next SEKAI Editor" (formerly "Sonolus Next SEKAI Editor").
- **Safari 17 or later is required** (iOS 17 or later on iPhone and iPad).
- If the editor does not start, add `?safe` to its address to open it in safe mode.

## 0.5.22 (2026-10-17)

- Version numbers now follow release tags.
