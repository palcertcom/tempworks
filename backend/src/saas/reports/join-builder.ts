/**
 * Phase 2.4 — Tenant-safe join builder.
 *
 * Renders a `JoinDef` into the deterministic SQL fragment used by the
 * composer. Two modes:
 *
 *   - `structuredOn` present: all identifiers and literals come from
 *     validated fields. NO arbitrary string concatenation. The
 *     resulting fragment is safe by construction.
 *
 *   - `on` (legacy free-form) present and `structuredOn` absent: the
 *     fragment is taken verbatim. The validator (`source-registry.ts`)
 *     has already confirmed it contains a tenant-equality term and
 *     does not match any forbidden pattern. No new free-form joins are
 *     accepted in Phase 2.4 sources — only Phase 2.1/2.3 single-table
 *     sources can fall back to this path (and they have empty
 *     `tenantAwareJoins` anyway).
 *
 * Returned fragment shape:
 *   `<JOIN-TYPE> JOIN "<table>" "<alias>" ON <on>`
 *
 * The fragment never references any of the user's filter values. The
 * builder is pure — no DB, no I/O.
 */
import { JoinDef, StructuredJoinOn } from './source-def.types';
import {
  assertJoinType,
  assertLiteral,
  CATALOG_TABLES,
  colRef,
  ident,
} from './sql-guards';

export interface RenderedJoin {
  /** The full `<KIND> JOIN "<tbl>" "<alias>" ON ...` fragment. */
  sql: string;
  /** The introduced alias. */
  alias: string;
  /** Whether the join is to a global catalog (no tenant equality). */
  isCatalog: boolean;
}

/**
 * Render one join. `knownAliases` is the set of aliases already in
 * scope (primary alias plus previously-rendered joined aliases). The
 * tenant-equality term and FK term must reference only known aliases
 * on one side and the new join alias on the other.
 */
export function renderJoin(j: JoinDef, knownAliases: ReadonlySet<string>): RenderedJoin {
  const joinType = assertJoinType(j.joinType);
  const kind = j.kind ?? 'tenant-equality';
  const isCatalog = kind === 'catalog';

  if (isCatalog && !CATALOG_TABLES.has(j.table)) {
    throw new Error(
      `join kind=catalog disallowed for table "${j.table}" — not in CATALOG_TABLES allow-list`,
    );
  }
  if (knownAliases.has(j.alias)) {
    throw new Error(`duplicate join alias "${j.alias}"`);
  }

  // Prefer structured form. Validator guarantees structured form is
  // present for Phase 2.4 sources.
  if (j.structuredOn) {
    const sql = renderStructured(j.alias, j.structuredOn, knownAliases, isCatalog);
    return {
      sql: `${joinType} JOIN ${ident(j.table)} ${ident(j.alias)} ON ${sql}`,
      alias: j.alias,
      isCatalog,
    };
  }

  if (j.on) {
    // Legacy free-form. Validator already confirmed tenant equality.
    return {
      sql: `${joinType} JOIN ${ident(j.table)} ${ident(j.alias)} ON ${j.on}`,
      alias: j.alias,
      isCatalog,
    };
  }

  throw new Error(`join "${j.alias}" has no on / structuredOn`);
}

function renderStructured(
  newAlias: string,
  on: StructuredJoinOn,
  knownAliases: ReadonlySet<string>,
  isCatalog: boolean,
): string {
  const parts: string[] = [];

  // 1. The FK relationship (always required). Exactly one side must be
  //    the new alias; the other must be a known alias.
  assertEdge(on.fk.leftAlias, on.fk.rightAlias, newAlias, knownAliases, 'fk');
  parts.push(`${colRef(on.fk.leftAlias, on.fk.leftCol)} = ${colRef(on.fk.rightAlias, on.fk.rightCol)}`);

  // 2. Tenant equality — required for non-catalog joins.
  if (!isCatalog) {
    if (!on.tenant) {
      throw new Error(`structured join "${newAlias}" missing tenant equality`);
    }
    assertEdge(on.tenant.leftAlias, on.tenant.rightAlias, newAlias, knownAliases, 'tenant');
    parts.push(
      `${colRef(on.tenant.leftAlias, on.tenant.leftCol)} = ${colRef(on.tenant.rightAlias, on.tenant.rightCol)}`,
    );
  }

  // 3. Literal equality terms (e.g. entityType='EMPLOYEE'). Each
  //    literal is validated against LITERAL_RE in `assertLiteral`.
  for (const lit of on.literals ?? []) {
    if (lit.alias !== newAlias && !knownAliases.has(lit.alias)) {
      throw new Error(`unknown alias in literal: ${lit.alias}`);
    }
    parts.push(`${colRef(lit.alias, lit.col)} = '${assertLiteral(lit.literal)}'`);
  }

  // 4. NULL checks (e.g. d.deletedAt IS NULL).
  for (const nc of on.nullChecks ?? []) {
    if (nc.alias !== newAlias && !knownAliases.has(nc.alias)) {
      throw new Error(`unknown alias in nullCheck: ${nc.alias}`);
    }
    parts.push(`${colRef(nc.alias, nc.col)} IS NULL`);
  }

  return parts.join(' AND ');
}

/**
 * Each edge (FK, tenant) must connect the new alias on one side to a
 * known alias on the other. This stops a malicious or sloppy registry
 * entry from creating an unconnected join (cartesian risk) or a join
 * that skips the new alias entirely (logic bug).
 */
function assertEdge(
  leftAlias: string,
  rightAlias: string,
  newAlias: string,
  knownAliases: ReadonlySet<string>,
  edgeKind: 'fk' | 'tenant',
): void {
  const leftIsNew  = leftAlias  === newAlias;
  const rightIsNew = rightAlias === newAlias;
  if (leftIsNew === rightIsNew) {
    throw new Error(`${edgeKind} edge must reference the new alias exactly once (${leftAlias},${rightAlias},${newAlias})`);
  }
  const otherSide = leftIsNew ? rightAlias : leftAlias;
  if (!knownAliases.has(otherSide)) {
    throw new Error(`${edgeKind} edge references unknown alias "${otherSide}"`);
  }
}
