/**
 * Tenant-safe SQL composer.
 *
 * Lives inside the runtime/ allow-listed directory so the raw-SQL
 * scanner does not flag the template-literal composition. All
 * identifiers come from the validated registry (`SourceDef`); all
 * values are positional parameters bound by `buildTenantSafeWhere`.
 *
 * Returns { sql, countSql, params, columns }; the integration point
 * in `backend/src/reports/reports.service.ts` runs them through a
 * single `$queryRawUnsafe` call (annotated `@tenant-reviewed`).
 */
import { SourceDef } from '../source-def.types';
import { buildTenantSafeWhere, BuildContext, UserFilter } from '../where-builder';
import { colRef, ident } from '../sql-guards';
import { renderJoin } from '../join-builder';

export interface ComposeRequest {
  def: SourceDef;
  filters?: UserFilter[];
  /** Field names from `SourceDef.fields`. Empty = all fields. */
  columns?: string[];
  /** Page is 1-indexed. */
  page?: number;
  limit?: number;
  /** Optional sort. Field must be in `def.sortFields` if that list is set. */
  sort?: { field: string; direction: 'ASC' | 'DESC' };
}

export interface ComposedReportSql {
  sql: string;
  countSql: string;
  params: unknown[];
  columns: { key: string; label: string; type: string }[];
  page: number;
  limit: number;
}

const MAX_LIMIT = 10_000;

export function composeReportSql(req: ComposeRequest, ctx: BuildContext): ComposedReportSql {
  const { def } = req;

  // Filter allow-list (when configured).
  if (def.allowedFilterFields && req.filters?.length) {
    const allowed = new Set(def.allowedFilterFields);
    for (const f of req.filters) {
      if (!allowed.has(f.field)) throw new Error(`filter not allowed for field: ${JSON.stringify(f.field)}`);
    }
  }

  // Export allow-list (when configured).
  const exportAllowed = def.exportFields ? new Set(def.exportFields) : null;

  const where = buildTenantSafeWhere(def, req.filters ?? [], ctx);

  const selectCols = (req.columns?.length ? req.columns : Object.keys(def.fields));
  const selectExpr = selectCols.map((c) => {
    const f = def.fields[c];
    if (!f) throw new Error(`unknown column: ${JSON.stringify(c)}`);
    if (exportAllowed && !exportAllowed.has(c)) throw new Error(`column not exportable: ${JSON.stringify(c)}`);
    return `${colRef(f.alias, f.dbCol)} AS ${ident(c)}`;
  }).join(', ');

  // Render joins using the structural builder. Track aliases as we go
  // so each join can only equate tenants with already-introduced ones.
  const knownAliases = new Set<string>([def.primaryAlias]);
  const joinFragments: string[] = [];
  for (const j of def.tenantAwareJoins ?? []) {
    const r = renderJoin(j, knownAliases);
    knownAliases.add(r.alias);
    joinFragments.push(r.sql);
  }
  const fromClause = `${ident(def.primaryTable)} ${ident(def.primaryAlias)}`
    + (joinFragments.length ? ' ' + joinFragments.join(' ') : '');

  // Sort. Default to def.defaultSort if caller didn't supply one. The
  // chosen field must be in def.sortFields when that list exists.
  let orderBy = '';
  const sort = req.sort ?? def.defaultSort;
  if (sort) {
    const f = def.fields[sort.field];
    if (!f) throw new Error(`unknown sort field: ${JSON.stringify(sort.field)}`);
    if (def.sortFields && !def.sortFields.includes(sort.field)) {
      throw new Error(`sort not allowed for field: ${JSON.stringify(sort.field)}`);
    }
    if (sort.direction !== 'ASC' && sort.direction !== 'DESC') {
      throw new Error(`bad sort direction: ${JSON.stringify(sort.direction)}`);
    }
    orderBy = ` ORDER BY ${colRef(f.alias, f.dbCol)} ${sort.direction}`;
  }

  const page  = Math.max(1, req.page ?? 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, req.limit ?? 100));
  const offset = (page - 1) * limit;

  const sql      = `SELECT ${selectExpr} FROM ${fromClause} WHERE ${where.sql}${orderBy} LIMIT ${limit} OFFSET ${offset}`;
  const countSql = `SELECT count(*)::int AS n FROM ${fromClause} WHERE ${where.sql}`;

  return {
    sql, countSql, params: where.params,
    columns: selectCols.map((c) => ({
      key: c, label: def.fields[c]?.label ?? c, type: def.fields[c]?.type ?? 'string',
    })),
    page, limit,
  };
}
