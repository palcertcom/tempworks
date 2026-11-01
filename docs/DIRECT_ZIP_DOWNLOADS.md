# Direct ZIP downloads

The backup page's manual creation button now creates and downloads in a single
authenticated POST request. It no longer creates an instance-local archive and
then attempts to download it from another instance.

* Database: ZIP containing `database.sql` (pg_dump plain SQL, schema and data)
  and `manifest.json` with a SHA-256 digest. No custom dump, tar or gzip.
* Files: one ZIP containing `spaces/<object-key>` and `uploads/<local-path>`,
  plus a manifest of included files and checksums.
* No SQL dump or ZIP is written to server disk. Data passes through bounded
  stream buffers; ZIP directory and manifest memory grow with the file count.
* Chrome's save-file picker streams to the chosen local file. Other browsers
  use a Blob download after completion and may require substantial client memory.
* Keep the page open. Cancel/navigation aborts the fetch and producer. Source
  failure aborts the response; an incomplete ZIP must not be treated as success.
* The existing System Admin guard and cross-instance advisory lock apply.
  No production restore, migration or new storage resource is introduced.

## Scope and restore

These are fresh exports, not a conversion of an earlier dated backup. A separate direct-download history shows the latest 50 operations, with the
initiating user's name/email, kind, timestamps, generated ZIP byte count and
server result. It is backed by existing audit_logs (no schema migration).
It does not offer download/restore buttons for archives held on a user's device.
Existing stored-backup history, scheduled backups and restore paths remain
legacy DR functionality.

Database SQL excludes cluster roles, object ownership and access grants for
portability. Restore into a separate empty compatible PostgreSQL database using
`psql --set ON_ERROR_STOP=on --dbname=TARGET --file=database.sql`. Referenced
roles (for example in RLS policies) and extensions may need provisioning first.
The existing UI restore endpoint does NOT import this ZIP format.

Files export enumerates all current objects in the configured uploads bucket,
including objects not referenced by the database. It also includes the serving
instance's local uploads when present. It cannot collect local files from other
instances or reconstruct absent historical files (including the previously
reported 32 unresolved references). The manifest explicitly states that database
references are not validated. Database and files ZIPs are separate exports, not
an atomic full-system recovery snapshot. Changed/deleted listed objects abort
the export; unsafe archive paths and local symlinks are rejected.

## Validation

Run `node --test backend/scripts/dr/tests/direct-export.test.mjs` (Node + Python3).
Tests exercise actual ZIP generation/extraction with fake pg_dump output and
mocked S3 responses: SQL ZIP, failed SQL producer, local Unicode contents,
disconnect, unsafe paths/symlinks, paginated objects and missing object failure.
No production credentials or data are used.

Validation completed on 2026-11-01:

* All six direct-export tests passed.
* Frontend `npm ci` and `npm run build` passed (Vite chunk-size warnings).
* Backend `npm ci` and `npm run build` passed, including Prisma generation and
  Nest/TypeScript compilation. A dummy local DATABASE_URL was used only for
  generation; no production database was contacted.

Before production deployment, run authenticated HTTP checks (including non-admin
rejection) and an isolated real PostgreSQL dump/restore. Test downloading from
each app instance and verify SQL/file contents. These integration checks have
NOT been run. DigitalOcean configuration was not changed.

## Repository import

`palcertcom/tempworks` was imported from `tempworkseu/tempworks` main at
22985588be0f4218966ac92c9b2f6f19b26bb07d. The import commit contains all 1650
tracked source files with identical Git tree f733139c5068e0095940d240a75cd617f327fb12.
The original commit history and other branches were not imported.
The direct-download changes are a separate commit after that exact snapshot.

The existing Dockerfile copies `scripts/dr` and includes Python3 and PostgreSQL18
tools; no new package dependency is required. Existing DR restore continues to
use its original package format, not these download ZIPs.

References:
* https://www.postgresql.org/docs/18/app-pgdump.html
* https://docs.python.org/3/library/zipfile.html

## Download progress and audit history

The modal shows an indeterminate activity bar, received MiB and elapsed seconds,
including the preparation period. ZIP length is unknown until export finishes;
no invented percentage is shown. Progress counts response bytes and preserves
backpressure, cancellation and error propagation.

The server records BACKUP_EXPORT_STARTED before starting its producer, including
a snapshot of the authenticated user's name and email. It appends a correlated
BACKUP_EXPORT_FINISHED with STREAMED, FAILED or CANCELLED. STREAMED means the
HTTP response finished sending, not proof that the browser saved the file.
Unfinished starts older than 65 minutes are shown as UNKNOWN, since process
termination can prevent a final audit write. Final audit write failures are
logged by the existing audit service; they do not manufacture success.
Old downloads made before this change are not backfilled into the new history.
Audit history follows the existing audit-log retention policy.

Validation: frontend/backend builds passed; 13 tests passed (6 export tests and
7 progress/controller/history tests with mocked persistence and HTTP streams).
No real DigitalOcean download or production database was used for these tests.
After a backend build, run:

```sh
node --test backend/scripts/dr/tests/direct-export.test.mjs backend/scripts/dr/tests/download-ui-audit.test.mjs
```
