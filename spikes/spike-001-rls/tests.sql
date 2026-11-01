-- Test 1: SELECT outside transaction WITHOUT setting GUC → expect zero rows under FORCE RLS
\echo '--- TEST 1: no GUC, no transaction (default app role) ---'
SET ROLE spike_app;
SELECT count(*) AS rows_visible FROM candidates;
RESET ROLE;

-- Test 2: SET LOCAL inside transaction → only that tenant's rows
\echo '--- TEST 2: SET LOCAL in transaction (tenant Acme) ---'
SET ROLE spike_app;
BEGIN;
  SET LOCAL app.tenant_id = '11111111-1111-1111-1111-111111111111';
  SELECT count(*) AS acme_rows FROM candidates;
COMMIT;
RESET ROLE;

-- Test 3: After commit, GUC drops; another statement sees zero
\echo '--- TEST 3: after COMMIT, GUC gone, expect 0 ---'
SET ROLE spike_app;
SELECT count(*) AS post_commit_rows FROM candidates;
RESET ROLE;

-- Test 4: Without LOCAL, plain SET in transaction-pooler-equivalent
\echo '--- TEST 4: SET (no LOCAL) inside tx then query in same session OUT of tx ---'
SET ROLE spike_app;
BEGIN;
  SET app.tenant_id = '11111111-1111-1111-1111-111111111111';
COMMIT;
SELECT count(*) AS plain_set_visible FROM candidates;
RESET ROLE;

-- Test 5: WITH CHECK enforcement on INSERT — try to insert under tenant A while GUC is tenant B
\echo '--- TEST 5: insert mismatched tenant under GUC=B → expect failure ---'
SET ROLE spike_app;
BEGIN;
  SET LOCAL app.tenant_id = '22222222-2222-2222-2222-222222222222';
  -- Attempt to insert a row tagged as tenant A
  DO $$ BEGIN
    BEGIN
      INSERT INTO candidates(tenant_id, email, full_name)
      VALUES ('11111111-1111-1111-1111-111111111111', 'leak@x.test', 'leak');
      RAISE NOTICE 'INSERT SUCCEEDED — RLS BYPASSED!';
    EXCEPTION WHEN insufficient_privilege OR check_violation THEN
      RAISE NOTICE 'INSERT BLOCKED by RLS WITH CHECK — OK';
    END;
  END $$;
ROLLBACK;
RESET ROLE;

-- Test 6: Platform admin role bypass
\echo '--- TEST 6: spike_admin sees both tenants ---'
SET ROLE spike_admin;
SELECT tenant_id, count(*) FROM candidates GROUP BY tenant_id ORDER BY tenant_id;
RESET ROLE;

-- Test 7: Nested transaction (savepoint) keeps GUC
\echo '--- TEST 7: nested savepoint preserves SET LOCAL ---'
SET ROLE spike_app;
BEGIN;
  SET LOCAL app.tenant_id = '11111111-1111-1111-1111-111111111111';
  SELECT count(*) AS rows_outer FROM candidates;
  SAVEPOINT sp;
    SELECT count(*) AS rows_inner FROM candidates;
  RELEASE SAVEPOINT sp;
  SELECT count(*) AS rows_after_release FROM candidates;
COMMIT;
RESET ROLE;

-- Test 8: Concurrent-tenant simulation in same connection
\echo '--- TEST 8: switching GUC between txns on same connection ---'
SET ROLE spike_app;
BEGIN;
  SET LOCAL app.tenant_id = '11111111-1111-1111-1111-111111111111';
  SELECT count(*) AS first_tx FROM candidates;
COMMIT;
BEGIN;
  SET LOCAL app.tenant_id = '22222222-2222-2222-2222-222222222222';
  SELECT count(*) AS second_tx FROM candidates;
COMMIT;
RESET ROLE;

-- Test 9: Forgotten GUC mid-transaction (set then unset attempts)
\echo '--- TEST 9: explicit RESET inside tx → 0 rows ---'
SET ROLE spike_app;
BEGIN;
  SET LOCAL app.tenant_id = '11111111-1111-1111-1111-111111111111';
  SELECT count(*) AS before_reset FROM candidates;
  RESET app.tenant_id;
  SELECT count(*) AS after_reset FROM candidates;
COMMIT;
RESET ROLE;

-- Test 10: Performance — 1000 SELECTs with vs without TX wrapper
\echo '--- TEST 10: timing 1000 selects under tx wrapper ---'
SET ROLE spike_app;
\timing on
DO $$
DECLARE
  i INT;
  c INT;
BEGIN
  FOR i IN 1..1000 LOOP
    PERFORM set_config('app.tenant_id','11111111-1111-1111-1111-111111111111', true);
    SELECT count(*) INTO c FROM candidates;
  END LOOP;
END $$;
\timing off
RESET ROLE;
