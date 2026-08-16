FileGram bulk uploads runtime ownership

upload-queue-core.js: queue state machine and scheduling
bulk-uploads.js: browser source access, IndexedDB queue persistence, duplicate review, Uploads UI
uploads-hardening.js: idempotent tagged transport, source integrity checks, Retry-After handling
bulk-upload-preload.js: intercepts tagged bulk upload requests before the legacy composer route
bulk-upload-server.js: owned-channel validation, staging, TDLib send completion, persistent idempotency ledger
files-stability.js: remains the only FileGram Files-index owner
