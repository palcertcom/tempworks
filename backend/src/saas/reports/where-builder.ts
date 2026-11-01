/**
 * Tenant-safe WHERE composer.
 *
 * Generates a clause of the shape:
 *   <primary>.<tenantColumn> = $1
 *   [ AND <primary>.<agencyColumn> IN ($2, ...) ]
 *   [ AND <primary>."deletedAt" IS NULL ]
 *   [ AND <user filters AND-only, parameterised> ]
 *
 * The tenant term is ALWAYS first. User filters can never displace it.
 * Identifiers are quoted via `colRef`. Values are positional parameters.
 * Operators are an allow-listed enum.
 */
import { SourceDef, FieldDef } from './source-def.types';
import { ALLOWED_OPS, assertOp, assertUuid, colRef, looksLikeUnsafeSql } from './sql-guards';

export interface UserFilter {
  /** A field name from `SourceDef.fields`. */
  field: string;
  op:
    | '=' | '!=' | '<' | '<=' | '>' | '>='
    | 'ILIKE' | 'IN' | 'BETWEEN' | 'IS NULL' | 'IS NOT NULL';
  /** Value(s) — type-checked against field.type by the caller. */
  value?: unknown;
  /** For BETWEEN / IN. */
  values?: unknown[];
}

export interface BuildContext {
  /** Active tenant id from `TenantContext.current()`. */
  tenantId: string;
  /** Optional set of agencies the caller is scoped to. Empty array = full tenant. */
  agencyIds?: ReadonlyArray<string>;
  /** Whether the caller has platform-admin privileges. */
  platformAdmin: boolean;
}

export interface BuiltWhere {
  sql: string;
  params: unknown[];
}

export function buildTenantSafeWhere(
  src: SourceDef,
  filters: ReadonlyArray<UserFilter>,
  ctx: BuildContext,
): BuiltWhere {
  if (src.platformAdminOnly && !ctx.platformAdmin) {
    throw new Error(`Source "${src.key}" is platform-admin only`);
  }
  if (!src.tenantColumn) {
    throw new Error(`Source "${src.key}" missing tenantColumn`);
  }

  const params: unknown[] = [];
  const parts: string[] = [];

  // 1. Tenant filter — ALWAYS the first AND-term.
  params.push(assertUuid(ctx.tenantId, 'BuildContext.tenantId'));
  parts.push(`${colRef(src.primaryAlias, src.tenantColumn)} = $${params.length}`);

  // 2. Agency-scope filter.
  if (src.agencyColumn && ctx.agencyIds && ctx.agencyIds.length > 0) {
    const placeholders: string[] = [];
    for (const a of ctx.agencyIds) {
      params.push(assertUuid(a, 'BuildContext.agencyIds[]'));
      placeholders.push(`$${params.length}`);
    }
    parts.push(`${colRef(src.primaryAlias, src.agencyColumn)} IN (${placeholders.join(', ')})`);
  }

  // 3. Soft-delete filter.
  if (src.softDelete) {
    parts.push(`${colRef(src.primaryAlias, 'deletedAt')} IS NULL`);
  }

  // 4. User filters — AND-only, allow-listed operators, whitelisted fields.
  for (const f of filters) {
    const def: FieldDef | undefined = src.fields[f.field];
    if (!def) throw new Error(`unknown field: ${JSON.stringify(f.field)}`);
    assertOp(f.op);
    const lhs = colRef(def.alias, def.dbCol);

    if (f.op === 'IS NULL' || f.op === 'IS NOT NULL') {
      parts.push(`${lhs} ${f.op}`);
    } else if (f.op === 'IN') {
      const arr = f.values ?? (Array.isArray(f.value) ? (f.value as unknown[]) : []);
      if (arr.length === 0) throw new Error(`IN requires non-empty array for field ${f.field}`);
      const placeholders: string[] = [];
      for (const v of arr) {
        if (typeof v === 'string' && looksLikeUnsafeSql(v)) {
          throw new Error(`refusing unsafe value for ${f.field}`);
        }
        params.push(v);
        placeholders.push(`$${params.length}`);
      }
      parts.push(`${lhs} IN (${placeholders.join(', ')})`);
    } else if (f.op === 'BETWEEN') {
      const [a, b] = f.values ?? [];
      if (a === undefined || b === undefined) throw new Error(`BETWEEN requires [from, to]`);
      params.push(a, b);
      parts.push(`${lhs} BETWEEN $${params.length - 1} AND $${params.length}`);
    } else {
      if (typeof f.value === 'string' && looksLikeUnsafeSql(f.value)) {
        throw new Error(`refusing unsafe value for ${f.field}`);
      }
      params.push(f.value);
      parts.push(`${lhs} ${f.op} $${params.length}`);
    }
  }

  return { sql: parts.join(' AND '), params };
}

/**
 * For consumers that prefer a Prisma `Sql` payload — small adapter.
 * Phase 3 will wire this through `TenantPrismaService.withTenant(...)`.
 *
 * Stays as a string + params here to keep the dormant module dependency-
 * free. Adapter lives in the wiring step.
 */
export function buildTenantSafeWhereDebug(
  src: SourceDef,
  filters: ReadonlyArray<UserFilter>,
  ctx: BuildContext,
): { sql: string; params: unknown[] } {
  return buildTenantSafeWhere(src, filters, ctx);
}
