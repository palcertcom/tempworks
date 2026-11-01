# TempWorks — Backup/DR: Production Deployment, Validation and Rollback

This is the remaining **production** work. Nothing below has been run against
production: this session had no access to the production host, the
DigitalOcean managed database, or the production Spaces bucket. Every step is
non-destructive unless explicitly marked.

---

## 0. Hosting topology — identified from public, read-only signals (2026-10-25)

| Component | Evidence (HTTP response headers / public bundle) | Conclusion |
|---|---|---|
| Frontend `careers.tempworks.eu` | `server: cloudflare`, `x-do-app-origin: a950bbac-c2fc-459b-a11a-cfc23b6ead4d`, `x-do-static-catchall-document: index.html`, `x-amz-request-id …fra1c` | DigitalOcean **App Platform static site** (fra1). `public/.htaccess` is **not** used. `GET /api/v1/*` on this host returns the SPA (`x-do-orig-status: 404`) — no backend behind it. |
| API | Production bundle `assets/index-DgvplX5_.js` contains `https://whale-app-j7l64.ondigitalocean.app/api/v1` (25×) | The SPA calls a **separate** origin |
| Backend `whale-app-j7l64.ondigitalocean.app` | `GET /api/v1/auth/me` → `401 {"statusCode":401,…,"code":"GENERIC.UNAUTHORIZED",…}` (this codebase's error format), `x-powered-by: Express`, `x-do-app-origin: 9a378360-409d-4dc8-960c-e170d41ff5e3` | TempWorks NestJS on DigitalOcean **App Platform** (separate app) |

Consequences: topology (A) (Apache + Node on a VM) does **not** apply. App
Platform containers have **no persistent disk** and can run several instances.
`vite.config.ts` lists `whale-app-j7j64` (with `j`), not the real `j7l64` — likely a stale entry.

**Still unknown (needs the app spec, see §7):** whether the backend component
is built by the buildpack or a Dockerfile, its instance count, region, and
which managed database / Spaces bucket it is bound to.

---

## 1. Root cause of “COMPLETED” + “File missing from disk” — now strongly supported

The old code wrote backups to `process.cwd()/backups` inside the backend
container. The backend runs on App Platform (§0), whose container filesystem is
ephemeral: it is replaced on every deploy/restart and is not shared between
instances. A backup written there disappears at the next deploy, while its
catalog row (in the database) survives — exactly the observed symptom.
Not yet *proven* by a log line; the app's deployment history (DO control panel →
Activity) around 2026-04-04 12:28 would confirm a redeploy after that backup.

`pg_dump 17.7 (Ubuntu 17.7-3.pgdg22.04+1)` matches the PostgreSQL client that
App Platform's Ubuntu 22.04 buildpack stack ships, i.e. the client comes from
the **platform image**, not from this repository. If the component is
buildpack-built, the version-correct client therefore requires either a
Dockerfile build (§4) or an Aptfile with the PGDG repository.

---

## 2. Configuration to set (names only — store values in the secret manager)

| Variable | Required | Purpose |
|---|---|---|
| `BACKUP_DIR` | yes | Local staging dir for packages. **(A)** a persistent path, e.g. `/var/lib/tempworks/backups`. **(B)** scratch only; off-site is mandatory. |
| `BACKUP_SPACES_ENDPOINT` | yes for DR | e.g. `https://fra1.digitaloceanspaces.com` (different region from uploads recommended) |
| `BACKUP_SPACES_REGION` | yes for DR | e.g. `fra1` |
| `BACKUP_SPACES_BUCKET` | yes for DR | a **new, private** bucket used only for backups |
| `BACKUP_SPACES_ACCESS_KEY` / `BACKUP_SPACES_SECRET_KEY` | yes for DR | a Spaces key scoped to that bucket |
| `BACKUP_SPACES_PREFIX` | no | default `dr/` |
| `BACKUP_RETENTION_COUNT` | no | default 10 local packages (newest + newest verified always kept) |
| `BACKUP_SCHEDULE_CRON` | no | **unset = scheduling disabled**. Suggested (operator decision): `17 2 * * *` |
| `BACKUP_SCHEDULE_TZ` | no | default `UTC`; suggested `Europe/Bratislava` |
| `BACKUP_SCHEDULE_KIND` | no | `FULL_SYSTEM` (default) or `DATABASE` |
| `BACKUP_STALE_HOURS` | no | default 26 — alert if no verified backup is newer |
| `PG_BIN_PATH` | no | pin the client, e.g. `/usr/lib/postgresql/18/bin` |

**Do not** set `DO_SPACES_FORCE_PATH_STYLE` / `BACKUP_SPACES_FORCE_PATH_STYLE` for
DigitalOcean Spaces (they exist for MinIO/S3-compatible endpoints).

Secure setup of the off-site bucket (DO control panel):
1. Spaces → Create a bucket in a **different region** from the uploads bucket; File Listing **Restricted**.
2. API → Spaces Keys → create a key **limited to that bucket** (read/write). Store it in the secret manager.
3. Optionally enable bucket versioning / lifecycle rules for retention of off-site copies.
4. Keep a **break-glass copy** of: this key, `DATABASE_URL` credentials, `JWT_SECRET`, `JWT_REFRESH_SECRET`,
   `DO_SPACES_*` uploads key, `RESEND_API_KEY`, `RECAPTCHA_SECRET_KEY` with a second custodian, off the server.

---

## 3. Deploy — topology (A) Apache + Node on a VM/Droplet — NOT APPLICABLE (production is App Platform, §0)

```bash
# 3.1 Version-correct PostgreSQL client (does NOT touch the database server)
sudo deploy/provision-postgres-client-18.sh
/usr/lib/postgresql/18/bin/pg_dump --version          # expect 18.x

# 3.2 Persistent backup directory owned by the service user
sudo install -d -o <service-user> -m 700 /var/lib/tempworks/backups

# 3.3 Deploy the code (normal process), then:
cd backend && npm ci && npx prisma generate && npm run build
#     The app heals the additive system_backups columns on boot (no migration needed).

# 3.4 Add the variables from section 2 to the service environment, restart:
pm2 restart <app> --update-env      # or: sudo systemctl restart <unit>

# 3.5 Validate (read-only)
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" https://careers.tempworks.eu/api/v1/backup/preflight | jq
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" https://careers.tempworks.eu/api/v1/backup/schedule  | jq
```

## 4. Deploy — topology (B) DigitalOcean App Platform — SUPERSEDED

The untested Dockerfile draft that was here is replaced by the tested package
in **[APP_PLATFORM_DEPLOYMENT.md](APP_PLATFORM_DEPLOYMENT.md)**: the real
`backend/Dockerfile`, the minimal App Spec patch, env-var table, two-instance
design + evidence, measured resource limits, TLS plan, migration plan,
deployment/rollback steps and the first-backup + isolated-restore procedure.
On App Platform use the **streaming engine** (`BACKUP_ENGINE=stream`, default
when `BACKUP_SPACES_BUCKET` is set): the staging engine below was measured at
~2x the dataset in local disk and memory and is OOM-killed in a 1 GiB container.

---

## 5. First production backup and isolated validation (no production writes paused)

1. Settings → Database Backup: preflight banner must be green.
2. Create Backup → **Full system**. Wait for `COMPLETED`; Integrity `Verified`; `Off-site copy verified`.
3. On a **separate, protected** machine (never production), using only the off-site copy:

```bash
export BACKUP_SPACES_ENDPOINT=... BACKUP_SPACES_REGION=... BACKUP_SPACES_BUCKET=... \
       BACKUP_SPACES_ACCESS_KEY=... BACKUP_SPACES_SECRET_KEY=...       # from the secret manager
git clone <repo> && cd <repo>/backend && npm ci
node scripts/dr/spaces-sync.mjs offsite-get "<package>.tar.gz"        /restore/<package>.tar.gz
node scripts/dr/spaces-sync.mjs offsite-get "<package>.tar.gz.sha256" /restore/<package>.tar.gz.sha256
(cd /restore && sha256sum -c <package>.tar.gz.sha256)
scripts/dr/verify.sh /restore/<package>.tar.gz
# empty PostgreSQL 18 + an EMPTY test bucket (never the production bucket):
UPLOAD_STORAGE_DRIVER=spaces DO_SPACES_BUCKET=<test-bucket> DO_SPACES_PUBLIC_URL=<test-bucket-url> ... \
scripts/dr/restore.sh /restore/<package>.tar.gz --target-url postgresql://postgres:...@localhost:5432/tempworks \
    --create-db --roles
```

4. Start the backend from the same release against that database with **no** `RESEND_API_KEY`
   and **no** `BACKUP_SCHEDULE_CRON`, then repeat the checks of
   `backend/scripts/dr/drill/verify-recovery.mjs` (login, tenant isolation, attachments, uploads, CRUD).

**Managed-database specifics to confirm during this step** (not verifiable locally):
- `pg_dumpall --globals-only` as the DO app user: the manifest records `components.globals.captured`.
  If false, recreate the app role on the target and restore with `--role-map <old>:<new>` or `--no-owner`.
- On a DO target, `doadmin`/`_dodb` are provider roles: `restore.sh` skips them explicitly (logged).
- If the target app user differs (DO generates `doadmin`), map it: `--role-map doadmin:<target-role>`.

---

## 6. Rollback

All changes are additive and reversible:

| Change | Rollback |
|---|---|
| Code (backup service, scheduler, UI) | redeploy the previous release |
| `system_backups` new columns (kind, checksum, verifyResult, …) | leave in place — old code ignores them (additive, nullable/defaulted) |
| PG 18 client installed | harmless; `sudo apt-get remove postgresql-client-18` if required |
| `BACKUP_SCHEDULE_CRON` | unset the variable and restart → scheduling disabled |
| Off-site bucket | independent; disable by unsetting `BACKUP_SPACES_BUCKET` |

There is **no** schema migration to revert and **no** data rewrite on deploy.

---

## 7. What still needs production access (in order)

1. **Read the backend app spec (read-only, ~2 min).** Answers the remaining
   unknowns from §0 — build type (buildpack vs Dockerfile), instance count,
   region, attached database, env-var *names*. The `jq` filter prints env-var
   **keys only**, never values:

   ```bash
   doctl apps get 9a378360-409d-4dc8-960c-e170d41ff5e3 --format ID,Spec.Name,DefaultIngress,UpdatedAt
   doctl apps spec get 9a378360-409d-4dc8-960c-e170d41ff5e3 --format json | jq '{
     region,
     services: [.services[]? | {name, environment_slug, dockerfile_path, source_dir, build_command, run_command,
                instance_count, instance_size_slug, routes, github: (.github // .git // {} | {repo, branch, deploy_on_push}),
                env_keys: [.envs[]?.key]}],
     workers: [.workers[]?.name], jobs: [.jobs[]?.name],
     databases: [.databases[]? | {name, engine, version, production, cluster_name}] }'
   ```
   (Control-panel equivalent: Apps → `whale-app-j7l64` → Settings → App Spec;
   Activity tab for deploys around 2026-04-04 12:28 — confirms §1.)
2. Run the cross-tenant grant query in `docs/security/TENANT_FILE_ISOLATION_FIX.md`
   (read-only) and deploy that fix on its own.
3. Create the private off-site Spaces bucket + scoped key (§2); set `BACKUP_*`.
4. Build the backend with the PostgreSQL 18 client (§4) and deploy.
5. Take the first full-system backup; confirm `Off-site copy verified`.
6. Restore it in a protected environment (§5) and run the verification checklist.
7. Decide `BACKUP_SCHEDULE_CRON`/`TZ`, and whether managed-DB PITR is required.
