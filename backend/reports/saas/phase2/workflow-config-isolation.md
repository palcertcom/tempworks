# Phase 2.63 — workflow config tenant-scope isolation

**19/19 PASS**

- PASS — 1. pilot off: createWorkflow returns row with tenantId=null (legacy) — tenantId=null
- PASS — 2. pilot A: createWorkflow stamps tenantId=A — tenantId=11111111
- PASS — 3. pilot A: createWorkflow(isDefault=true) flips ONLY own-tenant defaults — A.isDefault=false B.isDefault=true new=true
- PASS — 4. listWorkflows pilot A: own + NULL-global only (no B rows) — A=true B=false global=true
- PASS — 5. listWorkflows pilot B: own + NULL-global only (no A rows) — A=false B=true global=true
- PASS — 6. getWorkflow pilot A: own workflow visible — id=00000000
- PASS — 7. getWorkflow pilot A: NULL-global template visible — id=00000000
- PASS — 8. getWorkflow pilot A: tenant B workflow → NotFound — NotFound
- PASS — 9. updateWorkflow pilot A: NULL-global template refused (NotFound) — NotFound
- PASS — 10. updateWorkflow pilot A: tenant B workflow → NotFound — NotFound
- PASS — 11. updateWorkflow pilot A: own workflow → success — description=owned-update
- PASS — 12. deleteWorkflow pilot A: NULL-global → NotFound — NotFound
- PASS — 13. archiveWorkflow pilot A: tenant B → NotFound — NotFound
- PASS — 14. addStage pilot A: tenant B parent → NotFound + no row inserted — threw=true before=1 after=1
- PASS — 15. updateStage pilot A: stage in NULL-global → NotFound — NotFound
- PASS — 16. deleteStage pilot A: stage in NULL-global → NotFound — NotFound
- PASS — 17. addAccessUser pilot A: tenant B parent → NotFound — NotFound
- PASS — 18. concurrent ALS frames remain isolated for updateWorkflow — A.blocked=true B.blocked=true
- PASS — 19. source-level: helpers defined + wired into update/archive/delete/stage routes + createWorkflow stamps tenantData() — readWhere=true mutWhere=true mutOrFail=true gated=true createStamped=true
