# When a release breaks storage

The steps for the maintainer when a release stops users from reaching their stored work, and the reply to post. The rules behind it are in the release plan (Part 4 §4.9.3). Export Raw Data… is in every build from v0.6.0 on, and it reads the database without the editor's record decoder, so it works when Recent Sessions and Save to File… do not.

## 1. When to use it

A release breaks storage: the editor does not start, sessions are missing, or Save or storing fails for many users.

## 2. First

Stop promoting the release and ship a forward fix: revert or repair the code and tag a new, higher patch. Never redeploy an old tag, since only the highest `v*` tag deploys. Never revert a database version raise, since a build that meets a newer database opens it read-only and stops storing.

## 3. What to tell users

Post this in the fix's release notes and in the issue thread. Replace `{version}` with the broken release and `{fixed}` with the fix.

> Version {version} has a bug that can stop the editor from starting or hide your sessions. To keep your work:
>
> 1. Do not clear this site’s data in your browser.
> 2. Open the editor, go to Settings › Local Data › Recovery, choose Export Raw Data… and keep the file it downloads.
> 3. If the editor does not start normally, add `?safe` to the address and do step 2 there.
> 4. If the editor shows an error and does not start at all, choose Export Raw Data… on the error screen.
> 5. When version {fixed} is out, reload the page and look in History › Recent Sessions.
> 6. If your work is not there, send us the file. Do not attach it to a public issue. It holds your charts and audio. Put it somewhere private and email a link to nse@qwewqa.dev.

## 4. What to ask for

- The raw-data ZIP, sent privately as a link by email.
- The version: Settings › About, or Copy Diagnostic Info….
- The browser and the operating system.
- What they did and what they saw: the text of the message, or a screenshot.
- Whether the editor opens with `?safe` added to the address.
- Whether they have project files (`.nxsp`) saved.
- Roughly when they last saw their work.

## 5. Loading a dump

1. Unzip the ZIP. `dump.json` holds the data. Check its `format` (`nse-local-data-dump`), its `version` and its `appVersion`, the build that wrote it.
2. Copy `dump.json` into the nse-next `samples/` folder (or the folder `NSE_SAMPLES_DIR` names) as `<case>.json`, for example `reporter-1.json`. Never copy it into the repository. Case names use letters, digits, `.`, `_` and `-`.
3. Run `npm run dev` in a worktree at the broken release’s tag, to see what the user saw, or at the fix.
4. Open a fresh browser profile. The seeder refuses a database that holds any chain or session. A dump holds no file handles, so the first Save of a chain asks where to write.
5. Open `/?seedSample=<case>` on the dev server. The page seeds the profile and reloads with the user’s data. The console says `[seedSample] Seeded <case>; reloading.` A refusal says why, and the editor loads as usual.

## 6. Getting the work out

For each chain in History › Recent Sessions, open the row’s ⋯ menu and choose Save to File…. That writes the chain’s latest state to a file without opening it. To look at a chain first, choose Restore Session, then Save.

Work the editor could not read is under Settings › Local Data › Recovery: the unreadable recovered work and the journals of earlier visits, each with a Download button.

If the build cannot read a chain, fix the reader on a branch and load the dump again.

There is no `tools/recover.py`. It is deferred until a storage bug needs it (Part 4 §4.9.3).

## 7. Returning the files

Send the files back privately, as a link by email. Then delete the user’s ZIP, the copy in `samples/`, every other copy, and the browser profile you loaded it into. The privacy page says how such files are handled: they are used only to fix the problem and deleted when it is fixed.

## 8. Tried once

The steps above were tried on 2026-10-23, at commit `3cd87808` (branch `release-fixtures`), with the dev server on port 5335, `NSE_SAMPLES_DIR` set to a scratch folder and a fresh Chromium profile, driven by a script.

- `tests/fixtures/web-storage-v1/raw-export.zip` holds one entry, `dump.json` (1.7 MB): `format` `nse-local-data-dump`, `version` 1, `appVersion` `0.5.22+fbabcfff`, database `nse-local-data` version 1.
- `/?seedSample=<case>` seeded the profile, the console said it was reloading, and the editor opened.
- History › Recent Sessions listed six chains: `fixture-history` (the one the editor continued, 544 notes), `fork.nxsp`, `no-history.nxsp`, `fork` (not saved to a file), `no-media.nxsp` and `Untitled`.
- Restore Session of `no-media.nxsp` opened it.
- ⋯ › Save to File… on `fork.nxsp` opened the Save dialog (the profile has no handle for the file), and Save downloaded `fork (restored Nov 5).nxsp` (82.9 kB). The editor’s reader opens it fully.
