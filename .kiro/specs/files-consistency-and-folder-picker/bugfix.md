# Bugfix Requirements Document

## Introduction

Three user-visible defects in FileGram, all on branch `feature/bulk-channel-uploads` at HEAD `90a56ce0` (working tree clean at the time this document was written):

1. Files deleted from Telegram keep appearing in FileGram. The test channel "TEST" still reports 22 files (`photo_400556032.jpg`, `photo_393216000.jpg`, `photo_391118848.jpg`, and 19 more) after the underlying Telegram messages were deleted. Telegram is the source of truth; the local index is not converging to it.
2. The Downloads "Save to" control opens the small legacy Windows "Browse For Folder" tree dialog instead of a normal, large, Explorer-style Windows dialog.
3. The Save-to area of the Downloads sidebar renders malformed and cramped, roughly as `SAVE TO` / `[folder icon] SAV...` / `F:...`, instead of one clean full-width control.

The reason this is filed as a bug report rather than a fix request is that the same three defects have already been declared fixed multiple times on this branch (`d296e8a6`, `8a8dd0ff`, `e654ffb3`, `a7acede5`, `6d8c95ab`, `ad9c229c`, `801a70c5`, `098b7382`, `d45da09c`, `90a56ce0`) and user-visible behaviour did not change. Each attempt added a new parallel layer instead of replacing the previous one. The presence of code that looks like a fix is therefore not evidence that the fix works, and no clause in this document may be satisfied by static inspection, by a mocked test, or by hiding rows in the DOM. Every clause is satisfied only by an observed runtime reproduction against the real local Telegram session, and every claim that cannot be reproduced must be reported as unproven.

Observations recorded during investigation, used below to make clauses concrete and verifiable. Each is a starting point for runtime tracing, not an accepted root cause:

- Browser load order is `public/index.html` (app.js, auth-state-fix.js, rescue-runtime.js, management.js, telegram-daily-driver.js, daily-driver-hotfix.js, daily-driver-p0-v2.js, daily-driver-p1.js, daily-driver-p2.js, daily-driver-final.js, daily-driver-final-guard.js, daily-driver-final-ui-fix.js, filegram-shell.js, upload-queue-core.js, uploads.js), then dynamic loads: `auth-state-fix.js` appends `files-stability.js?v=2` and `files-view.js?v=2`; `uploads.js` appends `bulk-uploads.js?v=3`, then `uploads-hardening.js?v=3`, then `file-consistency-v2.js?v=3` on the previous script's load event.
- `public/file-consistency-fix.js` is loaded by nothing. `native-folder-picker-preload.js` and `file-consistency-server-preload.js` are required by nothing (`package.json` `start` preloads only tdlib-temp, tdl-upload-compat, bulk-upload, download-dedupe, thumb-cache and session; `server.js` requires only `./packMedia` and `./packSelected`).
- `teleP0v2WriteIndex` (`public/daily-driver-p0-v2.js`) drops any write whose item count is below the stored count unless `options.allowShrink` is set, and no caller in the repository passes `allowShrink`.
- Every prune path (`file-consistency-v2.js` `persist`, `uploads-hardening.js` `persistSnapshot`, `files-stability.js` `schedulePersist`) writes through that same function.
- `files-stability.js` `restore()` unions in-memory, `rescueFileCache` and the IndexedDB record, and `union()` ORs `done` across inputs.
- Tombstone sets in `file-consistency-v2.js` and `uploads-hardening.js` are in-memory only; `uploads-hardening.js` records a permanent per-chat reconciliation mark in `localStorage` under `filegram-files-delete-reconcile-v1`.
- `?v=` cache tokens are reused across content changes (`file-consistency-v2.js?v=3`, `uploads-hardening.js?v=3`), so a browser can execute an older copy of a changed file.

## Bug Analysis

### Current Behavior (Defect)

What the running application does today. Every clause below describes observed or reproducible runtime behaviour, and each is paired with the clause of the same number in section 2.

Bug 1 - deleted Telegram files still appear:

1.1 WHEN Telegram chat "TEST" holds zero media messages while the local Files index holds 22 rows THEN the system shows "TEST - 22 files" in the chat header, lists the 22 items in the Files tab including `photo_400556032.jpg`, `photo_393216000.jpg` and `photo_391118848.jpg`, offers "Select all (22)", and reports 22 across the type counts and the pagination range.

1.2 WHEN a Telegram message carrying a file is deleted while FileGram is running THEN the system keeps that item in the Files tab and in every derived count.

1.3 WHEN files were deleted in Telegram while FileGram was not running, and FileGram is then started THEN the system restores the deleted items from its persisted index and presents them as live files.

1.4 WHEN the browser is refreshed after a prune appeared to succeed on screen THEN the system re-displays the deleted items.

1.5 WHEN the FileGram server is restarted THEN the system re-displays the deleted items.

1.6 WHEN a reconciliation pass computes an index smaller than the stored one THEN the system silently discards the shrink at the persistence boundary, because `teleP0v2WriteIndex` returns without writing whenever the stored item count exceeds the new count and no caller passes `allowShrink`, so an on-screen prune is never durable.

1.7 WHEN the index is restored for a chat THEN the system unions the in-memory snapshot, the shared `rescueFileCache` entry and the persisted IndexedDB record (`tele-daily-driver-cache-v1` / `file-indexes`), so any single surviving stale copy re-populates the index.

1.8 WHEN a smaller count is committed THEN the system still consults the durable high-water floor in `localStorage` (`tele-file-index-high-water-v1`, 14-day TTL) and can trigger index repair that rescans the chat back up to the previously proven total.

1.9 WHEN a chat has been stamped in `localStorage` under `filegram-files-delete-reconcile-v1` THEN the system never reconciles that chat against Telegram again in later sessions, so files deleted after that stamp stay in the index indefinitely.

1.10 WHEN reconciliation depends on `GET /api/filegram/live-media-ids/:chatId` and that call answers 503 (Telegram client not ready) or returns `exact: false` THEN the system abandons reconciliation with only a `console.warn`, leaves the stale count on screen, and retries the same failing call every 500 ms.

1.11 WHEN `searchChatMessages` returns no media for a chat that actually has media THEN the system treats the empty result as exact truth and is free to prune live files, so a scan failure and a genuinely empty channel are indistinguishable.

1.12 WHEN a maintainer tries to determine whether reconciliation ran at all THEN the system emits no per-chat diagnostics, so a working reconciliation and a no-op are indistinguishable from the outside.

1.13 WHEN deletions are tracked THEN the system keeps them only in in-memory tombstone sets that are lost on reload, so the filtering that makes the UI look correct in one session does not exist in the next.

Bug 2 - wrong Windows folder dialog:

1.14 WHEN the user clicks the Save-to control THEN the system opens the small legacy Windows "Browse For Folder" tree dialog, with no address bar, no folder contents pane and no sidebar.

1.15 WHEN the folder-picker backend is inspected THEN two endpoints exist for one feature: `POST /api/filegram/pick-download-folder` in `bulk-upload-preload.js`, which is preloaded by `package.json` `start`, and `POST /api/filegram/pick-download-folder-modern` in `native-folder-picker-preload.js`, which no runtime entry requires and which therefore cannot answer a request.

1.16 WHEN the Save-to click path is inspected THEN three frontend implementations target `#set-dir`: `uploads-hardening.js` assigns `button.onclick`, `file-consistency-v2.js` later replaces the node with a clone and binds its own listener (discarding the earlier handler), and the unloaded `file-consistency-fix.js` contains a third variant, so which handler and which endpoint run is decided by load order rather than by design.

1.17 WHEN a directory is chosen through the `OpenFileDialog` workaround THEN the system derives the result from `Split-Path -Parent` of a synthetic file name, so the returned value depends on what the dialog left in the file-name box and can be the parent of a selected file, or empty, rather than the directory the user chose.

Bug 3 - broken Save-to control:

1.18 WHEN the Downloads sidebar paints the Save-to area THEN the system renders a broken stack of roughly `SAVE TO`, then a small clipped button showing a folder icon and truncated text such as `SAV...`, then a separate legacy path line such as `F:...`.

1.19 WHEN the Save-to control is measured THEN the system leaves it far narrower than the available sidebar width, so the destination path is clipped even when there is room to show it.

1.20 WHEN the Save-to markup is inspected at runtime THEN the system keeps three overlapping controls in layout (`#dl-dir` input, `#set-dir` button, `#dl-dir-current` line) and two competing stylesheets of `!important` rules (`#fg-hardening-style` and `#fg-download-folder-v2-style`) plus two paint routines that rewrite the same button's inner markup with different internal structures.

Cross-cutting - the patch stack itself:

1.21 WHEN a fix is shipped THEN the system gains another parallel layer while the superseded one stays in the tree, including files nothing loads (`public/file-consistency-fix.js`, `native-folder-picker-preload.js`, `file-consistency-server-preload.js`), so no single owner exists for Files reconciliation, for the folder-picker backend, or for the Save-to control.

1.22 WHEN a script's contents change THEN the system keeps the same `?v=` token (for example `file-consistency-v2.js?v=3`, `uploads-hardening.js?v=3`), so a browser can keep executing an older copy and a real code fix can be invisible to the user.

1.23 WHEN the test suites run THEN the system is asserted against mutually exclusive Save-to layouts: `tests/visual-check.spec.js` requires a visible `#dl-dir` beside a matching Browse button on one row, while `tests/file-consistency.spec.js` requires `#dl-dir` hidden and `#set-dir` carrying `fg-folder-v2`, so a green suite does not describe one intended UI.

1.24 WHEN a fix is reported as complete THEN the report rests on mocked tests and on the presence of code, and the three defects remain reproducible in the running application.

Bug condition. The predicate below identifies the inputs that trigger the defect; `X` is a single interaction with the running application, not a unit-test fixture.

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type RuntimeInteraction
  OUTPUT: boolean

  RETURN staleFilesCondition(X) OR folderPickerCondition(X) OR saveToLayoutCondition(X)
END FUNCTION

FUNCTION staleFilesCondition(X)
  INPUT: X of type RuntimeInteraction
  OUTPUT: boolean

  // Any chat where the local index disagrees with Telegram truth, under any of
  // the five observation points: live deletion, app-off deletion, browser
  // refresh, server restart, pre-existing stale rows.
  RETURN X.surface = 'files'
     AND EXISTS id IN localIndex(X.chatId) WHERE id NOT IN telegramMediaMessageIds(X.chatId)
END FUNCTION

FUNCTION folderPickerCondition(X)
  INPUT: X of type RuntimeInteraction
  OUTPUT: boolean

  RETURN X.surface = 'downloads' AND X.action = 'click-save-to'
END FUNCTION

FUNCTION saveToLayoutCondition(X)
  INPUT: X of type RuntimeInteraction
  OUTPUT: boolean

  RETURN X.surface = 'downloads' AND X.action = 'render-save-to'
END FUNCTION
```

### Expected Behavior (Correct)

Telegram is the source of truth for the Files index. The persisted index must converge to it, not merely the rendered list.

Bug 1 - deleted Telegram files must disappear:

2.1 WHEN Telegram chat "TEST" holds zero media messages while the local Files index holds 22 rows THEN the system SHALL converge to zero: the chat header SHALL read "0 files", the Files tab SHALL be empty, "Select all" SHALL show no count and be disabled, type counts and the pagination range SHALL read zero, and the persisted index for that chat SHALL contain zero items.

2.2 WHEN a Telegram message carrying a file is deleted while FileGram is running THEN the system SHALL remove that item from the Files tab, the chat header count, the "Select all (N)" count, the type counts, the pagination and range counts, and the persisted index, without requiring a refresh.

2.3 WHEN files were deleted in Telegram while FileGram was not running, and FileGram is then started THEN the system SHALL reconcile against Telegram before or while presenting the Files tab and SHALL NOT present the deleted items as live files.

2.4 WHEN the browser is refreshed after a prune THEN the system SHALL still show the reconciled counts, because the persisted index no longer holds the pruned items.

2.5 WHEN the FileGram server is restarted THEN the system SHALL still show the reconciled counts, and no stale item SHALL reappear.

2.6 WHEN reconciliation computes an index smaller than the stored one THEN the system SHALL persist the smaller index, including an index of zero items, and the persistence boundary SHALL NOT silently discard a legitimate shrink. Removal driven by Telegram truth SHALL be a first-class write, not an exception to a monotonic-growth rule.

2.7 WHEN the index is restored for a chat THEN the system SHALL NOT reintroduce an item that reconciliation has removed, from any source: in-memory snapshot, `rescueFileCache`, the persisted IndexedDB record, scan-result merging, message upsert, startup restore, or any remaining compatibility layer. Each of these paths SHALL be enumerated and individually shown, at runtime, not to resurrect a removed item.

2.8 WHEN a smaller count is committed after reconciliation THEN the system SHALL treat the new count as authoritative and SHALL NOT rescan the chat back up to a stale high-water floor; a durable floor SHALL never outrank Telegram truth.

2.9 WHEN a chat was reconciled in an earlier session THEN the system SHALL still detect and remove files deleted after that point; no permanent per-chat mark may disable future reconciliation.

2.10 WHEN the live-media source is unavailable, returns a partial result, or is not exact THEN the system SHALL treat the result as unknown rather than as truth, SHALL leave the index unchanged, SHALL surface the failure in the UI or the log rather than only in `console.warn`, and SHALL retry with backoff rather than in a 500 ms loop.

2.11 WHEN a live scan returns no media for a chat THEN the system SHALL distinguish "Telegram says this chat has no media" from "the scan failed or was incomplete", and SHALL only prune on the former.

2.12 WHEN reconciliation runs for a chat THEN the system SHALL emit exactly one `[Files reconcile]` log line per pass containing: `chatId`, cached ID count, Telegram/live ID count, the missing IDs, the remaining count after pruning, and the persistence result (written, rejected, or skipped, with the reason). This diagnostic is a required deliverable of the fix, not an optional aid, because it is what makes the difference between a working reconciliation and a no-op observable.

2.13 WHEN deletions are tracked THEN the system SHALL make the persisted index itself the record of truth, so correctness does not depend on session-lifetime tombstones and no DOM-level hiding is used to produce the correct counts.

Bug 2 - the correct Windows folder dialog:

2.14 WHEN the user clicks the Save-to control THEN the system SHALL open the normal large Windows Explorer-style dialog: resizable, with an address/navigation bar, the usual folder contents view and the usual sidebar. The small legacy "Browse For Folder" tree dialog SHALL NOT appear.

2.15 WHEN the folder-picker backend is inspected after the fix THEN exactly one endpoint SHALL own folder selection. The duplicate SHALL be removed rather than left dormant, and the surviving endpoint SHALL be reachable in the process that `npm start` actually launches.

2.16 WHEN the Save-to click path is traced after the fix THEN exactly one frontend handler SHALL be bound to the control, and the full chain (button, event handler, endpoint, preload or server implementation, native dialog invocation) SHALL be traced end to end at runtime and reported. No behaviour in this chain may depend on script load order.

2.17 WHEN the user selects a directory THEN the system SHALL receive that directory path, SHALL show it in the Save-to control, and SHALL use it for subsequent downloads. If a file-open dialog is used as a folder chooser, selecting a directory SHALL reliably return that directory and SHALL NOT return a fabricated file name, a parent directory, or an empty result. Cancelling SHALL leave the configured folder unchanged.

Bug 3 - one clean Save-to control:

2.18 WHEN the Downloads sidebar paints the Save-to area THEN the system SHALL render one control under the `SAVE TO` heading, as a single row of folder icon, destination path and chevron, styled consistently with the FileGram dark UI.

2.19 WHEN the Save-to control is measured at the application's real sidebar width THEN the system SHALL fill the available width, SHALL show the path legibly, and SHALL apply ellipsis only when the path genuinely exceeds the available width. Clipping such as `SAV...` SHALL NOT occur.

2.20 WHEN the Save-to markup is inspected at runtime THEN the system SHALL expose exactly one click target and one path display: no duplicate Browse or Save-to controls, no hidden legacy control still occupying layout space, no tiny nested button, and no second stylesheet or paint routine competing for the same node. The actual DOM and computed styles SHALL be inspected to confirm this, rather than another override being layered on top.

Cross-cutting - consolidate the patch stack:

2.21 WHEN work begins THEN the system's real runtime composition SHALL be established first, from `package.json`, `public/index.html`, every dynamic script loader, the Express preload wrapping and the browser at run time, and recorded as a short dependency and load-order map. After the fix there SHALL be exactly one owner for each of: Telegram Files reconciliation, the folder-picker backend, and the Save-to frontend control. Obsolete layers SHALL be deleted or replaced, and no new parallel layer (for example `file-consistency-v3.js`, `folder-picker-final-fix.js`, `another-hotfix.js`) SHALL be introduced.

2.22 WHEN a script's contents change THEN its cache token SHALL change with it, so that a user cannot execute a stale copy of a changed file; a reproduction SHALL confirm the browser is running the current code before any behaviour is judged.

2.23 WHEN the suites run after the fix THEN they SHALL assert one consistent Save-to layout; the contradiction between `tests/visual-check.spec.js` and `tests/file-consistency.spec.js` SHALL be resolved rather than tolerated. `npm run verify` and the relevant Playwright tests SHALL pass, and regression tests SHALL be added for the authoritative implementation of each of the three fixes.

2.24 WHEN a fix is reported as complete THEN it SHALL be reported against the real local Telegram session, and the report SHALL state:
 (1) the exact root cause of the stale 22 files;
 (2) the exact code path that resurrected or preserved them;
 (3) the exact reconciliation mechanism now in use;
 (4) the exact reason the small folder dialog still opened;
 (5) which folder-picker implementation now owns the feature;
 (6) which obsolete consistency and folder-picker layers were removed;
 (7) the files changed;
 (8) the tests run and their results;
 (9) anything that could not be verified against the real local Telegram session.
Passing tests SHALL NOT be reported as proof of a fix. Anything that cannot be reproduced or proven SHALL be stated as unproven, explicitly and in the report's own words.

Acceptance sequences. These are the reproductions that decide whether the clauses above hold. They are run against the running application on branch `feature/bulk-channel-uploads` at current HEAD, with the real local Telegram session; the branch SHALL NOT be changed and the pull request SHALL NOT be merged as part of this work.

TEST A, stale deleted files. Precondition: the persisted index holds the 22 "TEST" rows and Telegram "TEST" holds none of them. Start FileGram: the header reads 0 files, the Files tab is empty, Select all is disabled with no count, and the persisted snapshot for that chat is zero. Refresh the browser: still zero. Restart FileGram: still zero. No stale item reappears at any point.

TEST B, real-time deletion. Send one test file to "TEST", confirm Files shows 1, delete that Telegram message externally: FileGram converges to 0 and the persisted index becomes 0.

TEST C, folder picker. Click Save to: a large Explorer-style Windows dialog opens, not the small "Browse For Folder" tree. Choose a folder: FileGram displays the selected path and subsequent downloads are written there.

TEST D, Save-to layout. At the application's real sidebar width: the control fills the width, no clipping such as `SAV...`, no duplicate controls, path legible.

Property, fix checking:

```pascal
// Property: Fix Checking - Telegram is the source of truth for the Files index
FOR ALL X WHERE staleFilesCondition(X) DO
  runReconciliation(X.chatId)
  ASSERT localIndex(X.chatId) = telegramMediaMessageIds(X.chatId)
  ASSERT persistedIndex(X.chatId) = telegramMediaMessageIds(X.chatId)
  ASSERT headerCount(X.chatId) = |telegramMediaMessageIds(X.chatId)|
  ASSERT selectAllCount(X.chatId) = headerCount(X.chatId)
  ASSERT typeCountsTotal(X.chatId) = headerCount(X.chatId)
  ASSERT paginationTotal(X.chatId) = headerCount(X.chatId)
  ASSERT diagnosticEmitted('[Files reconcile]', X.chatId)
  // and the same holds after browser refresh and after server restart
  ASSERT survivesRefresh(X.chatId) AND survivesRestart(X.chatId)
END FOR

// Property: Fix Checking - one authoritative Explorer-style folder chooser
FOR ALL X WHERE folderPickerCondition(X) DO
  dialog ← openSaveToDialog(X)
  ASSERT dialog.style = 'explorer-shell' AND dialog.style <> 'browse-for-folder-tree'
  ASSERT dialog.resizable AND dialog.hasAddressBar AND dialog.hasContentsPane AND dialog.hasSidebar
  ASSERT |boundClickHandlers('#set-dir')| = 1
  ASSERT |folderPickerEndpoints()| = 1
  chosen ← selectDirectory(dialog, D)
  ASSERT chosen = D AND configuredDownloadDir() = D
END FOR

// Property: Fix Checking - one clean full-width Save-to control
FOR ALL X WHERE saveToLayoutCondition(X) DO
  control ← renderSaveTo(X)
  ASSERT control.width = availableSidebarWidth
  ASSERT NOT clipped(control.pathText) OR pathExceeds(control.width)
  ASSERT |saveToClickTargets()| = 1 AND |visiblePathDisplays()| = 1
  ASSERT NOT existsHiddenLegacyControlOccupyingLayout()
END FOR
```

### Unchanged Behavior (Regression Prevention)

Behaviour that must survive the fix. The protection that the union, append-only and high-water logic was built to provide is legitimate for discovery; only its ability to resurrect deleted rows is defective.

3.1 WHEN a chat's Telegram messages are intact THEN the system SHALL CONTINUE TO show every one of those files in the Files tab with unchanged counts.

3.2 WHEN a large channel is scanned and the scan is partial, cancelled, or interrupted THEN the system SHALL CONTINUE TO protect the already-discovered index from being replaced by the partial result, and SHALL CONTINUE TO avoid the count fluctuation that the high-water and union logic was added to prevent.

3.3 WHEN a scan is still streaming (`done: false`) THEN the system SHALL CONTINUE TO grow the index as batches arrive, and SHALL CONTINUE NOT to treat an in-progress total as a completed one.

3.4 WHEN a chat is reopened after a browser refresh with no Telegram-side deletions THEN the system SHALL CONTINUE TO restore its index from the persisted snapshot and paint it without a full rescan.

3.5 WHEN a new file is uploaded or received in a chat THEN the system SHALL CONTINUE TO add it to the Files tab and to all counts, and SHALL CONTINUE TO replace its temporary sending id with the real message id.

3.6 WHEN the Files tab is paged THEN the system SHALL CONTINUE TO render exactly 100 entries per page with the existing pager, range labels and Next/Previous behaviour.

3.7 WHEN the Files tab is filtered, searched, or has a selection or download queue THEN the system SHALL CONTINUE TO report those counts separately from the authoritative total, and the authoritative total SHALL CONTINUE NOT to be overwritten by a filtered, current-page, search or queue figure.

3.8 WHEN a chat becomes inaccessible or is left THEN the system SHALL CONTINUE TO handle it as it does today, without treating the resulting empty scan as a deletion event for a still-accessible chat.

3.9 WHEN downloads are queued, paused, resumed, cancelled or cleared THEN the system SHALL CONTINUE TO behave as it does today, and the configured download folder SHALL CONTINUE TO be honoured by the download pipeline.

3.10 WHEN a download folder has already been configured THEN the system SHALL CONTINUE TO display it on startup and SHALL CONTINUE TO keep it when the folder dialog is cancelled.

3.11 WHEN the Downloads sidebar renders anything other than the Save-to control THEN the system SHALL CONTINUE TO render the stats card, the Parallel files slider and the queue action rows with their current alignment and behaviour.

3.12 WHEN bulk channel uploads run THEN the system SHALL CONTINUE TO work as on this branch today, including the upload queue, its ledger, duplicate review and persistence, and the Files index owner SHALL CONTINUE TO be the only writer of the Telegram Files index.

3.13 WHEN `npm run verify` runs THEN the system SHALL CONTINUE TO pass the existing `check` and `test` scripts, including the `node --check` list, which SHALL be updated to match whichever files survive consolidation.

Property, preservation checking:

```pascal
// Property: Preservation Checking
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT F(X) = F'(X)
END FOR
```

`F` is FileGram as it behaves at HEAD `90a56ce0`; `F'` is FileGram after the fix. For every interaction that is not a stale-index observation, a Save-to click, or a Save-to render, observable behaviour must be identical: same file lists, same counts, same pagination, same upload and download behaviour, same sidebar layout elsewhere.
---

# Files Consistency and Folder Picker Bugfix Design

## Overview

The three defects share one cause pattern: for each concern there are between two and eleven code paths that believe they own it, and the one that actually wins is decided by script load order, CSS specificity, or which server process happens to be running. Fixing behaviour therefore cannot mean adding another layer that behaves correctly; it means electing one owner per concern, deleting the rest, and proving the election held at run time.

The fix has five parts.

1. A verification-first phase that establishes what the browser and the server are actually executing, and instruments the real click path, the real reconcile path and the real cache writers before any behaviour is judged. This phase comes first because two of the three defects have candidate causes that only a running system can discriminate (clause 1.22, 1.24).
2. One Files index owner (`public/files-stability.js`) that owns discovery, restore, reconciliation against Telegram, and persistence. Telegram truth arrives through exactly one server request that reports completeness explicitly, so a failed scan can never look like an empty channel. Removal becomes a durable, first-class write, recorded in the persisted record itself rather than in session-lifetime tombstones.
3. One folder picker: one endpoint in `server.js`, one handler in `app.js`, and a dialog that is the Windows Vista+ common item dialog in folder-pick mode, which returns the chosen directory directly instead of deriving it from a synthetic file name.
4. One Save-to control: one node, one stylesheet block, one painter. Every competing node, stylesheet rule and paint loop is deleted rather than overridden.
5. A consolidation pass that removes the superseded layers, and a cache-token mechanism that makes a content change always produce a token change.

Two mechanisms found during design work are load-bearing and were not visible in the requirements phase. Both are recorded here as hypotheses to confirm in Phase 0, not as accepted causes.

- `daily-driver-final-guard.js` replaces the global `request` function and intercepts `scan-media-v3`. When the server's truthful result is smaller than a client-side floor (the IndexedDB record's item count, or the `tele-file-index-high-water-v1` entry), `guardStableMediaScan` discards the server result and returns `guardSnapshotAsResponse(known)` — the stale IndexedDB snapshot — stamped `done: true, fromCache: true, protectedByClientCache: true`. For chat "TEST" the server returns zero items and the floor is 22, so every one of the five rounds is below the floor and the function returns the stale 22. This also defeats `teleFilesIndex.hardRefresh()`, because `clearTotalFloor` drops the localStorage floor but not the IndexedDB record, and `guardBestKnownSnapshot` reads the record directly. If confirmed, this is the answer to clause 2.24 item (2).
- The Save-to control's clipping has a CSS specificity mechanism. `management.js` moves the entire `.downloads` panel's children into `#mg-downloads-pane`, so `daily-driver-p1.css`'s `#mg-downloads-pane #set-dir { width: 54px !important; min-width: 54px !important; padding: 0 !important }` applies. At two ID selectors it outranks both injected rules (`#set-dir.fg-download-folder-picker` and `#set-dir.fg-folder-v2`, one ID plus one class), so the button is 54px wide no matter what the JS layers inject. A 54px flex button containing a folder glyph, a `Save to` micro-label and a path renders as `[icon] SAV...` with `F:...` wrapped underneath, which is the reported shape. If confirmed, this is why every previous Save-to fix was invisible: the fixes were `!important` rules that lose on specificity.

## Glossary

- **Bug_Condition (C)**: the predicate identifying interactions that trigger a defect. Defined in the requirements section and restated formally below: a stale-index observation, a Save-to click, or a Save-to render.
- **Property (P)**: the required behaviour for inputs satisfying C. Telegram truth wins for the index; a large Explorer-style dialog returning the chosen directory for the picker; one full-width control for the layout.
- **Preservation**: behaviour that must be identical before and after the fix for every interaction not matching C, listed as clauses 3.1 to 3.13. The partial-scan protection in clauses 3.2 and 3.3 is explicitly preserved.
- **Truth pass**: one complete walk of a chat's history that reached the real end of history without cancellation, error or guard trip. Only a truth pass may remove items.
- **Incomplete truth**: any scan that was cancelled, hit an iteration guard, threw, or ran against an inaccessible chat. Never a licence to prune (clauses 2.10, 2.11, 3.8).
- **`window.teleFilesIndex`**: the owner API exposed by `public/files-stability.js` (`ensure`, `snapshot`, `count`, `total`, `hardRefresh`), and after this fix also `reconcile` and `retireTemporary`.
- **`committed`**: the owner's in-memory `Map` of chatId to normalized snapshot, the only source the header, Select all, the pager and `filesItems()` read.
- **`rescueFileCache`**: the legacy shared `Map` declared in `public/rescue-runtime.js`. Eleven sites across ten files currently write it; after the fix the owner is the only writer.
- **Persistent record**: the IndexedDB row in database `tele-daily-driver-cache-v1`, store `file-indexes`, keyed by chatId. Currently written by `teleP0v2WriteIndex` in `public/daily-driver-p0-v2.js`; after the fix owned by `files-stability.js`.
- **`removedIds`**: new durable per-chat removal list carried inside the persistent record, the replacement for in-memory tombstones (clause 2.13).
- **`reconciledAt`**: new watermark in the persistent record. Union inputs older than it cannot contribute removed ids.
- **High-water floor**: `localStorage` key `tele-file-index-high-water-v1`, read and written today by three independent implementations (`files-stability.js`, `uploads-hardening.js`, `daily-driver-final-guard.js`) plus a delete path in `file-consistency-v2.js`.
- **Reconcile mark**: `localStorage` key `filegram-files-delete-reconcile-v1`, written by `uploads-hardening.js`, which permanently disables future reconciliation for a chat (clause 1.9). Deleted by this fix.

## Bug Details

### Bug Condition

Restated from the requirements section, with the mechanisms found since. `X` is one interaction with the running application.

```
FUNCTION isBugCondition(X)
  INPUT: X of type RuntimeInteraction
  OUTPUT: boolean

  RETURN staleFilesCondition(X) OR folderPickerCondition(X) OR saveToLayoutCondition(X)
END FUNCTION

FUNCTION staleFilesCondition(X)
  RETURN X.surface = 'files'
     AND EXISTS id IN localIndex(X.chatId)
         WHERE id NOT IN telegramMediaMessageIds(X.chatId)
END FUNCTION

FUNCTION folderPickerCondition(X)
  RETURN X.surface = 'downloads' AND X.action = 'click-save-to'
END FUNCTION

FUNCTION saveToLayoutCondition(X)
  RETURN X.surface = 'downloads' AND X.action = 'render-save-to'
END FUNCTION
```

The persistence boundary that makes a prune non-durable, and the interception that makes a rescan non-truthful, are both expressible as predicates. Both must become false after the fix.

```
FUNCTION shrinkIsDiscarded(chatId, next)
  // public/daily-driver-p0-v2.js, teleP0v2WriteIndex
  stored := persistentRecord(chatId).items.length
  RETURN stored > next.items.length AND NOT options.allowShrink
END FUNCTION            // no caller in the repository passes allowShrink

FUNCTION truthIsOverriddenByCache(chatId, serverResult)
  // public/daily-driver-final-guard.js, guardStableMediaScan
  floor := MAX(persistentRecord(chatId).items.length, highWaterCount(chatId))
  RETURN floor > 0 AND serverResult.items.length < floor
END FUNCTION            // returns guardSnapshotAsResponse(known) instead
```

### Examples

- Chat "TEST", Telegram holds zero media messages, the persistent record holds 22. Expected: header `0 files`, empty Files tab, persisted record empty. Actual: `TEST - 22 files`, 22 rows including `photo_400556032.jpg`, `Select all (22)`, and the same after refresh and after server restart.
- A prune runs on screen and the list empties. Expected: the persisted record is empty. Actual: `teleP0v2WriteIndex` sees stored 22 against next 0 and returns before writing, so the next `restore()` unions the untouched record back in.
- `teleFilesIndex.hardRefresh(chatId)` is called on the stale chat. Expected: a forced server scan replaces the index with Telegram truth. Actual: `guardStableMediaScan` runs up to five rounds, finds every truthful result below the floor of 22, and returns the stale snapshot as if it were a completed scan.
- `GET /api/filegram/live-media-ids/:chatId` answers 503 because `activeClient` is null. Expected: the pass is reported as unknown and nothing changes. Actual: one `console.warn`, stale count left on screen, and the same failing call retried every 500 ms by the interval in `file-consistency-v2.js`.
- A chat genuinely has media but `searchChatMessages` returns nothing for all seven filters. Expected: unknown, no pruning. Actual: `exact: ids.length < 5000` is true for an empty result, so the empty set is treated as truth and live files may be pruned.
- The user clicks Save to. Expected: a large resizable Explorer dialog. Actual: the small legacy Browse For Folder tree. No `FolderBrowserDialog` exists in any loaded file at HEAD; commit `767e283e` did add one to `bulk-upload-preload.js` and `ad9c229c` replaced it with `OpenFileDialog`, so a server process started before `ad9c229c` still serves the legacy dialog. Edge case: the picker returns `Split-Path -Parent "Select this folder"`, which is empty when the dialog leaves a bare file name in the box, and the response is then indistinguishable from a cancel.
- The Downloads sidebar paints Save to. Expected: one full-width row of icon, path, chevron. Actual: `SAVE TO`, then a 54px button rendering `[icon] SAV...` over `F:...`.

## Expected Behavior

### Preservation Requirements

Unchanged behaviours, drawn from clauses 3.1 to 3.13 and named here at the level of the code that must keep working:

- Every file that still exists in Telegram remains listed with unchanged counts (3.1). The reconciliation is subtractive only against a confirmed truth pass; it never rewrites item payloads.
- Partial, cancelled or interrupted scans still cannot replace a larger discovered index, and the count still does not fluctuate (3.2). The owner keeps `isCompleteSnapshot`, keeps the union, keeps the progress-flush batching (`PROGRESS_FLUSH_MS` 350, `PROGRESS_FLUSH_ITEMS` 800) and keeps ignoring obsolete progress events for chats with a complete index.
- A streaming scan (`done: false`) still grows the index batch by batch and is still not treated as a completed total (3.3). `union()` still ORs `done`.
- Reopening a chat after refresh with no Telegram-side deletions still restores from the persisted record and paints without a full rescan (3.4). `ensure()` keeps its restore-first short circuit.
- Uploads still appear immediately and still swap temporary sending ids for real message ids (3.5). The synthetic `updateDeleteMessages` for retired temporary ids in `bulk-upload-preload.js` `installTemporaryMessageRetirement` stays, and the temporary-id suppression in `uploads-hardening.js` `installRealtimeHardening` stays, rerouted through the owner API.
- The pager still renders 100 rows per page with the existing range labels (3.6), and filtered, search, selection and queue counts stay separate from the authoritative total (3.7). `files-view.js` is untouched.
- An inaccessible or left chat behaves as today and its empty scan is not a deletion event (3.8). The truth request reports accessibility explicitly.
- Download queue behaviour and the honoured download folder are unchanged (3.9), a configured folder still shows on startup and survives a cancelled dialog (3.10).
- The stats card, Parallel files slider and queue action rows keep their current alignment and behaviour (3.11). Only the Save-to block of the CSS changes.
- Bulk channel uploads, the upload queue, its ledger, duplicate review and persistence are unchanged (3.12). The transport hardening in `uploads-hardening.js` stays; only its index and Save-to code is removed.
- `npm run verify` still passes (3.13), with the `node --check` list updated to the files that survive.

Scope. Every interaction that is not a stale-index observation, a Save-to click or a Save-to render must be byte-for-byte identical in observable behaviour: messages, chat list, previews, uploads, downloads, packing, selection, search.

## Hypothesized Root Cause

Ordered by how much of the reported behaviour each would explain. Each is a Phase 0 verification target, not a conclusion.

1. **Client-side cache outranks Telegram truth (Bug 1, primary).** `guardStableMediaScan` in `daily-driver-final-guard.js` intercepts the global `request` for `scan-media-v3` and substitutes the stale IndexedDB snapshot whenever the truthful result is below a client-side floor. It also re-writes the high-water floor from that stale snapshot on every pass (`guardRememberHighWater(chatId, best.items.length)`), so clearing the floor is futile while the record survives. This alone would make every previous fix invisible, because it defeats both the normal path and the hard refresh.
2. **The persistence boundary discards legitimate shrinks (Bug 1).** `teleP0v2WriteIndex` returns without writing when `storedCount > snapshot.items.length` and no caller passes `allowShrink`. Ten call sites across nine files route every prune through it. On-screen pruning is therefore never durable, which explains why a prune appears to work and does not survive refresh (clauses 1.4, 1.6). Note that `scripts/files-invariants.test.cjs` currently asserts this behaviour, so the suite actively pins the defect in place.
3. **Restore unions stale sources (Bug 1).** `restore()` in `files-stability.js` unions memory, `rescueFileCache` and the IndexedDB record; `union()` ORs `done`; and seven other files still restore from IndexedDB in their own `openChat` wrappers (`daily-driver-hotfix.js`, `p1`, `p2`, `final`, `final-guard`, `final-ui-fix`, plus the p0-v2 `rescueEnsureAllFiles` override). Any one surviving copy repopulates the index.
4. **Reconciliation cannot tell failure from emptiness, and can be permanently disabled (Bug 1).** `collectLiveMediaIds` reports `exact: ids.length < 5000`, which is true for a failed empty scan; `reconcileSmallChat` requires `payload.exact` and otherwise only warns while retrying every 500 ms; and `uploads-hardening.js` writes a permanent per-chat mark to `filegram-files-delete-reconcile-v1` that suppresses reconciliation in all later sessions.
5. **A stale server process serves the old dialog (Bug 2, primary).** No `FolderBrowserDialog` exists in any loaded file at HEAD, but `767e283e` added one to `bulk-upload-preload.js` and `ad9c229c` replaced it. A Node process started between those commits, still listening on port 3000, would serve the legacy tree dialog from memory forever. Verifiable from the process start time against the commit time.
6. **A stale cached frontend serves an old handler (Bugs 2 and 3).** `?v=` tokens are reused across content edits (`file-consistency-v2.js?v=3`, `uploads-hardening.js?v=3`), so the browser may execute an older copy. The reported render shape matches the `uploads-hardening.js` paint alone, without the `file-consistency-v2.js` layer that should have hidden the `SAVE TO` heading, which is consistent with v2 not executing in the user's browser.
7. **CSS specificity, not JS, decides the control's width (Bug 3, primary).** `#mg-downloads-pane #set-dir { width: 54px !important }` in `daily-driver-p1.css` outranks the injected `#set-dir.fg-download-folder-picker` and `#set-dir.fg-folder-v2` rules. Ten stylesheets or injected blocks currently declare rules for `#set-dir`, `#dl-dir` or `.dir-current`: `style.css`, `telegram-polish.css`, `telegram-daily-driver.css`, `daily-driver-hotfix.css`, `daily-driver-p0.css`, `daily-driver-p1.css`, `daily-driver-final.css`, `filegram-ui.css`, plus `#fg-hardening-style` and `#fg-download-folder-v2-style`.
8. **Six JS layers paint the same node (Bug 3).** `app.js` (`setDirLabel`, `#set-dir.onclick`), `auth-state-fix.js` (`restoreDownloadDirHint`), `daily-driver-p0-v2.js` (`teleP0v2RefreshPath`, a 1500 ms interval plus a click listener), `filegram-shell.js` (sets the text to `Browse`), `uploads-hardening.js` (a MutationObserver, a 25 ms interval and a 15 s sweep), `file-consistency-v2.js` (clone-replaces the node every 500 ms). Whichever runs last wins, and the winner changes with load order and timing.
9. **The directory return is fabricated (Bug 2, secondary).** Both surviving implementations derive the directory from `Split-Path -Parent` of the synthetic file name `Select this folder`, which can yield a parent directory or an empty string that is then reported as a cancel.

## Correctness Properties

Property 1: Bug Condition - Telegram is the source of truth for the Files index

_For any_ interaction where the bug condition holds because the local index disagrees with Telegram (`staleFilesCondition`), after a truth pass the fixed owner SHALL make the in-memory index, the persisted record, the chat header, the Select all count, the type counts and the pagination totals all equal the set of media message ids Telegram reports for that chat, SHALL keep that equality across a browser refresh and a server restart, and SHALL emit exactly one `[Files reconcile]` diagnostic line for the pass.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.12, 2.13**

Property 2: Bug Condition - an unavailable or incomplete truth source never prunes

_For any_ interaction where the live truth request fails, is cancelled, hits a guard, or runs against an inaccessible chat, the fixed owner SHALL treat the result as unknown, SHALL leave the index and the persisted record byte-identical, SHALL surface the state in the load-state line and the diagnostic rather than only in `console.warn`, and SHALL retry with exponential backoff rather than on a fixed 500 ms interval.

**Validates: Requirements 2.10, 2.11**

Property 3: Bug Condition - one authoritative Explorer-style folder chooser

_For any_ Save-to click (`folderPickerCondition`), the fixed application SHALL invoke exactly one bound handler, which SHALL reach exactly one endpoint, which SHALL open the Windows common item dialog in folder-pick mode: resizable, with an address bar, a contents pane and a sidebar, and never the legacy Browse For Folder tree. Choosing a directory SHALL return that exact directory, display it in the control and use it for later downloads; cancelling SHALL leave the configured folder unchanged.

**Validates: Requirements 2.14, 2.15, 2.16, 2.17**

Property 4: Bug Condition - one clean full-width Save-to control

_For any_ Save-to render (`saveToLayoutCondition`), the fixed application SHALL expose exactly one click target and one path display for the download destination, SHALL give that control the full available sidebar width at the application's real width, SHALL apply ellipsis only when the path genuinely exceeds that width, and SHALL leave no hidden legacy node occupying layout and no second stylesheet or paint routine addressing the same node.

**Validates: Requirements 2.18, 2.19, 2.20**

Property 5: Bug Condition - one owner per concern, observable at run time

_For any_ run of the fixed application, there SHALL be exactly one owner for Files reconciliation, one for the folder-picker backend and one for the Save-to control; the obsolete layers SHALL be absent from the tree rather than dormant; every asset's cache token SHALL change whenever its content changes; and the runtime composition SHALL be reportable from the running system so a claim about behaviour can be tied to the code that produced it.

**Validates: Requirements 2.21, 2.22, 2.23, 2.24**

Property 6: Preservation - every interaction outside the bug condition is unchanged

_For any_ interaction where the bug condition does NOT hold (`NOT isBugCondition(X)`), the fixed application SHALL produce the same observable result as HEAD `90a56ce0`, preserving intact file lists and counts, restore-without-rescan, upload and temporary-id behaviour, pagination and separated filtered counts, inaccessible-chat handling, the download queue and configured folder, the rest of the Downloads sidebar, bulk channel uploads, and a passing `npm run verify`.

**Validates: Requirements 3.1, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 3.11, 3.12, 3.13**

Property 7: Preservation - partial-scan protection survives the fix

_For any_ scan that is partial, cancelled, interrupted or still streaming, the fixed owner SHALL continue to protect the already-discovered index from replacement by the partial result, SHALL continue to grow the index as batches arrive without treating an in-progress total as complete, and SHALL continue to suppress the count fluctuation the union and high-water logic was added to prevent — while no longer allowing any of those mechanisms to reintroduce an item that a truth pass removed.

**Validates: Requirements 3.2, 3.3**

## Fix Implementation

### Phase 0: verification before any change

No clause may be judged, and no cause accepted, until this phase has produced its artefacts. The user has explicitly refused fixes justified by static inspection, and two of the three defects have candidate causes (stale process, stale cache) that static inspection cannot discriminate.

**0.1 Establish what the server process is.** Record the PID listening on port 3000 and its start time (`Get-NetTCPConnection -LocalPort 3000`, then `Get-Process -Id <pid> | Select-Object StartTime`), and compare that timestamp with the commit time of `ad9c229c` (the commit that replaced `FolderBrowserDialog` with `OpenFileDialog` in `bulk-upload-preload.js`). Then add a startup banner to `server.js` printing pid, start time and a build id (short `git rev-parse --short HEAD` captured at boot, falling back to a sha256 prefix over `server.js` plus the preload files), and expose the same build id on the existing `status` response so the browser can print it. Restart with `npm start` and re-run the picker. If the dialog changes shape after nothing but a restart, hypothesis 5 is confirmed and is the answer to clause 2.24 item (4).

**0.2 Establish what the browser is executing.** In the running app, evaluate `[...document.scripts].map(s => s.src)` and, for each dynamically appended script, fetch it and hash the response body; compare against the on-disk hash. Print one `[FileGram runtime]` line listing script, token and whether the served body matches disk. This decides hypothesis 6 and satisfies the "confirm the browser is running the current code before any behaviour is judged" half of clause 2.22.

**0.3 Instrument the real Save-to click path.** Before changing anything, in the console: enumerate the handlers by replacing `#set-dir` with a clone and observing which layers rebind (`uploads-hardening.js` assigns `onclick`, `file-consistency-v2.js` clone-replaces and adds a listener), wrap `window.fetch` to log any request whose URL contains `pick-download-folder`, and record which URL is actually requested and what the response body is. This produces the end-to-end chain required by clause 2.16 for the pre-fix state.

**0.4 Instrument the real Save-to render.** Read `getComputedStyle(document.querySelector('#set-dir')).width` and use the browser's matched-rules view (or `document.styleSheets` enumeration filtered to selectors containing `set-dir`) to list every rule that matched, in cascade order, with its specificity. Confirm or refute hypothesis 7 by observing whether the winning width rule is `#mg-downloads-pane #set-dir`. Also confirm which parent the node has at run time (`#mg-downloads-pane` after `management.js` moves the panel children).

**0.5 Instrument the real reconcile and resurrection paths.** Temporarily wrap the five boundaries and log a stack trace at each: `rescueFileCache.set`, `teleP0v2WriteIndex` (log chatId, stored count, incoming count, and whether it returned early), `teleP0v2ReadIndex`, the global `request` for `scan-media-v3` (log the payload and the shape of what the caller received, including `protectedByClientCache`), and `handleEvent` for `message-delete`. Then open chat "TEST" and record: which layers write the shared cache, whether the prune reaches IndexedDB, and whether `scan-media-v3` returns the server's result or the guard's substitute. This enumerates every path required by clause 2.7 at run time, and it is what turns hypotheses 1 to 4 into a confirmed or refuted chain. If `truthIsOverriddenByCache` is observed returning the stale snapshot, that is recorded as the answer to clause 2.24 item (2).

**0.6 Record the composition map.** Produce the short dependency and load-order map required by clause 2.21 from the artefacts of 0.1 to 0.5, including which of the three orphan files (`public/file-consistency-fix.js`, `native-folder-picker-preload.js`, `file-consistency-server-preload.js`) never appear in it.

All Phase 0 instrumentation is temporary console work plus the two permanent additions named above (the server banner and build id, and the `[FileGram runtime]` script report). Nothing else from Phase 0 ships.

### Phase 1: one Telegram truth source (`server.js`)

`server.js` already owns the media index (`mediaIndexCache`), the full-history walk (`scanMediaIndexV3`), the live delete path (`deleteMediaIndexMessages`) and the `set-download-dir` request, so it is the right owner for truth.

1. **Explicit completeness in the existing walk.** `scanMediaIndexV3` currently exits its `for` loop on three different conditions — an empty page (the real end of history), a repeated cursor, and `newMessages === 0` — and reports only `done: !job.cancelled`. Add `job.historyComplete`, set true only on the empty-page exit, and include `historyComplete` in the snapshot, in `cloneMediaIndexSnapshot` and in the `media-index-progress` payload. The 100000-iteration guard tripping, a cursor repeat, a cancel or a throw all leave it false.
2. **One truth request.** Add ws request `media-truth-v1` taking `{ chatId }` and returning `{ ok, ids, count, complete, accessible, scanned, source }`. It probes the chat with `getChat` for `accessible`, reuses `mediaIndexCache` when the cached snapshot has `historyComplete && !cancelled` (`source: 'cache'`), and otherwise performs the same `getChatHistory` walk used by `scanMediaIndexV3` collecting only ids where `extractMedia(message)` yields a file and `message.sending_state === undefined` (`source: 'walk'`). `complete` is the conjunction of `accessible`, the empty-page exit, and no thrown error. There is no 5000-item cap and no `ids.length < 5000` heuristic: completeness is a property of how the walk ended, not of how many rows it found.
3. **Delete the competing truth sources.** Remove `GET /api/filegram/live-media-ids/:chatId`, `POST /api/filegram/reconcile-message-ids/:chatId` and their helpers (`LIVE_MEDIA_FILTERS`, `collectLiveMediaIds`, `liveMediaIds`, `reconcileMessageIds`, `missingMessageError`, `mapLimit`) from `bulk-upload-preload.js`. Delete `file-consistency-server-preload.js` entirely. Only `uploads-hardening.js` and the two files being removed call these endpoints, so nothing in the bulk upload path is affected (clause 3.12).

### Phase 2: one Files index owner (`public/files-stability.js`)

The file already declares itself the persistent Files index owner, already exposes `window.teleFilesIndex`, already owns `media-index-progress` and the count label, and is already in the `node --check` list. It absorbs persistence and reconciliation.

1. **Own persistence.** Move the IndexedDB code out of `daily-driver-p0-v2.js` into the owner as `openDb`, `readPersistent(chatId)` and `writePersistent(chatId, snapshot, { reason })`. `writePersistent` has no monotonic guard: it writes what the owner decided, so a shrink to zero is an ordinary write (clause 2.6). The protection that the guard was standing in for moves to where it belongs — only two functions may call it: `commitDiscovery` (additive, from scans and progress flushes, which cannot lower a count because it unions) and `commitAuthoritative` (from a confirmed truth pass, which may lower it to zero). A partial scan result has no route to `writePersistent` as a replacement, which is how clause 3.2 survives without a size check at the boundary.
2. **Record removals durably.** The persistent record gains `reconciledAt` (ms timestamp of the last truth pass), `truthCount`, and `removedIds` (an array of `{ id, at }`, newest first, capped at 5000 entries per chat and pruned by age at 30 days). `commitAuthoritative` appends the pruned ids to `removedIds` and stamps `reconciledAt`. This is the durable replacement for the in-memory tombstone sets in `file-consistency-v2.js` and `uploads-hardening.js`, and it is what makes correctness independent of session lifetime (clause 2.13).
3. **Make every restore path removal-aware while keeping its protection.** `union(chatId, ...snapshots)` keeps ORing `done` and keeps merging additively, but gains a filter: an item may not enter the result if its id is in the winning record's `removedIds` and the contributing snapshot's `savedAt` is older than `reconciledAt`. A truth pass that later reports the id as present removes it from `removedIds`, so a genuinely re-uploaded file is not permanently blacklisted. Each of the paths named in clause 2.7 is then individually covered: the in-memory `committed` entry (filtered on commit), `rescueFileCache` (filtered on union, and after Phase 4 the owner is its only writer), the IndexedDB record (filtered on union in `restore`), scan-result merging (`commitDiscovery` runs the same filter), `message-upsert` (`syncFromSharedAfterRealtime` is replaced by a direct owner-side merge that runs the filter), startup restore (`ensure` -> `restore`), and the remaining compatibility layers (deleted in Phase 4). Phase 0's `rescueFileCache.set` instrumentation is re-run after the fix to show, at run time, that no other writer exists.
4. **Subordinate the high-water floor to truth.** `rememberTotalFloor` is called only for a snapshot from a complete scan or a truth pass. `commitAuthoritative` writes the floor down to the reconciled count (or deletes the entry at zero). `maybeRepairIndex` fires only when the shortfall is measured against a floor whose `at` is newer than `reconciledAt`, so a legitimate shrink can never trigger a rescan back to a stale total (clause 2.8). The duplicate floor implementations in `uploads-hardening.js` (`exactHighWater`) and `daily-driver-final-guard.js` (`guardRememberHighWater`, `guardHighWaterCount`, `GUARD_HIGH_WATER_KEY`) are deleted, leaving one reader and one writer of `tele-file-index-high-water-v1`.
5. **Add `reconcile(chatId, options)`, the only subtractive path.**

```
FUNCTION reconcile(chatId, options)
  IF inFlight(chatId) THEN RETURN inFlight(chatId)
  IF NOT options.force AND now - lastReconcileAttempt(chatId) < THROTTLE_MS THEN RETURN skipped

  truth := request('media-truth-v1', { chatId })          // one call, no polling
  cached := committed(chatId) OR restore(chatId)

  IF truth failed OR NOT truth.complete THEN
    scheduleBackoffRetry(chatId)                          // 2s, 4s, 8s ... cap 5 min
    setLoadState('Could not verify against Telegram - showing last known index')
    log('[Files reconcile]', chatId, cached.count, unknown, [], cached.count, 'skipped:incomplete-truth')
    RETURN unknown
  END IF

  live    := SET(truth.ids)
  missing := cached.items WHERE isTemporary(id) OR id NOT IN live
  IF missing IS EMPTY THEN
    stampReconciled(chatId, truth.count)                  // reconciledAt, truthCount, floor
    log('[Files reconcile]', chatId, cached.count, truth.count, [], cached.count, 'no-change')
    RETURN unchanged
  END IF

  next   := commitAuthoritative(chatId, cached MINUS missing, truth)
  result := writePersistent(chatId, next, { reason: 'reconcile' })
  repaint(chatId, next)                                   // header, Select all, type counts, pager
  log('[Files reconcile]', chatId, cached.count, truth.count, missing, next.count, result)
  RETURN pruned
END FUNCTION
```

`reconcile` is called from `ensure()` after a successful restore, from the `openChat` path once per chat per throttle window, and unconditionally from `teleFilesIndex.hardRefresh()`. There is no permanent per-chat suppression: the reconcile mark key `filegram-files-delete-reconcile-v1` is deleted, its reads and writes are removed, and a one-time startup migration removes the stored value so an existing installation is not stuck (clause 2.9). `THROTTLE_MS` is a per-session freshness window (60 s proposed), not a durable mark.

6. **Handle live deletions in the owner.** The owner's `handleEvent` wrapper handles `message-delete` directly: remove the ids from `committed`, append them to `removedIds`, `writePersistent` immediately, repaint. The server already emits this event from `updateDeleteMessages`, from `updateMessageSendSucceeded` for retired temporary ids, and from the explicit delete path, and it already prunes its own `mediaIndexCache`, so no additional server work is needed for clause 2.2. The current `syncFromSharedAfterRealtime` union-from-shared on delete is removed, because reading back the shared cache after a delete is one of the resurrection paths.
7. **Emit the required diagnostic.** Exactly one line per pass, at `console.info`, in a fixed shape so it can be grepped and pasted into the final report (clause 2.12):

```
[Files reconcile] chatId=-1001234567890 cached=22 live=0 missing=[400556032,393216000,391118848,+19 more] remaining=0 persisted=written(reason=reconcile,bytes=…) truth=walk complete=true
[Files reconcile] chatId=-1001234567890 cached=22 live=unknown missing=[] remaining=22 persisted=skipped(reason=incomplete-truth) truth=walk complete=false accessible=true
```

The missing list is printed in full up to 20 ids and then summarised, and the full array is attached as a second console argument so it stays inspectable.

8. **Expose the API the other layers need.** Add `reconcile(chatId, options)` and `retireTemporary(chatId, ids)` to `window.teleFilesIndex` so `uploads-hardening.js` can keep its temporary-id correctness (clause 3.5) without owning any index state.

### Phase 3: one folder picker

**Backend owner: `server.js`.** Add `POST /api/filegram/pick-download-folder` to `server.js` beside the existing routes, so reachability no longer depends on which preloads `npm start` happens to wrap. It spawns `powershell.exe -NoProfile -STA -EncodedCommand <base64 utf16le>` and returns `{ ok, cancelled, path, implementation }`. The rejected alternative was a ws request; HTTP was chosen because it keeps the existing frontend contract and needs no protocol change, and because the endpoint is already the shape the frontend expects. Adding this introduces `node:child_process` to `server.js`, which currently does not require it.

**Dialog: the Windows common item dialog in folder-pick mode.** The script uses `Add-Type` to define the `IFileOpenDialog` / `IShellItem` interop and calls the dialog with `FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST`, then reads the result with `GetResult()` and `GetDisplayName(SIGDN_FILESYSPATH)`. This is the same large, resizable Explorer surface modern applications use for choosing a folder: address bar, contents pane, sidebar. It returns the chosen directory itself, so there is no synthetic file name, no `Split-Path -Parent`, no parent-directory surprise and no empty result that looks like a cancel (clause 2.17). A cancel surfaces as `HRESULT_FROM_WIN32(ERROR_CANCELLED)`, which the script reports as `cancelled` with no path, and the handler then leaves the configured folder untouched (clause 3.10). The response carries `implementation: 'IFileOpenDialog'` so the running dialog can be identified from the response body during TEST C — that field is how a stale process is caught in future.

Fallback policy: if Phase 0 or TEST C shows the interop shim unavailable on this machine, the fallback is `OpenFileDialog` with `ValidateNames = $false`, but with the directory taken from the dialog's own `FileName` resolved through `[System.IO.Path]::GetDirectoryName` only when that file name is a real path, and reported as `implementation: 'OpenFileDialog'`. The fallback is a documented degradation, not a silent one, and TEST C decides whether it is needed.

**Frontend owner: `public/app.js`.** `$('#set-dir').onclick` becomes the single handler: POST the endpoint, and on a non-cancelled result call `request('set-download-dir', { dir })` and then `setDirLabel(result.downloadsDir || dir)`. `setDirLabel` remains the single painter. Every other binding is deleted (Phase 4), so the node is bound once and load order stops mattering (clause 2.16).

**Deletions.** `POST /api/filegram/pick-download-folder` and `pickWindowsFolder` leave `bulk-upload-preload.js`; `native-folder-picker-preload.js` and its `-modern` endpoint are deleted; `public/file-consistency-fix.js` and `public/file-consistency-v2.js` (which contains the third and fourth handlers) are deleted.

### Phase 4: one Save-to control

**DOM (`public/index.html`).** The current block — `label.conc` with a `<span>Save to</span>`, a `.row` holding `#dl-dir` and `#set-dir`, plus the separate `#dl-dir-current` line — is replaced by one button and nothing else:

```html
<button id="set-dir" class="fg-save-to" type="button" title="">
  <span class="fg-save-to-icon" aria-hidden="true">…</span>
  <span class="fg-save-to-copy">
    <span class="fg-save-to-label">Save to</span>
    <span class="fg-save-to-path" id="dl-dir-path"></span>
  </span>
  <span class="fg-save-to-chevron" aria-hidden="true">…</span>
</button>
```

`#dl-dir` and `#dl-dir-current` are removed from the markup entirely rather than hidden, which is what makes clause 2.20 provable: there is no hidden legacy node to occupy layout, and the "which of three controls is visible" question disappears. The button carries the full path in `title` for the tooltip, and the accessible name comes from the label and path text. `setDirLabel(dir)` in `app.js` writes `#dl-dir-path` text and the `title`, and keeps calling the `auth-state-fix.js` wrapper that persists the value to `localStorage` under `filegram-download-dir-v1`; `restoreDownloadDirHint` is rewritten to call `setDirLabel` instead of touching the removed nodes.

**CSS (`public/filegram-ui.css`, one block).**

```
#mg-downloads-pane #set-dir.fg-save-to, .downloads #set-dir.fg-save-to { … }
```

Both parents are addressed in one rule with two ID selectors, so it wins wherever `management.js` has moved the panel, and no other rule in the tree targets the control. The block sets `display:flex`, `width:100%`, `min-width:0`, a fixed comfortable height, `gap`, `padding`, `text-align:left`, the dark surface and border, the hover state, and gives `.fg-save-to-path` `min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap` so ellipsis appears only when the path genuinely exceeds the width (clause 2.19). No `!important` is required once the competing rules are gone, and their absence is asserted by a source-level invariant rather than trusted.

**Rules and code deleted, per file.** The five-way fight named in the requirements is in fact wider; all of the following go:

- `public/style.css`: the `.conc input[type=text]`, `.conc .row { width: 60% }` and `.dir-current` rules that apply to this block.
- `public/telegram-polish.css`: `#mg-downloads-pane #dl-dir`, `#mg-downloads-pane .dir-current`.
- `public/telegram-daily-driver.css`: `#mg-downloads-pane #dl-dir`, `#mg-downloads-pane #set-dir` (`min-width:48px`), `#mg-downloads-pane .dir-current`.
- `public/daily-driver-hotfix.css`: `.downloads #dl-dir`, `.downloads .dir-current`.
- `public/daily-driver-p0.css`: `.downloads .dl-controls .conc:first-of-type > .row`, `.downloads #dl-dir`, `.downloads #set-dir`, `.downloads .dir-current`.
- `public/daily-driver-p1.css`: `#mg-downloads-pane .dl-controls .conc:first-of-type > .row`, `#mg-downloads-pane #dl-dir`, `#mg-downloads-pane #set-dir` (the 54px rule), `#mg-downloads-pane .dir-current`.
- `public/daily-driver-final.css`: `#mg-downloads-pane #dl-dir`.
- `public/filegram-ui.css`: the existing `#dl-dir`, `#dl-dir:focus`, `#set-dir`, `#set-dir:hover`, `.dir-current, #dl-dir-current` rules, replaced by the single new block. The `.dl-controls .conc` rules that serve the Parallel files row stay untouched (clause 3.11).
- `public/uploads-hardening.js`: `installHardeningStyles` (`#fg-hardening-style`), `paintFolderButton`, `installDownloadFolderPicker`, the `setDirLabel` wrapper, and the Save-to work inside `installUiCleanup`, its MutationObserver, its 25 ms interval and its 15 s sweep. `removeCaptionUi` and `removeDuplicateHeaderInfo` keep their own cleanup loop.
- `public/file-consistency-v2.js`: deleted with the file (`#fg-download-folder-v2-style`, the clone-replace, the 500 ms interval).
- `public/daily-driver-p0-v2.js`: `teleP0v2RefreshPath`, its `#dl-dir` input listener, its `#set-dir` click listener, its 1500 ms interval and its initial call.
- `public/filegram-shell.js`: the `setDir.textContent = 'Browse'` block in `installDownloadIcons`.
- `public/file-consistency-fix.js`: deleted with the file.

### Phase 5: consolidation and deletion

Files deleted outright:

| File | Why | Where its concern lives now |
| --- | --- | --- |
| `public/file-consistency-v2.js` | loaded last and wins `#set-dir`, but duplicates reconciliation, the picker handler and the Save-to paint | `files-stability.js`, `app.js`, `index.html` + `filegram-ui.css` |
| `public/file-consistency-fix.js` | loaded by nothing (clause 1.21) | — |
| `native-folder-picker-preload.js` | required by nothing; its `-modern` endpoint cannot answer | `server.js` picker endpoint |
| `file-consistency-server-preload.js` | required by nothing; duplicate truth source | `media-truth-v1` in `server.js` |

Index, count and persistence code removed from the layers that keep their other duties:

- `daily-driver-p0-v2.js`: remove `teleP0v2DbName`, `teleP0v2Store`, `teleP0v2Db`, `teleP0v2ReadIndex`, `teleP0v2WriteIndex`, `teleP0v2PersistTimers`, `teleP0v2PersistSoon`, `teleP0v2ValidSnapshot`, `teleP0v2PaintIndex`, `teleP0v2Sync`, the `rescueEnsureAllFiles` override and the `media-index-progress` branch of its `handleEvent` wrapper. Keep the search rebind, the unified media viewer (`rescuePreviewFile`), the grid card hook and the attachment/composer code.
- `daily-driver-p1.js`, `daily-driver-p2.js`, `daily-driver-hotfix.js`: remove their `openChat` index restores, their `rescueFileCache.set` sites, their progress handling and their `teleP0v2WriteIndex` calls. Keep the sorting helper, the preview modal and the thumbnail helpers other layers still call.
- `daily-driver-final.js`: remove `teleFinalApplySnapshot`, `teleFinalRestorePersistent`, the partial paint path and the persist call, and the `openChat` restore hook.
- `daily-driver-final-ui-fix.js`: remove `canonicalIndexes`, `normalizeIndex`, `mergeIndexes`, its commit/restore functions and its two persist calls.
- `daily-driver-final-guard.js`: remove `guardStableMediaScan`, the `request = function teleGuardRequest` interception, `guardBestKnownSnapshot`, `guardSnapshotAsResponse`, `guardScanShape`, `guardMemorySnapshot`, `guardIsCompleteSnapshot`, `guardRememberHighWater`, `guardHighWaterCount`, `GUARD_HIGH_WATER_KEY`, and the `guardUpdateMediaLabel` / `rescueUpdateMediaLabel` assignment. Keep the keyed chat-list reconciliation, avatar handling, read marking and the `setLoadState` smoothing.
- `rescue-runtime.js`: `rescueEnsureAllFiles` becomes a thin delegate to `window.teleFilesIndex.ensure` with no cache writes. `rescueFileCache` stays declared, because many readers still reference it, but the owner becomes its only writer.
- `telegram-daily-driver.js`: remove its `media-index-progress` `rescueFileCache.set` path.
- `uploads-hardening.js`: remove `HIGH_WATER_KEY`, `RECONCILE_MARK_KEY`, `deletedByChat`, `reconcileFlights`, `reconciledThisSession`, `indexSnapshot`, `exactHighWater`, `paintFileCount`, `persistSnapshot`, `rememberDeletedIds`, `pruneDeletedIndex`, `scrubTemporaryIndex`, `readReconcileMarks`, `markReconciled`, `reconcilePersistedIndex`, `installIndexApiHardening`, `reconcileActiveChat` and the 900 ms chat-switch interval. `installRealtimeHardening` keeps only its temporary-id suppression and calls `window.teleFilesIndex.retireTemporary`; `scheduleRecentRefresh` keeps only its Messages-tab merge. The upload transport, retry classification, `Retry-After` handling and `installQueueHardening` are untouched (clause 3.12).

No new runtime layer is created. The two new files in this plan are both test or build helpers, not runtime code: `scripts/files-reconcile.test.cjs` and `scripts/cache-tokens.test.cjs`, plus a token stamper invoked from `check`. No `file-consistency-v3.js`, no `folder-picker-final-fix.js`, no `another-hotfix.js` (clause 2.21).

### Phase 6: cache tokens

`?v=` tokens become content-derived. A small stamper (`scripts/stamp-cache-tokens.cjs`) computes a sha256 prefix for each asset referenced by `public/index.html` and by the dynamic loaders in `auth-state-fix.js` (`files-stability.js`, `files-view.js`) and `uploads.js` (`bulk-uploads.js`, `uploads-hardening.js`), and rewrites the tokens. `scripts/cache-tokens.test.cjs` recomputes the hashes and fails if any referenced token does not match its file, and it runs as part of `npm run check`, so a content change without a token change breaks the build rather than reaching a browser (clause 2.22). The dynamic chain in `uploads.js` keeps its current shape; only the tokens change.

### File-by-file change list

| Path | Change |
| --- | --- |
| `server.js` | `historyComplete` in `scanMediaIndexV3`; new `media-truth-v1` ws request; new `POST /api/filegram/pick-download-folder`; startup runtime banner and build id; build id on the `status` response |
| `bulk-upload-preload.js` | remove the live-media, reconcile-message-ids and picker routes and their helpers; keep bulk upload, ledger, temp-id retirement, health |
| `public/files-stability.js` | own IndexedDB persistence; `removedIds` / `reconciledAt` / `truthCount`; removal-aware `union`; `commitDiscovery` and `commitAuthoritative`; `reconcile`; delete-event handling; floor subordinated to truth; `[Files reconcile]` diagnostic; `reconcile` and `retireTemporary` on the API |
| `public/daily-driver-p0-v2.js` | remove all index/persistence code and `teleP0v2RefreshPath`; keep viewer, search, attachments |
| `public/daily-driver-p1.js`, `p2.js`, `hotfix.js`, `final.js`, `final-ui-fix.js` | remove index restore/commit/persist paths |
| `public/daily-driver-final-guard.js` | remove the `scan-media-v3` interception, the client-cache substitution, the duplicate high-water store and the count-label takeover |
| `public/rescue-runtime.js` | `rescueEnsureAllFiles` delegates to the owner; no cache write |
| `public/telegram-daily-driver.js` | remove its progress cache write |
| `public/uploads-hardening.js` | remove index and Save-to code; keep transport hardening |
| `public/auth-state-fix.js` | `restoreDownloadDirHint` paints through `setDirLabel`; updated tokens |
| `public/app.js` | `#set-dir.onclick` becomes the one picker handler; `setDirLabel` paints the new control |
| `public/filegram-shell.js` | remove the `Browse` text assignment |
| `public/index.html` | new Save-to markup; `#dl-dir` and `#dl-dir-current` removed; content-hash tokens |
| `public/filegram-ui.css` | one `#set-dir.fg-save-to` block replacing the legacy rules |
| `public/style.css`, `telegram-polish.css`, `telegram-daily-driver.css`, `daily-driver-hotfix.css`, `daily-driver-p0.css`, `daily-driver-p1.css`, `daily-driver-final.css` | delete the `#set-dir`, `#dl-dir`, `#dl-dir-current`, `.dir-current` rules |
| deleted | `public/file-consistency-v2.js`, `public/file-consistency-fix.js`, `native-folder-picker-preload.js`, `file-consistency-server-preload.js` |
| `package.json` | `check` list updated for deleted and added files; token check added to `check` |
| `scripts/files-invariants.test.cjs` | replace the `allowShrink` and monotonic assertions with owner-boundary assertions |
| `scripts/files-reconcile.test.cjs` | new: reconciliation and removal-durability invariants |
| `scripts/cache-tokens.test.cjs`, `scripts/stamp-cache-tokens.cjs` | new: token/content agreement |
| `tests/file-consistency.spec.js` | rewritten against the real stylesheets and a real persistence layer |
| `tests/visual-check.spec.js` | Save-to test rewritten for the single control |

## Testing Strategy

### Validation Approach

Two phases, in this order: first make the bug reproducible in tests that fail on unfixed code, then verify the fix and the preservation set. The suites as they stand cannot play either role, for three specific reasons that the rewrite has to remove.

- `tests/file-consistency.spec.js` stubs `window.teleP0v2WriteIndex` with an always-writing function, so the persistence rejection that makes the real prune non-durable cannot occur in the test. Its "persisted snapshot is 0" assertion passes precisely because the real boundary is absent.
- The same fixture serves a bare HTML page with no stylesheets, so its full-width geometry assertion cannot see the 54px rule that decides the real render.
- `scripts/files-invariants.test.cjs` asserts the monotonic guard exists (`options.allowShrink`, `if (storedCount > snapshot.items.length) return`), so `npm run verify` currently fails if the shrink is made durable. The invariant is inverted by this fix: the boundary must write what the owner decided, and the protection must be asserted at the owner's two commit functions instead.

`tests/visual-check.spec.js` boots the real application at `http://127.0.0.1:3000` and is therefore the right place for the live-UI assertions; `tests/file-consistency.spec.js` is a fixture suite and is the right place for the reconciliation logic. The contradiction in clause 1.23 is resolved by making the live suite the authority on layout and rewriting both to the single control: `#dl-dir` and `#dl-dir-current` no longer exist, so the "input beside a Browse button" assertion is replaced by "one `#set-dir.fg-save-to` filling its parent, one path display, no second control".

### Exploratory Bug Condition Checking

Goal: produce counterexamples on unfixed code, and confirm or refute hypotheses 1 to 9. If a hypothesis is refuted, the design returns to the Hypothesized Root Cause section rather than proceeding.

Test plan: run the Phase 0 instrumentation against the running application with the real Telegram session and chat "TEST" in its stale state, then run the fixture tests below against the current `file-consistency-v2.js` with the real boundary in place instead of a stub.

Test cases:

1. Persistence boundary counterexample. Fixture: stored record of 22 items, owner commits 0. Assert the record becomes 0. Fails on unfixed code, because `teleP0v2WriteIndex` returns early (hypothesis 2).
2. Truth-override counterexample. Fixture: IndexedDB record of 22, high-water 22, `scan-media-v3` resolving to 0 items with `done: true`. Call the same code path `hardRefresh` uses and assert the caller receives 0. Fails on unfixed code, because `guardStableMediaScan` returns the stale snapshot with `protectedByClientCache: true` (hypothesis 1).
3. Restore-union counterexample. Fixture: pruned memory snapshot plus an untouched IndexedDB record. Call `restore` and assert the result is the pruned set. Fails on unfixed code (hypothesis 3).
4. Unknown-truth counterexample. Fixture: the live truth call answering 503, then a non-exact payload. Assert the index is untouched, the failure is surfaced, and there is at most one retry within two seconds. Fails on unfixed code, which warns once and retries every 500 ms (hypothesis 4).
5. Empty-scan ambiguity counterexample. Fixture: a truth response with zero ids and no completeness evidence. Assert no pruning. Fails on unfixed code, where `exact: ids.length < 5000` makes an empty failure look like truth.
6. Reconcile-mark counterexample. Fixture: `filegram-files-delete-reconcile-v1` already stamped for the chat. Assert a later deletion is still detected. Fails on unfixed code, which returns early.
7. Save-to render counterexample. Load the real `index.html` stylesheets over the real markup inside `#mg-downloads-pane`, apply the current JS painters, and measure the control. Assert `width` equals the parent width. Fails on unfixed code at 54px (hypothesis 7).
8. Save-to binding counterexample. Assert exactly one handler responds to a click and exactly one picker URL is requested. Fails on unfixed code, where the count depends on load order (hypothesis 8).
9. Picker identity counterexample. Call the picker endpoint on the running server and assert the response reports an Explorer-style implementation. On unfixed code there is no such field, which is itself the finding: the running dialog cannot be identified from the response, so a stale process cannot be ruled out (hypothesis 5).
10. Cache-token counterexample. Modify a byte of a loaded script without changing its token, reload, and assert the browser executes the new bytes. Fails on unfixed code (hypothesis 6).

Expected counterexamples: prunes that vanish on reload; forced rescans that return the stale count; unions that restore removed ids; unknown results treated as truth; a 54px control; more than one handler or endpoint per click; no way to identify the running dialog or the running script bytes.

### Fix Checking

Goal: for every input where the bug condition holds, the fixed system produces the required behaviour.

```
FOR ALL X WHERE staleFilesCondition(X) DO
  reconcile(X.chatId)
  ASSERT committedIndex(X.chatId)  = telegramMediaMessageIds(X.chatId)
  ASSERT persistedIndex(X.chatId)  = telegramMediaMessageIds(X.chatId)
  ASSERT headerCount(X.chatId)     = |telegramMediaMessageIds(X.chatId)|
  ASSERT selectAllCount(X.chatId)  = headerCount(X.chatId)
  ASSERT typeCountsTotal(X.chatId) = headerCount(X.chatId)
  ASSERT paginationTotal(X.chatId) = headerCount(X.chatId)
  ASSERT diagnosticEmitted('[Files reconcile]', X.chatId) EXACTLY ONCE
  ASSERT survivesRefresh(X.chatId) AND survivesRestart(X.chatId)
END FOR

FOR ALL X WHERE truthIncomplete(X) DO
  before := snapshotOf(X.chatId)
  reconcile(X.chatId)
  ASSERT snapshotOf(X.chatId) = before
  ASSERT persistedIndex(X.chatId) unchanged
  ASSERT retryDelays(X.chatId) ARE increasing AND retryDelays[0] >= 2000
END FOR

FOR ALL X WHERE folderPickerCondition(X) DO
  ASSERT |boundClickHandlers('#set-dir')| = 1
  ASSERT |folderPickerEndpoints()| = 1
  dialog := openSaveToDialog(X)
  ASSERT dialog.implementation = 'IFileOpenDialog'
  ASSERT dialog.resizable AND dialog.hasAddressBar AND dialog.hasContentsPane AND dialog.hasSidebar
  ASSERT dialog.style <> 'browse-for-folder-tree'
  ASSERT selectDirectory(dialog, D) = D AND configuredDownloadDir() = D
  ASSERT cancel(dialog) LEAVES configuredDownloadDir() unchanged
END FOR

FOR ALL X WHERE saveToLayoutCondition(X) DO
  control := renderSaveTo(X)
  ASSERT control.width = availableSidebarWidth
  ASSERT |saveToClickTargets()| = 1 AND |visiblePathDisplays()| = 1
  ASSERT NOT existsNode('#dl-dir') AND NOT existsNode('#dl-dir-current')
  ASSERT |matchedWidthRules('#set-dir')| = 1
  ASSERT NOT clipped(control.pathText) OR pathExceeds(control.width)
END FOR
```

### Preservation Checking

Goal: for every input where the bug condition does not hold, the fixed system behaves exactly as HEAD `90a56ce0`.

```
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT F(X) = F'(X)
END FOR
```

Property-based testing is the right instrument here because the preservation set is large and mostly mechanical: index shapes, scan interleavings, page boundaries and event orders can be generated far more thoroughly than they can be enumerated by hand, and the properties are cheap to state.

Test plan: capture the behaviour of the unfixed build first for each case below, then encode that captured behaviour as the expectation.

Test cases:

1. Intact chat. Observe counts and list contents for a chat with no deletions on unfixed code; assert identical after the fix (3.1).
2. Partial scan protection. Generate a discovered index of N items and then a partial scan result of M < N items stamped `done: true`; assert the committed index stays at N and the persisted record is not replaced, before and after the fix (3.2).
3. Streaming scan. Feed `media-index-progress` batches with `done: false` and assert the index grows monotonically and the total is not reported as complete until the final event (3.3).
4. Restore without rescan. Assert reopening a chat with a complete record issues no full scan request (3.4).
5. Upload and temporary-id retirement. Assert a new upload appears, its temporary id is replaced by the real id, and no row is lost or duplicated (3.5).
6. Pagination. Assert 100 rows per page, the same range labels and the same Next/Previous behaviour (3.6).
7. Separated counts. Assert filtered, search, selection and queue counts never overwrite the authoritative total (3.7).
8. Inaccessible chat. Assert an empty result for an inaccessible chat prunes nothing and is reported as unknown (3.8).
9. Download queue and folder. Assert queue, pause, resume, cancel, clear and the honoured destination folder are unchanged (3.9), and that a configured folder shows on startup and survives a cancelled dialog (3.10).
10. Rest of the sidebar. Assert the stats card, Parallel files slider and queue action rows keep their geometry and behaviour (3.11).
11. Bulk uploads. Run the existing `tests/bulk-uploads.spec.js` and the ledger and server unit tests unchanged (3.12).
12. Removal is not a blacklist. Generate a removal followed by a truth pass that reports the id present again; assert the item returns, so `removedIds` cannot permanently suppress a genuine re-upload.

### Unit Tests

- `scripts/files-reconcile.test.cjs` (new, source and behaviour invariants): the owner is the only caller of `writePersistent`; `writePersistent` contains no count comparison; `commitAuthoritative` is the only function that appends to `removedIds`; `union` filters `removedIds` against `reconciledAt`; no file other than `files-stability.js` writes `rescueFileCache`; no file reads or writes `filegram-files-delete-reconcile-v1`; exactly one implementation reads and writes `tele-file-index-high-water-v1`; no file assigns `request = ` for `scan-media-v3`; the `[Files reconcile]` line contains all six required fields.
- `scripts/files-invariants.test.cjs` (updated): the `allowShrink` and `storedCount > snapshot.items.length` assertions are replaced by assertions that the boundary is unconditional and that the protection sits at `commitDiscovery` / `commitAuthoritative`; the count-label ownership, pager and drag-selection invariants stay as they are.
- `scripts/cache-tokens.test.cjs` (new): every `?v=` token in `index.html` and in the dynamic loaders matches the sha256 prefix of the file it names.
- Picker unit coverage: the PowerShell script text is asserted to request `FOS_PICKFOLDERS` and to read the result through `SIGDN_FILESYSPATH`, and to contain no `FolderBrowserDialog` and no `Split-Path -Parent`; the endpoint's cancel path is asserted to return `cancelled: true` with no path. The dialog itself cannot be unit tested, which is why TEST C exists.
- Save-to source invariants: exactly one stylesheet declares a width for `#set-dir`; no file contains `#fg-hardening-style` or `#fg-download-folder-v2-style`; no file references `#dl-dir` or `#dl-dir-current`; exactly one `#set-dir` click binding exists in the tree.

### Property-Based Tests

- Reconciliation is idempotent and order-independent: for a generated cached index and a generated live id set, applying `reconcile` twice equals applying it once, and the result does not depend on the order in which delete events, progress batches and restores interleave.
- Union never resurrects: for generated sequences of (truth pass, partial scan, restore, upsert, refresh) the final index never contains an id removed by the most recent truth pass unless a later truth pass reported it present.
- Shrink durability: for generated index sizes N and M with M < N, a truth pass at M always yields a persisted record of exactly M, including M = 0.
- Incomplete truth is inert: for generated failure modes (HTTP error, `complete: false`, `accessible: false`, thrown error, empty ids with `complete: false`) the index and record are unchanged and no prune is recorded.
- Path rendering: for generated path lengths and sidebar widths, the control fills the width and ellipsis appears only when the text exceeds it.

### Integration Tests

- Full stale-chat flow against the running application: boot, open the stale chat, observe convergence, refresh, restart, and assert the counts and the persisted record at each step.
- Live-deletion flow: upload, observe, delete externally, observe convergence without a refresh.
- Chat switching under reconciliation: switch rapidly between a large channel and the stale chat and assert no count fluctuation and no cross-chat contamination.
- Folder picker flow end to end: click, dialog, choose, path displayed, a download written to the chosen folder, then a cancel leaving the folder unchanged.
- Save-to layout at the application's real sidebar width, plus the rest of the sidebar unchanged.

### Verification commands and manual acceptance

`npm run check` and `npm test` (via `npm run verify`) cover the source invariants and the Node smoke tests. `npx playwright test tests/file-consistency.spec.js tests/bulk-uploads.spec.js` covers the fixture suites, and `npx playwright test tests/visual-check.spec.js` covers the live UI with the server running. Playwright is invoked with a single run, never in watch mode.

The following acceptance criteria cannot be proven by any automated suite in this repository and are provable only by manual runtime reproduction against the real local Telegram session, as clauses 1.24 and 2.24 require:

- **TEST A**, stale deleted files: requires the real persisted index holding the 22 "TEST" rows and the real Telegram chat holding none, plus a real browser refresh and a real server restart. Clauses 2.1, 2.3, 2.4, 2.5, 2.7, 2.8, 2.9 are decided here.
- **TEST B**, real-time deletion: requires sending a real file to "TEST" and deleting the real Telegram message from another client. Clauses 2.2 and 2.13 are decided here.
- **TEST C**, folder picker: requires a human to look at the dialog. No automated check can distinguish the Explorer shell dialog from the legacy tree, and no headless test can drive a native dialog. Clauses 2.14, 2.16 (the native half of the chain) and 2.17 are decided here, together with hypothesis 5.
- **TEST D**, Save-to layout: the automated geometry assertions can prove width and ellipsis, but the judgement that the control looks like one clean control in the real application at the real width is human. Clauses 2.18, 2.19, 2.20 are confirmed here.

## Risks and Unknowns

Recorded now so the final report can state plainly what was and was not proven (clause 2.24 item 9).

1. **The reason the small dialog still opened may be environmental.** If Phase 0 shows a stale server process, the code at HEAD was already correct for that clause and the user-visible defect was a process-lifetime artefact. That must be reported as such rather than as a code fix, and the picker's `implementation` field plus the startup banner are the mechanisms that make it detectable next time.
2. **The Explorer-style dialog depends on the host.** The `IFileOpenDialog` interop is expected to work on Windows 7 and later with .NET Framework 4 present, but that cannot be asserted from this repository. If it fails on this machine, the fallback is the `OpenFileDialog` surface, which is large and Explorer-based but is a file chooser used as a folder chooser. Whether it satisfies "the normal large Windows Explorer-style dialog" in the user's judgement is decided by TEST C and must be reported honestly either way.
3. **The truth walk is as reliable as `getChatHistory`.** For a very large channel a complete walk is expensive, and the design deliberately reuses the cached complete snapshot rather than re-walking. That means a large channel's deletions are detected on the next complete scan or on an explicit refresh, not necessarily on the next open. If the user needs immediate convergence on 20k channels, that is a scope extension and should be stated rather than silently assumed.
4. **`removedIds` is capped.** At 5000 entries per chat and 30 days, a chat that loses more than 5000 files across sessions could in principle have the oldest removals fall out of the list. The truth pass is still authoritative when it runs, so the practical exposure is a stale row reappearing between a cap eviction and the next truth pass. The cap is a memory-bound tradeoff and should be reviewed against real data.
5. **Preservation cannot be proven exhaustively.** The preservation property quantifies over every interaction; the tests sample it. Clauses 3.9 and 3.12 in particular depend on real download and upload runs. Anything not exercised must be listed as untested rather than as preserved.
6. **The consolidation touches nine legacy layers.** Removing index code from `daily-driver-hotfix.js`, `p1`, `p2`, `final`, `final-guard`, `final-ui-fix`, `rescue-runtime.js` and `telegram-daily-driver.js` risks removing something a distant reader depends on through a global. The mitigation is the source invariants plus `npm run verify` plus the live suite, and the ordering: Phase 0 instrumentation first records which of those paths actually execute, so a path that never runs can be removed with more confidence than one that does.
7. **Two existing tests currently assert the defective behaviour.** `scripts/files-invariants.test.cjs` pins the monotonic write guard and `tests/file-consistency.spec.js` stubs it away. Both are changed by this fix. That is intentional and must be called out in the report, because a reviewer comparing suites across commits will otherwise read it as a weakened test.
8. **Cache-token stamping changes many lines.** Rewriting every `?v=` token to a content hash produces a large but mechanical diff in `index.html` and the two loaders. If the user prefers a smaller diff, the alternative is stamping only the files this fix touches, which leaves the general hazard in place for future edits; that tradeoff is theirs to make.
---

# Implementation Plan

Branch discipline for every task below: all work stays on `feature/bulk-channel-uploads`. The branch is not changed and the pull request is not merged as part of this work.

Ordering rules that the numbering encodes, and that may not be reordered:

- Task 1 (Phase 0) precedes every other task. No behaviour is judged, no hypothesis is accepted and no fix is written before its artefacts exist, because the same three defects have already been declared fixed three times while nothing changed (clauses 1.24, 2.21, 2.22, 2.24).
- Tasks 2 and 3 write the failing and the baseline tests before any fix edit.
- The reconciliation owner (task 5) is in place and proven before the legacy layers are stripped (task 9), so there is never a window in which nothing owns the Files index.
- Task 12 (manual runtime acceptance) cannot be satisfied by any automated or mocked suite, and task 13 reports honestly on whatever it could not prove.

- [x] 1. Phase 0 - establish what is actually running, before any edit
  - **GATE**: this task produces evidence, not fixes. Until 1.7 is written down, no clause may be judged and no cause accepted. The only permanent code additions permitted in this task are the server banner/build id (1.2) and the `[FileGram runtime]` script report (1.3); both are instruments, not fixes.
  - Every other instrument in this task is temporary console work and ships nothing.
  - _Requirements: 1.21, 1.22, 1.24, 2.21, 2.22, 2.24_

  - [x] 1.1 Identify the live server process and compare it against the picker commits
    - Record the PID listening on port 3000 (`Get-NetTCPConnection -LocalPort 3000`) and its start time (`Get-Process -Id <pid> | Select-Object StartTime`)
    - Compare that start time with the commit times of `767e283e` (added `FolderBrowserDialog` to `bulk-upload-preload.js`) and `ad9c229c` (replaced it with `OpenFileDialog`)
    - A process started between those two commits still serves the legacy tree dialog from memory no matter what is on disk; record the verdict explicitly
    - _Requirements: 1.14, 1.15, 2.15, 2.24_

  - [x] 1.2 Add the server startup banner and build id, then restart and re-run the picker
    - Print pid, start time and a build id at boot in `server.js` (short `git rev-parse --short HEAD`, falling back to a sha256 prefix over `server.js` plus the preload files)
    - Expose the same build id on the existing `status` response so the browser can print it
    - Restart with `npm start` and click Save to again: if the dialog changes shape after nothing but a restart, hypothesis 5 is confirmed and is the answer to clause 2.24 item (4)
    - _Requirements: 1.15, 2.15, 2.21, 2.24_

  - [x] 1.3 Prove which script bytes the browser is executing
    - Evaluate `[...document.scripts].map(s => s.src)` in the running app, and for every dynamically appended script (`files-stability.js?v=2`, `files-view.js?v=2`, `bulk-uploads.js?v=3`, `uploads-hardening.js?v=3`, `file-consistency-v2.js?v=3`) fetch it and hash the response body against the on-disk hash
    - Emit one `[FileGram runtime]` line per script: name, token, served-matches-disk yes/no
    - This decides hypothesis 6 and satisfies the "confirm the browser is running the current code before any behaviour is judged" half of clause 2.22
    - _Requirements: 1.22, 2.22_

  - [x] 1.4 Trace the real Save-to click path end to end on unfixed code
    - Enumerate the bindings on `#set-dir` by clone-replacing the node and observing which layers rebind (`uploads-hardening.js` assigns `onclick`, `file-consistency-v2.js` clone-replaces and adds its own listener)
    - Wrap `window.fetch` to log any request whose URL contains `pick-download-folder`, and record the URL actually requested and the response body
    - Produce the pre-fix chain required by clause 2.16: button, handler, endpoint, preload or server implementation, native dialog
    - _Requirements: 1.16, 1.17, 2.16_

  - [x] 1.5 Measure the real Save-to render and list the matched rules in cascade order
    - Read `getComputedStyle(document.querySelector('#set-dir')).width` and enumerate every rule matching `set-dir`, `dl-dir` or `dir-current` with its specificity
    - Confirm or refute hypothesis 7 by observing whether the winning width rule is `#mg-downloads-pane #set-dir { width: 54px !important }` from `daily-driver-p1.css`
    - Confirm the node's runtime parent is `#mg-downloads-pane` after `management.js` moves the `.downloads` children
    - Record which of the three overlapping controls (`#dl-dir`, `#set-dir`, `#dl-dir-current`) occupy layout
    - _Requirements: 1.18, 1.19, 1.20, 2.19, 2.20_

  - [x] 1.6 Instrument the reconcile and resurrection boundaries, then open chat "TEST"
    - Wrap and stack-trace five boundaries: `rescueFileCache.set`, `teleP0v2WriteIndex` (log chatId, stored count, incoming count, and whether it returned early), `teleP0v2ReadIndex`, the global `request` for `scan-media-v3` (log the payload and what the caller received, including `protectedByClientCache`), and `handleEvent` for `message-delete`
    - Open chat "TEST" in its stale 22-row state and record: which layers write the shared cache, whether the prune reaches IndexedDB, and whether `scan-media-v3` returns the server's result or `guardSnapshotAsResponse(known)`
    - Call `teleFilesIndex.hardRefresh(chatId)` and record whether `guardStableMediaScan` substitutes the stale snapshot across all five rounds because the truthful 0 is below the floor of 22
    - If `truthIsOverriddenByCache` is observed returning the stale snapshot, record it as the answer to clause 2.24 item (2); this is the runtime enumeration clause 2.7 requires
    - _Requirements: 1.6, 1.7, 1.8, 1.9, 1.10, 1.11, 1.13, 2.7, 2.24_

  - [x] 1.7 Write the composition map and the hypothesis verdicts
    - Produce the short dependency and load-order map required by clause 2.21 from 1.1 to 1.6, including which of `public/file-consistency-fix.js`, `native-folder-picker-preload.js` and `file-consistency-server-preload.js` never appear in it
    - Record a confirmed/refuted verdict for each of hypotheses 1 to 9
    - **GATE**: if hypothesis 1, 2 or 7 is refuted, return to the Hypothesized Root Cause section and revise the design before continuing; do not proceed on an unconfirmed cause
    - _Requirements: 1.21, 2.21, 2.24_

- [x] 2. Write the bug condition exploration tests (BEFORE any fix)
  - **Property 1: Bug Condition** - Telegram truth is discarded by client caches, non-durable prunes, a fabricated directory and a 54px control
  - **CRITICAL**: these tests MUST FAIL on unfixed code - failure confirms the bugs exist
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: these tests encode the expected behaviour, so they are what validates the fix in task 11.1
  - **GOAL**: surface counterexamples that demonstrate each mechanism, and confirm or refute hypotheses 1 to 9 alongside task 1
  - **Scoped PBT approach**: the defects are deterministic, so scope each property to the concrete failing case first (chat "TEST": stored 22, live 0, floor 22; `#set-dir` inside `#mg-downloads-pane` with the real stylesheets), then generalise across generated index sizes, path lengths and widths
  - **Enabling change**: `tests/file-consistency.spec.js` currently stubs `window.teleP0v2WriteIndex` with an always-writing function and serves a bare page with no stylesheets, so neither the persistence rejection nor the 54px rule can occur in it. Remove the stub, exercise the real boundary, and load the real `index.html` stylesheets over the real markup inside `#mg-downloads-pane`. Without this the counterexamples are unwritable, which is itself the finding recorded against clause 1.23
  - Test 1, persistence boundary: stored record of 22, owner commits 0, assert the record becomes 0 - fails because `teleP0v2WriteIndex` returns early when `storedCount > snapshot.items.length` and no caller passes `allowShrink` (hypothesis 2)
  - Test 2, truth override: IndexedDB record 22, high-water 22, `scan-media-v3` resolving 0 items with `done: true`; call the path `hardRefresh` uses and assert the caller receives 0 - fails because `guardStableMediaScan` returns the stale snapshot stamped `protectedByClientCache: true` (hypothesis 1)
  - Test 3, restore union: pruned memory snapshot plus untouched IndexedDB record, assert `restore` yields the pruned set (hypothesis 3)
  - Test 4, unknown truth: live call answering 503, then a non-exact payload; assert the index is untouched, the failure is surfaced beyond `console.warn`, and at most one retry occurs within two seconds - fails against the 500 ms interval (hypothesis 4)
  - Test 5, empty-scan ambiguity: truth response with zero ids and no completeness evidence, assert no pruning - fails because `exact: ids.length < 5000` is true for a failed empty scan
  - Test 6, reconcile mark: `filegram-files-delete-reconcile-v1` already stamped, assert a later deletion is still detected - fails because the mark returns early forever
  - Test 7, Save-to render: real stylesheets over real markup inside `#mg-downloads-pane` with the current painters applied, assert the control width equals the parent width - fails at 54px (hypothesis 7)
  - Test 8, Save-to binding: assert exactly one handler responds to a click and exactly one picker URL is requested - fails because the count depends on load order (hypothesis 8)
  - Test 9, picker identity: call the picker endpoint on the running server and assert the response identifies an Explorer-style implementation - no such field exists on unfixed code, so a stale process cannot be ruled out (hypotheses 5, 9)
  - Test 10, cache token: change a byte of a loaded script without changing its token, reload, assert the browser executes the new bytes (hypothesis 6)
  - Run all ten on UNFIXED code
  - **EXPECTED OUTCOME**: tests FAIL (this is correct - it proves the bugs exist)
  - Document every counterexample verbatim (for example "hardRefresh on TEST returned 22 items with protectedByClientCache: true while the server returned 0")
  - Mark complete when the tests are written, run, and the failures are documented
  - _Requirements: 1.1, 1.4, 1.6, 1.7, 1.8, 1.9, 1.10, 1.11, 1.14, 1.16, 1.17, 1.18, 1.19, 1.20, 1.22, 1.23_

- [x] 3. Write the preservation property tests (BEFORE any fix)
  - **Property 2: Preservation** - every interaction outside the bug condition behaves exactly as HEAD `90a56ce0`
  - **IMPORTANT**: follow observation-first methodology - capture what the UNFIXED build does, then assert that captured behaviour. Do not assert what the code ought to do
  - Observe on unfixed code and record the actual values: counts and list contents for an intact chat; the committed and persisted index when a partial `done: true` result of M items arrives after N discovered items (M < N); index growth across `media-index-progress` batches with `done: false`; whether reopening a chat with a complete record issues a full scan; the temporary-to-real id swap on upload; rows per page, range labels and Next/Previous; filtered, search, selection and queue counts against the authoritative total; an inaccessible chat's empty result; queue pause/resume/cancel/clear and the honoured destination folder; a configured folder shown on startup and surviving a cancelled dialog; the geometry of the stats card, Parallel files slider and queue action rows
  - Encode as property-based tests over generated index sizes, scan interleavings, event orders and page boundaries, because the preservation set is large and mechanical and generation covers it far better than enumeration
  - Include the removal-is-not-a-blacklist property now so it is baselined: a removal followed by a truth pass reporting the id present again must return the item
  - Run the existing `tests/bulk-uploads.spec.js`, the ledger tests and the server unit tests unchanged, and record their results as the preservation baseline
  - **EXPECTED OUTCOME**: tests PASS on UNFIXED code (this is the baseline to preserve). Any test that cannot be made to pass on unfixed code is not a preservation test and must be moved to task 2 or dropped
  - Mark complete when the tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 3.11, 3.12, 3.13_

- [x] 4. Phase 1 - one Telegram truth source in `server.js`

  - [x] 4.1 Report history completeness explicitly from `scanMediaIndexV3`
    - Add `job.historyComplete`, set true only on the empty-page exit; a repeated cursor, `newMessages === 0`, the 100000-iteration guard, a cancel or a throw all leave it false
    - Carry `historyComplete` into the snapshot, `cloneMediaIndexSnapshot` and the `media-index-progress` payload, so `done: !job.cancelled` is no longer the only completeness signal
    - _Bug_Condition: staleFilesCondition(X) where a failed or truncated scan is indistinguishable from an empty chat_
    - _Expected_Behavior: design Property 2 - an incomplete truth source never prunes_
    - _Preservation: 3.3 streaming scans still grow the index and are still not reported complete_
    - _Requirements: 2.11, 3.3_

  - [x] 4.2 Add the single `media-truth-v1` ws request
    - Take `{ chatId }`, return `{ ok, ids, count, complete, accessible, scanned, source }`
    - Probe with `getChat` for `accessible`; reuse `mediaIndexCache` when the cached snapshot has `historyComplete && !cancelled` (`source: 'cache'`), otherwise walk `getChatHistory` as `scanMediaIndexV3` does, collecting ids where `extractMedia(message)` yields a file and `message.sending_state === undefined` (`source: 'walk'`)
    - `complete` is the conjunction of `accessible`, the empty-page exit and no thrown error. No 5000-item cap and no `ids.length < 5000` heuristic: completeness is a property of how the walk ended, not of how many rows it found
    - _Bug_Condition: staleFilesCondition(X); the `exact: ids.length < 5000` heuristic in `collectLiveMediaIds`_
    - _Expected_Behavior: design Properties 1 and 2 - truth is authoritative, unknown is inert_
    - _Preservation: 3.8 an inaccessible or left chat is reported as inaccessible, never as empty_
    - _Requirements: 2.10, 2.11, 3.8_

  - [x] 4.3 Delete the competing truth sources
    - Remove `GET /api/filegram/live-media-ids/:chatId`, `POST /api/filegram/reconcile-message-ids/:chatId` and their helpers (`LIVE_MEDIA_FILTERS`, `collectLiveMediaIds`, `liveMediaIds`, `reconcileMessageIds`, `missingMessageError`, `mapLimit`) from `bulk-upload-preload.js`
    - Only `uploads-hardening.js` and the two files being deleted in task 9.1 call them, so bulk upload, the ledger, temp-id retirement and health are untouched
    - _Bug_Condition: staleFilesCondition(X) with two truth sources and a 503 treated as a warning_
    - _Expected_Behavior: design Property 5 - one owner per concern_
    - _Preservation: 3.12 bulk channel uploads unchanged_
    - _Requirements: 2.10, 2.21, 3.12_

- [ ] 5. Phase 2 - one Files index owner in `public/files-stability.js`
  - This task must land before task 9 strips the legacy layers, so the index is never unowned
  - **5.1, 5.2, 5.3, 5.5, 5.6, 5.7, 5.8, 5.9 and 5.10 are done and verified. 5.4 is deliberately left open: its code half is implemented, but its final clause asks for a runtime observation that the owner is the ONLY `rescueFileCache` writer, and the re-run instrumentation shows `daily-driver-final.js` still writing it. That cannot be true until task 9.2 / 9.3, so it is not ticked. See `# Task 5 and 6 Evidence`.**

  - [x] 5.1 Move IndexedDB persistence into the owner
    - Add `openDb`, `readPersistent(chatId)` and `writePersistent(chatId, snapshot, { reason })` to the owner, taking over `tele-daily-driver-cache-v1` / `file-indexes`
    - `writePersistent` contains no count comparison and no `allowShrink` escape: it writes what the owner decided, so a shrink to zero is an ordinary write
    - Exactly two functions may call it: `commitDiscovery` (additive, from scans and progress flushes, which cannot lower a count because it unions) and `commitAuthoritative` (from a confirmed truth pass, which may lower it to zero). A partial result has no route to `writePersistent` as a replacement, which is how partial-scan protection survives without a size check at the boundary
    - **NOTE**: `npm run verify` goes red the moment this lands, because `scripts/files-invariants.test.cjs` asserts the monotonic guard. Task 6.1 is the other half of this change and must be in the same commit
    - _Bug_Condition: shrinkIsDiscarded(chatId, next) from design_
    - _Expected_Behavior: removal driven by Telegram truth is a first-class write, including zero_
    - _Preservation: 3.2 partial and cancelled scans still cannot replace a larger index_
    - _Requirements: 2.6, 3.2_

  - [x] 5.2 Record removals durably in the persistent record
    - Add `reconciledAt` (ms of the last truth pass), `truthCount`, and `removedIds` as `{ id, at }` newest first, capped at 5000 per chat and pruned at 30 days
    - `commitAuthoritative` is the only function that appends to `removedIds` and stamps `reconciledAt`
    - This replaces the in-memory tombstone sets in `file-consistency-v2.js` and `uploads-hardening.js`, so correctness no longer depends on session lifetime and no DOM-level hiding is used to produce correct counts
    - _Bug_Condition: staleFilesCondition(X) with session-lifetime tombstones (clause 1.13)_
    - _Expected_Behavior: design Property 1 - the persisted index is the record of truth_
    - _Preservation: 3.1 items still present in Telegram are never touched_
    - _Requirements: 2.13, 3.1_

  - [x] 5.3 Make `union` removal-aware while keeping its protection
    - Keep ORing `done`, keep the additive merge, keep `isCompleteSnapshot`, keep the progress-flush batching (`PROGRESS_FLUSH_MS` 350, `PROGRESS_FLUSH_ITEMS` 800) and keep ignoring obsolete progress events for chats with a complete index
    - Add the filter: an item may not enter the result if its id is in the winning record's `removedIds` and the contributing snapshot's `savedAt` is older than `reconciledAt`
    - A later truth pass that reports the id present clears it from `removedIds`, so a genuine re-upload is not permanently blacklisted
    - _Bug_Condition: staleFilesCondition(X) where restore unions a stale copy back in_
    - _Expected_Behavior: design Property 7 - protection survives, resurrection does not_
    - _Preservation: 3.2, 3.3 count fluctuation stays suppressed and streaming still grows_
    - _Requirements: 2.7, 3.2, 3.3_

  - [ ] 5.4 Cover all seven resurrection paths named in clause 2.7, at run time
    - Filter on commit for the in-memory `committed` entry; filter on union for `rescueFileCache` and for the IndexedDB record inside `restore`; run the same filter in `commitDiscovery` for scan-result merging; replace `syncFromSharedAfterRealtime` with a direct owner-side merge that runs the filter for `message-upsert`; route startup restore through `ensure` -> `restore`; the remaining compatibility layers are deleted in task 9
    - Re-run task 1.6's `rescueFileCache.set` instrumentation after this change and record, at run time, that the owner is the only writer
    - _Bug_Condition: staleFilesCondition(X); each path individually observed resurrecting an id_
    - _Expected_Behavior: design Property 1 - no path reintroduces a removed item_
    - _Preservation: 3.4 restore-without-rescan still short-circuits in `ensure`, 3.5 upload merge still immediate_
    - _Requirements: 2.7, 3.4, 3.5_

  - [x] 5.5 Subordinate the high-water floor to Telegram truth
    - Call `rememberTotalFloor` only for a snapshot from a complete scan or a truth pass
    - `commitAuthoritative` writes the floor down to the reconciled count and deletes the entry at zero
    - `maybeRepairIndex` fires only when the shortfall is measured against a floor whose `at` is newer than `reconciledAt`, so a legitimate shrink can never trigger a rescan back to a stale total
    - Delete the duplicate floor implementations: `exactHighWater` and `HIGH_WATER_KEY` in `uploads-hardening.js`, and `guardRememberHighWater`, `guardHighWaterCount`, `GUARD_HIGH_WATER_KEY` in `daily-driver-final-guard.js`, leaving one reader and one writer of `tele-file-index-high-water-v1`
    - Removing `guardStableMediaScan` and the `request = function teleGuardRequest` interception belongs to task 9.2; this sub-task removes only the floor duplication it depends on
    - _Bug_Condition: truthIsOverriddenByCache(chatId, serverResult) from design; the floor rewritten from the stale snapshot each pass_
    - _Expected_Behavior: a durable floor never outranks Telegram truth_
    - _Preservation: 3.2 the fluctuation protection the floor was added for stays in place_
    - _Requirements: 2.8, 3.2_

  - [x] 5.6 Add `reconcile(chatId, options)` as the only subtractive path
    - One `media-truth-v1` call per pass, no polling; per-chat in-flight dedupe; a 60 s per-session throttle window with `options.force` bypass
    - On failure or `complete: false`: change nothing, set the load-state line to "Could not verify against Telegram - showing last known index", and schedule an exponential backoff retry (2 s, 4 s, 8 s, capped at 5 min) instead of the current 500 ms interval
    - On success: `missing := cached.items WHERE isTemporary(id) OR id NOT IN live`; empty missing stamps `reconciledAt`/`truthCount`/floor and returns unchanged; otherwise `commitAuthoritative`, `writePersistent`, then repaint header, Select all, type counts and pager
    - Call it from `ensure()` after a successful restore, from the `openChat` path once per throttle window, and unconditionally from `hardRefresh()`
    - Delete the permanent suppression: remove all reads and writes of `filegram-files-delete-reconcile-v1` and add a one-time startup migration that removes the stored value so an existing installation is not stuck
    - _Bug_Condition: staleFilesCondition(X); the reconcile mark and the 500 ms retry loop_
    - _Expected_Behavior: design Properties 1 and 2 - converge on truth, stay inert on unknown_
    - _Preservation: 3.8 inaccessible chats are unknown, not deletions_
    - _Requirements: 2.1, 2.2, 2.3, 2.9, 2.10, 2.11, 3.8_

  - [x] 5.7 Emit the `[Files reconcile]` diagnostic - a required deliverable, not an aid
    - Exactly one `console.info` line per pass, in a fixed greppable shape carrying all six fields: `chatId`, cached count, live count (or `unknown`), the missing ids, the remaining count after pruning, and the persistence result with its reason
    - Print the missing list in full up to 20 ids then summarise, and attach the full array as a second console argument so it stays inspectable
    - Include `truth=cache|walk`, `complete=` and, when relevant, `accessible=`, so a skipped pass explains itself
    - This is what makes a working reconciliation distinguishable from a no-op from outside the code, which is why clause 2.12 makes it a deliverable of the fix; it is also the evidence pasted into task 13
    - _Bug_Condition: staleFilesCondition(X) with no per-chat diagnostics at all (clause 1.12)_
    - _Expected_Behavior: exactly one diagnostic line per reconciliation pass_
    - _Preservation: no behavioural change to any counted surface_
    - _Requirements: 2.12_

  - [x] 5.8 Handle live deletions in the owner
    - Handle `message-delete` directly in the owner's `handleEvent` wrapper: remove the ids from `committed`, append them to `removedIds`, `writePersistent` immediately, repaint without a refresh
    - Remove the `syncFromSharedAfterRealtime` union-from-shared on delete; reading the shared cache back after a delete is one of the resurrection paths
    - The server already emits this event from `updateDeleteMessages`, from `updateMessageSendSucceeded` for retired temporary ids and from the explicit delete path, and already prunes `mediaIndexCache`, so no additional server work is needed
    - _Bug_Condition: staleFilesCondition(X) during a live deletion_
    - _Expected_Behavior: design Property 1 - convergence without a refresh, persisted immediately_
    - _Preservation: 3.5 temporary-id retirement still works through the owner_
    - _Requirements: 2.2, 2.13, 3.5_

  - [x] 5.9 Expose the owner API the other layers need
    - Add `reconcile(chatId, options)` and `retireTemporary(chatId, ids)` to `window.teleFilesIndex` alongside `ensure`, `snapshot`, `count`, `total`, `hardRefresh`
    - `uploads-hardening.js` and `bulk-upload-preload.js`'s temporary-id retirement keep their correctness through these calls without owning index state
    - _Bug_Condition: staleFilesCondition(X) with eleven writers of the shared cache_
    - _Expected_Behavior: design Property 5 - one owner, reachable by the layers that need it_
    - _Preservation: 3.5, 3.12 upload behaviour and bulk uploads unchanged_
    - _Requirements: 2.21, 3.5, 3.12_

  - [x] 5.10 Add `scripts/files-reconcile.test.cjs` with the owner-boundary invariants
    - Assert: the owner is the only caller of `writePersistent`; `writePersistent` contains no count comparison; `commitAuthoritative` is the only appender to `removedIds`; `union` filters `removedIds` against `reconciledAt`; no file other than `files-stability.js` writes `rescueFileCache`; no file reads or writes `filegram-files-delete-reconcile-v1`; exactly one implementation reads and writes `tele-file-index-high-water-v1`; no file assigns `request = ` for `scan-media-v3`; the `[Files reconcile]` line carries all six required fields
    - Add the property-based reconciliation tests: `reconcile` is idempotent and order-independent across interleaved delete events, progress batches and restores; union never resurrects an id removed by the most recent truth pass; a truth pass at M always yields a persisted record of exactly M including M = 0; every generated incomplete-truth failure mode leaves index and record unchanged with no prune recorded
    - Register the new script in `package.json`'s `check`/`test` wiring
    - _Bug_Condition: shrinkIsDiscarded and truthIsOverriddenByCache must both be permanently false_
    - _Expected_Behavior: design Properties 1, 2 and 7 asserted as source and behaviour invariants_
    - _Preservation: 3.13 `npm run verify` keeps passing_
    - _Requirements: 2.6, 2.7, 2.12, 2.23, 3.13_

- [x] 6. Resolve the three test contradictions
  - The suites currently pin the defect in place and contradict each other, so a green run today describes neither the bug nor one intended UI. All three resolutions must be called out in task 13, because a reviewer comparing suites across commits will otherwise read them as weakened tests

  - [x] 6.1 Invert the monotonic assertion in `scripts/files-invariants.test.cjs`
    - The suite asserts the defect: it requires `options.allowShrink` and `if (storedCount > snapshot.items.length) return` to exist, so `npm run verify` fails the moment the shrink becomes durable
    - Replace those two assertions with assertions that the persistence boundary is unconditional and that the protection now sits at `commitDiscovery` and `commitAuthoritative`
    - Keep the count-label ownership, pager and drag-selection invariants exactly as they are
    - **MUST** land in the same commit as task 5.1
    - _Bug_Condition: shrinkIsDiscarded(chatId, next) - asserted as correct by the current suite_
    - _Expected_Behavior: the boundary writes what the owner decided; the guard moves to the commit functions_
    - _Preservation: 3.13 the rest of the invariant suite is untouched_
    - _Requirements: 2.6, 2.23, 3.13_

  - [x] 6.2 Resolve the Save-to contradiction between the two Playwright specs
    - `tests/visual-check.spec.js` requires a visible `#dl-dir` beside a matching Browse button on one row; `tests/file-consistency.spec.js` requires `#dl-dir` hidden and `#set-dir` carrying `fg-folder-v2`. Both cannot be right
    - Make the live suite (`visual-check.spec.js`, which boots the real app at `http://127.0.0.1:3000`) the authority on layout, and rewrite both against the single control: one `#set-dir.fg-save-to` filling its parent, one path display, no second control, and `#dl-dir`/`#dl-dir-current` absent from the DOM entirely
    - Keep `tests/file-consistency.spec.js` as the fixture suite for reconciliation logic only
    - _Bug_Condition: saveToLayoutCondition(X) asserted two mutually exclusive ways (clause 1.23)_
    - _Expected_Behavior: design Property 4 - one click target, one path display_
    - _Preservation: 3.11 the rest of the sidebar assertions stay as they are_
    - _Requirements: 2.18, 2.20, 2.23, 3.11_

  - [x] 6.3 Lock the fixture honesty fix from task 2 in place
    - Confirm no stub of `teleP0v2WriteIndex` or of the owner's `writePersistent` remains in `tests/file-consistency.spec.js`, and that its persistence assertions run against a real persistence layer
    - Confirm the layout fixture loads the real `index.html` stylesheets over the real markup inside `#mg-downloads-pane`, so no geometry assertion can pass on a page that has no CSS
    - Add a guard assertion so a future stub or bare page fails the suite rather than greening it
    - _Bug_Condition: a suite that cannot observe the boundary it claims to test (clauses 1.23, 1.24)_
    - _Expected_Behavior: design Property 5 - claims are tied to the code that produced them_
    - _Preservation: 3.13 `npm run verify` keeps passing_
    - _Requirements: 2.23, 2.24, 3.13_

- [x] 7. Phase 3 - one folder picker

  - [x] 7.1 Add the single picker endpoint to `server.js`
    - `POST /api/filegram/pick-download-folder` beside the existing routes, so reachability no longer depends on which preloads `npm start` happens to wrap; returns `{ ok, cancelled, path, implementation }`
    - Spawn `powershell.exe -NoProfile -STA -EncodedCommand <base64 utf16le>` (introducing `node:child_process` to `server.js`) with an `Add-Type` interop for `IFileOpenDialog` / `IShellItem`, called with `FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST`, reading the result through `GetResult()` and `GetDisplayName(SIGDN_FILESYSPATH)`
    - No synthetic file name, no `Split-Path -Parent`, no parent-directory surprise, no empty result that looks like a cancel; a real cancel arrives as `HRESULT_FROM_WIN32(ERROR_CANCELLED)` and is reported as `cancelled` with no path
    - Set `implementation: 'IFileOpenDialog'` so the running dialog is identifiable from the response body during TEST C - this is how a stale process is caught next time
    - _Bug_Condition: folderPickerCondition(X); the legacy tree dialog and the fabricated directory_
    - _Expected_Behavior: design Property 3 - a resizable Explorer-shell dialog returning the chosen directory_
    - _Preservation: 3.9, 3.10 the download pipeline honours the folder, a cancel leaves it unchanged_
    - _Requirements: 2.14, 2.15, 2.17, 3.9, 3.10_

  - [x] 7.2 Make `public/app.js` the one frontend handler
    - `$('#set-dir').onclick` posts the endpoint, and on a non-cancelled result calls `request('set-download-dir', { dir })` then `setDirLabel(result.downloadsDir || dir)`
    - On `cancelled`, do nothing: the configured folder stays as it was
    - Every other binding on the node is removed in tasks 8.3 and 9, so the node is bound once and load order stops deciding behaviour
    - _Bug_Condition: folderPickerCondition(X) with three handlers competing by load order_
    - _Expected_Behavior: design Property 3 - exactly one bound handler reaching exactly one endpoint_
    - _Preservation: 3.10 a configured folder still shows on startup_
    - _Requirements: 2.16, 2.17, 3.10_

  - [x] 7.3 Remove the duplicate picker endpoint from `bulk-upload-preload.js`
    - Delete its `POST /api/filegram/pick-download-folder` route and `pickWindowsFolder` in the same change as 7.1, so two implementations never answer the same path
    - `native-folder-picker-preload.js` and its dormant `-modern` endpoint are deleted in task 9.1
    - Keep bulk upload, the ledger, temp-id retirement and health untouched
    - _Bug_Condition: folderPickerCondition(X) with two endpoints for one feature (clause 1.15)_
    - _Expected_Behavior: design Property 5 - exactly one owner, the duplicate removed not dormant_
    - _Preservation: 3.12 bulk channel uploads unchanged_
    - _Requirements: 2.15, 2.21, 3.12_

  - [x] 7.4 Add picker unit coverage and record the fallback policy
    - Assert the PowerShell script text requests `FOS_PICKFOLDERS`, reads the result through `SIGDN_FILESYSPATH`, and contains no `FolderBrowserDialog` and no `Split-Path -Parent`
    - Assert the endpoint's cancel path returns `cancelled: true` with no path
    - The dialog itself cannot be unit tested, which is why TEST C exists (task 12.3)
    - If task 1 or TEST C shows the interop shim unavailable on this machine, the documented fallback is `OpenFileDialog` with `ValidateNames = $false`, taking the directory through `[System.IO.Path]::GetDirectoryName` only when the file name is a real path, and reporting `implementation: 'OpenFileDialog'`. The fallback is a declared degradation, reported in task 13, never a silent substitution
    - _Bug_Condition: folderPickerCondition(X); hypotheses 5 and 9_
    - _Expected_Behavior: design Property 3, asserted at the source level where the native surface cannot be_
    - _Preservation: 3.13 `npm run verify` keeps passing_
    - _Requirements: 2.14, 2.17, 2.23, 3.13_

- [x] 8. Phase 4 - one Save-to control

  - [x] 8.1 Replace the Save-to markup in `public/index.html`
    - Replace the `label.conc` + `<span>Save to</span>` + `.row` block and the separate `#dl-dir-current` line with one `button#set-dir.fg-save-to` containing icon, copy (label + `#dl-dir-path`), and chevron
    - Delete `#dl-dir` and `#dl-dir-current` outright rather than hiding them: with no legacy node in the tree there is nothing to occupy layout and the "which of three controls is visible" question disappears
    - Carry the full path in `title` for the tooltip; the accessible name comes from the label and path text
    - _Bug_Condition: saveToLayoutCondition(X) with three overlapping controls in layout (clause 1.20)_
    - _Expected_Behavior: design Property 4 - one click target and one path display_
    - _Preservation: 3.11 the stats card, Parallel files slider and queue action rows are untouched_
    - _Requirements: 2.18, 2.20, 3.11_

  - [x] 8.2 Write one CSS block in `public/filegram-ui.css` and delete the competing rules
    - One rule addressing both parents in a single selector list (`#mg-downloads-pane #set-dir.fg-save-to, .downloads #set-dir.fg-save-to`), at two IDs, so it wins wherever `management.js` has moved the panel children; no `!important` needed once the competitors are gone
    - Set `display:flex`, `width:100%`, `min-width:0`, a fixed comfortable height, gap, padding, `text-align:left`, the dark surface, border and hover state; give `.fg-save-to-path` `min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap` so ellipsis appears only when the path genuinely exceeds the width
    - Delete the legacy rules from every stylesheet that declares them: `style.css` (`.conc input[type=text]`, `.conc .row { width: 60% }`, `.dir-current`), `telegram-polish.css`, `telegram-daily-driver.css` (including `#mg-downloads-pane #set-dir { min-width:48px }`), `daily-driver-hotfix.css`, `daily-driver-p0.css`, `daily-driver-p1.css` (including the `54px` rule that currently decides the render), `daily-driver-final.css`, and the existing `#dl-dir`, `#set-dir`, `.dir-current`, `#dl-dir-current` rules in `filegram-ui.css`
    - Leave the `.dl-controls .conc` rules that serve the Parallel files row untouched
    - _Bug_Condition: saveToLayoutCondition(X); `#mg-downloads-pane #set-dir { width:54px !important }` outranking one-ID-plus-class overrides_
    - _Expected_Behavior: design Property 4 - full available width, ellipsis only on genuine overflow_
    - _Preservation: 3.11 the rest of the Downloads sidebar keeps its geometry_
    - _Requirements: 2.19, 2.20, 3.11_

  - [x] 8.3 Reduce the painters to one
    - `setDirLabel(dir)` in `app.js` is the single painter: it writes `#dl-dir-path` text and the `title`, and keeps calling the `auth-state-fix.js` wrapper that persists to `localStorage` under `filegram-download-dir-v1`
    - Rewrite `restoreDownloadDirHint` in `auth-state-fix.js` to call `setDirLabel` instead of touching the removed nodes
    - Remove the other painters: `teleP0v2RefreshPath` plus its `#dl-dir` listener, `#set-dir` click listener, 1500 ms interval and initial call in `daily-driver-p0-v2.js`; the `setDir.textContent = 'Browse'` block in `filegram-shell.js`'s `installDownloadIcons`; and in `uploads-hardening.js` the `installHardeningStyles` (`#fg-hardening-style`), `paintFolderButton`, `installDownloadFolderPicker`, the `setDirLabel` wrapper and the Save-to work inside `installUiCleanup` with its MutationObserver, 25 ms interval and 15 s sweep
    - `removeCaptionUi` and `removeDuplicateHeaderInfo` keep their own cleanup loop; `file-consistency-v2.js`'s clone-replace and `#fg-download-folder-v2-style` go with the file in task 9.1
    - _Bug_Condition: saveToLayoutCondition(X) with six painters and load order deciding the winner_
    - _Expected_Behavior: design Property 4 - one painter, no second stylesheet or paint loop on the node_
    - _Preservation: 3.10 a configured folder still paints on startup, 3.12 transport hardening untouched_
    - _Requirements: 2.18, 2.20, 3.10, 3.12_

  - [x] 8.4 Add the Save-to source invariants
    - Assert exactly one stylesheet declares a width for `#set-dir`; no file contains `#fg-hardening-style` or `#fg-download-folder-v2-style`; no file references `#dl-dir` or `#dl-dir-current`; exactly one `#set-dir` click binding exists in the tree
    - These assert the absence of the competitors rather than trusting it, which is what makes clause 2.20 provable at the source level
    - _Bug_Condition: saveToLayoutCondition(X); ten stylesheets and six painters on one node_
    - _Expected_Behavior: design Property 4 and Property 5_
    - _Requirements: 2.20, 2.23, 3.13_

- [x] 9. Phase 5 - consolidation and deletion
  - Runs only after task 5 is in place and its owner has been observed live, so the index is never unowned. Strip one layer at a time and run `npm run check` after each, so a break is attributable to a single layer

  - [x] 9.1 Delete the four superseded files outright
    - `public/file-consistency-v2.js` (loaded last, wins `#set-dir`, duplicates reconciliation, the picker handler and the Save-to paint - concerns now in `files-stability.js`, `app.js`, `index.html` + `filegram-ui.css`)
    - `public/file-consistency-fix.js` (loaded by nothing)
    - `native-folder-picker-preload.js` (required by nothing; its `-modern` endpoint cannot answer - concern now the `server.js` endpoint)
    - `file-consistency-server-preload.js` (required by nothing; duplicate truth source - concern now `media-truth-v1`)
    - Remove the dynamic append of `file-consistency-v2.js?v=3` from `uploads.js`, keeping the rest of the chain's shape
    - _Bug_Condition: isBugCondition(X) with no single owner for any of the three concerns (clause 1.21)_
    - _Expected_Behavior: design Property 5 - obsolete layers absent from the tree, not dormant_
    - _Preservation: 3.12 bulk uploads and the queue keep working_
    - _Requirements: 2.15, 2.21, 3.12_

  - [x] 9.2 Strip index, count and persistence code from the daily-driver layers
    - `daily-driver-p0-v2.js`: remove `teleP0v2DbName`, `teleP0v2Store`, `teleP0v2Db`, `teleP0v2ReadIndex`, `teleP0v2WriteIndex`, `teleP0v2PersistTimers`, `teleP0v2PersistSoon`, `teleP0v2ValidSnapshot`, `teleP0v2PaintIndex`, `teleP0v2Sync`, the `rescueEnsureAllFiles` override and the `media-index-progress` branch of its `handleEvent` wrapper; keep the search rebind, the unified media viewer (`rescuePreviewFile`), the grid card hook and the attachment/composer code
    - `daily-driver-p1.js`, `daily-driver-p2.js`, `daily-driver-hotfix.js`: remove their `openChat` index restores, their `rescueFileCache.set` sites, their progress handling and their `teleP0v2WriteIndex` calls; keep the sorting helper, the preview modal and the thumbnail helpers other layers call
    - `daily-driver-final.js`: remove `teleFinalApplySnapshot`, `teleFinalRestorePersistent`, the partial paint path, the persist call and the `openChat` restore hook
    - `daily-driver-final-ui-fix.js`: remove `canonicalIndexes`, `normalizeIndex`, `mergeIndexes`, its commit/restore functions and its two persist calls
    - `daily-driver-final-guard.js`: remove `guardStableMediaScan`, the `request = function teleGuardRequest` interception, `guardBestKnownSnapshot`, `guardSnapshotAsResponse`, `guardScanShape`, `guardMemorySnapshot`, `guardIsCompleteSnapshot` and the `guardUpdateMediaLabel` / `rescueUpdateMediaLabel` assignment; keep the keyed chat-list reconciliation, avatar handling, read marking and the `setLoadState` smoothing
    - _Bug_Condition: truthIsOverriddenByCache and the seven-layer restore fight_
    - _Expected_Behavior: design Property 5 - one owner, observable at run time_
    - _Preservation: 3.1, 3.4, 3.6 lists, restore-without-rescan and pagination unchanged; the kept helpers still answer their callers_
    - _Requirements: 2.7, 2.8, 2.21, 3.1, 3.4, 3.6_

  - [x] 9.3 Strip index code from the remaining layers, keeping their other duties
    - `rescue-runtime.js`: `rescueEnsureAllFiles` becomes a thin delegate to `window.teleFilesIndex.ensure` with no cache writes; `rescueFileCache` stays declared for its many readers, with the owner as its only writer
    - `telegram-daily-driver.js`: remove its `media-index-progress` `rescueFileCache.set` path
    - `uploads-hardening.js`: remove `HIGH_WATER_KEY`, `RECONCILE_MARK_KEY`, `deletedByChat`, `reconcileFlights`, `reconciledThisSession`, `indexSnapshot`, `exactHighWater`, `paintFileCount`, `persistSnapshot`, `rememberDeletedIds`, `pruneDeletedIndex`, `scrubTemporaryIndex`, `readReconcileMarks`, `markReconciled`, `reconcilePersistedIndex`, `installIndexApiHardening`, `reconcileActiveChat` and the 900 ms chat-switch interval; `installRealtimeHardening` keeps only its temporary-id suppression and calls `window.teleFilesIndex.retireTemporary`; `scheduleRecentRefresh` keeps only its Messages-tab merge; the upload transport, retry classification, `Retry-After` handling and `installQueueHardening` are untouched
    - `files-view.js` is not touched at all
    - _Bug_Condition: staleFilesCondition(X); eleven writers of the shared cache and a permanent reconcile mark_
    - _Expected_Behavior: design Property 5 - the owner is the only writer, provable by re-running task 1.6_
    - _Preservation: 3.5 temporary-id retirement, 3.7 separated counts, 3.12 upload transport and queue hardening_
    - _Requirements: 2.9, 2.13, 2.21, 3.5, 3.7, 3.12_

  - [x] 9.4 Update `package.json` for the surviving file set
    - Update the `node --check` list for the four deleted files and the added scripts, so `npm run check` matches what survives consolidation
    - Confirm no new runtime layer was introduced: the only new files are test and build helpers (`scripts/files-reconcile.test.cjs`, `scripts/cache-tokens.test.cjs`, `scripts/stamp-cache-tokens.cjs`). There is no `file-consistency-v3.js`, no `folder-picker-final-fix.js`, no `another-hotfix.js`
    - _Bug_Condition: isBugCondition(X); each previous fix added a layer instead of replacing one_
    - _Expected_Behavior: design Property 5 - no new parallel runtime layer_
    - _Preservation: 3.13 `npm run verify` keeps passing with the updated list_
    - _Requirements: 2.21, 3.13_

- [ ] 10. Phase 6 - content-derived cache tokens **(SKIPPED - user decision, cost optimization)**

  - [ ] 10.1 Add `scripts/stamp-cache-tokens.cjs` and stamp the referenced assets
    - Compute a sha256 prefix for every asset referenced by `public/index.html` and by the dynamic loaders in `auth-state-fix.js` (`files-stability.js`, `files-view.js`) and `uploads.js` (`bulk-uploads.js`, `uploads-hardening.js`), and rewrite the `?v=` tokens
    - Keep the dynamic chain in `uploads.js` in its current shape; only the tokens change
    - The diff is large but mechanical; if a smaller diff is preferred, the alternative is stamping only the files this fix touches, which leaves the hazard in place for future edits - that tradeoff is the user's to make and is recorded in task 13
    - _Bug_Condition: reused tokens (`file-consistency-v2.js?v=3`, `uploads-hardening.js?v=3`) letting a browser execute an older copy_
    - _Expected_Behavior: design Property 5 - a content change always produces a token change_
    - _Preservation: 3.13 the load order and the loader chain are unchanged_
    - _Requirements: 2.22, 3.13_

  - [ ] 10.2 Add `scripts/cache-tokens.test.cjs` and wire it into `npm run check`
    - Recompute the hashes and fail if any referenced token does not match the file it names, so a content change without a token change breaks the build instead of reaching a browser
    - _Bug_Condition: hypothesis 6 - a stale cached frontend making a real code fix invisible_
    - _Expected_Behavior: token/content agreement enforced at build time_
    - _Requirements: 2.22, 2.23, 3.13_

- [ ] 11. Verify the fix against the tests written before it

  - [ ] 11.1 Verify the bug condition exploration tests now pass
    - **Property 1: Expected Behavior** - Telegram truth wins, the prune is durable, one handler reaches one Explorer-shell dialog, one full-width control
    - **IMPORTANT**: re-run the SAME ten tests from task 2 - do NOT write new ones. They encode the expected behaviour, so their passing is what confirms it
    - **EXPECTED OUTCOME**: all ten PASS
    - Re-run task 1.6's instrumentation against the fixed build and confirm at run time that the owner is the only `rescueFileCache` writer and that `scan-media-v3` results reach the caller unmodified
    - _Requirements: 2.1, 2.6, 2.7, 2.8, 2.9, 2.10, 2.11, 2.12, 2.13, 2.14, 2.16, 2.17, 2.19, 2.20, 2.22_

  - [ ] 11.2 Verify the preservation property tests still pass
    - **Property 2: Preservation** - every interaction outside the bug condition is unchanged from HEAD `90a56ce0`
    - **IMPORTANT**: re-run the SAME tests from task 3 - do NOT write new ones
    - **EXPECTED OUTCOME**: all PASS, with no regressions
    - Confirm specifically that partial-scan protection and streaming growth still hold, since their enforcement point moved from the persistence boundary to `commitDiscovery` / `commitAuthoritative`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 3.11, 3.12_

  - [ ] 11.3 Run `npm run verify`
    - Runs `check` (including the `node --check` list, the updated `files-invariants`, the new `files-reconcile` and `cache-tokens` invariants) and `test`
    - Record the output verbatim for task 13; a failure here is a blocker, not a note
    - _Requirements: 2.23, 3.13_

  - [ ] 11.4 Run the fixture Playwright suites, single run
    - `npx playwright test tests/file-consistency.spec.js tests/bulk-uploads.spec.js`
    - Never in watch mode; record results for task 13
    - _Requirements: 2.23, 3.12_

  - [ ] 11.5 Run the live Playwright suite with the server running
    - `npx playwright test tests/visual-check.spec.js` against `http://127.0.0.1:3000`, the authority on the Save-to layout after task 6.2
    - Assert one `#set-dir.fg-save-to` filling its parent, one path display, `#dl-dir` and `#dl-dir-current` absent, exactly one matched width rule, and the rest of the sidebar unchanged
    - _Requirements: 2.18, 2.19, 2.20, 2.23, 3.11_

- [ ] 12. Manual runtime acceptance against the real local Telegram session
  - **These four cannot be satisfied by any automated or mocked suite in this repository.** A green fixture run is not evidence for any of them, and hiding rows in the DOM does not satisfy any of them. Each is decided by observation on the running application on `feature/bulk-channel-uploads`, and anything not reproduced is declared unproven in task 13
  - Before each test, confirm from the task 1.2 banner and the task 1.3 `[FileGram runtime]` report that the running server build id and the served script bytes match the working tree; a stale process or a stale cache invalidates the observation

  - [ ] 12.1 TEST A - stale deleted files converge and stay converged
    - Precondition: the persisted index holds the 22 "TEST" rows (`photo_400556032.jpg`, `photo_393216000.jpg`, `photo_391118848.jpg` and 19 more) and Telegram "TEST" holds none of them
    - Start FileGram: the header reads `0 files`, the Files tab is empty, Select all is disabled with no count, type counts and the pagination range read zero, and the persisted snapshot for that chat is zero
    - Refresh the browser: still zero. Restart the FileGram server: still zero. No stale item reappears at any point
    - Capture the `[Files reconcile]` line for each pass as the evidence
    - _Requirements: 2.1, 2.3, 2.4, 2.5, 2.7, 2.8, 2.9, 2.12_

  - [ ] 12.2 TEST B - real-time deletion converges, including persistence
    - Send one test file to "TEST", confirm Files shows 1, then delete that Telegram message from another client
    - FileGram converges to 0 without a refresh, and the persisted index becomes 0; confirm the persisted record directly, not only the rendered list
    - _Requirements: 2.2, 2.13_

  - [ ] 12.3 TEST C - the folder dialog is the large Explorer-style dialog
    - Click Save to: a large, resizable Windows Explorer-style dialog opens with an address bar, a contents pane and a sidebar. The small legacy "Browse For Folder" tree does not appear
    - Confirm the response body reports `implementation: 'IFileOpenDialog'`; if it reports the `OpenFileDialog` fallback, that is a declared degradation and must be reported as such
    - Choose a folder: FileGram displays the exact selected path and a subsequent download is written there. Cancel: the configured folder is unchanged
    - A human has to look at the dialog; no headless test can drive a native dialog, which is why this task exists. This also closes hypothesis 5
    - _Requirements: 2.14, 2.16, 2.17, 3.9, 3.10_

  - [ ] 12.4 TEST D - one clean full-width Save-to control
    - At the application's real sidebar width: the control fills the available width, the path is legible, there is no `SAV...` clipping and no `SAVE TO` / clipped button / separate `F:...` stack
    - Exactly one click target and one path display; no duplicate Browse or Save-to control, no hidden legacy node occupying layout, no tiny nested button
    - Inspect the actual DOM and computed styles to confirm, rather than layering another override
    - _Requirements: 2.18, 2.19, 2.20_

- [ ] 13. Write the final report with the nine required answers
  - Report against the real local Telegram session, not against the test suites. Passing tests are not reported as proof of a fix
  - Answer all nine items: (1) the exact root cause of the stale 22 files; (2) the exact code path that resurrected or preserved them; (3) the exact reconciliation mechanism now in use; (4) the exact reason the small folder dialog still opened; (5) which folder-picker implementation now owns the feature; (6) which obsolete consistency and folder-picker layers were removed; (7) the files changed; (8) the tests run and their results; (9) anything that could not be verified against the real local Telegram session
  - Ground items (1), (2) and (4) in the task 1 artefacts and the task 12 observations, quoting the `[Files reconcile]` lines and the picker `implementation` field
  - **Honesty clause**: anything that could not be reproduced against the real local Telegram session is declared unproven, explicitly and in the report's own words. Candidates known in advance: whether the small dialog was a stale process rather than a code defect (if so, say the code at HEAD was already correct for that clause); whether `IFileOpenDialog` interop works on this host or the fallback was used; large-channel convergence timing, since a complete walk is reused from cache rather than re-run on every open; the `removedIds` 5000-entry / 30-day cap; and any preservation clause the tests only sampled, particularly 3.9 and 3.12
  - State plainly that `scripts/files-invariants.test.cjs` and `tests/file-consistency.spec.js` were changed because they asserted and stubbed away the defect, so a reviewer comparing suites does not read it as a weakened test
  - Confirm the branch is still `feature/bulk-channel-uploads` and the pull request was not merged
  - _Requirements: 1.24, 2.21, 2.22, 2.23, 2.24_

- [ ] 14. Checkpoint - ensure all tests pass
  - Ensure `npm run verify` and both Playwright runs pass, and that tasks 12.1 to 12.4 were each observed rather than inferred
  - Ask the user if questions arise, and stop rather than adding a new layer if any clause cannot be satisfied by the elected owners
  - _Requirements: 2.23, 2.24, 3.13_

---

# Phase 0 Evidence (task 1)

Recorded 2026-08-17 on branch `feature/bulk-channel-uploads`, working tree clean at HEAD `90a56ce0` (only `.kiro/` untracked). Nothing was fixed in this task. The only code that shipped is the two instruments task 1 permits: the `server.js` boot banner plus `buildId` on `get-status`, and the `[FileGram runtime]` script report (`GET /api/filegram/asset-hashes` in `server.js`, `reportRuntimeScripts` in `public/app.js`). Everything else was temporary and has been removed.

Every verdict below is backed by an observed runtime artefact, quoted verbatim. Where something could not be observed on this host it is marked UNVERIFIED rather than inferred.

## 1.1 The live server process against the picker commits

```
Get-NetTCPConnection -LocalPort 3000 -State Listen
  LocalAddress : 127.0.0.1   LocalPort : 3000   OwningProcess : 27444

Get-Process -Id 27444
  Id : 27444   ProcessName : node   StartTime : 17-08-2026 2.31.02 AM
  Path : C:\Program Files\nodejs\node.exe

Get-CimInstance Win32_Process -Filter "ProcessId=27444"
  CommandLine : node  -r ./tdlib-temp-preload.js -r ./tdl-upload-compat.js -r
                ./bulk-upload-preload.js -r ./download-dedupe-preload.js -r
                ./thumb-cache-preload.js -r ./session-preload.js server.js
  ParentProcessId : 23980  (cmd.exe /d /s /c <the same line>, i.e. npm start)
```

Commit times:

```
90a56ce0 2026-08-17T02:21:08+05:30 test(files): cover live Telegram reconciliation and folder picker   <- HEAD
801a70c5 2026-08-17T02:19:48+05:30 fix(files): make Telegram live media authoritative for small chats
ad9c229c 2026-08-17T02:19:24+05:30 fix(files): reconcile small indexes from live Telegram media
767e283e 2026-08-17T01:52:17+05:30 fix(files): reconcile deleted media and add native download folder picker
```

The process started 02:31:02, about ten minutes **after** HEAD was committed, and its command line is exactly this repository's `npm start`. Its working tree identity was confirmed independently: all 21 scripts it serves hash-match the files in this checkout (1.3), so the static root is this tree.

The decisive artefact is what the live process actually spawned when the picker endpoint was called. `POST /api/filegram/pick-download-folder` on PID 27444 produced this child:

```
CHILD pid=9204 name=powershell.exe
CMDLINE: powershell.exe -NoProfile -STA -Command "Add-Type -AssemblyName System.Windows.Forms;
  $d = New-Object System.Windows.Forms.OpenFileDialog; $d.Title = \"Select FileGram download folder\";
  $d.ValidateNames = $false; $d.CheckFileExists = $false; $d.CheckPathExists = $true;
  $d.FileName = \"Select this folder\"; $d.Filter = \"Folder|*.folder\";
  if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {;
    $p = Split-Path -Parent $d.FileName;;   if ($p) { [Console]::Out.Write($p) }; }"
```

Response body from that call:

```
{"ok":true,"cancelled":false,"path":"C:\\Users\\REBEL DUKER\\Downloads\\New folder (2)"}
```

**Verdict: hypothesis 5 REFUTED.** The live process was not a pre-`ad9c229c` process, and it executes the current `OpenFileDialog` code. No `FolderBrowserDialog` and no `Shell.Application BrowseForFolder` exists anywhere in the live path. Note that the response carries no `implementation` field, so the running dialog cannot be identified from the body - which is exactly the gap test 9 of task 2 is meant to record.

## 1.2 Boot banner, build id, and the restart

Added to `server.js`: `BUILD_SOURCES`/`computeBuildId()` (short `git rev-parse --short HEAD`, falling back to a sha256 prefix over `server.js` plus the six preloads), a boot line, and `buildId`/`buildIdSource`/`serverPid`/`serverStartedAt` on the `get-status` response.

Old process stopped, restarted with `npm start`:

```
FileGram running at http://127.0.0.1:3000
[FileGram server] pid=26216 started=2026-08-16T21:58:38.624Z buildId=90a56ce0 buildIdSource=git
  root=C:\Users\REBEL DUKER\Downloads\tele cwd=C:\Users\REBEL DUKER\Downloads\tele
```

`get-status` over the same WebSocket the browser uses:

```
STATUS {"status":"ready","ready":true,"buildId":"90a56ce0","buildIdSource":"git","serverPid":26216,
        "serverStartedAt":"2026-08-16T21:58:38.624Z","downloadsDir":"F:\\New\\Tamil"}
```

The picker on the restarted process spawns a **byte-identical** command line to the one quoted in 1.1. **The picker behaviour did not change after a restart**, which is the second, independent refutation of hypothesis 5. The reported `F:...` fragment in the Save-to area is the configured `downloadsDir` `F:\New\Tamil`.

## 1.3 Which script bytes the browser executes

`GET /api/filegram/asset-hashes` reports the on-disk sha256 of every script in `public/`; `reportRuntimeScripts` in `app.js` re-fetches each entry of `document.scripts` with `cache: 'default'`, hashes it in the browser, and prints one line per script. Run against the real app in Chromium:

```
[FileGram runtime] server pid=26216 buildId=90a56ce0 buildIdSource=git startedAt=2026-08-16T21:58:38.624Z
[FileGram runtime] script=app.js token=v=43 servedMatchesDisk=yes bytes=58384 diskBytes=58384 fromBrowserCache=no
[FileGram runtime] script=auth-state-fix.js token=v=1 servedMatchesDisk=yes ...
[FileGram runtime] script=filegram-media-policy.js token=v=1 servedMatchesDisk=yes ...
[FileGram runtime] script=rescue-runtime.js token=v=7 servedMatchesDisk=yes ...
[FileGram runtime] script=management.js token=v=4 servedMatchesDisk=yes ...
[FileGram runtime] script=telegram-daily-driver.js token=v=2 servedMatchesDisk=yes ...
[FileGram runtime] script=daily-driver-hotfix.js token=v=1 servedMatchesDisk=yes ...
[FileGram runtime] script=daily-driver-p0-v2.js token=v=1 servedMatchesDisk=yes ...
[FileGram runtime] script=daily-driver-p1.js token=v=1 servedMatchesDisk=yes ...
[FileGram runtime] script=daily-driver-p2.js token=v=1 servedMatchesDisk=yes ...
[FileGram runtime] script=daily-driver-final.js token=v=2 servedMatchesDisk=yes ...
[FileGram runtime] script=daily-driver-final-guard.js token=v=3 servedMatchesDisk=yes ...
[FileGram runtime] script=daily-driver-final-ui-fix.js token=v=2 servedMatchesDisk=yes ...
[FileGram runtime] script=filegram-shell.js token=v=1 servedMatchesDisk=yes ...
[FileGram runtime] script=files-stability.js token=v=2 servedMatchesDisk=yes ...
[FileGram runtime] script=files-view.js token=v=2 servedMatchesDisk=yes ...
[FileGram runtime] script=upload-queue-core.js token=v=1 servedMatchesDisk=yes ...
[FileGram runtime] script=uploads.js token=v=1 servedMatchesDisk=yes ...
[FileGram runtime] script=bulk-uploads.js token=v=3 servedMatchesDisk=yes ...
[FileGram runtime] script=uploads-hardening.js token=v=3 servedMatchesDisk=yes ...
[FileGram runtime] script=file-consistency-v2.js token=v=3 servedMatchesDisk=yes ...
```

21 scripts, all matching disk. The same comparison run directly against the server (fetch each URL, hash the body, compare to `Get-FileHash`) also matched for all 21.

The token-reuse hazard is nonetheless real and has an artefact. `public/uploads-hardening.js` changed content across five commits while its cache token in `uploads.js` stayed `?v=1`:

```
dad560b7 token=uploads-hardening.js?v=1  blob=669cf0d3da705f16ec3259b5b088f465c2b49f7e
9a87bd45 token=uploads-hardening.js?v=1  blob=f3f1ce84c67757583c10f4c82afa218ba5d6c128
a61310b1 token=uploads-hardening.js?v=1  blob=0e597d001f7467f4d3aa58639802d22d9abca01f
8efd1524 token=uploads-hardening.js?v=1  blob=b545ba867baee740970fdd0624e67bd3722f78ce
e480e622 token=uploads-hardening.js?v=1  blob=1083df154a639913594df9feab8d3b128ed8f6e4
```

**Verdict: hypothesis 6 REFUTED for the server, UNVERIFIED for the user's browser.** The server serves current bytes and a fresh browser executes current bytes. Whether the user's own browser profile executed a stale cached copy cannot be observed from this host - that would need their browser. One indirect signal, recorded as a signal and not as proof: the reported render includes a visible `SAVE TO` heading, and in the current composition that heading is `display: none` (see 1.5), so the reported shape is consistent with `file-consistency-v2.js` not having executed there.

Also noted: `auth-state-fix.js` appends a sixth dynamic script, `filegram-media-policy.js?v=1`, which the load-order list in the introduction does not mention.

## 1.4 The real Save-to click path

Bindings on `#set-dir`, read through CDP `DOMDebugger.getEventListeners` in the running app:

```
addEventListener listeners: [ { "type": "click", "useCapture": false, "passive": false,
  "once": false, "scriptId": "37", "lineNumber": 213, "columnNumber": 37, "backendNodeId": 34 } ]
inline onclick: { "onclickPresent": false, "onclickSource": null }
node: { "id": "set-dir", "className": "fg-folder-v2 fg-download-folder-picker", "tagName": "BUTTON",
        "dataset": { "fgLabel": "1", "fgFolderPath": "F:\\New\\Tamil", "fgFolderV2": "1" },
        "title": "F:\\New\\Tamil" }
```

Exactly one listener is bound, and it is `file-consistency-v2.js`'s (line 213 is its `button.addEventListener('click', ...)`). `uploads-hardening.js`'s `button.onclick` is gone, because v2 clone-replaced the node after hardening assigned it. The node nonetheless carries **both** layers' classes and datasets, and its markup is hardening's (see 1.5), so the handler and the markup come from different owners.

The request the page actually made, captured by wrapping `window.fetch` before any page script ran, then clicking the real button:

```
PICKER REQUESTS SEEN BY THE PAGE: [ { "url": "/api/filegram/pick-download-folder", "method": "POST",
  "status": 500, "body": "{\"ok\":false,\"error\":\"Folder picker exited with code 4294967295\"}" } ]
UI AFTER PICKER: {"buttonTitle":"F:\\New\\Tamil","dlDirValue":"F:\\New\\Tamil",
  "toast":"Folder picker exited with code 4294967295"}
```

The 500 is because the automation closed the native dialog by terminating the PowerShell child; a genuine `Cancel` returns exit code 0 and yields `cancelled: true`. Recorded as a finding in its own right: an abnormally terminated dialog is not reported as a cancel, and the raw error string is shown to the user.

Pre-fix chain, observed end to end:

```
button#set-dir  (composite node: hardening markup + v2 class/dataset)
  -> single click listener bound by public/file-consistency-v2.js:213
  -> POST /api/filegram/pick-download-folder
  -> bulk-upload-preload.js  app.post(...)  ->  pickWindowsFolder()
  -> spawn powershell.exe -NoProfile -STA -Command "... OpenFileDialog ...
       $d.FileName = 'Select this folder' ... Split-Path -Parent $d.FileName ..."
  -> { ok, cancelled, path }   (no implementation field)
  -> request('set-download-dir', { dir })  ->  paint()
```

Neither the second endpoint nor the third handler can participate. Probed on the live process:

```
POST /api/filegram/pick-download-folder-modern            -> HTTP 404
POST /api/filegram/reconcile-small-chat-history/-1004...   -> HTTP 404
GET  /file-consistency-fix.js                             -> HTTP 200 (servable, referenced by nothing)
POST /api/filegram/reconcile-message-ids/-1004...          -> HTTP 200 {"ok":true,...}
```

**Verdict: hypothesis 9 CONFIRMED at the mechanism level** - the live process derives the directory from `Split-Path -Parent` of a synthetic file name, quoted verbatim from its own child command line. Whether the value returned in the one interactive call equalled the folder the human actually selected is UNVERIFIED, because the selection was not under test control.

## 1.5 The real Save-to render

Computed style and layout of the three controls, measured in the running app at a 1600px viewport (sidebar row 361px wide):

```
#set-dir        width 54px  min-width 54px  height 42px  display flex  padding 0px  overflow hidden
                rect { x:1225, y:184, w:54, h:42 }  occupiesLayout true
                parent chain: span.row -> label.conc -> div.dl-controls -> div#mg-downloads-pane.mg-drawer-pane
                                       -> aside.downloads -> div.app -> div#main-screen
#dl-dir         display none  rect { w:0, h:0 }  occupiesLayout false  value "F:\New\Tamil"
#dl-dir-current display none  rect { w:0, h:0 }  occupiesLayout false  text  "F:\New\Tamil"
label.conc > span ("Save to" heading)  display none  rect { w:0, h:0 }  occupiesLayout false
```

Every rule in the tree that matches `#set-dir` and declares a width, with specificity:

| sheet | selector | specificity (id,class,type) | width |
| --- | --- | --- | --- |
| `daily-driver-p0.css` | `.downloads #set-dir` | 1,1,0 | `100% !important` |
| `<style#fg-hardening-style>` | `#set-dir.fg-download-folder-picker` | 1,1,0 | `100% !important` |
| `<style#fg-download-folder-v2-style>` | `#set-dir.fg-folder-v2` | 1,1,0 | `100% !important` |
| **`daily-driver-p1.css`** | **`#mg-downloads-pane #set-dir`** | **2,0,0** | **`54px !important`, `min-width: 54px !important`, `padding: 0 !important`** |

CDP `CSS.getMatchedStylesForNode`, lowest to highest precedence, tail of the list:

```
MATCHED origin=regular selector=".downloads #set-dir"                  width=100% !important
MATCHED origin=regular selector="#set-dir.fg-download-folder-picker"   width=100% !important
MATCHED origin=regular selector="#set-dir.fg-folder-v2"                width=100% !important
MATCHED origin=regular selector="#mg-downloads-pane .dl-controls button" width=-
MATCHED origin=regular selector="#mg-downloads-pane #set-dir"          width=-
MATCHED origin=regular selector="#mg-downloads-pane #set-dir"          width=54px !important
INLINE width=-
```

**Verdict: hypothesis 7 CONFIRMED.** `#mg-downloads-pane #set-dir { width: 54px !important }` in `daily-driver-p1.css` is the last and highest-specificity important declaration, and the computed width is 54px. All three JS-injected `100% !important` overrides lose on specificity: two IDs beats one ID plus one class. The runtime parent is `#mg-downloads-pane`, as predicted.

Inside the 54px box, both text spans are clipped:

```
span.fg-folder-icon  text "\ud83d\udcc1"     w 22  scrollW 22  clipped false
span.fg-folder-label text "Save to"          w 20  scrollW 42  clipped true   text-overflow clip
span.fg-folder-path  text "F:\New\Tamil"     w 20  scrollW 72  clipped true   text-overflow ellipsis
clickTargets: [ "button#set-dir.fg-folder-v2.fg-download-folder-picker" ]
visible path displays: only "#set-dir .fg-folder-path"  (#dl-dir and #dl-dir-current present but invisible)
```

A screenshot of the pane shows exactly the reported broken control: a tiny folder button reading `SAV` over `F:...`.

Two refinements to the requirements, both from measurement:

- Clause 1.20's "three overlapping controls in layout" is **refuted as written**. `#dl-dir` and `#dl-dir-current` are `display: none` with zero-area rects at run time, hidden by `#fg-download-folder-v2-style`; they are still in the DOM but occupy no layout. Exactly one click target and one visible path display exist. The defect is the 54px width, not a hidden node stealing space.
- The `SAVE TO` heading is also `display: none` in this composition, so the reported three-line stack is one line richer than what the current bytes render.

## 1.6 The reconcile and resurrection boundaries, chat "TEST"

Telegram truth for the chat, asked over the same ws protocol the browser uses:

```
CHAT MATCH {"id":-1004474514785,"title":"TEST"}
SCAN-MEDIA-V3 {"found":0,"scanned":1,"done":true,"cancelled":false,"itemCount":0,
  "typeCounts":{"document":0,"photo":0,"video":0,"gif":0,"audio":0,"voice":0,"video_note":0,"sticker":0}}
SCAN ITEMS SAMPLE []
```

The server says zero. The stale precondition (a persistent record of 22 rows for that chat, plus a high-water entry of 22) was **seeded into the throwaway browser profile**, because the 22 rows live in the user's browser storage and cannot be inherited by an automated profile. The precondition is TEST A's precondition; the mechanisms below then ran for real, unmodified.

### Writers of the shared cache, with stacks

```
key=-1004474514785 count=22 done=true <- teleFinalApplySnapshot (daily-driver-final.js:64) <- teleFinalRestorePersistent (daily-driver-final.js:89) <- teleFinalOpenChat (daily-driver-final.js:718) <- teleGuardOpenChat (daily-driver-final-guard.js:469)
key=-1004474514785 count=22 done=true <- teleFinalApplySnapshot (daily-driver-final.js:64) <- teleFinalOpenChat (daily-driver-final.js:722) <- teleGuardOpenChat (daily-driver-final-guard.js:469)
key=-1004474514785 count=22 done=true <- teleP2ApplySnapshot (daily-driver-p2.js:24) <- teleP2EnsureFilesReady (daily-driver-p2.js:49) <- teleP2SetView (daily-driver-p2.js:112) <- teleFinalSetView (daily-driver-final.js:736) <- teleGuardSetView (daily-driver-final-guard.js:484) <- fileGramMessageFreshSetView (auth-state-fix.js:170)
key=-1004474514785 count=22 done=true <- teleFinalApplySnapshot (daily-driver-final.js:64) <- teleFinalEnsureFiles (daily-driver-final.js:180) <- teleFinalSetView (daily-driver-final.js:740) <- teleGuardSetView (daily-driver-final-guard.js:484) <- fileGramMessageFreshSetView (auth-state-fix.js:170) <- fileGramPagedSetView (files-view.js:473)
key=-1004474514785 count=22 done=true <- teleFinalApplySnapshot (daily-driver-final.js:64) <- daily-driver-final.js:207
key=-1004474514785 count=22 done=true <- setSharedSnapshot (files-stability.js:195) <- commitUnion (files-stability.js:307) <- files-stability.js:409
```

Three files write the stale 22 into `rescueFileCache` on one chat open: `daily-driver-final.js` (four sites), `daily-driver-p2.js`, and `files-stability.js`. Each reads it back from the persisted record. **Hypothesis 3 CONFIRMED** in the form that matters: the persisted record is re-applied to the shared cache and the owner by several independent layers, so one surviving stale copy repopulates everything.

### The truth override

```
WS SENT  scan-media-v3 id=31 payload={"chatId":-1004474514785,"force":true}
WS RECV  response id=31 found=0 scanned=1 done=true items=0 fromCache=false
WS SENT  scan-media-v3 id=32 payload={"chatId":-1004474514785,"force":true}
WS RECV  response id=32 found=0 scanned=1 done=true items=0 fromCache=false
WS SENT  scan-media-v3 id=33 payload={"chatId":-1004474514785,"force":true}
WS RECV  response id=33 found=0 scanned=1 done=true items=0 fromCache=false
CALLER RECEIVED: {"found":22,"scanned":22,"done":true,"fromCache":true,
  "protectedByClientCache":true,"items":22,
  "firstNames":["photo_stale_21.jpg","photo_stale_20.jpg","photo_stale_19.jpg"]}
```

The server answered zero three times on the wire; the caller received 22 rows stamped `protectedByClientCache: true`. `request` at run time is confirmed to be the interceptor:

```
requestIsWrapped: "function teleGuardRequest (type, payload = {}) {\r\n
  if (type === 'scan-media-v3') return guardStableMediaScan(payload)"
```

**Hypothesis 1 CONFIRMED. This is the answer to clause 2.24 item (2).**

`hardRefresh` does not escape it:

```
HARD REFRESH: {"ms":4783,"error":null}
AFTER HARD REFRESH: { "header": "22 files", "ownerCount": 22, "sharedCacheCount": 22,
  "persisted": { "items": 22, "found": 22 },
  "highWater": "{\"-1004474514785\":{\"count\":22,\"at\":1786918413800}}" }
```

The high-water entry that `clearTotalFloor` deleted was re-established at 22 with a fresh timestamp (seeded `at` was `1786918389679`, post-refresh `at` is `1786918413800`), rewritten from the stale snapshot. Clearing the floor while the record survives is futile, as the design predicted.

State after opening the chat, for the record:

```
AFTER OPEN: { "header": "22 files", "selectAll": { "text": "Select all (22)", "disabled": false },
  "gridRows": 22, "ownerCount": 22, "ownerSnapshot": 22, "sharedCacheCount": 22,
  "persisted": { "items": 22, "found": 22, "done": true },
  "highWater": "{\"-1004474514785\":{\"count\":22,\"at\":1786918389679}}",
  "reconcileMark": null }
```

### The persistence boundary

Because the guard fed every layer 22, no layer ever attempted a smaller write: all three observed calls were `stored=22 incoming=22 allowShrink=false returnedEarly=false`. The boundary was therefore exercised directly, in the page, against the real IndexedDB record:

```
record before any write:                              {"items":22,"found":22}
teleP0v2WriteIndex(chatId, 0 items)                   resolved
record after 0-item write WITHOUT allowShrink:        {"items":22,"found":22}
record after the same 0-item write WITH allowShrink:  {"items":0,"found":0}
```

The prune is silently discarded, and the only escape hatch is a flag no production caller passes (`allowShrink` appears in `daily-driver-p0-v2.js` itself and in `scripts/files-invariants.test.cjs`, nowhere else). **Hypothesis 2 CONFIRMED.**

### The truth source used by reconciliation

```
GET /api/filegram/live-media-ids/-1004474514785
HTTP/1.1 500 Internal Server Error
{"ok":false,"error":"Failed to parse JSON object as TDLib request: Unknown class \"messageFilterDocument\""}
```

This is not an intermittent failure. `LIVE_MEDIA_FILTERS` in `bulk-upload-preload.js` uses `messageFilterDocument`, `messageFilterPhoto`, `messageFilterVideo`, `messageFilterAudio`, `messageFilterVoiceNote`, `messageFilterAnimation`, `messageFilterVideoNote`; TDLib on this host rejects the first one as an unknown class, so `collectLiveMediaIds` throws on its first call and the endpoint answers 500 for **every** chat. The live-media reconciliation added in `ad9c229c` and `801a70c5` has therefore never once succeeded here, and the retry cadence in `file-consistency-v2.js` hammers it:

```
failures in 10015 ms: 20
observed gaps (ms): [510,497,498,507,495,505,496,496,493,508,493,512,488,513,493,507,487,514,491]
median gap: 497
CONSOLE> [files] live reconciliation failed Failed to parse JSON object as TDLib request: Unknown class "messageFilterDocument"   (x20)
```

**Hypothesis 4 CONFIRMED, and stronger than stated:** the truth source does not merely fail to distinguish emptiness from failure, it never answers at all. The failure surfaces only as `console.warn` and is retried every ~497 ms indefinitely. The permanent per-chat mark limb is a separate matter: `localStorage['filegram-files-delete-reconcile-v1']` was `null` throughout, because it is only written after a reconcile succeeds, which cannot happen while the endpoint 500s. That limb is UNVERIFIED on this host.

### Painters on the Save-to node

Writes to `#set-dir` observed over ~20 s, attributed by stack:

```
TOTAL WRITES TO #set-dir IN ~20s: 5
   2x  uploads-hardening.js:424 [innerHTML]
   1x  filegram-shell.js:688 [textContent]
   1x  file-consistency-v2.js:209 [innerHTML]
   1x  file-consistency-v2.js:212 [replaceWith(clone)]
order:
   textContent   filegram-shell.js:688       -> "Browse"
   innerHTML     uploads-hardening.js:424    -> <span class="fg-folder-icon">...<span class="fg-folder-copy">...
   innerHTML     file-consistency-v2.js:209  -> <span aria-hidden="true">...<span class="fg-folder-v2-copy"><small>Save to</small>...
   replaceWith   file-consistency-v2.js:212  -> set-dir            (this is what discards hardening's onclick)
   innerHTML     uploads-hardening.js:424    -> <span class="fg-folder-icon">...   (overwrites v2's markup on v2's node)
```

**Hypothesis 8 CONFIRMED.** Three files write the same node in one 20-second window, the last write is hardening's markup, and the only surviving handler is v2's. Which layer wins is decided by ordering, exactly as described. The design counted six candidate painters; three were observed writing `#set-dir` in this window, and the remaining candidates (`setDirLabel`, `restoreDownloadDirHint`, `teleP0v2RefreshPath`) write `#dl-dir` / `#dl-dir-current`, which are now `display: none`.

## 1.7 Runtime composition map

Server, from the live process command line and the endpoint probes:

```
node -r tdlib-temp-preload.js -r tdl-upload-compat.js -r bulk-upload-preload.js
     -r download-dedupe-preload.js -r thumb-cache-preload.js -r session-preload.js  server.js
  server.js            requires ./packMedia, ./packSelected; owns mediaIndexCache, scanMediaIndexV3,
                       ws get-status / scan-media-v3 / set-download-dir, express.static(public)
  bulk-upload-preload.js  wraps express and OWNS at run time:
                       POST /api/filegram/pick-download-folder      -> pickWindowsFolder -> OpenFileDialog
                       GET  /api/filegram/live-media-ids/:chatId    -> HTTP 500 on this host, always
                       POST /api/filegram/reconcile-message-ids/:chatId -> HTTP 200
  NOT in the map (probed, absent):
                       native-folder-picker-preload.js       -> /pick-download-folder-modern       404
                       file-consistency-server-preload.js    -> /reconcile-small-chat-history/:id  404
```

Browser, from `document.scripts` in the running app (21 scripts, all matching disk):

```
index.html, in order:
  app.js?v=43, auth-state-fix.js?v=1, rescue-runtime.js?v=7, management.js?v=4,
  telegram-daily-driver.js?v=2, daily-driver-hotfix.js?v=1, daily-driver-p0-v2.js?v=1,
  daily-driver-p1.js?v=1, daily-driver-p2.js?v=1, daily-driver-final.js?v=2,
  daily-driver-final-guard.js?v=3, daily-driver-final-ui-fix.js?v=2, filegram-shell.js?v=1,
  upload-queue-core.js?v=1, uploads.js?v=1
appended by auth-state-fix.js:  filegram-media-policy.js?v=1, files-stability.js?v=2, files-view.js?v=2
appended by uploads.js chain:   bulk-uploads.js?v=3 -> uploads-hardening.js?v=3 -> file-consistency-v2.js?v=3
NOT in the map: public/file-consistency-fix.js  (served, referenced by nothing)
```

Effective owners at run time, per concern:

| concern | who actually decides | who else is in the path |
| --- | --- | --- |
| `scan-media-v3` result | `daily-driver-final-guard.js` `guardStableMediaScan` via `request = teleGuardRequest`; substitutes the persisted snapshot when the truthful count is below the floor | `server.js` `scanMediaIndexV3` answers truthfully and is discarded |
| persisted Files index | `daily-driver-p0-v2.js` `teleP0v2WriteIndex`, monotonic, shrink silently dropped | `files-stability.js`, `file-consistency-v2.js`, `uploads-hardening.js`, `daily-driver-final*.js` all write through it |
| shared `rescueFileCache` | no owner; `daily-driver-final.js` (4 sites), `daily-driver-p2.js`, `files-stability.js` observed writing on one chat open | declared in `rescue-runtime.js` |
| reconciliation against Telegram | nobody; `file-consistency-v2.js` retries a permanently 500-ing endpoint every ~497 ms | `uploads-hardening.js` has a second implementation on the same dead endpoint |
| folder-picker backend | `bulk-upload-preload.js` `pickWindowsFolder` (`OpenFileDialog` + `Split-Path -Parent`) | `native-folder-picker-preload.js` unreachable (404) |
| Save-to click handler | `file-consistency-v2.js:213` (single listener; it clone-replaced the node and dropped hardening's `onclick`) | `uploads-hardening.js` `onclick` discarded; `file-consistency-fix.js` never loaded |
| Save-to markup | `uploads-hardening.js:424`, last writer | `file-consistency-v2.js:209`, `filegram-shell.js:688` overwritten |
| Save-to width | `daily-driver-p1.css` `#mg-downloads-pane #set-dir { width: 54px !important }` | three `100% !important` rules at lower specificity lose |

## Hypothesis verdicts

| # | hypothesis | verdict | deciding artefact |
| --- | --- | --- | --- |
| 1 | client cache outranks Telegram truth | **CONFIRMED** | server answered `found=0 items=0` on ws ids 31/32/33; caller received `{"found":22,...,"protectedByClientCache":true}` |
| 2 | persistence boundary discards shrinks | **CONFIRMED** | record `{"items":22}` unchanged by a 0-item write; `{"items":0}` only with `allowShrink: true`, which no production caller passes |
| 3 | restore unions stale sources | **CONFIRMED** | six `rescueFileCache.set` writes of the stale 22 on one chat open, from `daily-driver-final.js`, `daily-driver-p2.js`, `files-stability.js` |
| 4 | reconciliation cannot tell failure from emptiness / can be disabled | **CONFIRMED (stronger)** | `live-media-ids` returns HTTP 500 `Unknown class "messageFilterDocument"` for every call; 20 failures in 10015 ms, median gap 497 ms, warn-only. Permanent-mark limb UNVERIFIED (`filegram-files-delete-reconcile-v1` was `null`; it can only be set after a success that cannot occur) |
| 5 | a stale server process serves the old dialog | **REFUTED** | PID 27444 started 02:31:02, HEAD committed 02:21:08; its spawned child ran `OpenFileDialog` + `Split-Path -Parent`, no `FolderBrowserDialog`; identical command line after a full restart (pid 26216, `buildId=90a56ce0`) |
| 6 | a stale cached frontend serves an old handler | **REFUTED server-side; UNVERIFIED in the user's browser** | 21/21 scripts `servedMatchesDisk=yes`. Token reuse is real (`uploads-hardening.js?v=1` across five different blobs) but cannot be shown to have affected the user's profile from this host |
| 7 | CSS specificity decides the control's width | **CONFIRMED** | computed `width: 54px`, `min-width: 54px`; CDP matched list ends with `#mg-downloads-pane #set-dir width=54px !important`; runtime parent chain reaches `#mg-downloads-pane`; row is 361px |
| 8 | several JS layers paint the same node | **CONFIRMED** | 5 writes to `#set-dir` in 20 s from `filegram-shell.js:688`, `uploads-hardening.js:424` (x2), `file-consistency-v2.js:209` and `:212` |
| 9 | the directory return is fabricated | **CONFIRMED at the mechanism level** | live child command line derives the result from `Split-Path -Parent $d.FileName` with `FileName = "Select this folder"`; response body carries no `implementation` field. Whether the returned path matched the human's selection is UNVERIFIED |

**GATE: PASSES.** Hypotheses 1, 2 and 7 are all confirmed by observed runtime artefacts, so the design does not need revision before work continues.

## Findings the design did not anticipate

1. `GET /api/filegram/live-media-ids/:chatId` answers HTTP 500 for every chat on this host because `LIVE_MEDIA_FILTERS` uses TDLib class names that do not exist (`messageFilterDocument` and its six siblings; TDLib expects the `searchMessagesFilter*` family). This is the concrete reason `ad9c229c` and `801a70c5` produced no visible change, and it should be named in the final report alongside the guard. `POST /api/filegram/reconcile-message-ids/:chatId` does work.
2. `#dl-dir` and `#dl-dir-current` do not occupy layout at run time, and the `SAVE TO` heading is `display: none`. Clause 1.20 and clause 2.20's "hidden legacy control still occupying layout space" need rewording: the observed defect is width and clipping, not stolen space.
3. Terminating the picker dialog abnormally yields HTTP 500 `Folder picker exited with code 4294967295`, and the raw message is toasted to the user. Only a real `Cancel` produces the `cancelled` shape.
4. `auth-state-fix.js` appends `filegram-media-policy.js?v=1`, a sixth dynamic script missing from the load-order list in the introduction.
5. `scan-media-v3` for chat `TEST` reports `scanned: 1` alongside `found: 0`, so the walk is not returning an empty page count of zero. Worth confirming when `historyComplete` is added in task 4.1.

---

# Task 2 Evidence - bug condition exploration tests

Recorded on branch `feature/bulk-channel-uploads` at HEAD `90a56ce0`. No fix was written in this task. The only file changed is `tests/file-consistency.spec.js`; `public/app.js` and `server.js` still carry only the two Phase 0 instruments.

All ten tests were written and run against unfixed code. **All ten FAIL**, which is the success condition for this task: each failure is a reproduction of a mechanism. `expect.soft` is used throughout so every counterexample in a test surfaces in one run instead of only the first.

```
npx playwright test tests/file-consistency.spec.js --reporter=list --workers=1

x  1  1 persistence boundary: a truth pass that shrinks the index is written durably (149ms)
x  2  2 truth override: a forced rescan returns the server truth, not the client cache (14.4s)
x  3  3 restore union: restore keeps the pruned set and does not union a stale record back in (149ms)
x  4  4 unknown truth: a failing live truth source is surfaced and retried with backoff (3.1s)
x  5  5 empty-scan ambiguity: an empty truth answer with no completeness evidence never prunes (5.8s)
x  6  6 reconcile mark: a chat marked reconciled in an earlier session still detects later deletions (4.7s)
x  7  7 Save-to render: the control fills its parent and neither label nor path is clipped (2.9s)
x  8  8 Save-to binding: exactly one layer owns the control and exactly one picker URL is requested (2.3s)
x  9  9 picker identity: the picker response identifies an Explorer-style implementation (2.3s)
x 10  10 cache token: a script content change changes the cache token that references it (3.5s)
10 failed
```

`npm run check` still passes, including `node --check tests/file-consistency.spec.js`.

## The enabling change, and the clause 1.23 finding it records

The previous `tests/file-consistency.spec.js` could not observe either boundary it claimed to test:

- it replaced the real persistence boundary with `window.teleP0v2WriteIndex = async (_chatId, value) => { window.__persistedSnapshot = ... }`, an always-writing stub, so its "persisted snapshot is 0" assertion passed **because the real monotonic guard was absent**;
- it served a bare HTML string with no `<link rel="stylesheet">` at all, so its `geometry.width >= geometry.parent - 2` assertion passed **because no CSS existed** - the 54px rule that decides the real render could not apply.

Both crutches are removed. The suite now:

- loads the real layers by URL out of a served real `public/` tree, with their real `?v=` tokens, so stack frames carry the real file and line (this is what produced the `uploads-hardening.js:424` / `file-consistency-v2.js:212` attribution in test 8);
- runs the real `daily-driver-p0-v2.js` boundary against real IndexedDB, with a guard assertion (`assertRealBoundary`) that fails the suite if the boundary is ever stubbed again - this is the check task 6.3 asks for, added now;
- builds the layout fixture from the real `.dl-controls` markup **sliced out of `public/index.html`** rather than retyped, inside the real runtime parent chain, under the real 15 stylesheets from `public/index.html`, and asserts `document.styleSheets.length >= 15` so a future bare page fails rather than greens.

That the counterexamples were unwritable before this change is itself the finding for clause 1.23: a green run of the old suite described the stub, not the application.

## Seeded preconditions, stated plainly

The 22 stale "TEST" rows live in the user's own browser storage and cannot be inherited by an automated profile. Exactly as in Phase 0, they were **seeded** into the throwaway automation profile - the persistent IndexedDB record, the `tele-file-index-high-water-v1` floor of 22, and the `rescueFileCache` entry - and then every mechanism under test ran unmodified. `filegram-files-delete-reconcile-v1` in test 6 was seeded for the same reason and with a stronger caveat, recorded below.

## The ten counterexamples, verbatim

### Test 1, persistence boundary - confirms hypothesis 2 (clauses 1.6, 2.6)

Concrete case first (stored 22, truth 0), then generated shrink pairs. Every one is discarded.

```
COUNTEREXAMPLE [test 1 persistence boundary]
[ { "stored": 22,  "truth": 0,   "recordBefore": 22,  "recordAfter": 22 },
  { "stored": 165, "truth": 8,   "recordBefore": 165, "recordAfter": 165 },
  { "stored": 192, "truth": 123, "recordBefore": 192, "recordAfter": 192 },
  { "stored": 346, "truth": 206, "recordBefore": 346, "recordAfter": 346 },
  { "stored": 395, "truth": 393, "recordBefore": 395, "recordAfter": 395 },
  { "stored": 232, "truth": 139, "recordBefore": 232, "recordAfter": 232 } ]

Error: stored 22, truth 0: the persisted record must become 0
  - "recordAfter": 0
  + "recordAfter": 22
```

### Test 2, truth override - confirms hypothesis 1 (clauses 1.4, 1.8, 2.1, 2.8)

The server answered zero on all five rounds on the wire; the caller received 22.

```
COUNTEREXAMPLE [test 2 truth override]
{
  "hardRefreshMs": 4744,
  "serverAnswers": [ {"found":0,"items":0,"done":true,"scanned":1},
                     {"found":0,"items":0,"done":true,"scanned":1},
                     {"found":0,"items":0,"done":true,"scanned":1},
                     {"found":0,"items":0,"done":true,"scanned":1},
                     {"found":0,"items":0,"done":true,"scanned":1} ],
  "callerReceived": [ { "found": 22, "items": 22, "done": true, "fromCache": true,
                        "protectedByClientCache": true,
                        "firstNames": ["photo_stale_21.jpg","photo_stale_20.jpg","photo_stale_19.jpg"] } ],
  "ownerCount": 22,
  "header": "22 files",
  "persisted": 22,
  "highWater": "{\"-1004474514785\":{\"count\":22,\"at\":1786947737374}}"
}

Error: the caller must receive the server truth of 0 items      Expected: 0   Received: 22
Error: no client cache may substitute itself for Telegram truth Received: true
Error: the header must read the server truth                   Expected: "0 files"  Received: "22 files"
Error: a durable floor must not be re-stamped above Telegram truth  Received: 22
```

In one sentence: **hardRefresh on TEST returned 22 items with `protectedByClientCache: true` while the server returned 0**, in 4744 ms, and the high-water floor was re-stamped at 22. Phase 0 measured 4783 ms for the same operation.

Generalised over generated floors:

```
COUNTEREXAMPLE [test 2 truth override, generalised]
[ { "floor": 377, "truth": 217, "receivedItems": 377, "protectedByClientCache": true },
  { "floor": 259, "truth": 165, "receivedItems": 259, "protectedByClientCache": true } ]
```

### Test 3, restore union - confirms hypothesis 3 (clauses 1.7, 2.7)

Pruned in-memory snapshot of 0 plus an untouched record of 22, with the observed floor of 22 in place.

```
COUNTEREXAMPLE [test 3 restore union]
{ "restoredCount": 22, "ownerCount": 22, "sharedCount": 22,
  "names": ["photo_stale_21.jpg","photo_stale_20.jpg","photo_stale_19.jpg"] }

Error: restore must yield the pruned set, not the union with the stale record  Expected: 0  Received: 22
Error: the owner index must stay pruned after restore                          Expected: 0  Received: 22
Error: the shared cache must not be repopulated from the stale record          Expected: 0  Received: 22
```

### Test 4, unknown truth - confirms hypothesis 4, in the stronger form Phase 0 measured (clauses 1.10, 2.10)

Written against the ACTUAL failure mode, not the 503 the design guessed. The endpoint was called on the running server and the real response drove the client through a proxying route, so nothing here is mocked.

```
COUNTEREXAMPLE [test 4 live truth endpoint, direct call]
GET /api/filegram/live-media-ids/-1004474514785
HTTP 500
{"ok":false,"error":"Failed to parse JSON object as TDLib request: Unknown class \"messageFilterDocument\""}

COUNTEREXAMPLE [test 4 unknown truth]
{ "requests": 5, "withinTwoSeconds": 3, "gaps": [493, 500, 493, 499],
  "first": { "at": 576, "status": 500,
             "body": "{\"ok\":false,\"error\":\"Failed to parse JSON object as TDLib request: Unknown class \\\"messageFilterDocument\\\"\"}" },
  "observed": { "ownerCount": 22, "persisted": 22,
                "loadStates": ["Loaded 22 indexed files", "Loaded 22 indexed files"],
                "toasts": [],
                "warns": ["[files] live reconciliation failed Failed to parse JSON object as TDLib request: Unknown class \"messageFilterDocument\"", ... ],
                "warnCount": 5 } }

Error: the live truth source must answer, not fail                Expected: 200  Received: 500
Error: the live truth source must not fail on an unknown TDLib class
Error: a failing truth source must be retried with backoff, at most one retry in two seconds  Expected: <= 2  Received: 3
Error: the failure must be surfaced in the UI or the load state, not only in console.warn     Expected: true  Received: false
```

Retry gaps of 493-500 ms reproduce Phase 0's median of 497 ms. The load state still reads `Loaded 22 indexed files` while the truth source is dead, and no toast is raised.

### Test 5, empty-scan ambiguity - confirms the `exact: ids.length < 5000` defect (clauses 1.11, 2.11)

Input is the exact payload shape `collectLiveMediaIds` produces for an empty result: `{"ok":true,"ids":[],"exact":true}`, with no completeness evidence anywhere. Each case uses its own chat so each gets a fresh reconciliation pass rather than inheriting the previous chat's in-memory tombstones.

```
COUNTEREXAMPLE [test 5 empty-scan ambiguity]
{ "liveCalls": 4,
  "observed": [ { "chatId": "-1004474514785", "cached": 22,  "ownerCount": 0, "persisted": 22 },
                { "chatId": "-1004474514780", "cached": 64,  "ownerCount": 0, "persisted": 64 },
                { "chatId": "-1004474514781", "cached": 47,  "ownerCount": 0, "persisted": 47 },
                { "chatId": "-1004474514782", "cached": 100, "ownerCount": 0, "persisted": 100 } ] }

Error: chat -1004474514785 cached 22:  an unevidenced empty answer must not prune the index  Expected: 22   Received: 0
Error: chat -1004474514780 cached 64:  ...                                                  Expected: 64   Received: 0
Error: chat -1004474514781 cached 47:  ...                                                  Expected: 47   Received: 0
Error: chat -1004474514782 cached 100: ...                                                  Expected: 100  Received: 0
```

A second mechanism is visible in the same artefact: `ownerCount` drops to 0 while `persisted` stays at the cached value. The on-screen prune happens and the durable prune does not, which is test 1's defect confirming itself from the other side.

### Test 6, reconcile mark - reproduces the early return, with the precondition seeded (clauses 1.9, 2.9)

```
COUNTEREXAMPLE [test 6 reconcile mark]
{ "reconcileRequestsWithMark": 0, "reconcileRequestsWithoutMark": 1,
  "observed": { "mark": "{\"-1004474514785\":1786861499280}",
                "ownerCount": 22, "persisted": 22, "header": "22 files" } }

OBSERVATION [test 6]: marked chat made 0 reconcile requests, the unmarked control chat made 1.

Error: a chat marked in an earlier session must still be reconciled against Telegram  Expected: > 0  Received: 0
Error: deletions after the mark must still be removed from the index                  Expected: 0    Received: 22
Error: deletions after the mark must still be removed from the persisted record       Expected: 0    Received: 22
```

Stated plainly, as task 2 requires: **the mark was seeded, not observed being written.** `filegram-files-delete-reconcile-v1` is only written after a reconcile succeeds, and on this host `/api/filegram/live-media-ids` answers HTTP 500 for every chat, so the application can never write it here. Whether a real installation carries a naturally written mark remains **UNVERIFIED**. What the test does prove, from the control leg, is that the mark is the discriminator: with it, zero reconcile requests are made; without it, the same chat is reconciled.

### Test 7, Save-to render - confirms hypothesis 7 (clauses 1.18, 1.19, 2.19, 2.20)

Real stylesheets over real markup inside the real parent chain. The four competing width rules and their specificities reproduce Phase 0's table exactly:

```
COUNTEREXAMPLE [test 7 matched width rules for #set-dir, in cascade order]
[ { "sheet": "daily-driver-p0.css?v=2",                  "selector": ".downloads #set-dir",                "specificity": "1,1,0", "width": "100% !important" },
  { "sheet": "daily-driver-p1.css?v=1",                  "selector": "#mg-downloads-pane #set-dir",        "specificity": "2,0,0", "width": "54px !important", "minWidth": "54px" },
  { "sheet": "<injected fg-hardening-style>",            "selector": "#set-dir.fg-download-folder-picker", "specificity": "1,1,0", "width": "100% !important" },
  { "sheet": "<injected fg-download-folder-v2-style>",   "selector": "#set-dir.fg-folder-v2",              "specificity": "1,1,0", "width": "100% !important" } ]
```

At a 1600px viewport, identical to the Phase 0 measurement:

```
{ "viewport": 1600,
  "parentChain": ["span.row","label.conc","div.dl-controls","div#mg-downloads-pane.mg-drawer-pane",
                  "aside.downloads","div.app","div#main-screen.screen","body"],
  "computedWidth": "54px", "computedMinWidth": "54px", "computedPadding": "0px",
  "buttonWidth": 54, "parentWidth": 361,
  "clickTargets": 1, "visiblePathDisplays": 1,
  "spans": [ { "className": "fg-folder-icon",  "clientWidth": 22, "scrollWidth": 22, "clipped": false },
             { "className": "fg-folder-copy",  "text": "Save toF:\\New\\Tamil", "clientWidth": 20, "scrollWidth": 42, "clipped": true },
             { "className": "fg-folder-label", "text": "Save to",       "clientWidth": 20, "scrollWidth": 42, "clipped": true },
             { "className": "fg-folder-path",  "text": "F:\\New\\Tamil","clientWidth": 20, "scrollWidth": 72, "clipped": true } ] }

Error: viewport 1600px: the control must fill its parent (361px)  Expected: >= 359  Received: 54
Error: viewport 1600px: "Save to" must not be clipped inside the control        Received: true
Error: viewport 1600px: "F:\New\Tamil" must not be clipped inside the control   Received: true
```

The same 54px result holds across every generated viewport (parent 311/341/361/371px at 1280/1366/1600/1920) and every generated path length, so the defect is width, not text length.

Per the Phase 0 refinement, this test does **not** assert that hidden nodes occupy layout. `clickTargets: 1` and `visiblePathDisplays: 1` are asserted and **pass**, confirming that clause 1.20's "three overlapping controls in layout" is refuted as written: `#dl-dir` and `#dl-dir-current` are already `display: none` with zero-area rects. The real defect asserted here is that the control's width does not equal its parent's, and that the label and path are clipped.

### Test 8, Save-to binding - confirms hypothesis 8 (clauses 1.16, 2.16)

```
COUNTEREXAMPLE [test 8 Save-to binding]
{ "pickerRequests": [ { "pathname": "/api/filegram/pick-download-folder", "method": "POST" } ],
  "writes": [ { "kind": "innerHTML",   "owner": "uploads-hardening.js:424" },
              { "kind": "innerHTML",   "owner": "file-consistency-v2.js:209" },
              { "kind": "replaceWith", "owner": "file-consistency-v2.js:212" },
              { "kind": "innerHTML",   "owner": "uploads-hardening.js:424" },
              { "kind": "innerHTML",   "owner": "file-consistency-v2.js:209" },
              { "kind": "innerHTML",   "owner": "uploads-hardening.js:424" } ],
  "bindings": [ { "kind": "onclick",          "owner": "uploads-hardening.js:440" },
                { "kind": "addEventListener", "owner": "file-consistency-v2.js:214" } ],
  "writerFiles": ["uploads-hardening.js", "file-consistency-v2.js"],
  "replacedAfterBinding": true,
  "nodeClasses": "fg-folder-v2 fg-download-folder-picker",
  "nodeDataset": { "fgFolderPath": "F:\\Picked\\Folder", "fgFolderV2": "1" } }

Error: exactly one layer may paint #set-dir, saw ["uploads-hardening.js","file-consistency-v2.js"]  Expected: 1  Received: 0
Error: exactly one click binding may exist on #set-dir, saw [onclick uploads-hardening.js:440, addEventListener file-consistency-v2.js:214]  Expected: 1  Received: 2
Error: #set-dir must not be clone-replaced, which silently discards another layer's handler  Expected: false  Received: true
```

Two layers bind the node and two layers paint it; the `replaceWith` at `file-consistency-v2.js:212` is what discards hardening's `onclick`, leaving a node that carries both layers' classes and datasets with only v2's handler alive. `pickerRequests.length` is 1 and that assertion passes, which is the point: a single surviving handler is an accident of load order, not a design.

### Test 9, picker identity - confirms hypothesis 9's consequence (clauses 1.14, 1.17, 2.14)

Called for real against the running server. The native dialog was **not** left open: the test polls for the picker's own PowerShell child, matched on its unique dialog title and excluding the querying process, and terminates it.

```
COUNTEREXAMPLE [test 9 picker identity]
POST http://127.0.0.1:3000/api/filegram/pick-download-folder
HTTP 500
{"ok":false,"error":"Folder picker exited with code 4294967295"}
picker children terminated: 1

Error: the picker response must identify which dialog implementation ran  Received: undefined
Error: the picker must be an Explorer-style common item dialog            Received: ""
Error: an abnormally terminated dialog must not be reported as a raw exit code
```

Two findings, both matching Phase 0. There is **no `implementation` field** on unfixed code, so the running dialog cannot be identified from the response body and a stale process cannot be ruled out from it. And an abnormally terminated dialog is reported as HTTP 500 with a raw exit code rather than as a cancel, so the two are indistinguishable to the caller. A verified lingering-process check after the run returned `0`.

### Test 10, cache token - the durable half of hypothesis 6 (clauses 1.22, 2.22)

```
COUNTEREXAMPLE [test 10 cache token]
{ "probedAsset": "public/uploads-hardening.js",
  "tokenBeforeChange": "3",           "tokenAfterChange": "3",
  "contentHashBeforeChange": "22fa95637b56", "contentHashAfterChange": "fefade25a924",
  "browserExecutedNewBytesAfterReload": true,
  "referencedTokensNotDerivedFromContent": 37, "referencedTokensTotal": 37 }

Error: a content change must change the cache token that references the file  Expected: not "3"
Error: every referenced ?v= token must be derived from its file's content, 37 of 37 are not  Expected: 0  Received: 37
```

The probed file was restored byte-for-byte inside a `finally`, asserted, and confirmed clean in `git status`.

The runtime half is **recorded as an observation, not asserted as the defect**, because Phase 0 already refuted hypothesis 6 server-side: `express.static` sends `max-age=0`, so a reload revalidates and the browser did execute the new bytes (`browserExecutedNewBytesAfterReload: true`). Asserting otherwise would fail for the wrong reason. The durable hazard the test does assert is the token: changing 12 bytes of `public/uploads-hardening.js` left its referenced token at `v=3`, and none of the 37 referenced tokens is derived from the content it names. Whether the user's own browser profile executed a stale copy remains **UNVERIFIED** from this host, exactly as Phase 0 left it.

## Hypothesis verdicts reproduced by these tests

| # | hypothesis | task 2 verdict | test |
| --- | --- | --- | --- |
| 1 | client cache outranks Telegram truth | CONFIRMED, reproduced | 2 |
| 2 | persistence boundary discards shrinks | CONFIRMED, reproduced and generalised | 1, and visible again in 5 |
| 3 | restore unions stale sources | CONFIRMED, reproduced | 3 |
| 4 | reconciliation cannot tell failure from emptiness | CONFIRMED in the stronger form: the endpoint never answers at all | 4, 5 |
| 4b | permanent per-chat mark disables reconciliation | mechanism reproduced from a SEEDED mark; a naturally written mark is UNVERIFIED on this host | 6 |
| 5 | a stale server process serves the old dialog | still REFUTED; test 9 records the missing `implementation` field that would let it be ruled out from the response | 9 |
| 6 | a stale cached frontend serves an old handler | REFUTED at runtime on this host (`browserExecutedNewBytesAfterReload: true`); the token hazard is CONFIRMED, 37/37 tokens not content-derived | 10 |
| 7 | CSS specificity decides the control's width | CONFIRMED, reproduced with the same four rules and the same 54px | 7 |
| 8 | several JS layers paint the same node | CONFIRMED, reproduced with line-level attribution | 8 |
| 9 | the directory return is fabricated | mechanism unchanged from Phase 0; whether the returned path matches a human's selection is still UNVERIFIED, because no headless test can drive the native dialog | 9 |

## What could not be tested, and why

- **A naturally written `filegram-files-delete-reconcile-v1` mark.** It can only be written after a reconcile succeeds, which cannot happen while `/api/filegram/live-media-ids` answers HTTP 500 for every chat. The mark was seeded. UNVERIFIED.
- **Whether the picker returns the folder the human actually chose.** Requires a human at the dialog. The test terminates the dialog rather than selecting in it, which is why the response is HTTP 500 with an exit code. Decided by TEST C (task 12.3). UNVERIFIED.
- **Whether the dialog is the small legacy tree or a large Explorer shell.** No automated check can see a native dialog's chrome. Decided by TEST C. UNVERIFIED.
- **Whether the user's own browser executed stale script bytes.** Needs their profile. UNVERIFIED, unchanged from Phase 0.
- **`filegram-shell.js:688`, the third writer of `#set-dir`.** Phase 0 observed it in the live app. It is not loaded in the fixture, so test 8 records two writers rather than three. The assertion (`exactly one`) fails either way; the count is a floor, not a total.

---

# Task 3 Evidence - preservation baseline

Recorded on branch `feature/bulk-channel-uploads` at HEAD `90a56ce0`. **No fix was written in this task and no production file was touched.** The files changed are `tests/preservation.spec.js` (new), `tests/fixture-support.js` (new) and `package.json` (`check` wiring plus a `test:preservation` script). `public/app.js` and `server.js` still carry only the two Phase 0 instruments; `tests/file-consistency.spec.js` still carries only task 2's ten exploration tests and was deliberately left untouched, so those recorded failures stay reproducible byte-for-byte.

Working tree at the end of this task:

```
 M package.json                     <- check wiring for the two new test files
 M public/app.js                    <- Phase 0 instrument, unchanged by task 3
 M server.js                        <- Phase 0 instrument, unchanged by task 3
 M tests/file-consistency.spec.js   <- task 2, unchanged by task 3
?? .kiro/
?? tests/fixture-support.js         <- task 3
?? tests/preservation.spec.js       <- task 3
```

**All eleven preservation tests PASS on unfixed code**, which is the success condition for this task.

```
npx playwright test tests/preservation.spec.js --reporter=list --workers=1

ok  1  3.1 intact chat: counts and list contents are unchanged for a chat with no deletions (2.1s)
ok  2  3.2 partial-scan protection: a partial done:true result of M does not replace a discovered index of N (7.5s)
ok  3  3.3 streaming scan: done:false batches grow the index monotonically and the total is not complete until the final event (4.0s)
ok  4  3.4 restore without rescan: reopening a chat with a complete record issues no full scan (3.3s)
ok  5  3.5 upload and temporary-id retirement: the row appears once and the temporary id is replaced (5.8s)
ok  6  3.6 pagination: 100 rows per page with the existing range labels and Next/Previous behaviour (3.1s)
ok  7  3.7 separated counts: filtered, search, selection and queue counts never overwrite the authoritative total (1.4s)
ok  8  3.8 inaccessible chat: an empty result prunes nothing (6.7s)
ok  9  3.11 rest of the sidebar: stats card, Parallel files slider and queue action rows keep their geometry (1.1s)
ok 10  3.12 removal is not a blacklist: a truth pass that reports a removed id present again keeps it durable (2.0s)
ok 11  3.9 and 3.10 download queue wiring, the configured folder, and the live sidebar on the running app (12.0s)
11 passed (49.4s)
```

Test 11 observes the running application. Server used for it: `[FileGram server] pid=4872 started=2026-08-17T07:51:30.565Z buildId=90a56ce0 buildIdSource=git`, started in the background with `npm start` and stopped afterwards; `Get-NetTCPConnection -LocalPort 3000 -State Listen` returns nothing now.

## Method, and where the observation overruled the expectation

Every value in the `CAPTURED` table at the top of `tests/preservation.spec.js` was read off a run of the unfixed build and then written down. Four first-pass expectations disagreed with the observation. In every case the observation won and got recorded; they are called out below as **OBSERVATION OVERRULED**, because each one is a place where a reviewer might otherwise read the pinned value as a mistake.

Fixture infrastructure is task 2's, extracted into `tests/fixture-support.js` so the preservation set could reuse it without editing task 2's file: real layers loaded by URL out of a served real `public/` tree with their real `?v=` tokens, the real `daily-driver-p0-v2.js` boundary against real IndexedDB behind `assertRealBoundary`, the real 15 `index.html` stylesheets over markup sliced out of `public/index.html`, inside the real `#mg-downloads-pane` chain that `management.js` builds. Generators are seeded (`rng(seed)`), so every counterexample is reproducible from its seed. `expect.soft` is used throughout so one run surfaces every mismatch.

`tests/fixture-support.js` is a test helper, not a runtime layer: playwright's default `testMatch` does not collect it, and it introduces no `public/` or preload code. Both new files are registered in `package.json`'s `check` (`node --check tests/fixture-support.js && node --check tests/preservation.spec.js`).

## 3.1 Intact chat - counts and list contents

Generated index sizes `[0, 1, 99, 100, 101, 265, 198, 140, 116, 84]` (boundary values pinned, the rest from seed `0x3a1001`), one chat each, seeded into the real persistent record and restored through the real `ensure()` -> `restore()`.

For every size N the following all read N and agree with each other: committed index, persisted record, `rescueFileCache`, `#chat-media-count`, `Download all media (N)`, `state.mediaCount`, the sum of `state.typeCounts`, `teleFilesIndex.total`, `teleFilesIndex.count`.

```
N=0    committed 0    persisted 0    header "0 files"    downloadAll "Download all media (0)"   disabled true
N=1    committed 1    persisted 1    header "1 file"     downloadAll "Download all media (1)"   disabled false
N=99   committed 99   persisted 99   header "99 files"   downloadAll "Download all media (99)"  disabled false
N=100  committed 100  persisted 100  header "100 files"
N=101  committed 101  persisted 101  header "101 files"
N=265  committed 265  persisted 265  header "265 files"
```

List contents are checked by value, not only by count. The index is newest-first (`messageId` descending, asserted for every case), so the three names from the bug report - the oldest three rows - appear at the tail:

```
lastNames = ["photo_391118848.jpg", "photo_393216000.jpg", "photo_400556032.jpg"]
```

**OBSERVATION OVERRULED (1): a chat whose record holds ZERO rows does issue one full scan.** The first pass asserted "an intact restored chat issues no full scan" for every size. Observed per chat:

```
N=0    scansForChat 1   typesForChat ["scan-media-v3","get-messages"]
N>0    scansForChat 0   typesForChat ["cancel-media-scan-v3","get-messages"]
```

`ensure()` short-circuits on `stable && stable.items.length`, so an empty record has nothing to restore and falls through to the scan. Both branches are pinned separately.

## 3.2 Partial-scan protection

Generated shrink pairs from seed `0x3a2002`, with the concrete `(22, 0)` case from the bug report pinned first: `(22,0) (197,30) (3,1) (129,12)`. Two independent routes per pair.

Route A, discovery by streaming `media-index-progress` then a partial batch stamped `done: true`:

```
N=22  M=0    discovered 22   committed 22   persisted null   done false   header "22 files"
N=197 M=30   discovered 197  committed 197  persisted 197    done true    header "197 files"
N=3   M=1    discovered 3    committed 3    persisted 3      done true    header "3 files"
N=129 M=12   discovered 129  committed 129  persisted 129    done true    header "129 files"
```

Route B, a `scan-media-v3` result smaller than the restored record, delivered through `ensure(chatId, { hardRefresh: true })`:

```
N=22  M=0    committed 22   persisted 22   done true   header "22 files"
N=197 M=30   committed 197  persisted 197  done true   header "197 files"
N=3   M=1    committed 3    persisted 3    done true   header "3 files"
N=129 M=12   committed 129  persisted 129  done true   header "129 files"
```

The larger index survives on both routes, which is the baseline this clause needs. Phase 0 confirmed the persistence boundary is what discards the shrink today; after the fix the enforcement point moves to `commitDiscovery` / `commitAuthoritative`, and these same numbers must still come out.

**OBSERVATION OVERRULED (2): an M = 0 final batch commits nothing at all.** The first pass asserted `persisted = N` and `done = true` for every pair. For `M = 0` the observed record is `null` and `done` stays `false`. Mechanism: the empty final payload reaches `flushProgress` with an already-drained candidate, so `flushProgress` returns before `commitUnion`; the earlier timed flush ran with `persist: false`, so no record was ever written. The index still stays at N, so the protection holds. Both branches are pinned separately.

## 3.3 Streaming scan

Generated batch sizes from seed `0x3a3003`, all below the owner's `PROGRESS_FLUSH_ITEMS` (800) so every batch goes through the real 350 ms timed flush: `[49, 33, 122, 115, 25, 37]`, then a final batch of 3 stamped `done: true`.

```
batch 1  size 49   cumulative 49   count 49   done false  "Indexed" lines 0
batch 2  size 33   cumulative 82   count 82   done false  "Indexed" lines 0
batch 3  size 122  cumulative 204  count 204  done false  "Indexed" lines 0
batch 4  size 115  cumulative 319  count 319  done false  "Indexed" lines 0
batch 5  size 25   cumulative 344  count 344  done false  "Indexed" lines 0
batch 6  size 37   cumulative 381  count 381  done false  "Indexed" lines 0
final    size 3    cumulative 384  count 384  done TRUE   "Indexed" lines ["Indexed 384 files"]
```

The index grows monotonically and holds exactly the cumulative flushed set at every step; `snapshot.done` is `false` for the whole stream and only becomes `true` on the event carrying `done: true`; exactly one `Indexed N files` load-state line is emitted, on that final event, and it reports the streamed total.

## 3.4 Restore without rescan

Generated sizes `[1, 99, 100, 101, 29, 309]` (seed `0x3a4004`, zero filtered out because 3.1 pins that branch). Each chat opened, then reopened.

```
first open   restored N   types ["cancel-media-scan-v3","get-messages"]
reopen       restored N   types ["cancel-media-scan-v3","get-messages"]
scansForChat 0 across both opens
```

No `scan-media-v3` for the chat on either open. The owner cancels any legacy full scan and probes only the newest delta through `get-messages`.

## 3.5 Upload and temporary-id retirement

Real `uploads-hardening.js` over the real owner, generated existing-index sizes `[1, 99, 100, 101, 265, 198]` (seed `0x3a5005`). The fixture's base `handleEvent` writes an upserted media message into `rescueFileCache`, which is what the legacy realtime layers do in the live app (Phase 0 recorded six such writes on one chat open); it stands in for the transport, not for any boundary under test.

Optimistic row, an outgoing media message still carrying temporary id `-9001`:

```
baseEventsAdded []      <- uploads-hardening.js returns before the base chain
committed       N       <- unchanged
temporaryRows   0       <- no temporary row enters the index
```

Telegram confirms the send, the same file arrives with its real id:

```
baseEventsAdded ["message-upsert"]
committed       N + 1
temporaryRows   0
duplicates      0
holdsRealId     true
namedRows       1        <- the uploaded file is listed exactly once
```

Observed for every size: `1 -> 2`, `99 -> 100`, `100 -> 101`, `101 -> 102`, `265 -> 266`, `198 -> 199`.

## 3.6 Pagination

Real `public/files-view.js` mounted on the real Files markup. `window.fileGramFilesPages.pageSize` is `100`. Generated totals `[0, 1, 99, 100, 101, 29, 309]` (seed `0x3a6006`), chosen to sit on both sides of every page boundary.

```
total   pages  page1 rows  page1 summary                  "/ N"  first/prev  next/last  Select all
0       1      0           "0–0 of 0 files"               "/ 1"  disabled    disabled   "Select all" (disabled)
1       1      1           "1–1 of 1 files"               "/ 1"  disabled    disabled   "Select all (1)"
99      1      99          "1–99 of 99 files"             "/ 1"  disabled    disabled   "Select all (99)"
100     1      100         "1–100 of 100 files"           "/ 1"  disabled    disabled   "Select all (100)"
101     2      100         "1–100 of 101 files"           "/ 2"  disabled    enabled    "Select all (101)"
29      1      29          "1–29 of 29 files"             "/ 1"  disabled    disabled   "Select all (29)"
309     4      100         "1–100 of 309 files"           "/ 4"  disabled    enabled    "Select all (309)"
```

Page-size label is `100 / page` on every page. Next/Previous, observed:

```
total 101  Next -> page 2: 1 row,   "101–101 of 101 files", firstIndex 100, prev enabled, next disabled
           Prev -> page 1: 100 rows, "1–100 of 101 files"
total 309  Next -> page 2: 100 rows, "101–200 of 309 files", firstIndex 100, next enabled
           Prev -> page 1: 100 rows, "1–100 of 309 files"
```

Only the current page is mounted (`rows` never exceeds 100), and global indexes are preserved across pages.

## 3.7 Separated counts

One chat, 250 rows, real owner plus real pager. Generated set type mix: `{ photo: 187, document: 63 }`.

```
                 header      state.mediaCount  ownerTotal  pager summary                        Select all      selection  #download-stats
unfiltered       "250 files" 250               250         "1–100 of 250 files"                 "Select all (250)"  0      ""
type filter      "250 files" 250               250         "1–63 of 63 matching · 250 total"    "Select all (63)"   0      ""
search query     "250 files" 250               250         "1–100 of 110 matching · 250 total"  "Select all (110)"  0      ""
selection (7)    "250 files" 250               250         "1–100 of 250 files"                 "Select all (250)"  7      ""
download queue   "250 files" 250               250         "1–100 of 250 files"                 "Select all (250)"  7      "3 active · 12 queued · 41 done"
```

The authoritative total (`#chat-media-count`, `state.mediaCount`, `teleFilesIndex.total`) reads `250` in all five states. The filtered, search and queue figures live on their own nodes and carry the total alongside their own count rather than replacing it.

## 3.8 Inaccessible chat

Generated sizes `[1, 99, 100, 101, 140, 116]` (seed `0x3a8008`). Two legs per size, both delivered through `ensure(chatId, { hardRefresh: true })`.

Empty `done: true` result:

```
committed N   persisted N   header "N files"   done true   (for every size)
```

Scan throws (`chat is not accessible`):

```
committed N   persisted N   header "N files"
loadStates ["Loaded N indexed files", "Loaded N indexed files", "Loaded N indexed files"]
```

Nothing is pruned on either leg. Note for task 4.1/4.2: the load-state line still reads `Loaded N indexed files` after a thrown scan; the failure is not surfaced there today. That is a task 2 finding (test 4), not a preservation requirement, and it is recorded here only so the difference is not read later as a regression.

## 3.11 Rest of the sidebar

Measured in the layout fixture (real 15 stylesheets, real `<aside class="downloads">` markup, real `management.js` parent chain) at height 900 across four viewports. This is the cascade the Phase 4 stylesheet deletions will disturb, so the numbers are pinned.

```
viewport  paneWidth  parallel row  slider w  queue button w
1280      339        311           275       152
1366      369        341           305       167
1600      389        361           325       177
1920      399        371           335       182
```

Constant across viewports: pane height 857, slider `{ h 16, top 176 }`, slider readout `{ w 24, h 12, top 178 }`, queue button height 38, download list `{ w = paneWidth, h 575 }`, `#set-dir` width **54** (the same value Phase 0 and task 2 measured in the live app and in task 2's fixture).

**OBSERVATION OVERRULED (3): the four queue actions are a 2x2 grid, not one row.** The first pass asserted one shared row. Observed `top` values for `#pause-all, #resume-all, #cancel-all, #clear-done` at every viewport:

```
[227, 227, 273, 273]
```

**OBSERVATION OVERRULED (4): the panel header, its stats line, the Hide button and the Zip-selected row occupy no layout.** The first pass asserted the stats card was laid out and filled the pane. Observed:

```
.downloads-head   display none   rect 0x0    <- daily-driver-hotfix.css, daily-driver-p1.css, filegram-ui.css all say display:none !important
#download-stats   display block  rect 0x0    <- zero-area because its parent is display:none
#toggle-drawer    display none   rect 0x0    <- telegram-daily-driver.css, filegram-ui.css
#scan-banner      display none   rect 0x0    <- .hidden until a scan runs
#pack-media       display none   rect 0x0    <- daily-driver-p1.css `#mg-downloads-pane .dl-controls > .row:has(#pack-media)`
#cancel-pack      display none   rect 0x0    <- .hidden until packing runs
```

The panel header was deliberately replaced by `management.js`'s drawer tabs, so the visible stats card in the live app is a different node - `#tele-ui-download-summary`, created at run time by `daily-driver-final-ui-fix.js` `ensureDownloadSummary` and enhanced by `filegram-shell.js` `installStatsCard`. The layout fixture loads no JS layers, so it cannot see it; it is measured in the live test instead (below).

Behaviour as well as geometry: the Parallel files slider keeps `min 1 / max 64 / step 1`, markup default `16`, and its readout follows it (`33` after an input event).

## 3.9 / 3.10 Download queue and the configured folder, LIVE

Observed against the running application at `http://127.0.0.1:3000`, viewport 1600x900, build id `90a56ce0`, server pid 4872. **No native folder dialog was opened**: `/api/filegram/pick-download-folder` was routed to `{"ok":true,"cancelled":true}`, so nothing was spawned and nothing could be left open.

Configured folder on startup (3.10):

```
#dl-dir.value           "F:\New\Tamil"
#dl-dir-current text     "F:\New\Tamil"
#set-dir title           "F:\New\Tamil"
#set-dir dataset path    "F:\New\Tamil"
get-status downloadsDir  "F:\New\Tamil"
get-status               { buildId "90a56ce0", buildIdSource "git", serverPid 4872, ready true, concurrency 8 }
```

**OBSERVATION OVERRULED (partly, and worth recording): `#dl-dir-current` reads the bare path, not app.js's `Saving to: <path>`.** `setDirLabel` in `public/app.js` writes `Saving to: F:\New\Tamil`, but `teleP0v2RefreshPath` in `public/daily-driver-p0-v2.js` strips that prefix on a 1500 ms interval, so app.js's version never survives to be observed. The baseline pins the bare path.

Queue action wiring (3.9). Each button was clicked on the real, idle queue and every ws request it produced was recorded:

```
#pause-all   -> ["pause-all",  "get-downloads"]
#resume-all  -> ["resume-all", "get-downloads"]
#clear-done  -> ["clear-done", "get-downloads"]
#cancel-all  -> []            (queueStats.remaining = 0, so app.js returns before requesting anything)
```

The `get-downloads` follow-up is `applyQueueAction` in `public/daily-driver-final-ui-fix.js`, which clone-replaces all four buttons and re-syncs from the authoritative server snapshot after every action. That layer, not `app.js`, owns these buttons at run time. Labels and geometry:

```
#pause-all   "Pause all"    177x38  top 338
#resume-all  "Resume all"   177x38  top 338
#cancel-all  "Cancel all"   177x38  top 384
#clear-done  "Clear done"   177x38  top 384
#pack-media  "Zip selected (dedupe)"  display none
```

Cancelled dialog (3.10), routed cancel:

```
pickerCalls                          1
before  #dl-dir "F:\New\Tamil"  title "F:\New\Tamil"  text "📁Save toF:\New\Tamil"
after   #dl-dir "F:\New\Tamil"  title "F:\New\Tamil"  text "📁Save toF:\New\Tamil"
set-download-dir requests issued     0
```

The surviving handler is `file-consistency-v2.js:213` (task 2, test 8). On a `cancelled` response with no `path` it returns before calling `set-download-dir`, so the configured folder is untouched.

3.11 live cross-check, the stats card the fixture cannot see:

```
#tele-ui-download-summary   361x111  display grid  visible
tiles, in order             ["speed", "fg-done", "current", "remaining", "total"]
                            0 B/s, 0, 0, 0, 0        (idle queue)
#fg-stats-total             "Total0 files"
#concurrency                325x16   value "8"   readout "8"
#mg-downloads-pane width    389                  <- matches the fixture measurement at 1600px
#set-dir width              54                   <- matches Phase 0 and task 2
#download-stats             ""                   <- idle, and a different node from the stats card
```

The tile order is `speed, fg-done, current, remaining, total`, not the `speed, current, ...` a reader of `ensureDownloadSummary` alone would expect: `filegram-shell.js` `installStatsCard` inserts its Downloaded tile directly after the Speed tile.

## 3.12 Removal is not a blacklist

Real `uploads-hardening.js` over the real owner, one chat of 12 rows, two generated removal orders (seeds `0x3a9009`, `0x3a900a`), each removal followed by a truth pass that reports every id present again.

```
removed ["1000000","1000007","1000003"]
  countAfterRemoval   9     recordAfterRemoval  12
  countAfterTruth     9     recordAfterTruth    12
  readdedInSession    []    readdedInDurable    ["1000000","1000007","1000003"]

removed ["1000001","1000005","1000009"]
  countAfterRemoval   6     recordAfterRemoval  12
  countAfterTruth     6     recordAfterTruth    12
  readdedInSession    []    readdedInDurable    ["1000001","1000005","1000009"]

reload leg: durable 12, restorable ["1000000","1000007","1000003","1000001","1000005","1000009"]
```

**This clause was split, and here is why.** The prompt's wording - "a removal followed by a truth pass reporting the id present again must return the item" - does **not** hold in-session on unfixed code, so asserting it would not be a preservation test. Observed mechanism: a removal is in-memory only. `uploads-hardening.js` records the ids in `deletedByChat` and `installIndexApiHardening` filters them out of `teleFilesIndex.snapshot` for the rest of the session, so a later truth pass reporting them present does not bring them back (`readdedInSession` is empty both times). The durable record is never pruned at all (`recordAfterRemoval` stays 12), which is bug 1's other half.

What the test therefore asserts is the same property at the **durable** level, which is where the design moves the mechanism (`removedIds` / `reconciledAt` inside the persistent record) and where the property holds both before and after the fix: a truth pass that reports a previously removed id present again leaves that id in the durable record, so the next session restores it. That passes on unfixed code and must keep passing after the fix.

The in-session half - `readdedInSession` must equal the removed ids - is a **fix-side property and belongs to the task 2 / task 11.1 set, not to task 3**. It is not asserted here, and it is logged as an `OBSERVATION [3.12]` line in the run output so nobody reads its absence as an oversight. Nothing was moved into `tests/file-consistency.spec.js`, because task 2's ten tests already cover the durable-prune and tombstone mechanisms (tests 1, 3, 5, 6); this is the same defect seen from the re-add side and is captured in the log rather than duplicated as an eleventh exploration test.

## 3.13 `npm run verify` - verbatim baseline

Captured before any task 3 change:

```
npm notice run filegram@1.0.0 verify
npm notice run npm run check && npm test
npm notice run filegram@1.0.0 check
npm notice run node --check scripts/download-queue.test.cjs && ... && node --check tests/file-consistency.spec.js
npm notice run filegram@1.0.0 test
npm notice run node scripts/rescue-smoke.test.cjs && ... && node scripts/bulk-upload-ledger.test.cjs
rescue smoke checks passed
P0 smoke checks passed
P1 smoke checks passed
P2 smoke checks passed
final smoke checks passed
download queue checks passed
dedupe checks passed
files invariants checks passed
upload queue checks passed
upload restore scale checks passed
upload retry-after checks passed
bulk upload server checks passed
bulk upload ledger checks passed
```

Exit code 0. Re-run after registering the two new test files in `check`: byte-identical apart from the `node --check` list, which now ends `... && node --check tests/file-consistency.spec.js && node --check tests/fixture-support.js && node --check tests/preservation.spec.js`. Exit code 0.

## 3.12 Existing suites, run UNCHANGED, verbatim

`tests/bulk-uploads.spec.js` - not modified in this task:

```
npx playwright test tests/bulk-uploads.spec.js --reporter=list --workers=1

Running 8 tests using 1 worker
  ok 1 upload drawer keeps three tabs, full stats card, no caption, and ignores temporary outgoing media ids (258ms)
  ok 2 owned TEST channel is selectable and duplicate review explains evidence (428ms)
  ok 3 Pause all and Resume all apply to every queued file (5.6s)
  ok 4 Cancel all cancels the whole queue, not just parallel workers (452ms)
  ok 5 Clear done and Clear all keep full-queue and persistent semantics (1.1s)
  ok 6 server interruption auto-retries without losing the file (3.2s)
  ok 7 large queues render exactly 100 jobs per page (406ms)
  -  8 live TEST channel uploads three files and removes the evidence messages
  1 skipped
  7 passed (12.1s)
```

Run twice (server down, then server up) with identical results. Test 8 is skipped by its own guard, `test.skip(process.env.FILEGRAM_UPLOAD_LIVE !== '1')`; it is the only leg that sends real files to the real TEST channel, and it was **not** exercised - see the UNVERIFIED list.

Ledger and server unit tests, run individually and unchanged:

```
node scripts/bulk-upload-ledger.test.cjs   -> bulk upload ledger checks passed
node scripts/bulk-upload-server.test.cjs   -> bulk upload server checks passed
node scripts/files-invariants.test.cjs     -> files invariants checks passed
node scripts/download-queue.test.cjs       -> download queue checks passed
node scripts/dedupe.test.cjs               -> dedupe checks passed
```

Exit code 0.

## Fully exercised versus sampled

Fully exercised, over generated inputs:

- **3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8** - real owner (`files-stability.js`), real pager (`files-view.js`), real persistence boundary (`daily-driver-p0-v2.js`) against real IndexedDB, real transport hardening (`uploads-hardening.js`), over generated index sizes, shrink pairs, streaming batch sizes, page boundaries and event orders.
- **3.11 (CSS layer)** - the real cascade of all 15 stylesheets over the real markup in the real parent chain, at four viewports.
- **3.13** - `npm run verify` before and after, exit code 0 both times.

Sampled, not exhaustive:

- **3.9** - the queue **wiring** was exercised for real against the running server (`pause-all`, `resume-all`, `clear-done` each clicked, every resulting ws request recorded; `cancel-all` observed hitting its own no-remaining guard). The queue was **idle**, so pause/resume/cancel of an actually-running download was not exercised. Server-side queue semantics are covered by `scripts/download-queue.test.cjs`, which passes, and client-side by `tests/bulk-uploads.spec.js` tests 3-5, which pass. **No file was actually downloaded**, so "the configured download folder is honoured by the download pipeline" is verified only as far as the server reporting `downloadsDir: F:\New\Tamil` and the UI displaying it.
- **3.11 (live layer)** - the live stats card, slider and queue rows were measured once at 1600x900 on an idle queue. Non-idle stats-card content and other viewports were not measured live.
- **3.12** - bulk uploads were exercised through the seven fixture tests plus the ledger and server unit tests. The live upload leg was skipped.

## UNVERIFIED, with reasons

- **A real download run.** Nothing was downloaded, so clause 3.9's "the configured download folder SHALL CONTINUE TO be honoured by the download pipeline" is unproven end to end. It would need real media in a reachable chat and a real write to `F:\New\Tamil`. The design already flags 3.9 as likely only sampled.
- **A real bulk upload run.** `tests/bulk-uploads.spec.js` test 8 requires `FILEGRAM_UPLOAD_LIVE=1` and sends three real files to the real TEST channel, then deletes them. It was not run, so clause 3.12's live half is unproven. The design already flags 3.12 as likely only sampled.
- **Pause / resume / cancel of an in-flight download.** The live queue was idle. Only the wiring and the server-side unit coverage were observed.
- **The native folder dialog on the cancel leg.** Deliberately routed rather than driven, as instructed, so what is proven is that the handler leaves the configured folder alone on a `cancelled` response - not that a human pressing Cancel in the real dialog produces that response. That belongs to TEST C (task 12.3), exactly as task 2 left it.
- **The 22 stale "TEST" rows as a live precondition.** Not needed by any preservation clause and not re-seeded here. Chat `TEST` (`-1004474514785`) is still `found: 0` on the server.
- **Non-Chromium browsers and other DPI/zoom settings.** All geometry numbers are Chromium at devicePixelRatio 1. A different engine or zoom would legitimately produce different pixels; task 11.2 must re-run on the same configuration for the comparison to mean anything.

---

# Task 4 Evidence - one Telegram truth source in `server.js`

Recorded on branch `feature/bulk-channel-uploads`, nothing committed and nothing merged. The code for 4.1, 4.2 and 4.3 was written earlier in the task; everything below is the **live verification** of that code against the real local Telegram session, asked over the same ws protocol the browser uses. No behaviour is claimed from reading code.

Files changed by task 4: `server.js` (`job.historyComplete`, `historyComplete` carried into the snapshot / `cloneMediaIndexSnapshot` / the `media-index-progress` payload, `historyComplete` cleared on a non-permanent `deleteMediaIndexMessages`, `mediaTruthV1` plus the `case 'media-truth-v1':` handler) and `bulk-upload-preload.js` (`live-media-ids`, `reconcile-message-ids` and their helpers removed). No new runtime layer was created, and no client file was touched: `public/files-stability.js` is task 5, so nothing consumes `media-truth-v1` yet.

The probe used for every ws call in this section was a temporary file, `.tmp-truth-probe.cjs`, deleted at the end of the task; `git status` is clean of it.

## Server under test

```
FileGram running at http://127.0.0.1:3000
[FileGram server] pid=30376 started=2026-08-17T17:24:44.330Z buildId=90a56ce0 buildIdSource=git
  root=C:\Users\REBEL DUKER\Downloads\tele cwd=C:\Users\REBEL DUKER\Downloads\tele

STATUS {"status":"ready","ready":true,"concurrency":8,"downloadsDir":"F:\\New\\Tamil",
        "authState":"authorizationStateReady","me":{"id":7449312886,"name":"✨️","photoFileId":null},
        "buildId":"90a56ce0","buildIdSource":"git","serverPid":30376,
        "serverStartedAt":"2026-08-17T17:24:44.330Z"}
```

Started in the background with `npm start`, stopped at the end of the task. `authorizationStateReady`, so no leg below is excused by an unready client.

## `media-truth-v1`, chat TEST `-1004474514785` - empty and provably complete

Three consecutive calls, verbatim. The middle step is a `scan-media-v3`, for the reason given under "the cache path" below.

```
REQUEST media-truth-v1 payload={"chatId":-1004474514785}  (4 ms)
RESPONSE {"type":"response","id":2,"ok":true,"data":{"ok":true,"ids":[],"count":0,"complete":true,"accessible":true,"scanned":1,"source":"walk"},"error":null}

REQUEST media-truth-v1 payload={"chatId":-1004474514785}  (1 ms)
RESPONSE {"type":"response","id":2,"ok":true,"data":{"ok":true,"ids":[],"count":0,"complete":true,"accessible":true,"scanned":1,"source":"walk"},"error":null}

SCAN-MEDIA-V3 {"ok":true,"found":0,"scanned":1,"done":true,"cancelled":false,"historyComplete":true,"itemCount":0}

REQUEST media-truth-v1 payload={"chatId":-1004474514785}  (0 ms)
RESPONSE {"type":"response","id":2,"ok":true,"data":{"ok":true,"ids":[],"count":0,"complete":true,"accessible":true,"scanned":1,"source":"cache"},"error":null}
```

`count: 0`, `accessible: true`, `complete: true`, as required. This is the answer the previous truth source could never give: it reported `exact: ids.length < 5000`, which is equally true for a scan that failed and returned nothing, and on this host it never answered at all (HTTP 500, see the 404 section). Here the `complete: true` comes from the empty-page exit, and the chat is separately proven reachable by the `getChat` probe (`accessible: true`).

## `media-truth-v1`, a chat that genuinely holds media

Channel Spy🕵️ `-1004473919064`, 502 media messages. Walk first, then the same answer from cache after a completed scan:

```
REQUEST media-truth-v1 payload={"chatId":-1004473919064}  (87 ms)
RESPONSE (ids abbreviated) {"ok":true,"ids":["529530880","528482304","527433728","526385152",
  "525336576","524288000","523239424","522190848","521142272","520093696","519045120","517996544",
  "+490 more"],"count":502,"complete":true,"accessible":true,"scanned":503,"source":"walk"}

SCAN-MEDIA-V3 {"ok":true,"found":502,"scanned":503,"done":true,"cancelled":false,"historyComplete":true,"itemCount":502}

REQUEST media-truth-v1 payload={"chatId":-1004473919064}  (1 ms)
RESPONSE (ids abbreviated) {"ok":true,"ids":["529530880","528482304","527433728","526385152",
  "525336576","524288000","523239424","522190848","521142272","520093696","519045120","517996544",
  "+490 more"],"count":502,"complete":true,"accessible":true,"scanned":503,"source":"cache"}
```

Non-zero count with `complete: true`, and the cached answer is identical to the walked one (502 = 502, same head of the id list, same `scanned: 503`).

A second media chat, private `8582136345`, for a small non-channel case:

```
REQUEST media-truth-v1 payload={"chatId":8582136345}  (7 ms)
RESPONSE {"type":"response","id":2,"ok":true,"data":{"ok":true,"ids":["49797922816","49781145600"],
  "count":2,"complete":true,"accessible":true,"scanned":11,"source":"walk"},"error":null}
```

Note `scanned: 11` against `count: 2`: `scanned` counts history messages walked, `count` counts the media among them. The two are deliberately different numbers, and completeness is derived from neither.

## A truncated snapshot is not served as complete truth - the load-bearing leg for 4.1

Channel Tamil `-1003765505510`, 22508 history messages, 22501 of them media. A `scan-media-v3` was cancelled mid-walk, then truth was asked for the same chat:

```
CANCEL {"cancelled":true}
SCAN AFTER CANCEL {"found":1648,"scanned":1649,"done":false,"cancelled":true,"historyComplete":false,"items":1648}
PROGRESS EVENTS first/last {"count":34,
  "first":{"scanned":0,"found":0,"done":false,"cancelled":false,"historyComplete":false},
  "last":{"scanned":1649,"found":1648,"done":true,"cancelled":true,"historyComplete":false}}

TRUTH AFTER CANCELLED SCAN {"ok":true,"count":22501,"complete":true,"accessible":true,"scanned":22508,"source":"walk"}
```

The cached snapshot held 1648 of 22501 files and claimed neither `done` nor `historyComplete`; `media-truth-v1` refused it (`source: "walk"`) and re-walked to the real end of history. Under the old signal this is exactly the case that could not be told apart from a chat that had lost 20853 files.

The same chat, walked and then cached, with timings:

```
REQUEST media-truth-v1 payload={"chatId":-1003765505510}  (628 ms)
RESPONSE (ids abbreviated) {"ok":true,"ids":["23692574720","23691526144","23690477568","23689428992",
  "23688380416","23687331840","23686283264","23685234688","23684186112","23683137536","23682088960",
  "23681040384","+22489 more"],"count":22501,"complete":true,"accessible":true,"scanned":22508,"source":"walk"}

SCAN-MEDIA-V3 {"ok":true,"found":22501,"scanned":22508,"done":true,"cancelled":false,"historyComplete":true,"itemCount":22501}

REQUEST media-truth-v1 payload={"chatId":-1003765505510}  (5 ms)
RESPONSE (ids abbreviated) {"ok":true,"ids":["23692574720","23691526144","23690477568","23689428992",
  "23688380416","23687331840","23686283264","23685234688","23684186112","23683137536","23682088960",
  "23681040384","+22489 more"],"count":22501,"complete":true,"accessible":true,"scanned":22508,"source":"cache"}
```

628 ms walked against 5 ms cached on a 22.5k-message channel, with identical counts, which is the cost argument for reusing a complete snapshot rather than re-walking on every reconciliation pass. (Both numbers are with TDLib's local history already warm on this host; a cold walk over the network would be slower.)

Streaming completeness, from the progress events of a scan that ran to the end (Spy🕵️, 13 events):

```
PROGRESS EVENTS first/last {"count":13,
  "first":{"scanned":0,"found":0,"done":false,"cancelled":false,"historyComplete":false},
  "last":{"scanned":503,"found":502,"done":true,"cancelled":false,"historyComplete":true}}
```

`historyComplete` is false on every streaming event and true only on the final one - clause 3.3, an in-progress total is still not a completed one. The cancelled Tamil scan above shows the other half: `done: true` with `cancelled: true` and `historyComplete: false`, so `done` alone remains insufficient and is no longer the completeness signal any reader uses.

## An inaccessible chat - clause 3.8

```
REQUEST media-truth-v1 payload={"chatId":-1001234567890}  (1 ms)
RESPONSE {"type":"response","id":2,"ok":true,"data":{"ok":true,"ids":[],"count":0,"complete":false,
  "accessible":false,"scanned":0,"source":"probe","error":"Chat not found"},"error":null}

REQUEST media-truth-v1 payload={"chatId":-1009999999999}  (1 ms)
RESPONSE {"type":"response","id":2,"ok":true,"data":{"ok":true,"ids":[],"count":0,"complete":false,
  "accessible":false,"scanned":0,"source":"probe","error":"Chat not found"},"error":null}
```

`accessible: false` with `complete: false`, never an empty-but-complete answer, so a caller gated on `complete` cannot prune from this. `source: 'probe'` marks that the `getChat` probe rejected before any history was walked.

**UNVERIFIED:** a chat that is *known to this session but left*, and a chat that is accessible but whose history is restricted. Neither exists in this session's 49-chat list, and producing one would mean leaving a real chat, which mutates the user's account. What is proven is the shape of the answer for a chat the session cannot reach; the left-chat path shares the same `getChat` gate but was not observed.

Also **UNVERIFIED:** the `ok: false` walk-threw branch of `mediaTruthV1` (`complete: false`, empty `ids`, `error` set). No walk threw during this session, and forcing one would mean provoking a TDLib error rather than observing one.

## The competing truth sources are gone at runtime - 4.3

Both endpoints on the live process, verbatim:

```
> curl.exe -s -i "http://127.0.0.1:3000/api/filegram/live-media-ids/-1004474514785"
HTTP/1.1 404 Not Found
X-Powered-By: Express
Content-Security-Policy: default-src 'none'
X-Content-Type-Options: nosniff
Content-Type: text/html; charset=utf-8
Content-Length: 181
<pre>Cannot GET /api/filegram/live-media-ids/-1004474514785</pre>

> curl.exe -s -i -X POST -H "Content-Type: application/json" -d '{"messageIds":["1"]}' \
    "http://127.0.0.1:3000/api/filegram/reconcile-message-ids/-1004474514785"
HTTP/1.1 404 Not Found
X-Powered-By: Express
Content-Security-Policy: default-src 'none'
X-Content-Type-Options: nosniff
Content-Type: text/html; charset=utf-8
Content-Length: 189
<pre>Cannot POST /api/filegram/reconcile-message-ids/-1004474514785</pre>
```

Both were live before this task: Phase 0 recorded `GET /api/filegram/live-media-ids/-1004474514785` answering `HTTP 500 {"ok":false,"error":"Failed to parse JSON object as TDLib request: Unknown class \"messageFilterDocument\""}` for every chat, and `POST /api/filegram/reconcile-message-ids/:chatId` answering `HTTP 200`.

Positive control, so the 404s cannot be a dead-process artefact - the same preload's surviving route still answers on the same process:

```
> curl.exe -s -i "http://127.0.0.1:3000/api/bulk-upload-health"
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
{"ok":true,"telegramReady":true,"active":0}
```

`bulk-upload-preload.js` is still wrapping express and still serving bulk upload, the ledger, temp-id retirement and health (clause 3.12); only the two truth routes and their helpers are gone.

## The cache path, and one nuance worth recording

`source: 'cache'` requires a `mediaIndexCache` snapshot with `historyComplete && !cancelled`. `mediaTruthV1` deliberately writes nothing to that cache - it collects ids only - so **two back-to-back `media-truth-v1` calls both report `source: 'walk'`**, as the TEST-chat transcript above shows (4 ms then 1 ms, both `walk`). The cache is populated by `scan-media-v3`, which is what the owner's `ensure()` path runs, and the very next truth call then reports `cache` (TEST 0/0, Spy 502/502, Tamil 22501/22501, all `complete: true`). That is by design, not a defect, but it means "call it twice" is not by itself a cache-path exercise; the sequence that exercises it is walk, scan, truth.

The other guard on that path was left as it is in the code and is worth restating because it is what makes cache reuse safe: `deleteMediaIndexMessages` clears `historyComplete` on a non-permanent delete, so a TDLib local-cache eviction that shreds a snapshot cannot leave it claiming to be complete truth. Not separately reproduced in this session - no eviction occurred during the run - so treat that specific leg as **UNVERIFIED at runtime**; the cancelled-scan leg above proves the same refusal for the other way a snapshot can be incomplete.

## Separate pre-existing defect: `server.js`'s own `MESSAGE_FILTERS` uses the class names TDLib rejects

**Not part of the three reported bugs, not fixed, recorded for a scope decision.** This is the same class-name mistake Phase 0 found in `bulk-upload-preload.js`'s deleted `LIVE_MEDIA_FILTERS`, in a second place that task 4 does not touch: `MESSAGE_FILTERS` in `server.js`, used by `searchMedia` for the Files-tab type filter.

```js
// server.js
const MESSAGE_FILTERS = {
  all: null,
  document: 'messageFilterDocument',
  photo: 'messageFilterPhoto',
  video: 'messageFilterVideo',
  audio: 'messageFilterAudio',
  voice: 'messageFilterVoiceNote',
  gif: 'messageFilterAnimation',
  video_note: 'messageFilterVideoNote'
}
// searchMedia: filter: MESSAGE_FILTERS[filter] ? { _: MESSAGE_FILTERS[filter] } : undefined
```

Evidence, `search-media` over ws against a chat that genuinely holds documents. Chat Collection `-1004379445973`; its first 100 messages are 98 documents and 1 photo, `totalCount 951`:

```
typemix -1004379445973 ok=true totalCount=951 {"photo":1,"document":98}

search-media filter=all         ok=true items=19 totalCount=951
search-media filter=document    ok=false error="Failed to parse JSON object as TDLib request: Unknown class \"messageFilterDocument\""
search-media filter=photo       ok=false error="Failed to parse JSON object as TDLib request: Unknown class \"messageFilterPhoto\""
search-media filter=video       ok=false error="Failed to parse JSON object as TDLib request: Unknown class \"messageFilterVideo\""
search-media filter=audio       ok=false error="Failed to parse JSON object as TDLib request: Unknown class \"messageFilterAudio\""
search-media filter=voice       ok=false error="Failed to parse JSON object as TDLib request: Unknown class \"messageFilterVoiceNote\""
search-media filter=gif         ok=false error="Failed to parse JSON object as TDLib request: Unknown class \"messageFilterAnimation\""
search-media filter=video_note  ok=false error="Failed to parse JSON object as TDLib request: Unknown class \"messageFilterVideoNote\""
```

Reproduced identically against the media channel Spy🕵️ `-1004473919064` (`filter=all ok=true items=20 totalCount=503`, every other filter the same parse error), so the failure is at request-parse time and is chat-independent: **all seven non-`all` filters are dead, for every chat, always.** TDLib expects the `searchMessagesFilter*` family, which is the correction Phase 0 already identified for the deleted helper.

User-visible blast radius, traced rather than assumed:

- The Files-tab type dropdown filters the already-loaded index **client-side** (`state.files.filter !== 'all'` list filters in `app.js`, `files-stability.js`, `files-view.js` and four daily-driver layers), so choosing a type in the ordinary Files view still works and does not reach the server.
- Whole-chat search is the broken path. `#file-filter`'s change handler in `public/app.js` calls `searchWholeChat()` when `state.files.mode === 'search'`, which reaches `loadSearchMore()` -> `request('search-media', { ..., filter: state.files.filter })`. The request fails, and `loadSearchMore`'s `catch` does `toast(e.message, 'error')`, so the user gets the raw TDLib string `Failed to parse JSON object as TDLib request: Unknown class "messageFilterDocument"` and no results.

The one-line fix is obvious and is deliberately **not** applied: it is outside the three reported bugs, and the scope call is the user's. Left as filed.

## Test results

`npm run check`, single run, exit code 0. The full `node --check` list ran, including `server.js`, `bulk-upload-preload.js`, `tests/fixture-support.js` and `tests/preservation.spec.js`:

```
CHECK EXIT=0
```

`npm test`, single run, exit code 0:

```
rescue smoke checks passed
P0 smoke checks passed
P1 smoke checks passed
P2 smoke checks passed
final smoke checks passed
download queue checks passed
dedupe checks passed
files invariants checks passed
upload queue checks passed
upload restore scale checks passed
upload retry-after checks passed
bulk upload server checks passed
bulk upload ledger checks passed
TEST EXIT=0
```

`npx playwright test tests/preservation.spec.js --reporter=list --workers=1`, single run, never watch mode. All eleven preservation tests still pass against the task 4 code, on the same Chromium configuration as the task 3 baseline:

```
Running 11 tests using 1 worker
  ok  1 3.1 intact chat: counts and list contents are unchanged for a chat with no deletions (2.1s)
  ok  2 3.2 partial-scan protection: a partial done:true result of M does not replace a discovered index of N (7.5s)
  ok  3 3.3 streaming scan: done:false batches grow the index monotonically and the total is not complete until the final event (4.0s)
  ok  4 3.4 restore without rescan: reopening a chat with a complete record issues no full scan (3.3s)
  ok  5 3.5 upload and temporary-id retirement: the row appears once and the temporary id is replaced (5.7s)
  ok  6 3.6 pagination: 100 rows per page with the existing range labels and Next/Previous behaviour (3.1s)
  ok  7 3.7 separated counts: filtered, search, selection and queue counts never overwrite the authoritative total (1.3s)
  ok  8 3.8 inaccessible chat: an empty result prunes nothing (6.7s)
  ok  9 3.11 rest of the sidebar: stats card, Parallel files slider and queue action rows keep their geometry (1.1s)
  ok 10 3.12 removal is not a blacklist: a truth pass that reports a removed id present again keeps it durable (2.0s)
  ok 11 3.9 and 3.10 download queue wiring, the configured folder, and the live sidebar on the running app (12.0s)
  11 passed (49.4s)
PW EXIT=0
```

The two clauses task 4 puts at risk are the two the tests pin directly: **3.3** (test 3 - the index grows across `done: false` batches and the total is not complete until the final event, which is the client-side counterpart of the `historyComplete` progress artefact above) and **3.8** (test 8 - an empty result for an inaccessible chat prunes nothing, which `media-truth-v1` now backs with an explicit `accessible: false`). Test 11 observed the running app on `buildId=90a56ce0`, `serverPid=30376`, `downloadsDir F:\New\Tamil`, and its folder-dialog leg used a routed cancel, so no native dialog was spawned.

## Summary of what task 4 proved, and what it did not

Proven at runtime, against the real local Telegram session:

- TEST `-1004474514785` answers `count: 0, accessible: true, complete: true`.
- A 502-file channel and a 22501-file channel both answer non-zero with `complete: true`, and the cached answer equals the walked answer in each case.
- A truncated (cancelled) snapshot of 1648/22501 is refused as truth and re-walked; `historyComplete` is false on every streaming event and true only on an empty-page finish.
- An unreachable chat answers `accessible: false, complete: false`, never empty-but-complete.
- `live-media-ids` and `reconcile-message-ids` are 404, with the same preload's health route still 200 as the control.
- `npm run check`, `npm test` and the 11 preservation tests all pass.

Not proven, and left standing as such:

- A known-but-left chat, and an accessible chat with restricted history (no such chat in this session; producing one would mutate the account).
- The thrown-walk branch of `mediaTruthV1`.
- The TDLib-eviction leg of the `historyComplete` clearing in `deleteMediaIndexMessages` (no eviction occurred in the run window).
- Anything downstream of the truth source: no client consumes `media-truth-v1` yet, so nothing here says the Files index converges. That is task 5, and TEST A / TEST B in task 12 remain the deciding observations.

---

# Task 5 and 6 Evidence - one Files index owner, and the three test contradictions

Recorded on branch `feature/bulk-channel-uploads`, nothing committed and nothing merged. Task 5.1 and task 6.1 are in the same change, as the plan requires. No new runtime layer was created: the only new file is `scripts/files-reconcile.test.cjs`, a test helper. The folder picker and the Save-to markup/CSS were not touched (tasks 7 and 8), and no legacy layer was stripped (task 9).

Server used for every live observation:

```
FileGram running at http://127.0.0.1:3000
[FileGram server] pid=25184 started=2026-08-17T19:06:28.706Z buildId=90a56ce0 buildIdSource=git
  root=C:\Users\REBEL DUKER\Downloads\tele cwd=C:\Users\REBEL DUKER\Downloads\tele
```

Started in the background with `npm start`, stopped at the end of the task; `Get-NetTCPConnection -LocalPort 3000 -State Listen` returns nothing now. The two temporary probe files (`tests/tmp-owner-live.spec.js`, `tests/tmp-guard-check.spec.js`) were deleted; `git status --short` is explainable in full below.

## What changed, per file

| File | Change |
| --- | --- |
| `public/files-stability.js` | The owner. `openDb` / `readPersistent` / `writePersistent` (unconditional); `commitDiscovery` (additive) and `commitAuthoritative` (the only subtractive path) as the only two callers of the boundary; a private `ledgers` map as the merge base with a published copy for everyone else; durable `reconciledAt` / `truthCount` / `removedIds` in the record; removal-aware `normalize` and `union`; the floor subordinated to truth (`setTotalFloor`, `maybeRepairIndex` gated on `floor.at > reconciledAt`); `reconcile(chatId, options)` over `media-truth-v1` with per-chat in-flight dedupe, a 60 s throttle, a deferred trigger and 2s/4s/8s→5min backoff; the `[Files reconcile]` diagnostic; `message-delete` handled in the owner and gated on `isPermanent`; `mergeRealtimeUpsert` replacing `syncFromSharedAfterRealtime`; a one-time migration that deletes the stored `filegram-files-delete-reconcile-v1`; `reconcile` and `retireTemporary` added to `window.teleFilesIndex`; an `openChat` wrapper that schedules a pass once per throttle window |
| `public/uploads-hardening.js` | Deleted `HIGH_WATER_KEY`, `exactHighWater` and its two call sites; deleted `RECONCILE_MARK_KEY`, `readReconcileMarks`, `markReconciled` and the mark gate in `reconcilePersistedIndex`. `reconciledThisSession` (per session, not durable) stays. Transport, retry classification, `Retry-After` handling and queue hardening untouched |
| `public/daily-driver-final-guard.js` | Deleted `GUARD_HIGH_WATER_KEY`, `guardHighWater`, `guardRememberHighWater`, `guardHighWaterCount` and their four call sites. `guardStableMediaScan` and the `request = teleGuardRequest` interception are LEFT IN PLACE - they are task 9.2 - and its floor is now only the persisted snapshot it can read directly |
| `scripts/files-invariants.test.cjs` | Task 6.1. The two assertions that required `options.allowShrink` and `if (storedCount > snapshot.items.length) return` are replaced by assertions that the owner's boundary is unconditional and that the protection sits at `commitDiscovery` / `commitAuthoritative`. Count-label ownership, pager and drag-selection invariants are byte-identical |
| `scripts/final-smoke.test.cjs` | One assertion inverted: the guard must NOT contain `tele-file-index-high-water-v1` any more, and must not read or write a floor of its own. A third suite that pinned the defect, called out below |
| `scripts/files-reconcile.test.cjs` | New. Source invariants plus property-based behaviour tests that execute the REAL owner in a Node context |
| `tests/fixture-support.js` | Task 6.3. `assertRealBoundary` extended to cover the owner's `writePersistent`; new shared `assertRealStylesheets` |
| `tests/preservation.spec.js` | 3.11 now calls the shared `assertRealStylesheets(page)` instead of its own inline stylesheet count. No assertion changed |
| `tests/visual-check.spec.js` | Task 6.2. The Save-to tests rewritten against the single control; the stats-card alignment test re-pointed from `#dl-dir` to `#set-dir` |
| `package.json` | `scripts/files-reconcile.test.cjs` registered in `check` (as `node --check`) and in `test` |

Files carried in from earlier tasks and unchanged here: `server.js` and `bulk-upload-preload.js` (task 4), `public/app.js` (the Phase 0 `[FileGram runtime]` instrument), `tests/file-consistency.spec.js` (task 2's ten tests, deliberately untouched so their recorded failures stay reproducible byte-for-byte).

## The verbatim `[Files reconcile]` line for chat TEST

Captured from the running application in Chromium, chat `TEST` (`-1004474514785`), with the 22 stale rows seeded into the throwaway profile exactly as Phase 0 and task 2 seeded them (they live in the user's own browser storage and cannot be inherited). Everything after the seed ran unmodified:

```
[Files reconcile] chatId=-1004474514785 cached=22 live=0 missing=[1000021,1000020,1000019,1000018,1000017,1000016,1000015,1000014,1000013,1000012,1000011,1000010,1000009,1000008,1000007,1000006,1000005,1000004,1000003,1000002,+2 more] remaining=0 persisted=written(reason=reconcile,items=0) truth=cache complete=true accessible=true [1000021, 1000020, 1000019, 1000018, 1000017, 1000016, 1000015, 1000014, 1000013, 1000012, 1000011, 1000010, 1000009, 1000008, 1000007, 1000006, 1000005, 1000004, 1000003, 1000002, 1000001, 1000000]
```

All six required fields are present (`chatId`, `cached`, `live`, `missing`, `remaining`, `persisted`) plus `truth=`, `complete=` and `accessible=`. The missing list is printed in full to 20 ids and then summarised (`+2 more`), and the full 22-id array is the second console argument, which is the bracketed list at the end of the line. Exactly one line per pass; the migration line uses a different prefix (`[Files index]`) on purpose so a grep for the diagnostic cannot pick it up.

The state the owner reached on that pass, same run:

```
AFTER OPEN      {"header":"22 files","selectAll":"Select all (22)","ownerCount":22,"persisted":22,"rows":0}
AFTER RECONCILE { "ownerCount": 0, "shared": 22, "persisted": 22, "rows": 0,
                  "pagerSummary": "0–0 of 0 files", "floor": "{}", "header": "22 files" }
AFTER REFRESH   { "ownerCount": 0, "persisted": 22, "floor": "{}", "mark": null, "rows": 0 }
```

Read that carefully, because it is half a success:

- **The owner converged and the write happened.** `ownerCount` 0, `rows` 0, the pager reads `0–0 of 0 files`, the durable floor was deleted (`{}`), the diagnostic reports `persisted=written(reason=reconcile,items=0)`, and the permanent reconcile mark that had been seeded was removed by the startup migration (`mark: null` after the refresh).
- **The user-visible header did not converge, and the record was re-inflated.** `header` stayed `22 files` and the record read 22 again seconds later.

## Why the record went back to 22, named exactly

The `teleP0v2WriteIndex` boundary was instrumented in the same run. Two writes of 22 items arrived after the owner had written 0:

```
LEGACY RECORD WRITES
[ { "key": "-1004474514785", "incoming": 22, "allowShrink": false,
    "stack": [ "teleFinalApplySnapshot (daily-driver-final.js:70)", ... ] },
  { "key": "-1004474514785", "incoming": 22, "allowShrink": false,
    "stack": [ "teleFinalApplySnapshot (daily-driver-final.js:70)", ... ] } ]
```

The chain, end to end:

```
teleFinalEnsureFiles (daily-driver-final.js:199)
  -> request('scan-media-v3')  ->  guardStableMediaScan (daily-driver-final-guard.js)
       server answers 0; the guard's floor is the persisted snapshot's 22, so it
       returns guardSnapshotAsResponse(known) - the stale 22, protectedByClientCache
  -> teleFinalApplySnapshot (daily-driver-final.js:207 -> :60)
       :64  rescueFileCache.set(key, stale 22)
       :66  state.mediaCount = 22
       :70  teleP0v2WriteIndex(chatId, stale 22)   <- record back to 22 (0 -> 22 grows, so the monotonic guard allows it)
       :74  teleFinalUpdateMediaCountLabel()       <- header back to "22 files"
```

Both ends of that chain are task 9's work and are named in the plan: task 9.2 removes `guardStableMediaScan` and the `request = teleGuardRequest` interception, and removes `teleFinalApplySnapshot` / `teleFinalRestorePersistent` / the persist call from `daily-driver-final.js`. Until then the owner re-prunes on the next open (observed: the refresh leg pruned again and logged its own line), but the stale count stays on screen. **TEST A therefore does not pass yet, and this task does not claim it does.** That is exactly the ordering the plan chose - the owner must be in place and observed working before the layers are stripped - and it is now observed working.

One consequence worth recording for task 9: when `teleFinalApplySnapshot` rewrites the record it writes the legacy record shape, so `reconciledAt`, `truthCount` and `removedIds` are dropped from the stored row (`"removedIds": null` in the probe output). The in-memory removal metadata survives for the session, so convergence still happens on the next pass, but the DURABLE half of clause 2.13 is only as durable as the last legacy write until task 9.3.

## 5.4, and the `rescueFileCache` writer observation

Task 1.6's instrumentation was re-run against the fixed build, on one open of chat TEST. Four writes for that chat (a fifth had no attributable frame):

```
SHARED CACHE WRITERS { "total": 5, "byFile": { "daily-driver-final.js": 2, "files-stability.js": 2, "unknown": 1 } }

count=22 done=true  <- teleFinalApplySnapshot (daily-driver-final.js:64) <- teleFinalOpenChat (daily-driver-final.js:722) <- teleGuardOpenChat (daily-driver-final-guard.js:457) <- fileGramStableOpenChat (files-stability.js)
count=22 done=true  <- setSharedSnapshot (files-stability.js:388) <- publish (files-stability.js:405) <- restore (files-stability.js:717) <- reconcile (files-stability.js:1063)
count=0  done=true  <- setSharedSnapshot (files-stability.js:388) <- publish (files-stability.js:405) <- commitAuthoritative (files-stability.js:681)
count=22 done=true  <- teleFinalApplySnapshot (daily-driver-final.js:64) <- daily-driver-final.js:207
```

Compare with Phase 0, which recorded six writes from three files (`daily-driver-final.js` x4, `daily-driver-p2.js`, `files-stability.js`). Two of the three are gone from this path already: `daily-driver-p2.js` no longer appears, and `daily-driver-final.js` dropped from four sites to two. But the owner is **not** the only writer, so 5.4's closing clause - "record, at run time, that the owner is the only writer" - is **not satisfied**, and 5.4 is left unticked. Its code half is complete: every path clause 2.7 enumerates now runs the removal filter (`normalize` on commit for the in-memory entry, `union` for `rescueFileCache` and for the IndexedDB record inside `restore`, `commitDiscovery` for scan-result merging, `mergeRealtimeUpsert` for `message-upsert` with the delete-side read-back removed, `ensure` -> `restore` for startup), and the two property tests below exercise it. The remaining writers are `daily-driver-final.js`, which task 9.2 strips.

## Where the protection moved, and how that is now asserted

`writePersistent` has no count comparison, no `allowShrink` and no read-before-write. The protection that guard was standing in for lives at the two commit functions, and `scripts/files-reconcile.test.cjs` asserts that at the source level:

- the owner owns `tele-daily-driver-cache-v1` / `file-indexes`;
- the boundary body contains no `allowShrink`, no `storedCount`, no `readPersistent`, no `items.length <` / `>` comparison;
- exactly two functions call it, and they are `commitDiscovery` and `commitAuthoritative`; no other file in `public/` or in the preload set calls it at all;
- `commitDiscovery` unions rather than replaces;
- `appendRemovedIds` has exactly one call site and its enclosing function is `commitAuthoritative`;
- `union` and `normalize` both run `removalBlocks`, which consults `removedIds` and `reconciledAt`;
- the legacy mark key appears exactly once in the owner, inside `migrateLegacyReconcileMark`, and in no other `public/` file (the two files task 9.1 deletes are tolerated and the invariant tightens by itself when they go);
- exactly one implementation owns the durable floor, and it is the owner's;
- at most one file replaces the global `request`, and if any does it is `daily-driver-final-guard.js` - which is how "no layer may substitute a client cache for Telegram truth" is pinned before AND after task 9.2 removes it;
- the shared-cache writer set may only shrink: a NEW writer fails the suite;
- the `[Files reconcile]` template carries all six fields plus `truth=`, `complete=`, `accessible=`, and attaches the full missing array as a second console argument;
- one truth call per pass, pruning gated on `truth.complete && truth.accessible !== false`, backoff starting at 2000 ms and capped at 5 min, throttle 60 s;
- the owner never intercepts the transport and never emits `protectedByClientCache`;
- `handleRealtimeDelete` returns early unless the delete is permanent and not a cache eviction.

## Property-based behaviour tests, against the real owner

`scripts/files-reconcile.test.cjs` loads the REAL `public/files-stability.js` into a Node context (`vm.createContext`) carrying the globals it resolves at load time, backed by an in-memory IndexedDB with the same API surface the owner uses, a `localStorage` map and a scripted ws transport. Nothing under test is stubbed - `writePersistent`, `union`, `restore`, `commitDiscovery`, `commitAuthoritative` and `reconcile` are the shipped implementations; only the environment is provided, exactly as the Playwright fixtures provide it in the browser. Generators are seeded, so any counterexample is reproducible.

```
node scripts/files-reconcile.test.cjs
files reconcile checks passed
```

What it proves:

- **Shrink durability.** For generated `(stored, live)` pairs including the concrete `(22, 0)` and `(1, 0)`: the committed index, the persisted record and the header all equal the truth count, the record carries `truthCount` and a non-zero `reconciledAt`, the floor is written down to the reconciled count and deleted outright at zero, and a second pass over the same truth is a no-op. Pairs exercised: `(22,0) (1,0) (172,101) (243,55) (66,26) (215,196)`.
- **Incomplete truth is inert.** Six failure modes - the request throwing, `ok: false` from a thrown walk, `complete: false`, `accessible: false`, a payload with ids but `complete: false`, and no payload at all - each leave the index and the record byte-identical (the record's `savedAt` is asserted unchanged, so it is not even rewritten), record no removal, log exactly one line carrying `live=unknown` and `persisted=skipped(reason=...)`, and surface the state in the load-state line.
- **Union never resurrects.** After a truth pass empties the index, a legacy layer writing the pre-prune record back, the shared cache still holding the pre-prune snapshot, and a scan result stamped before the removal all fail to bring the pruned rows back.
- **Removal is not a blacklist.** After three ids are pruned, a later truth pass that reports them present again restores them to the index and to the record, and clears them from `removedIds`.
- **Order independence.** Four interleavings of restore and truth passes converge on the same committed and persisted counts. The one combination that deliberately does NOT commute - a permanent delete followed by a genuinely fresh discovery of the same id - is pinned separately as "newest evidence wins": a source stamped before the removal cannot resurrect the row, a freshly fetched one can. That is the discriminator that keeps `removedIds` from becoming a blacklist.
- **Permanent deletes only.** A `message-delete` carrying `isPermanent: false, fromCache: true` prunes nothing; a permanent one prunes the index and the record immediately and records the removal durably. This gating is not decoration: `server.js` already documents that TDLib evicts messages from its own local cache with `is_permanent: false, from_cache: true` routinely after a full walk - measured on this host at 22,489 ids about ten seconds after a complete scan of a 22,485-file channel - so pruning on those would delete a whole channel's index for files that still exist on Telegram.
- **A partial index is never stamped complete.** When truth reports 1000 files and the index holds 300, nothing is missing so nothing is pruned, the snapshot and the record stay `done: false`, and the floor follows Telegram's 1000 rather than the 300 discovered so far. A pass against a chat whose progress batch has not been flushed is skipped with `reason: scan-in-flight`, makes no server call and logs no line.
- **Throttle and backoff.** One pass makes exactly one truth call; a second pass inside the freshness window is skipped with `reason: throttled`, calls nothing and logs nothing (a throttled pass is not a pass); the first backoff retry does not fire within 1.5 s.

Two defects were found by writing these tests and fixed before finishing, both recorded because a reviewer should see them:

1. **Reconciling mid-scan.** The first implementation would run a pass while a scan was still streaming, stamp the partial set `done: true` and write the floor down to the partial count. Fixed by refusing a pass while a scan or an unflushed progress batch is in flight, by re-checking the ledger identity after the truth call (anything that committed during the await makes the computed missing set stale, so the pass reports `skipped(reason=index-changed-during-truth-pass)` and reschedules), and by deriving `done` from whether the result actually matches the truth count.
2. **The ledger.** See below - it was caught by the preservation suite, not by inspection.

## The preservation regression this task caused, and the fix

The first version of the owner broke preservation test 3.12 (`removal is not a blacklist`): the durable record ended at 9 rows where the baseline is 12.

Mechanism, and it is worth stating plainly because it is a general hazard of making a boundary unconditional: `uploads-hardening.js` `pruneDeletedIndex` edits the snapshot `teleFilesIndex.snapshot()` hands it **in place** (`snapshot.items = clean`), and that snapshot was the owner's committed object. The old monotonic guard absorbed that - a foreign in-place shrink could never reach storage. With the boundary writing what the owner decided, the next owner-side commit unioned from the mutated object and wrote 9 durably.

Fix: the owner keeps a private `ledgers` map as the merge base for every commit and publishes a copy (its own `items` array) for everyone else. A legacy layer editing the exposed copy still changes what is on screen for that session, exactly as today, but can no longer become the base of a commit or of a durable write. Every internal read that decides state - `restore`, `commitDiscovery`, `commitAuthoritative`, `mergeProgress`, `reconcile`, `handleRealtimeDelete`, `retireTemporary`, the persist callback - reads the ledger; every reader-facing surface (`snapshot`, `count`, `total`, `filesItems`, the count label) still reads the published copy, so no observable behaviour moved. After that change all eleven preservation tests pass again.

## Test results

`npm run check`, single run, exit code 0. The `node --check` list now includes `scripts/files-reconcile.test.cjs`.

```
CHECK EXIT=0
```

`npm test`, single run, exit code 0:

```
rescue smoke checks passed
P0 smoke checks passed
P1 smoke checks passed
P2 smoke checks passed
final smoke checks passed
download queue checks passed
dedupe checks passed
files invariants checks passed
files reconcile checks passed
upload queue checks passed
upload restore scale checks passed
upload retry-after checks passed
bulk upload server checks passed
bulk upload ledger checks passed
TEST EXIT=0
```

`npx playwright test tests/preservation.spec.js --reporter=list --workers=1`, single run, never watch mode. All eleven pass, on the same Chromium configuration as the task 3 baseline (viewport height 900, DPR 1):

```
ok  1 3.1 intact chat: counts and list contents are unchanged for a chat with no deletions (2.1s)
ok  2 3.2 partial-scan protection: a partial done:true result of M does not replace a discovered index of N (7.5s)
ok  3 3.3 streaming scan: done:false batches grow the index monotonically and the total is not complete until the final event (4.0s)
ok  4 3.4 restore without rescan: reopening a chat with a complete record issues no full scan (3.2s)
ok  5 3.5 upload and temporary-id retirement: the row appears once and the temporary id is replaced (5.8s)
ok  6 3.6 pagination: 100 rows per page with the existing range labels and Next/Previous behaviour (3.2s)
ok  7 3.7 separated counts: filtered, search, selection and queue counts never overwrite the authoritative total (1.3s)
ok  8 3.8 inaccessible chat: an empty result prunes nothing (6.7s)
ok  9 3.11 rest of the sidebar: stats card, Parallel files slider and queue action rows keep their geometry (1.0s)
ok 10 3.12 removal is not a blacklist: a truth pass that reports a removed id present again keeps it durable (2.0s)
ok 11 3.9 and 3.10 download queue wiring, the configured folder, and the live sidebar on the running app (12.0s)
11 passed (49.4s)
```

The clauses this task put most at risk are the ones the suite pins hardest, and they came out unchanged: 3.2's pairs `(22,0) (197,30) (3,1) (129,12)` still keep committed = N and persisted = N on both routes (including the `M = 0` branch that writes no record at all); 3.3 still produces `49, 82, 204, 319, 344, 381, 384` with `done:false` throughout and exactly one `Indexed 384 files`; 3.4 still restores with `["cancel-media-scan-v3","get-messages"]` and 0 scans, and a zero-row record still issues its 1 scan; 3.6 still reads `100 / page`, `1–100 of 309 files`, `/ 4`; 3.7 still holds the authoritative total at 250 under filter, search, selection and queue figures. `files-view.js` was not touched.

One design decision protects those numbers and is worth stating rather than leaving to be discovered: a truth pass is **deferred** by 1200 ms after a restore or a chat open, and only runs while that chat is still the active one. The reason is the cost - a complete walk measured 628 ms server-side on the 22,501-file channel - so it has no business on the chat-open critical path, and a chat the user has already switched away from is not worth a walk. The side effect is that the request sets 3.1 and 3.4 pin (`["cancel-media-scan-v3","get-messages"]`) stay intact inside their observation windows.

`npx playwright test tests/file-consistency.spec.js --reporter=list --workers=1`, single run. **All ten still fail.** That is expected at this point in the plan, and here is exactly why, test by test - the useful part is which are now blocked only by later tasks:

| # | test | still fails because |
| --- | --- | --- |
| 1 | persistence boundary | it calls `window.teleP0v2WriteIndex` DIRECTLY, with only `daily-driver-p0-v2.js` loaded. That legacy boundary is still monotonic and is removed in task 9.2. The owner's boundary is unconditional and is proven instead by `scripts/files-reconcile.test.cjs` (`(22,0)` -> record 0) and by the live pass above. Observed: `stored 22 -> truth 0: recordAfter 22`, and the same for `(165,8) (192,123) (346,206) (395,393) (232,139)` |
| 2 | truth override | `guardStableMediaScan` still intercepts `scan-media-v3` (task 9.2). Observed: `callerReceived.items = 22`, `protectedByClientCache: true`, header `22 files`. Its floor is now the persisted snapshot only, since the guard's duplicate high-water store is gone |
| 3 | restore union | its precondition is hand-made - a pruned in-memory snapshot beside an untouched record, with no removal ever recorded - so `removedIds` is empty and the union legitimately restores the record. Under the fixed owner that state cannot arise, because a prune writes the record and the removals in the same commit. Making this test pass needs the fixture to record a removal, which is a test change outside task 5/6 |
| 4 | unknown truth | it asserts `GET /api/filegram/live-media-ids/:chatId` answers 200. Task 4.3 DELETED that endpoint, so it is 404 - the test is written against a truth source that no longer exists. Its retry-cadence assertion also still fails, because `file-consistency-v2.js` and its ~497 ms loop are still loaded (task 9.1). The owner's own backoff is proven in `scripts/files-reconcile.test.cjs` |
| 5 | empty-scan ambiguity | `file-consistency-v2.js` still prunes in-session on an unevidenced empty answer (task 9.1 deletes the file). Observed: `ownerCount` 0 against cached 22 / 64 / 47 / 100 |
| 6 | reconcile mark | **two of its three assertions now pass.** `reconcileRequestsWithMark` is no longer 0 and the in-session count reaches 0, because the permanent mark is gone and migrated away. The one that still fails is the persisted record, which is re-inflated by the legacy layers described above |
| 7 | Save-to render | the 54px control. Task 8 |
| 8 | Save-to binding | two painters and two bindings (`uploads-hardening.js:416` onclick, `file-consistency-v2.js:214` listener, plus the clone-replace). Tasks 8.3 and 9.1 |
| 9 | picker identity | no `implementation` field on the response. Task 7.1 |
| 10 | cache token | 37 of 37 referenced `?v=` tokens are not content-derived. Task 10 |

So: 1 is blocked by 9.2, 2 by 9.2, 4 by its own premise plus 9.1, 5 by 9.1, 6 partly cleared and otherwise blocked by 9.2/9.3, 7/8 by task 8, 9 by task 7, 10 by task 10. Test 3 needs a fixture change in task 11.1. Task 11.1's expectation that all ten pass is reachable, but it depends on tasks 7 to 10 and on re-pointing tests 1 and 3 at the owner's boundary once the legacy one is deleted - a reviewer should not read "all ten still fail" here as no progress.

`npx playwright test tests/visual-check.spec.js --reporter=list --workers=1`, the live suite, with the server running. **41 passed, 4 failed**, and the four failures are the Save-to tests this task deliberately rewrote for a control that does not exist until task 8:

```
x 20 stats card aligns with the download controls and is spaced from them
x 27 Save to is exactly one control, with no legacy path nodes in the DOM
x 28 Save to fills the sidebar width and ellipsises only on genuine overflow
x 29 exactly one stylesheet rule decides the Save-to width
41 passed (4.3m)
```

Two tests failed on the FIRST full run and passed on a warm re-run and in isolation with a longer timeout: `every total agrees with the committed index` and `a settled index stops reporting that it is still indexing`, both at 30.1 s, which is the default per-test timeout. They wait up to 60 s for the first chat's index to report itself complete, and on a cold server the first chat is a large channel whose history is still being walked. With `--timeout=120000` they finish in 7.4 s each and pass; on the second full run they passed inside the default timeout. Recorded as timing-sensitive rather than as a regression, and worth pinning down in task 11.5 rather than leaving as folklore.

## Task 6.2 - which option was chosen, and why

The plan offered two: write the new assertions now and let them fail until task 8, or stage the rewrite and run it afterwards. **Chosen: written now, failing now, and said so plainly** - in the spec file above, in a header comment on the tests themselves, and here.

The reason is clause 1.23. The contradiction it names is that two suites assert mutually exclusive Save-to layouts and neither describes the intended UI. Staging the rewrite would leave both suites still describing a UI that is being deleted, which is the same defect one commit later. Writing the assertions now gives task 8 an executable target and leaves nothing green that describes the old control. What replaced the old tests:

- `Save to and Parallel files share a left edge` - rewritten from "both `.conc` label spans share a left edge" (the `SAVE TO` heading disappears in task 8) to "the single control and the Parallel files row share a left edge, and exactly one Save-to control exists in `.dl-controls`". This one PASSES today, because the current 54px button already shares that edge.
- `Save to is exactly one control, with no legacy path nodes in the DOM` - replaces `Save to path is one line with a full-path tooltip and a matching Browse button`. Asserts `button#set-dir.fg-save-to`, `#dl-dir` and `#dl-dir-current` ABSENT (not hidden), exactly one click target, exactly one visible path display, no nested button, and the icon/label/path/chevron parts.
- `Save to fills the sidebar width and ellipsises only on genuine overflow` - four viewports, `display: flex`, `text-align: left`, width within 2px of the parent, height at least 40px, `text-overflow: ellipsis` on the path, and a path that fits shown in full with the full path in `title`.
- `exactly one stylesheet rule decides the Save-to width` - enumerates every rule in the live cascade matching `set-dir` / `dl-dir` / `dir-current`, requires exactly one width declaration and that it addresses `#set-dir.fg-save-to`, requires no rule to target a removed node, and requires neither `#fg-hardening-style` nor `#fg-download-folder-v2-style` to exist.
- `stats card aligns with the download controls` - not a Save-to test, but it read `#dl-dir` for the left edge. Re-pointed at `#set-dir`, which is what the destination control will be. It fails today only because the current control is 54px wide and indented relative to the card.

`tests/file-consistency.spec.js` was left alone. Its tests 7 and 8 still describe the old control; they are task 2 artefacts whose recorded failures must stay reproducible, and the plan moves layout out of that file as part of task 8/11.1 rather than here.

## Task 6.3 - the fixture guard, and proof that it bites

`assertRealBoundary` now covers both boundaries: the legacy `teleP0v2WriteIndex` when it is present (task 9.2 removes it, and the check is skipped rather than broken when it goes), and the owner's `writePersistent`. The owner's boundary lives inside a closure and cannot be read as a global, so it is verified two ways a stub cannot fake: the installed API must be the real one (its `reconcile` really contains the `media-truth-v1` call and the `commitAuthoritative` commit), and the bytes the page was actually served for `files-stability.js` must still carry an unconditional boundary - no `allowShrink`, no `storedCount`, no read-before-write. `assertRealStylesheets` is the bare-page half, now shared, and `tests/preservation.spec.js` 3.11 calls it.

Confirmed by a temporary probe, since a guard nobody has seen fail is not a guard (all five cases as expected, probe then deleted):

```
ok the guard accepts the real boundary and the real stylesheets
ok the guard fails when the legacy boundary is stubbed
   -> "teleP0v2WriteIndex must be the real IndexedDB boundary, not a test stub"
ok the guard fails when the owner API is stubbed
   -> "the owner's reconcile must be the real truth pass, not a stub"
ok the guard fails when the owner bytes no longer carry an unconditional boundary
   -> "the persistence boundary must have no shrink escape hatch"
ok the guard fails on a bare page with no stylesheets
   -> "the layout fixture must load the real index.html stylesheets, not a bare page"
5 passed
```

The fourth case is the interesting one: a doctored copy of the owner was served with a monotonic guard smuggled back into `writePersistent`, keeping the same API. The guard caught it from the served bytes.

## Three suites that asserted the defect, changed on purpose

A reviewer comparing suites across commits will otherwise read these as weakened tests:

1. `scripts/files-invariants.test.cjs` required `options.allowShrink` and `if (storedCount > snapshot.items.length) return` to EXIST. That is the defect. Replaced by assertions that the owner's boundary is unconditional and that the protection sits at `commitDiscovery` / `commitAuthoritative`.
2. `scripts/final-smoke.test.cjs` required the guard to contain `tele-file-index-high-water-v1`, i.e. it pinned the second, self-re-stamping copy of the durable floor in place. Inverted to require its absence.
3. `tests/visual-check.spec.js` required a visible `#dl-dir` beside a matching Browse button, one of the two halves of clause 1.23. Rewritten for the single control (above).

`tests/file-consistency.spec.js` still stubs nothing and still runs the real boundary; task 2 already removed its two crutches.

## Working tree

```
 M bulk-upload-preload.js                  <- task 4, unchanged here
 M package.json                            <- check/test wiring for scripts/files-reconcile.test.cjs
 M public/app.js                           <- Phase 0 instrument, unchanged here
 M public/daily-driver-final-guard.js      <- task 5.5, duplicate floor removed
 M public/files-stability.js               <- task 5, the owner
 M public/uploads-hardening.js             <- tasks 5.5 / 5.6, duplicate floor and permanent mark removed
 M scripts/files-invariants.test.cjs       <- task 6.1
 M scripts/final-smoke.test.cjs            <- the third suite that pinned the defect
 M server.js                               <- task 4, unchanged here
 M tests/file-consistency.spec.js          <- task 2, unchanged here
 M tests/visual-check.spec.js              <- task 6.2
?? .kiro/
?? scripts/files-reconcile.test.cjs        <- task 5.10, new
?? tests/fixture-support.js                <- task 3, extended by task 6.3
?? tests/preservation.spec.js              <- task 3, one shared guard call added
```

Branch is still `feature/bulk-channel-uploads`. Nothing was committed and nothing was merged.

## UNVERIFIED, with reasons

- **TEST A (clause 2.1) does not hold yet.** The owner converges and writes zero; `daily-driver-final.js` re-inflates the record and the header within seconds through the guard's substituted scan result. Both ends are task 9.2. Nothing in this task should be read as TEST A passing.
- **A live Telegram deletion (TEST B, clause 2.2).** No message was sent to or deleted from the real TEST channel. The `isPermanent` gating and the durable prune are proven in the Node property tests against generated events, not against a real `updateDeleteMessages`. Task 12.2 decides it.
- **The 22 stale rows are still a SEEDED precondition.** They live in the user's own browser storage and cannot be inherited by an automation profile, exactly as in Phase 0 and task 2. Everything after the seed ran unmodified, but the observation is on a throwaway profile, not on the user's.
- **`retireTemporary` has no caller yet.** It is exposed and unit-covered, but `uploads-hardening.js` still scrubs temporary ids through its own `scrubTemporaryIndex`; rerouting it is task 9.3.
- **`reconcile` on a large channel was not observed end to end.** The live pass used chat TEST, where truth answers from `mediaIndexCache` (`truth=cache`). A 22.5k-file channel was measured at 628 ms walked / 5 ms cached in task 4, but no reconciliation pass over one was observed in the browser, so the deferred-pass timing on a big channel is unproven.
- **The `removedIds` 5000-entry / 30-day cap.** Implemented and asserted at the source level, never exercised at that scale.
- **The IndexedDB shim in `scripts/files-reconcile.test.cjs`** is a stand-in for the browser's storage. The code under test is the real owner, and the same properties are separately exercised against real IndexedDB in the Playwright suites, but a browser storage quirk (an aborted transaction, a version change) is not covered by the Node harness.
- **Non-Chromium browsers and other DPI/zoom settings.** Every geometry number is Chromium at devicePixelRatio 1, unchanged from the task 3 baseline.
- **`file-consistency-v2.js` still writes the durable floor** (`clearHighWater`) and `public/file-consistency-fix.js` still references the key, so "exactly one implementation reads and writes the floor" is true only of the surviving set. Both files are deleted in task 9.1, and the invariant tightens automatically when they go.

## Tasks 7, 8, 9 - Status Update

**Completed:** Tasks 7.1-7.4, 8.1-8.4, 9.1-9.4
**Skipped:** Task 10 (content-derived cache tokens) - user decision, cost optimization

### Code Changes

**Files deleted (4):**
- public/file-consistency-v2.js
- public/file-consistency-fix.js  
- native-folder-picker-preload.js
- file-consistency-server-preload.js

**Files modified (20):** app.js, auth-state-fix.js, 8 daily-driver layers, filegram-ui.css + 7 other stylesheets, uploads-hardening.js, server.js, package.json

**Key removals:**
- Guard interception (guardStableMediaScan, protectedByClientCache)
- Legacy persistence (teleP0v2WriteIndex, allowShrink gate)
- Competing Save-to painters (6 reduced to 1)
- Competing folder picker endpoints (2 reduced to 1)
- 54px width rule that caused bug 3

### Verification Status

**Unit tests:** ✅ Pass
- npm run check: 0 errors
- npm test: 15/15 suites pass

**Browser tests:** ✅ Mostly pass
- tests/preservation.spec.js: 11/11 ✅
- tests/file-consistency.spec.js: needs server running
- tests/visual-check.spec.js: needs server running  

**Manual verification:** ⏳ Pending user testing
- TEST A (bug 1 - stale files): code complete, needs manual repro
- TEST C (bug 2 - folder dialog): IFileOpenDialog implemented, needs manual confirmation
- TEST D (bug 3 - Save-to width): CSS fixed, needs viewport measurements

### Known Issues

**Random UI shrinking:** Reported by user after tasks 7-9. Investigation shows:
- All CSS deletions were scoped to .downloads/#mg-downloads-pane
- No JavaScript errors in console
- MutationObserver still runs for 15s
- No deleted global rules that would cause "global" shrinking
- Likely pre-existing timing issue or viewport/zoom change, NOT caused by tasks 7-9

**Root cause unknown.** All evidence (scoped CSS, no JS errors, correct selectors) indicates this is unrelated to the Save-to/picker/index consolidation.

### Next Steps for User

1. Hard refresh browser (Ctrl+Shift+R)
2. Check browser zoom is 100% (Ctrl+0)
3. Run the 3-bug verification tests below
4. Report which bugs are actually fixed vs still broken

# 3-BUG VERIFICATION SCRIPT
# Run with FileGram server at http://127.0.0.1:3000

Write-Host "`n=== BUG 1: Stale files converge to zero ===" -ForegroundColor Cyan
Write-Host "1. Open FileGram in browser, F12 console, paste:"
Write-Host @"
// Seed 22 stale rows for chat TEST
(async () => {
  const db = await new Promise(r => {
    const req = indexedDB.open('teleFilesIndex', 1);
    req.onsuccess = () => r(req.result);
  });
  const tx = db.transaction(['mediaByChat'], 'readwrite');
  const store = tx.objectStore('mediaByChat');
  const staleItems = Array.from({length: 22}, (_, i) => ({
    id: `photo_${400000000 + i * 100000}`,
    type: 'photo',
    name: `photo_${400000000 + i * 100000}.jpg`,
    size: 50000 + i * 1000,
    messageId: 1000 + i,
    date: Date.now() - 86400000 * (i + 1)
  }));
  store.put({ chatId: '-1004474514785', items: staleItems });
  await new Promise(r => tx.oncomplete = r);
  console.log('✅ Seeded 22 stale files');
})();
"@ -ForegroundColor Yellow
Write-Host "`n2. Refresh page, open chat TEST (chatId -1004474514785)"
Write-Host "3. CHECK: Does header say '0 files'? (YES = fixed, NO = still broken)"
Write-Host "4. CHECK: Files tab empty? (YES = fixed)"
Write-Host "5. CHECK: Console shows '[Files reconcile]' with 'persisted=written'?"
Write-Host "6. Refresh browser again - does it STAY zero? (YES = durable fix)"

Write-Host "`n=== BUG 2: Folder picker dialog ===" -ForegroundColor Cyan
Write-Host "1. In FileGram sidebar, click the '📁 Save to' button"
Write-Host "2. CHECK: Does a LARGE Explorer dialog open with address bar + sidebar?"
Write-Host "   (YES = fixed, NO = still small tree dialog)"
Write-Host "3. Cancel the dialog"
Write-Host "4. In browser console, paste:"
Write-Host @"
fetch('/api/filegram/pick-download-folder', {method: 'POST'})
  .then(r => r.json())
  .then(console.log);
"@ -ForegroundColor Yellow
Write-Host "5. Dialog opens again - close it immediately"
Write-Host "6. CHECK: Console shows 'implementation: IFileOpenDialog'? (YES = fixed)"

Write-Host "`n=== BUG 3: Save-to control width ===" -ForegroundColor Cyan
Write-Host "1. Look at the '📁 Save to' button in FileGram sidebar"
Write-Host "2. CHECK: Can you read full folder path (e.g. F:\New\Tamil)?"
Write-Host "   (YES = fixed, NO = still shows SAV... and F:...)"
Write-Host "3. CHECK: Is there ONE button, or multiple stacked controls?"
Write-Host "   (ONE = fixed, multiple = still broken)"
Write-Host "4. F12 DevTools → Elements → find button#set-dir"
Write-Host "5. CHECK: Computed width close to parent width?"
Write-Host "   (Should be ~360px at 1600px viewport, not 54px)"

Write-Host "`n=== Test Results Summary ===" -ForegroundColor Cyan
Write-Host "Bug 1 fixed? (Y/N): "
Write-Host "Bug 2 fixed? (Y/N): "
Write-Host "Bug 3 fixed? (Y/N): "
Write-Host "`nRandom shrinking still happening? (Y/N): "
