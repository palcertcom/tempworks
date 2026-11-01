-- ─────────────────────────────────────────────────────────────────────────────
-- prereqs.sql — database prerequisites that pg_dump does NOT contain, read from
-- catalogs every role can read (pg_roles, pg_auth_members, pg_db_role_setting,
-- object owners/ACLs). Needs no superuser and no CONNECT on other databases,
-- so it works where `pg_dumpall --globals-only` is refused (managed providers).
--
-- Output: ONE JSON document
--   requiredRoles  every role the restored database needs: object/database
--                  owners, ACL grantees (incl. column ACLs and default
--                  privileges), RLS policy roles, the connecting role, and the
--                  membership closure of those (parents and members)
--   roles          their attributes, memberships and cluster-wide settings
--                  (never passwords)
--   extensions     installed extensions (pg_dump re-creates them; the TARGET
--                  must offer them)
--   tablespaces    non-default tablespaces used by this database
-- ─────────────────────────────────────────────────────────────────────────────
WITH RECURSIVE
ns AS (
  SELECT oid FROM pg_namespace
   WHERE nspname NOT IN ('pg_catalog', 'information_schema') AND nspname NOT LIKE 'pg\_toast%' AND nspname NOT LIKE 'pg\_temp%'
),
direct(oid, why) AS (
  SELECT datdba, 'database owner' FROM pg_database WHERE datname = current_database()
  UNION SELECT (SELECT oid FROM pg_roles WHERE rolname = current_user), 'connecting role'
  UNION SELECT nspowner, 'schema owner' FROM pg_namespace WHERE oid IN (SELECT oid FROM ns)
  UNION SELECT relowner, 'relation owner' FROM pg_class WHERE relnamespace IN (SELECT oid FROM ns)
  UNION SELECT proowner, 'function owner' FROM pg_proc WHERE pronamespace IN (SELECT oid FROM ns)
  UNION SELECT typowner, 'type owner' FROM pg_type WHERE typnamespace IN (SELECT oid FROM ns)
  UNION SELECT conowner, 'conversion owner' FROM pg_conversion WHERE connamespace IN (SELECT oid FROM ns)
  UNION SELECT oprowner, 'operator owner' FROM pg_operator WHERE oprnamespace IN (SELECT oid FROM ns)
  UNION SELECT collowner, 'collation owner' FROM pg_collation WHERE collnamespace IN (SELECT oid FROM ns)
  UNION SELECT extowner, 'extension owner' FROM pg_extension
  UNION SELECT lomowner, 'large object owner' FROM pg_largeobject_metadata
  UNION SELECT evtowner, 'event trigger owner' FROM pg_event_trigger
  UNION SELECT pubowner, 'publication owner' FROM pg_publication
  UNION SELECT defaclrole, 'default privileges owner' FROM pg_default_acl
  UNION SELECT (aclexplode(relacl)).grantee, 'grantee (relation)' FROM pg_class WHERE relacl IS NOT NULL AND relnamespace IN (SELECT oid FROM ns)
  UNION SELECT (aclexplode(attacl)).grantee, 'grantee (column)' FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
         WHERE a.attacl IS NOT NULL AND c.relnamespace IN (SELECT oid FROM ns)
  UNION SELECT (aclexplode(nspacl)).grantee, 'grantee (schema)' FROM pg_namespace WHERE nspacl IS NOT NULL AND oid IN (SELECT oid FROM ns)
  UNION SELECT (aclexplode(proacl)).grantee, 'grantee (function)' FROM pg_proc WHERE proacl IS NOT NULL AND pronamespace IN (SELECT oid FROM ns)
  UNION SELECT (aclexplode(typacl)).grantee, 'grantee (type)' FROM pg_type WHERE typacl IS NOT NULL AND typnamespace IN (SELECT oid FROM ns)
  UNION SELECT (aclexplode(datacl)).grantee, 'grantee (database)' FROM pg_database WHERE datacl IS NOT NULL AND datname = current_database()
  UNION SELECT (aclexplode(lomacl)).grantee, 'grantee (large object)' FROM pg_largeobject_metadata WHERE lomacl IS NOT NULL
  UNION SELECT (aclexplode(defaclacl)).grantee, 'grantee (default privileges)' FROM pg_default_acl
  UNION SELECT unnest(polroles), 'RLS policy role' FROM pg_policy
),
seed AS (SELECT DISTINCT oid FROM direct WHERE oid IS NOT NULL AND oid <> 0),
closure(oid) AS (                                   -- parents and members, recursively
  SELECT oid FROM seed
  UNION
  SELECT x.other FROM closure c
    JOIN (SELECT member AS a, roleid AS other FROM pg_auth_members
          UNION ALL SELECT roleid, member FROM pg_auth_members) x ON x.a = c.oid
),
req AS (
  SELECT r.* FROM pg_roles r WHERE r.oid IN (SELECT oid FROM closure) AND r.rolname !~ '^pg_'
)
SELECT json_build_object(
  'capturedAt', now(),
  'database', current_database(),
  'connectingRole', current_user,
  'serverVersionNum', current_setting('server_version_num')::int,
  'requiredRoles', COALESCE((SELECT json_agg(rolname ORDER BY rolname) FROM req), '[]'),
  'roles', COALESCE((SELECT json_agg(json_build_object(
      'name', r.rolname, 'superuser', r.rolsuper, 'inherit', r.rolinherit, 'createrole', r.rolcreaterole,
      'createdb', r.rolcreatedb, 'login', r.rolcanlogin, 'replication', r.rolreplication,
      'bypassrls', r.rolbypassrls, 'connectionLimit', r.rolconnlimit, 'validUntil', r.rolvaliduntil,
      'why', COALESCE((SELECT json_agg(DISTINCT d.why) FROM direct d WHERE d.oid = r.oid), '["membership closure"]'),
      'settings', COALESCE((SELECT json_agg(s) FROM pg_db_role_setting rs, unnest(rs.setconfig) s
                             WHERE rs.setrole = r.oid AND rs.setdatabase = 0), '[]'),
      'memberOf', COALESCE((SELECT json_agg(jsonb_build_object('role', pr.rolname) || (to_jsonb(m) - 'oid' - 'roleid' - 'member' - 'grantor'))
                             FROM pg_auth_members m JOIN pg_roles pr ON pr.oid = m.roleid
                            WHERE m.member = r.oid AND pr.rolname !~ '^pg_'), '[]'),
      'builtinMemberOf', COALESCE((SELECT json_agg(pr.rolname) FROM pg_auth_members m JOIN pg_roles pr ON pr.oid = m.roleid
                            WHERE m.member = r.oid AND pr.rolname ~ '^pg_'), '[]')
    ) ORDER BY r.rolname) FROM req r), '[]'),
  'extensions', COALESCE((SELECT json_agg(json_build_object('name', e.extname, 'version', e.extversion, 'schema', n.nspname) ORDER BY e.extname)
                            FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace), '[]'),
  'tablespaces', COALESCE((SELECT json_agg(DISTINCT t.spcname) FROM pg_class c JOIN pg_tablespace t ON t.oid = c.reltablespace
                            WHERE c.reltablespace <> 0 AND t.spcname NOT IN ('pg_default', 'pg_global')), '[]')
);
