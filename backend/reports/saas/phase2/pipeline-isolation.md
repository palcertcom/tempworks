# Phase 2.61 — pipeline isolation

**12/12 PASS**

- PASS — 1. tenant A getWorkflowCandidates returns only tenant A — count=1
- PASS — 2. tenant A excludes tenant B candidates — B excluded
- PASS — 3. tenant A excludes NULL-tenant assignments — NULL excluded
- PASS — 4. tenant B getWorkflowCandidates returns only tenant B — count=1
- PASS — 5. tenant A getWorkflowStats counts only tenant A — active=2 completed=1
- PASS — 6. tenant B getWorkflowStats counts only tenant B — active=2 completed=0
- PASS — 7. tenant A board view counts only tenant A subjects in columns — totalCount=1
- PASS — 8. concurrent ALS frames stay isolated for getWorkflowCandidates — A=1 B=1
- PASS — 9. allow-list "nothing" ⇒ legacy union (B + NULL visible) — B=true NULL=true
- PASS — 10. workflow CONFIG (getWorkflow) remains global — tenant A sees the global workflow id — id=00000000
- PASS — 11. mutation paths still flow through pilot.prisma (createWorkflow present) — createWorkflow present
- PASS — 12. audit emission routes through TenantAuditLogService (Phase 2.62) — helper=true noRawCreate=true
