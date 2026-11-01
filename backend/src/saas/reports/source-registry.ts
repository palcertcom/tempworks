/**
 * Tenant-safe report source registry.
 *
 * Phase 2 ships this dormant. The legacy `SOURCE_DEFS` in
 * `backend/src/reports/reports.service.ts` continues to be the live
 * surface. Phase 3 cuts the live engine over to this registry.
 *
 * Public API:
 *   - `TenantSafeReportSourceRegistry.register(source)` — adds a
 *     definition; idempotent by `key`.
 *   - `TenantSafeReportSourceRegistry.get(key)` — read.
 *   - `TenantSafeReportSourceRegistry.validateAll()` — boot validator;
 *     returns `[]` if every source is safe; otherwise an array of
 *     `SourceValidationError`.
 *   - `TenantSafeReportSourceRegistry.assertAllValid()` — same but
 *     throws on violation (use in boot path).
 */
import { SourceDef, SourceValidationError } from './source-def.types';
import { ALLOWED_JOIN_TYPES, CATALOG_TABLES, joinHasTenantEquality } from './sql-guards';
import { renderJoin } from './join-builder';

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export class TenantSafeReportSourceRegistry {
  private readonly entries = new Map<string, SourceDef>();

  register(source: SourceDef): void {
    if (!IDENT_RE.test(source.key)) {
      throw new Error(`Invalid source key: ${JSON.stringify(source.key)}`);
    }
    this.entries.set(source.key, source);
  }

  get(key: string): SourceDef | undefined {
    return this.entries.get(key);
  }

  list(): ReadonlyArray<SourceDef> {
    return [...this.entries.values()];
  }

  size(): number {
    return this.entries.size;
  }

  /** Returns one error per offending property; never throws. */
  validateAll(): SourceValidationError[] {
    const errors: SourceValidationError[] = [];
    for (const s of this.entries.values()) {
      this.validateOne(s, errors);
    }
    return errors;
  }

  /** Throws an aggregated error if any source is invalid. */
  assertAllValid(): void {
    const errs = this.validateAll();
    if (!errs.length) return;
    const msg = errs.map((e) => `  ${e.source}: [${e.rule}] ${e.detail}`).join('\n');
    throw new Error(`TenantSafeReportSourceRegistry: ${errs.length} invalid source(s):\n${msg}`);
  }

  private validateOne(s: SourceDef, errors: SourceValidationError[]): void {
    const push = (rule: SourceValidationError['rule'], detail: string) =>
      errors.push({ source: s.key, rule, detail });

    if (!s.tenantColumn || !IDENT_RE.test(s.tenantColumn)) {
      if (!s.tenantColumn) push('missing-tenantColumn', `Source "${s.key}" must declare tenantColumn.`);
      else push('invalid-tenantColumn', `tenantColumn "${s.tenantColumn}" must match identifier regex.`);
    }
    if (!IDENT_RE.test(s.primaryTable)) push('invalid-primaryTable', `${s.primaryTable}`);
    if (!IDENT_RE.test(s.primaryAlias)) push('invalid-primaryAlias', `${s.primaryAlias}`);

    if (s.agencyColumn !== null && !IDENT_RE.test(s.agencyColumn)) {
      push('invalid-tenantColumn', `agencyColumn "${s.agencyColumn}" must be a valid identifier or null.`);
    }
    if (s.agencyColumn && !s.tenantColumn) {
      push('agencyColumn-without-tenantColumn',
        `agencyColumn requires tenantColumn (defense in depth).`);
    }

    for (const [name, fld] of Object.entries(s.fields)) {
      if (!IDENT_RE.test(name))      push('invalid-field-name', `${name}`);
      if (!IDENT_RE.test(fld.alias)) push('invalid-field-name', `${name}.alias=${fld.alias}`);
      if (!IDENT_RE.test(fld.dbCol)) push('invalid-field-dbCol', `${name}.dbCol=${fld.dbCol}`);
    }

    const aliasesSoFar = new Set<string>([s.primaryAlias]);
    for (const j of s.tenantAwareJoins) {
      if (!IDENT_RE.test(j.table)) push('invalid-join-table', `${j.table}`);
      if (!IDENT_RE.test(j.alias)) push('invalid-join-alias', `${j.alias}`);
      if (!ALLOWED_JOIN_TYPES.has(j.joinType)) {
        push('invalid-join-type', `Join "${j.alias}" has type "${j.joinType}". Only LEFT/INNER allowed.`);
        continue;
      }
      if (aliasesSoFar.has(j.alias)) {
        push('duplicate-join-alias', `alias "${j.alias}" reused in source "${s.key}"`);
        continue;
      }

      const kind = j.kind ?? 'tenant-equality';

      if (kind === 'catalog' && !CATALOG_TABLES.has(j.table)) {
        push('catalog-table-not-allowed',
          `Join "${j.alias}" uses kind=catalog on table "${j.table}" not in CATALOG_TABLES.`);
        continue;
      }

      if (j.structuredOn) {
        // Render once with the validator's alias set; renderer throws
        // structured errors that map cleanly onto our rule names.
        try {
          renderJoin(j, aliasesSoFar);
        } catch (e) {
          const msg = (e as Error).message;
          if (/literal/i.test(msg))            push('invalid-literal', msg);
          else if (/missing tenant/i.test(msg)) push('tenant-equality-missing-from-structured-join', msg);
          else if (/unknown alias/i.test(msg))  push('unknown-join-alias-reference', msg);
          else if (/duplicate/i.test(msg))      push('duplicate-join-alias', msg);
          else                                  push('join-missing-tenant-equality', msg);
          continue;
        }
      } else if (j.on) {
        // Legacy free-form path. Tenant-equality regex still applies
        // (catalog joins may legitimately omit it).
        if (kind !== 'catalog' && !joinHasTenantEquality(j.on)) {
          push('join-missing-tenant-equality',
            `Join on ${j.table} (alias ${j.alias}) does not equate tenant_id. ON: ${j.on}`);
          continue;
        }
      } else {
        push('join-missing-tenant-equality',
          `Join "${j.alias}" must declare structuredOn or on.`);
        continue;
      }

      aliasesSoFar.add(j.alias);
    }

    const fieldKeys = new Set(Object.keys(s.fields));
    for (const k of s.allowedFilterFields ?? []) {
      if (!fieldKeys.has(k)) push('unknown-allowed-filter', `${k}`);
    }
    for (const k of s.sortFields ?? []) {
      if (!fieldKeys.has(k)) push('unknown-sort-field', `${k}`);
    }
    for (const k of s.exportFields ?? []) {
      if (!fieldKeys.has(k)) push('unknown-export-field', `${k}`);
    }
    if (s.defaultSort && !fieldKeys.has(s.defaultSort.field)) {
      push('unknown-default-sort', `${s.defaultSort.field}`);
    }
  }
}

/**
 * Process-wide singleton. Mounted by the dormant report module in
 * Phase 2; consumed by the live engine in Phase 3.
 */
export const tenantSafeReportSources = new TenantSafeReportSourceRegistry();
