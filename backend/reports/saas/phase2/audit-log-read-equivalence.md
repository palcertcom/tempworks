# Phase 2.52 — audit-log read equivalence

**14/14 PASS**

- PASS — 1. pilot disabled returns legacy list shape — keys=data,meta
- PASS — 2. pilot disabled count matches legacy (>=5 Phase252A) — total=5
- PASS — 3. pilot enabled response shape preserved — keys=data,meta
- PASS — 4. pilot enabled list ⊂ legacy union — legacy=5 pilotA=4
- PASS — 5. entity filter preserved — entity=Phase252A
- PASS — 6. entityId filter preserved — entityId=...a01
- PASS — 7. action filter preserved — action=EQ_A_CREATE
- PASS — 8. userId filter preserved (zero match for synthetic id) — userId=synthetic
- PASS — 9. date range filter preserved — last 7 days
- PASS — 10. pagination shape preserved (page=1 limit=1) — page=1 limit=1
- PASS — 11. allow-list unset ⇒ all modules allowed — both true
- PASS — 12. allow-list "audit-logs" allows audit-logs, denies others — audit=true att=false
- PASS — 13. allow-list comma-separated allows both — both true
- PASS — 14. allow-list "nothing" ⇒ scope inactive (legacy) — module "audit-logs" not in TENANT_PRISMA_PILOT_MODULES
