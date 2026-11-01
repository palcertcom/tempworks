#!/usr/bin/env python3
"""
prereqs.py — turn the JSON from prereqs.sql into a re-runnable roles.sql.

  prereqs.py roles-sql <prerequisites.json> [provider-roles-regex]  > roles.sql

roles.sql recreates every REQUIRED role of the database (never passwords),
their attributes, memberships and cluster-wide settings. It is idempotent and
provider-compatible:
  * runs as a superuser OR as a non-superuser with CREATEROLE (DigitalOcean
    "doadmin", RDS master user, …);
  * PostgreSQL 16+: sets createrole_self_grant='set, inherit' so the restoring
    role can SET ROLE to each role it creates — required to restore ownership;
  * attributes only a superuser may grant (SUPERUSER, REPLICATION, BYPASSRLS)
    are applied when possible and otherwise reported with a WARNING;
  * provider-managed roles (regex) are never created or altered — they exist on
    the provider's target or must be mapped with restore.sh --role-map.
"""
import json, re, sys


def q(ident):
    return '"' + ident.replace('"', '""') + '"'


def lit(s):
    return "'" + str(s).replace("'", "''") + "'"


def roles_sql(p, provider_re):
    prov = re.compile(provider_re)
    out = [
        f"-- Roles required by database {p.get('database')} (captured {p.get('capturedAt')}). No passwords:",
        "-- LOGIN roles must get theirs from the secret store after restore.",
        "\\set ON_ERROR_STOP on",
        "SELECT set_config('createrole_self_grant', 'set, inherit', false)",
        "  WHERE current_setting('server_version_num')::int >= 160000;",
    ]
    roles = [r for r in p.get('roles', []) if not prov.match(r['name'])]
    for r in roles:
        n = r['name']
        out.append(f"\n-- {n}: {', '.join(r.get('why') or [])}")
        out.append(f"DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = {lit(n)}) THEN CREATE ROLE {q(n)}; END IF; END $$;")
        attrs = [
            'INHERIT' if r['inherit'] else 'NOINHERIT',
            'LOGIN' if r['login'] else 'NOLOGIN',
            'CREATEDB' if r['createdb'] else 'NOCREATEDB',
            'CREATEROLE' if r['createrole'] else 'NOCREATEROLE',
            f"CONNECTION LIMIT {int(r['connectionLimit'])}",
        ]
        if r.get('validUntil'):
            attrs.append(f"VALID UNTIL {lit(r['validUntil'])}")
        out.append(f"ALTER ROLE {q(n)} WITH {' '.join(attrs)};")
        for attr, on in (('SUPERUSER', r['superuser']), ('REPLICATION', r['replication']), ('BYPASSRLS', r['bypassrls'])):
            if on:
                out.append(
                    "DO $$ BEGIN IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) "
                    f"THEN ALTER ROLE {q(n)} WITH {attr}; ELSE RAISE WARNING 'role {n}: {attr} not granted "
                    "(restoring role is not a superuser — provider restriction); grant it via the provider if needed'; END IF; END $$;")
        for s in r.get('settings') or []:
            k, _, v = s.partition('=')
            out.append(f"ALTER ROLE {q(n)} SET {k} = {lit(v)};")
    names = {r['name'] for r in roles}
    out.append("\n-- the restoring role must be able to SET ROLE to each role to restore ownership.")
    out.append("-- A non-superuser CREATEROLE admin (managed provider) has ADMIN on roles it created")
    out.append("-- (e.g. via globals.sql) but not necessarily SET; grant it to itself explicitly.")
    for r in roles:
        n = r['name']
        out.append(
            "DO $$ BEGIN IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AND current_user <> " + lit(n) + " THEN "
            "IF current_setting('server_version_num')::int >= 160000 THEN "
            "IF NOT pg_has_role(current_user, " + lit(n) + ", 'SET') THEN EXECUTE format('GRANT %I TO %I WITH SET TRUE, INHERIT TRUE', " + lit(n) + ", current_user); END IF; "
            "ELSIF NOT pg_has_role(current_user, " + lit(n) + ", 'MEMBER') THEN EXECUTE format('GRANT %I TO %I', " + lit(n) + ", current_user); END IF; "
            "END IF; EXCEPTION WHEN insufficient_privilege THEN RAISE WARNING 'cannot let % SET ROLE % (no ADMIN option on it) — restoring its ownership will fail', current_user, " + lit(n) + "; END $$;")
    out.append("\n-- memberships")
    for r in roles:
        for m in r.get('memberOf') or []:
            parent = m['role']
            if parent not in names:
                out.append(f"-- skipped: {r['name']} member of provider-managed role {parent}")
                continue
            opts = []
            if m.get('admin_option'):
                opts.append('ADMIN TRUE')
            if 'inherit_option' in m:
                opts.append(f"INHERIT {'TRUE' if m['inherit_option'] else 'FALSE'}")
            if 'set_option' in m:
                opts.append(f"SET {'TRUE' if m['set_option'] else 'FALSE'}")
            w = f" WITH {', '.join(opts)}" if opts else ''
            member = q(r['name'])
            plain = f"GRANT {q(parent)} TO {member}" + (' WITH ADMIN OPTION' if m.get('admin_option') else '')
            if 'inherit_option' in m or 'set_option' in m:   # PG16+ options; plain GRANT on older targets
                pg16 = f"GRANT {q(parent)} TO {member}{w}"
                out.append("DO $$ BEGIN IF current_setting('server_version_num')::int >= 160000 THEN "
                           f"EXECUTE {lit(pg16)}; ELSE EXECUTE {lit(plain)}; END IF; END $$;")
            else:
                out.append(plain + ';')
        for b in r.get('builtinMemberOf') or []:
            stmt = f"GRANT {q(b)} TO {q(r['name'])}"
            out.append(f"DO $$ BEGIN EXECUTE {lit(stmt)}; EXCEPTION WHEN insufficient_privilege THEN "
                       f"RAISE WARNING 'role {r['name']}: membership in built-in {b} not granted (provider restriction)'; END $$;")
    return '\n'.join(out) + '\n'


if __name__ == '__main__':
    cmd = sys.argv[1]
    p = json.load(open(sys.argv[2]))
    rx = sys.argv[3] if len(sys.argv) > 3 else r'^(postgres|doadmin|_dodb|rdsadmin|rds_superuser|rdsrepladmin|cloudsqladmin|cloudsqlsuperuser|azure_pg_admin|azuresu|pg_.*)$'
    if cmd == 'roles-sql':
        sys.stdout.write(roles_sql(p, rx))
    elif cmd == 'summary':
        prov = re.compile(rx)
        print(json.dumps({
            'requiredRoles': p.get('requiredRoles', []),
            'providerRoles': [n for n in p.get('requiredRoles', []) if prov.match(n)],
            'loginRoles': [r['name'] for r in p.get('roles', []) if r.get('login') and not prov.match(r['name'])],
            'extensions': [e['name'] for e in p.get('extensions', [])],
            'tablespaces': p.get('tablespaces', []),
        }))
    else:
        sys.exit(f'unknown command {cmd}')
