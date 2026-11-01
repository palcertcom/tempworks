#!/usr/bin/env python3
"""
apply-spec-patch.py — minimal, phase-by-phase App Spec patch for the TempWorks
backend component. Reads the CURRENT spec (from `doctl apps spec get <app-id>`)
and writes a patched spec that changes ONLY the listed fields of ONE component.
Everything else — other components, ingress, domains, alerts, region, every
other env var and every encrypted secret (EV[...] values) — is copied through
unchanged. A diff of exactly what changed is printed to stderr.

  python3 apply-spec-patch.py --phase 1 current.yaml > phase1.yaml
  python3 apply-spec-patch.py --phase 2 phase1-live.yaml > phase2.yaml
  python3 apply-spec-patch.py --phase 3 --database-ca-file do-ca.crt phase2-live.yaml > phase3.yaml

Phase 1  build from backend/Dockerfile (drop buildpack fields + run command),
         reconcile PORT with http_port, add the backup-destination settings.
         Requires BACKUP_SPACES_ACCESS_KEY / BACKUP_SPACES_SECRET_KEY to exist
         ALREADY as encrypted SECRET env vars (add them in the console first —
         this tool never handles secret values).
Phase 2  NODE_ENV=production.
Phase 3  trust the database CA (DATABASE_CA_CERT, public), verify migrations
         strictly, remove NODE_TLS_REJECT_UNAUTHORIZED. Only after
         scripts/ops/tls-check.mjs passed in the running container.

Refuses to run if any SECRET env var of the component is not EV[...]-encrypted
(i.e. the input would contain a plaintext secret), or if the component/fields
do not look as expected.
"""
import argparse, copy, difflib, re, sys
import yaml

COMPONENT = 'tempworksemployeerecruitmentcomp'


def die(msg):
    sys.stderr.write(f'apply-spec-patch: {msg}\n')
    sys.exit(2)


def find_component(spec, name):
    for kind in ('services', 'workers', 'jobs'):
        for c in spec.get(kind) or []:
            if c.get('name') == name:
                return kind, c
    die(f"component '{name}' not found in services/workers/jobs")


def env_map(c):
    return {e.get('key'): e for e in (c.get('envs') or [])}


def set_env(c, key, value, scope='RUN_TIME', typ='GENERAL'):
    envs = c.setdefault('envs', [])
    for e in envs:
        if e.get('key') == key:
            e['value'] = value
            return
    envs.append({'key': key, 'value': value, 'scope': scope, 'type': typ})


def del_env(c, key):
    c['envs'] = [e for e in (c.get('envs') or []) if e.get('key') != key]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--phase', type=int, choices=(1, 2, 3), required=True)
    ap.add_argument('--component', default=COMPONENT)
    ap.add_argument('--port-mode', choices=('delete-env', 'set-8080', 'keep'), default='delete-env',
                    help='phase 1: how to reconcile PORT with http_port (see docs §PORT)')
    ap.add_argument('--backup-endpoint', default='https://ams3.digitaloceanspaces.com')
    ap.add_argument('--backup-region', default='ams3')
    ap.add_argument('--backup-bucket', default='tempworks-dr-backups')
    ap.add_argument('--backup-prefix', default='dr/')
    ap.add_argument('--retention', default='14')
    ap.add_argument('--schedule-cron', default='', help='e.g. "47 1 * * *"; empty = leave scheduling off')
    ap.add_argument('--schedule-tz', default='Europe/Bratislava')
    ap.add_argument('--database-ca-file', help='phase 3: PEM file of the database cluster CA (public)')
    ap.add_argument('--strict-migrations', choices=('1', '0'), default='1')
    ap.add_argument('spec')
    a = ap.parse_args()

    raw = open(a.spec).read()
    spec = yaml.safe_load(raw)
    before = copy.deepcopy(spec)
    kind, c = find_component(spec, a.component)
    envs = env_map(c)

    for k, e in envs.items():
        if e.get('type') == 'SECRET' and not str(e.get('value', '')).startswith('EV['):
            die(f"secret env '{k}' is not EV[...]-encrypted in the input — refusing to handle plaintext secrets")

    if a.phase == 1:
        if c.get('dockerfile_path'):
            die('dockerfile_path already set — phase 1 already applied?')
        c['dockerfile_path'] = 'backend/Dockerfile'
        if c.get('source_dir', '').strip('/') != 'backend':
            die(f"unexpected source_dir {c.get('source_dir')!r} (expected /backend: the Docker build context)")
        for f in ('environment_slug', 'build_command', 'run_command'):
            c.pop(f, None)  # buildpack-only fields; run_command would override the image entrypoint
        http_port = c.get('http_port', 8080)
        if a.port_mode == 'delete-env':
            del_env(c, 'PORT')  # App Platform then injects PORT = http_port
        elif a.port_mode == 'set-8080':
            if http_port != 8080:
                die(f'http_port is {http_port}, not 8080')
            set_env(c, 'PORT', '8080')
        for key in ('BACKUP_SPACES_ACCESS_KEY', 'BACKUP_SPACES_SECRET_KEY'):
            e = envs.get(key)
            if not e or e.get('type') != 'SECRET':
                die(f'{key} must already exist as an encrypted SECRET env var on the component (add it in the console first)')
        if a.backup_bucket == (envs.get('DO_SPACES_BUCKET') or {}).get('value'):
            die('backup bucket must differ from the live upload bucket')
        for k, v in (('BACKUP_ENGINE', 'stream'), ('BACKUP_SPACES_ENDPOINT', a.backup_endpoint),
                     ('BACKUP_SPACES_REGION', a.backup_region), ('BACKUP_SPACES_BUCKET', a.backup_bucket),
                     ('BACKUP_SPACES_PREFIX', a.backup_prefix), ('BACKUP_RETENTION_COUNT', a.retention),
                     ('BACKUP_SCHEDULE_KIND', 'FULL_SYSTEM'), ('BACKUP_STALE_HOURS', '26')):
            set_env(c, k, v)
        if a.schedule_cron:
            set_env(c, 'BACKUP_SCHEDULE_CRON', a.schedule_cron)
            set_env(c, 'BACKUP_SCHEDULE_TZ', a.schedule_tz)
    elif a.phase == 2:
        if not c.get('dockerfile_path'):
            die('phase 1 (Dockerfile build) is not applied')
        set_env(c, 'NODE_ENV', 'production')
    else:
        if not a.database_ca_file:
            die('--database-ca-file is required for phase 3')
        pem = open(a.database_ca_file).read().strip()
        if 'BEGIN CERTIFICATE' not in pem or 'PRIVATE KEY' in pem:
            die('database CA file must contain only certificate(s)')
        set_env(c, 'DATABASE_CA_CERT', pem)
        set_env(c, 'DATABASE_TLS_STRICT_MIGRATIONS', a.strict_migrations)
        del_env(c, 'NODE_TLS_REJECT_UNAUTHORIZED')

    out = yaml.safe_dump(spec, sort_keys=False, default_flow_style=False, width=4096)
    # Self-check: nothing outside this component changed.
    b2, s2 = copy.deepcopy(before), copy.deepcopy(spec)
    for x in (b2, s2):
        x[kind] = [k for k in x[kind] if k.get('name') != a.component]
    if b2 != s2:
        die('internal error: a change escaped the target component')
    diff = difflib.unified_diff(yaml.safe_dump(before, sort_keys=False, width=4096).splitlines(),
                                out.splitlines(), 'current', f'phase{a.phase}', lineterm='', n=1)
    sys.stderr.write('\n'.join(re.sub(r'EV\[[^\]]*\]', 'EV[…]', d) for d in diff) + '\n')
    sys.stdout.write(out)


if __name__ == '__main__':
    main()
