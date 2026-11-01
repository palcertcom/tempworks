# Production validation checklist (backup / disaster recovery)

**Production recovery is NOT verified until step 7 succeeds.** Steps 1–3 are
read-only. Nothing here may write to the production database or the live
upload bucket. The only production writes are the backup itself (into the
separate backup bucket) and the inventory files it records there.

## Already done locally (not a substitute for this list)

All of the following ran on PostgreSQL 18 with an S3 **simulator**, using the
image from the same Dockerfile with a CA-trusting base. Evidence is in
`docs/dr-evidence/`.

* Two-instance recovery drill from the image into a fresh cluster and an
  empty bucket: 57/57.
* Image checks: 17/17.
* Prerequisite / fresh-cluster tests: 31/31.
* Stream regression suite (races, missing files, version evidence).
* Self-test: 67/67.
* TLS: 16/16.
* `spaces-real-test.sh`: 9/9, but only against the **simulator** (script
  smoke test).

## Pending, in order

**0. Exact production image.** Unblock GitHub Actions. All three runs were
refused before start with the annotation *"recent account payments have
failed or your spending limit needs to be increased"*. The owner, at
**Settings → Billing and plans**, must update the payment method or raise the
Actions spending limit. Then start *Actions → backend-image → Run workflow*
once. Alternatively, on any Ubuntu host with Docker and unrestricted internet:
```bash
git clone <repo> && cd <repo> && git checkout <PR head>
bash backend/scripts/ci/verify-production-image.sh --install-prereqs
```
Pass = `ALL STEPS PASSED` and `verify-evidence/image-identity.txt` with
`exact_production_build=yes`. Record the commit and `image_id`.

**1. Read-only database checks.** Run these in the backend component Console.
The session is read-only and prints no credentials.
```bash
q() { psql "$DATABASE_URL" -X -At -v ON_ERROR_STOP=1 -c "SET default_transaction_read_only = on" -c "$1"; }
q "SHOW server_version"                                         # expect 18.x
q "SELECT count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL), count(*) FROM _prisma_migrations"   # expect 13|13
node -e 'const u=new URL(process.env.DATABASE_URL);console.log(JSON.stringify({host:u.hostname,port:u.port||"5432",database:u.pathname.slice(1),sslmode:u.searchParams.get("sslmode")}))'   # port 25060 (direct), not the 25061 pool
q "SELECT count(*) FROM employee_agency_access g JOIN employees e ON e.id=g.\"employeeId\" JOIN agencies a ON a.id=g.\"agencyId\" WHERE g.\"canView\" AND e.\"tenantId\"<>a.\"tenantId\""   # 0 = attachment fix ships as is
q "DO \$\$DECLARE r record; n bigint; BEGIN FOR r IN SELECT table_name t, column_name c FROM information_schema.columns WHERE table_schema='public' AND data_type IN ('text','character varying') AND column_name ILIKE '%url%' LOOP EXECUTE format('SELECT count(*) FROM %I WHERE %I LIKE %L', r.t, r.c, '/uploads/%') INTO n; IF n > 0 THEN RAISE NOTICE '% . % : % legacy reference(s)', r.t, r.c, n; END IF; END LOOP; END\$\$"
```
After the PR's code is deployed (the file ships with it), also run
`psql "$DATABASE_URL" -X -Atf scripts/dr/lib/prereqs.sql`. It lists the
required roles (no passwords). Note whether a provider role such as `doadmin`
owns the database; restores to a non-DigitalOcean target then need
`--role-map doadmin:<role>`. Also check the runtime-log line `TempWorks API
running on: …:<port>` (deployment doc §6).

**2. Every active instance's legacy directory is inventoried.** Do this only
if step 1 found legacy references, after phase 1 (streaming engine) is live.

1. App Platform → component → **Console**. Open it once **per instance**
   (instance selector) and run:
   ```bash
   hostname
   bash scripts/dr/snapshot.sh legacy-inventory
   ```
   Each run prints that instance's hostname and its file count.
2. Then call `GET /api/v1/backup/legacy-inventory` (System Admin), or run
   `bash scripts/dr/snapshot.sh legacy-inventories`.

Pass: every hostname from (1) is listed, each with a `scannedAt` later than the
latest deployment. Save that output as evidence. A redeploy replaces the
instances and resets their disks, so repeat after every deploy until the
legacy files are migrated.

**3. Private off-site storage, credential scope, retention, recovery prerequisites.**

* **Bucket is not publicly listable.** An anonymous request to the bucket
  root must return 403:
  `curl -s -o /dev/null -w '%{http_code}\n' https://<backup-bucket>.<region>.digitaloceanspaces.com/`
* **Objects are not publicly readable.** After step 5, an anonymous GET of any
  `…/snapshots/<pkg>/MANIFEST.json` must return 403.
* **Key scope.** With the **backup** key, listing `tempworks-uploads` must fail
  (AccessDenied) if the key is bucket-scoped. With the **app** key, writing to
  the backup bucket must fail. If your plan has no scoped keys, record that the
  keys are separate.
* **Retention and lifecycle.** `BACKUP_RETENTION_COUNT` is set. The lifecycle
  rule "abort incomplete multipart uploads after 1 day" exists on the backup
  bucket.
* **Recovery prerequisites in the secret store:**
  * database role password(s);
  * `JWT_SECRET` and `JWT_REFRESH_SECRET`;
  * one administrator login for step 7;
  * backup-bucket read credentials;
  * the DigitalOcean database CA certificate;
  * the tested commit and image id.

**4. Controlled test on real DigitalOcean Spaces with isolated test objects.**
Use a dedicated **empty** test bucket (never `tempworks-uploads`) and a test
prefix in the backup bucket. Run on the temporary recovery droplet (deployment
doc §2 #3):
```bash
export TEST_LIVE_BUCKET=<empty test bucket> DO_SPACES_ENDPOINT=https://fra1.digitaloceanspaces.com DO_SPACES_REGION=fra1 \
       DO_SPACES_ACCESS_KEY=… DO_SPACES_SECRET_KEY=… \
       BACKUP_SPACES_ENDPOINT=https://<region>.digitaloceanspaces.com BACKUP_SPACES_REGION=<region> \
       BACKUP_SPACES_BUCKET=<backup bucket> BACKUP_SPACES_ACCESS_KEY=… BACKUP_SPACES_SECRET_KEY=…
bash backend/scripts/dr/tests/spaces-real-test.sh ./spaces-evidence
```
It covers multipart (40 MiB plus the dump), metadata (write-once version
evidence), listing, DeleteObjects, deep verify, and a restore into a fresh
cluster with hash comparison. It deletes everything it created.
Pass = `9 passed, 0 failed`.

**5. First full production backup.**

1. UI → Create Backup → **Full system**.
2. Record the result:
   * status (COMPLETED / DEGRADED / INCOMPLETE);
   * integrity (Integrity verified);
   * every recovery issue with its count.
3. From the **other** instance, run **Verify integrity**, which deep re-hashes
   everything.
4. If the status is DEGRADED, export `uploads.refcheck.json`. The lists
   `unresolved[]` (in no source) and `versionUnverified[]` (candidate copy
   without version evidence) are the **missing data**. Resolve them per runbook
   *Missing files*, or accept them explicitly and in writing. They are not
   recoverable as the referenced version.

**6. Restore into a separate EMPTY environment.** Use the recovery droplet: a
fresh PostgreSQL 18 cluster, an empty uploads directory or empty test bucket,
and no production credentials except backup read access. Follow deployment
doc §13 step 4:
`snapshot.sh verify --deep` → `materialize` → `restore.sh --create-db --roles`
as a non-superuser admin (`--role-map doadmin:<role>` if needed) → set role
passwords from the secret store.

**7. Verify the restored environment.**

1. Start the backend from the image against the restored database, bound to
   localhost, with mail disabled:
   `docker run --network host --env-file recovery.env <image>`.
2. Run:
   ```bash
   export DATABASE_URL=<restored> ADMIN_COMPANY=<company> ADMIN_EMAIL=… ADMIN_PASSWORD=… UPLOAD_STORAGE_DRIVER=local UPLOAD_DEST=<restored files>
   node backend/scripts/dr/tests/post-restore-check.mjs http://127.0.0.1:<port>/api/v1 /srv/restore/<pkg> post-restore.json
   ```
3. Together with restore.sh's own checks (objects, row counts, ownership,
   grants, sequences, files), this covers:
   * database objects and data;
   * file hashes;
   * authentication (original password accepted, wrong one rejected);
   * every attachment served by the restored app matching its backup SHA-256.

Pass = `POST-RESTORE CHECK PASSED`. Mark the backup **restore-tested**, store
the evidence, and destroy the droplet. **Only now is production recovery
verified, and only to the extent of the issues recorded in step 5.**
