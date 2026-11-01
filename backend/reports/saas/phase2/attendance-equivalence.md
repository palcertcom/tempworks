# Phase 2.47 — attendance equivalence

**12/12 PASS**

- PASS — 1. pilot disabled returns legacy list shape — keys=data,meta
- PASS — 2. pilot disabled count matches legacy (>=2 employees) — total=10
- PASS — 3. pilot enabled response shape preserved — keys=data,meta
- PASS — 4. pilot enabled list ⊂ legacy union — legacy=10 pilotA=6
- PASS — 5. date-range filter equivalent (legacy >= pilot, both >0) — legacy=3 pilotA=3
- PASS — 6. employee filter works for same-tenant employee under pilot — id=eeeeeeea recs=0
- PASS — 7. pagination shape preserved (page=1 limit=1) — page=1 limit=1 data=1
- PASS — 8. mutation shape preserved (upsert returns id + employee) — id=19d63d25
- PASS — 9. allow-list unset ⇒ all modules allowed — both true
- PASS — 10. allow-list "attendance" allows attendance, denies others — att=true emp=false
- PASS — 11. allow-list comma-separated allows both — both true
- PASS — 12. allow-list "nothing" ⇒ scope inactive (legacy) — module "attendance" not in TENANT_PRISMA_PILOT_MODULES
