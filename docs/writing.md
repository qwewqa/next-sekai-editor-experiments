# Writing

These rules cover everything we write: the text users see, the maintainer docs (`README.md`, `CONTRIBUTING.md` and `docs/`), code comments, commit messages and the release notes. The first part applies to all of it. The second part adds the rules for user-facing text.

## Everything we write

- Write terse, plain text.
- Choose the word that is idiomatic in the register. The app uses plain software English, neither literary nor bureaucratic. The docs and comments use plain technical English.
  - A file contains something, and a feature requires something.
  - When unsure, follow the existing text, then common software usage.
- Leave out what the reader can assume.
- Give extra information its own sentence, not a ", which …" tail.

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
  - colons or dashes that join two sentences.

## User-facing text

The strings in `src/i18n/`, Help, notices, the release notes in `CHANGELOG.md` and the privacy page follow these rules as well as the first part.

- Use no contractions, and ’ for apostrophes.
- Buttons, command names, setting names and their choices are Title Case. A command that asks for more before it acts ends with an ellipsis.
- Put session names in double quotes. Put a file name in double quotes only when it is the subject or starts the sentence: "Saved to coconut.nxsp", but ""coconut.nxsp" could not be written."
- Change all seven locales (`en`, `fr`, `ja`, `ko`, `tr`, `zhs`, `zht`) in the same commit, and reuse each locale’s existing terms.
- "Saved" means saved as a project file, and "unsaved" means not saved as one. Work kept only in this browser, such as Recent Sessions and the Timeline, is "stored" or "kept", never "saved". An export does not save.
- Say what happened and what to do, in words the user already knows.
  - Leave out internal terms such as chain, journal, worker, binding and slot. The maintainer docs may name them.
  - History lines say "Timeline steps", so they cannot be read as chart content being lost.
- Leave out what an action obviously does, and what does not happen.
- Reuse an existing phrasing ("could not be read", "Save to keep your work.") rather than writing a new one.
