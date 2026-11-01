# Phase 2.45 — per-recipient notification dedup

**12/12 PASS**

- PASS — 1. flag off: duplicates still created (legacy) — r1={"created":1,"deduped":0} r2={"created":1,"deduped":0} count=2
- PASS — 2. flag on: second identical suppressed — r1={"created":1,"deduped":0} r2={"created":0,"deduped":1} count=1
- PASS — 3. dedup does NOT suppress different user same tenant — r1={"created":1,"deduped":0} r2={"created":1,"deduped":0} totalA=2
- PASS — 4. dedup does NOT cross tenants — aCount=1 bCount=1
- PASS — 5. dedup does NOT suppress different event type — r1={"created":1,"deduped":0} r2={"created":1,"deduped":0} total=2
- PASS — 6. window respected: old row outside window does not suppress — r={"created":1,"deduped":0} total=2
- PASS — 7. tenant A dedup does NOT see tenant B rows — r={"created":1,"deduped":0} aCount=1
- PASS — 8. NULL-tenant legacy row does NOT suppress tenant-scoped notification — r={"created":1,"deduped":0} aCount=1
- PASS — 9. compliance coupling: first tick creates, second tick deduped — t1={"notified":1,"deduped":0} t2={"notified":0,"deduped":1}
- PASS — 10. scheduler health includes notifyDeduped counter — health={"status":"ok","notifyDeduped":2,"notifySucceeded":0}
- PASS — 11. missing tenant context refuses safely (assertTenantForFanout) — threw
- PASS — 12. concurrent tenant fan-outs remain isolated — a={"created":1,"deduped":0} b={"created":1,"deduped":0}
