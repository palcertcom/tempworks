# Phase 2.61 — pipeline equivalence

**12/12 PASS**

- PASS — 1. pilot disabled returns legacy list shape — workflows=3
- PASS — 2. pilot disabled getWorkflow matches legacy — id=00000000 stages=2
- PASS — 3. pilot enabled response shape preserved (array) — count=1
- PASS — 4. pilot enabled candidates ⊂ legacy union — legacy=3 pilotA=1
- PASS — 5. getWorkflow under pilot returns same workflow id (workflows are global) — id=00000000
- PASS — 6. stages list shape preserved (id/name/order) — stages=2
- PASS — 7. getWorkflowStats keys preserved — keys=totalActive,totalCompleted,flaggedCount,slaBreached
- PASS — 8. getWorkflowBoardView shape preserved (workflow + columns) — columns=2
- PASS — 9. allow-list unset ⇒ all modules allowed — both true
- PASS — 10. allow-list "pipeline" allows pipeline, denies others — pipeline=true audit=false
- PASS — 11. allow-list comma-separated allows both — both true
- PASS — 12. allow-list "nothing" ⇒ scope inactive (legacy) — module "pipeline" not in TENANT_PRISMA_PILOT_MODULES
