-- Spike 001 — RLS + SET LOCAL validation
-- Removable: drop schema spike_rls cascade is NOT used because we use the
-- dedicated database `spike_rls`. Drop the database to clean up.

DROP TABLE IF EXISTS candidates CASCADE;
DROP TABLE IF EXISTS tenants CASCADE;

CREATE TABLE tenants (
  id          UUID PRIMARY KEY,
  name        TEXT NOT NULL
);

CREATE TABLE candidates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  email       TEXT NOT NULL,
  full_name   TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_candidates_tenant ON candidates(tenant_id, created_at DESC);
CREATE UNIQUE INDEX uq_candidates_tenant_email ON candidates(tenant_id, lower(email));

-- Seed two tenants and 1000 rows each
INSERT INTO tenants(id, name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Acme'),
  ('22222222-2222-2222-2222-222222222222', 'Globex');

INSERT INTO candidates(tenant_id, email, full_name)
SELECT '11111111-1111-1111-1111-111111111111', 'a' || g || '@acme.test', 'Acme User ' || g
FROM generate_series(1, 1000) g;

INSERT INTO candidates(tenant_id, email, full_name)
SELECT '22222222-2222-2222-2222-222222222222', 'b' || g || '@globex.test', 'Globex User ' || g
FROM generate_series(1, 1000) g;

-- RLS
ALTER TABLE candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidates FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON candidates
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Bypass policy for platform_admin role
CREATE POLICY platform_admin_bypass ON candidates
  TO spike_admin
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON candidates TO spike_app, spike_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenants    TO spike_app, spike_admin;
