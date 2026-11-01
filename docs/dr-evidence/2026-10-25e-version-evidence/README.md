# Evidence: version identity of recovered files; exact-image blocker (2026-10-25)

All runs are LOCAL: PostgreSQL 18, the s3rver S3 **simulator**, and Docker on
this host. Nothing was deployed, merged, or changed in production or billing.

## 1. Version identity of files recovered from older sources

**Problem.** `resolveDangling` accepted a copy from an earlier snapshot or
another instance's inventory once its blob hash and size checked out. That
proves the blob is intact, but not that it is the version the captured
database references. Example: V1 backed up, the key rewritten with V2, then
the live file lost. Recovery then reported COMPLETE with V1.

**Rule now.** No database column stores a content hash; `fileSize` is not
proof. So a recovered copy counts as the referenced version only with an
**immutable-key guarantee recorded at write time**:

* `StorageService` writes every object once (it refuses existing keys),
  under a generated `<uuid>` key.
* It stores `x-amz-meta-tw-sha256`, `tw-write-once` and `tw-unique-key`.
* The backup records `versionEvidence: app-write-once-unique-key` only when
  that recorded hash equals the captured content.

Every other copy is **kept** as a disclosed candidate (`versionVerified:
false`, source and reason), the issue is reported as `FILES_VERSION_UNVERIFIED`,
and recoverability stays **DEGRADED**. This covers:

* every legacy `/uploads` file, because local keys can be rewritten;
* every other-instance inventory;
* objects without the evidence (written before this change or out of band).

Regression cases (`race/stream-race-test.json`, `stream-race.out.txt`):

| Case | Scenario | Result |
|---|---|---|
| D5 | **legacy key backed up as V1 → replaced with V2 → live file removed → recovery from the older snapshot** | exit 6 DEGRADED, `FILES_VERSION_UNVERIFIED`; V1 preserved as candidate with source, sha256 and reason; verify: integrity OK, recoverability DEGRADED |
| D6 | other instance inventoried V1, its copy then replaced with V2 | candidate from `instance-B`, DEGRADED (same rule) |
| D2 | object lost, earlier copy written without version evidence | candidate kept, DEGRADED |
| D2p | object written by the real `StorageService` (evidence in metadata), then lost | **COMPLETE**: copy `versionVerified: true`, bytes identical, `LIVE_STORAGE_MISSING_RECOVERED` (normal recovery of provably identical files keeps working) |

Remaining limitation: the guarantee is application-level. An out-of-band
overwrite that also forges the metadata hash is undetectable without a hash
stored alongside the database reference, and there is no such column today.

## 2. Exact production image — diagnosis and alternative

* **CI diagnostic (explicit, not assumed).** All three `backend-image` runs
  (40201541345, 40201646973, 40204031823) had empty log archives, and 0
  billable ms. Each job's check-run annotation (`ci-annotations.txt`, read
  from the public API) says: *"The job was not started because recent account
  payments have failed or your spending limit needs to be increased. Please
  check the 'Billing & plans' section in your settings"*.
  * **Owner action:** at Settings → Billing and plans, fix the payment method
    or raise the Actions spending limit. Then run *Actions → backend-image →
    Run workflow* once.
  * The workflow is now manual-only, so pushes no longer create runs that
    cannot start. It was not re-run.
* **Local exact build.** `bash backend/scripts/ci/verify-production-image.sh`
  (unmodified Dockerfile, pinned base, no build args) **fails as expected**:
  `curl: (60) SSL certificate problem: self-signed certificate in certificate
  chain` at the PGDG key download (`exact-build-via-verify-script.log`). This
  sandbox re-signs every container TLS connection (issuer `Egress Gateway SDS
  Issuing CA`). TLS verification was **not** bypassed.
* **Copy-paste alternative** for any Ubuntu host with Docker and normal
  internet access. It is the same script the workflow runs:
  `bash backend/scripts/ci/verify-production-image.sh --install-prereqs`.
  It builds, records identity (`exact_production_build=yes`), runs the image
  checks (incl. real public TLS endpoints), runs the full drill from the image,
  and writes `verify-evidence/`.
* **Script validated here in test mode** (`--use-image`). The build step was
  skipped and the CA-trusting-base image was used instead, with
  `exact_production_build=no` recorded. Results are in §3.

## 3. Results on the tested code

Tested commit: `b369d87`. The suites marked † ran on `421f43e`; the only
change after it is a reporting tweak in `post-restore-check.mjs`.
Image: `sha256:e136b31131056bf18c1165d8767ac67252328ec1f1d3f52a1159555a4c4e10c5`
(same Dockerfile; base = CA-trusting copy of the pinned node digest).

| Command | Result |
|---|---|
| `verify-production-image.sh --use-image …` (test mode): identity → image checks → full two-instance drill from the image | **ALL STEPS PASSED** — image checks 17/17, drill 57/57 (`verify-run.txt`, `verify-run/`) |
| full drill from the image on `421f43e` + `tests/post-restore-check.mjs` against the recovered env | drill 57/57; post-restore check passed: original admin login, wrong password rejected, 6/6 attachments via the API match backup SHA-256, all 8 manifest files in recovery storage match. The 2 documents without a backup file are the uploads made *after* recovery (ids listed). `post-restore-check-drill.json` |
| † stream regression suite | all passed (incl. D2, D2p, D5, D6) |
| † `tests/prereq-restore-test.sh` | **31/31**. New target 3: a source whose `pg_dumpall` works, restored as a non-superuser admin. This exposed and fixed a real bug: such roles were not SET-able, so the restore failed with "must be able to SET ROLE". |
| † `tests/spaces-real-test.sh` against the **simulator** (script smoke test only) | 9/9 |
| † `dr-selftest.sh` | 67/67 |
| † `ops/tls-local-test.sh` | 16/16 |

Still pending in production: `docs/PRODUCTION_VALIDATION_CHECKLIST.md`.
