# Bulk upload validation

The bulk channel upload feature is intentionally gated by automated behavior tests plus one logged-in TEST-channel smoke test.

## Automated gates

Run:

```bat
npm run verify
npm run test:uploads-ui
```

Coverage includes:

- queue concurrency remains bounded;
- Pause all / Resume all affect the complete queue;
- Cancel all affects pending and active jobs, not only parallel workers;
- Clear done / Clear all keep full-queue semantics;
- interrupted transfers retry automatically;
- uncertain delivery is verified before retrying;
- server upload IDs are idempotent across retries;
- destination must be a channel owned by the current Telegram account;
- FLOOD_WAIT is surfaced as Retry-After and respected by the queue;
- 20,000-job restore remains bounded and cancellable;
- upload list renders 100 rows per page;
- duplicate review shows selection and destination-index evidence.

## Live TEST channel gate

This test requires the local logged-in TDLib session and therefore is not run in GitHub Actions.

Start FileGram from the feature branch, then in a second terminal run:

### Command Prompt

```bat
set FILEGRAM_UPLOAD_LIVE=1
npx playwright test tests/bulk-uploads.spec.js -g "live TEST channel"
```

### PowerShell

```powershell
$env:FILEGRAM_UPLOAD_LIVE='1'
npx playwright test tests/bulk-uploads.spec.js -g "live TEST channel"
```

The test selects the owned channel named `TEST`, uploads three uniquely named text files, waits for all three queue jobs to reach `completed`, verifies Telegram message IDs were returned, and deletes the three evidence messages afterward.

Do not merge until `npm run verify`, `npm run test:uploads-ui`, and the live TEST-channel gate all pass.
