# Phase 2.62 — pipeline mutation isolation

**17/17 PASS**

- PASS — 1. pilot off: assignment reads succeed (legacy-compatible) — count=3
- PASS — 2. pilot A reads: every returned assignment has tenantId=A — count=1
- PASS — 3. assignEmployee remains a documented BadRequest (no mutation surface) — forbidden_by_product
- PASS — 4. tenant A cannot assign tenant B candidate (NotFound) — NotFound
- PASS — 5. employee assign mutation surface forbidden by product (covers cross-tenant trivially) — see case 3
- PASS — 6. rejected tenant B assign creates no row in tenant A scope — count=0
- PASS — 7. tenant A can advance tenant A assignment (passes tenant gate) — success
- PASS — 8. tenant A cannot advance tenant B assignment (NotFound) — NotFound
- PASS — 9. rejected tenant B advance leaves progress unchanged — status=IN_PROGRESS
- PASS — 10. tenant A can toggle flag on tenant A progress — success
- PASS — 11. tenant A cannot toggle flag on tenant B progress (NotFound) — NotFound
- PASS — 12. tenant A cannot mutate NULL-tenant legacy assignment (NotFound) — NotFound
- PASS — 13. audit row tenant A carries tenantId=A (audit pilot ON) — tenantId=11111111
- PASS — 14. rejected tenant B mutation emits no audit row — before=0 after=0
- PASS — 15. workflow CONFIG remains global (same id visible to A and B) — A=00000000 B=00000000
- PASS — 16. concurrent ALS frames remain isolated for advanceToStage — A.blocked=true B.blocked=true
- PASS — 17. source-level: every candidateWorkflowAssignment.create site spreads tenantData() — creates=1 stamped=1
