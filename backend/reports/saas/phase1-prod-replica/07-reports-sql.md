# Audit G — Reports SQL

- **Status:** BLOCKER
- **Started:** 2026-05-09T14:53:03.117Z
- **Duration:** 351 ms

## Metrics

| Key | Value | Note |
|-----|-------|------|
| `reports.scanned-files` | 1 |  |
| `reports.source-decl-occurrences` | 3 |  |
| `reports.raw-sql-occurrences` | 13 |  |
| `reports.files-with-tenantColumn` | 0 |  |
| `exports.exceljs.files` | 6 |  |
| `exports.pdfkit.files` | 2 |  |
| `exports.docx.files` | 1 |  |

## Findings

- **[BLOCKER]** `reports.raw-sql-without-tenant-column` — Found 13 raw-SQL occurrences but no source declares `tenantColumn`. Phase 3 reports refactor (ADR-007) MUST land before Phase 2 enforcement.
  ```json
  [{"file":"src/reports/reports.service.ts","declarationsFound":3,"rawSqlOccurrences":13,"hasTenantColumnHint":false}]
  ```
- **[INFO]** `reports.files-listed` — Scanned 1 files.
  ```json
  [{"file":"src/reports/reports.service.ts","declarationsFound":3,"rawSqlOccurrences":13,"hasTenantColumnHint":false}]
  ```

## Notes
- This audit is static (no DB queries). It estimates the Phase 3 reports-engine refactor.
- Phase 1 does NOT touch the reports module.
