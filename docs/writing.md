# Writing

These rules cover everything we write: the text users see, the maintainer docs (`README.md`, `CONTRIBUTING.md` and `docs/`), code comments, commit messages and the release notes. The first part applies to all of it. The second part adds the rules for user-facing text.

## Everything we write

- Write terse, plain text.
- Choose the word that is idiomatic in the register. The app uses plain software English, neither literary nor bureaucratic. The docs and comments use plain technical English.
  - A file contains something, and a feature requires something.
  - When unsure, follow the existing text, then common software usage.
- Leave out what the reader can assume.
- Give extra information its own sentence, not a ", which …" tail.
- Within a document, refer to the writer and the reader the same way throughout, such as "we" and "you".
- In code, comments, test titles, messages only developers see and commit messages, use ASCII quotes, apostrophes and operators, and name a command without its ellipsis. Keep other characters only where the text quotes the UI or the data needs them.
- Reword existing text only when the new wording is clearer or more accurate.

### Easy to read

These slow a reader down. Avoid them:

- **Things that act like people:** "storage did not answer". Use the plain verb: "returned an error", "could not be read".
- **Three or more nouns in a row:** "storage quota warning threshold". Use a preposition or a verb: "the warning when storage is almost full". Established names such as Level Info are fine.
- **Verbs made from nouns on the spot,** such as "surface" or "bucket". Use the ordinary verb.
- **A missing "that" when the clause has a long subject:** write "parts that this version of the editor does not support". After "you", the short form is fine: "items you load".
- **Unusual word pairs:** "returned an error", not "answered with an error".
- **Related words far apart:** keep a subject near its verb, with no clauses nested between them.
- **Padding:**
  - reassurance ("your work is safe");
  - "simply" and "just";
  - "not X but Y";
  - a sentence that repeats the heading or bold label before it;
  - colons or dashes that join two sentences.

## User-facing text

These rules apply only to user-facing text: the strings in `src/i18n/`, Help, notices, the release notes in `CHANGELOG.md`, the privacy page and docs written for users, such as `docs/usage-statistics.md`. That text follows the first part as well.

- Use no contractions, and ’ for apostrophes.
- Buttons, command names, setting names and their choices are Title Case.
- A label ends with an ellipsis when its action waits for the user’s answer before it happens: a value or a name (Scale Beats…, Save As…), a file (Choose…) or a confirmation (Delete Selected…). A confirmation that appears only in some cases, such as New’s when the chart has unsaved changes, does not count. A label that opens a window or a panel (Settings, Level Info, History) takes none, because the window is the result. The ellipsis tells the user that a question comes first. It would lose that meaning if every window had one. A dialog title drops it.
- When running text names a command, leave out its ellipsis and end the sentence with its own full stop. Keep the ellipsis only when the name is itself the clickable label.
- Put session names in quotes: “ ” in English, and each locale’s usual marks in the others. Put a file name in quotes only when it is the subject or starts the sentence: "Saved to coconut.nxsp", but "“coconut.nxsp” could not be written."
- Change all seven locales (`en`, `fr`, `ja`, `ko`, `tr`, `zhs`, `zht`) in the same commit, and reuse each locale’s existing terms.
- "Saved" means saved as a project file, and "unsaved" means not saved as one. Work kept only in this browser, such as Recent Sessions and the Timeline, is "stored" or "kept", never "saved". An export does not save.
- Say what happened and what to do, in words the user already knows.
  - Leave out internal terms such as chain, journal, worker, binding and slot. The maintainer docs may name them.
  - History lines say "Timeline steps", so they cannot be read as chart content being lost.
- Leave out what an action obviously does, and what does not happen.
- Reuse an existing phrasing ("could not be read", "Save to keep your work.") rather than writing a new one.
- Put a hint or note under a control only when it tells the user something they cannot learn from the label or by using the control, and they need it at that moment. Examples: a warning before data is lost, a privacy disclosure, a unit, the reason a control is unavailable.
- Give a setting a description, behind its info button, when its label and choices leave something unclear: a term (Render Scale, Antialiasing), the difference between its choices (Beat and Measure), a condition or limit (Show Stage Name, Max Scroll X), or where the effect shows (a focused group, playback). Leave it out when it would only repeat the label and choices. Keep a description to the setting and its choices, and leave out how to use other parts of the editor. A setting with a visible note has no description. Buttons, links and shortcut rows have none.
- Label related controls the same way: if one has a suffix, its neighbours have one too, or none does. In each locale, put a name in the same place across related messages: "Added group {0}", "Deleted group {0}".
