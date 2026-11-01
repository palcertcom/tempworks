# Phase 3.7B — JWT dual-read bake check

**14/14 PASS**

Local fixture probe: avg=2745μs p95=4431μs p99=6649μs over 50 validations.
> Numbers are local-only and NOT a production performance claim.

- PASS — 1. signal agreement report runs read-only — noWrites=true readOnlyTxn=true
- PASS — 2. signal agreement report writes JSON and MD — md=true hasTotals=true
- PASS — 3. legacyOnly users counted — legacyOnly=0
- PASS — 4. platformOnly users counted — platformOnly=0
- PASS — 5. agreementBoth users counted — agreementBoth=0
- PASS — 6. inactive/deleted PlatformAdmin users reported — inactivePlatform=0
- PASS — 7. report has explicit go/no-go fields — goPhase38=true blockers=0
- PASS — 8. JWT bake check preserves output shape — keys=agencyId,agencyIsSystem,email,firstName,id,lastName,role,roleId
- PASS — 9. JWT bake check confirms PlatformAdminAccessService is called — calls=50 probes=50
- PASS — 10. JWT bake check reports validation timings — avg=2745μs p95=4431μs p99=6649μs (LOCAL FIXTURE — NOT PROD)
- PASS — 11. no INSERT/UPDATE/DELETE in bake script source (outside seed templates) — bakeNoWrites=true sigNoWrites=true
- PASS — 12. Phase 3.7 JWT dual-read harness wiring intact — pkg.json
- PASS — 13. Phase 3.6 dual-read guard wiring intact — pkg.json
- PASS — 14. cumulative regression chain outputs present — present=12/12
