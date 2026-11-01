#!/usr/bin/env node
/**
 * Phase 3 (#1 R-5) — DTO `tenantId` whitelist hardening guard.
 *
 * NestJS's ValidationPipe is configured with `whitelist: true` (see
 * backend/src/main.ts:697), which strips any property the DTO did not
 * declare. The Phase 1B / Phase 3 #27 pattern relies on this:
 *
 *   • For modules that do NOT support a SUPER tenant override, the DTO
 *     must NOT declare `tenantId`. Whitelist drops a client-supplied
 *     value before the service ever sees it; that is the spoof guard.
 *
 *   • For modules that DO support a SUPER override (Agency, JobAd,
 *     Vehicle, Workshop), the DTO declares `tenantId` AND the service
 *     gates by `isSuperPlatformAdmin` AND validates the target via
 *     `tenant.findUnique` so an unvalidated id can never be persisted.
 *
 * If a future contributor adds `tenantId?: string` to a DTO in one of
 * the listed modules without also adding the matching SUPER + validate
 * pair in the service, this check fails — preventing the silent
 * "DTO now passes the field, but the service still does nothing
 * useful with it" trap.
 *
 * This is the regression that closes R-5 from the Phase 3 #1 audit.
 *
 * Exit 1 on any failure.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

let problems = 0;
const fail = (m) => { problems++; console.log(`✗ ${m}`); };
const ok = (m) => console.log(`✓ ${m}`);

// Modules that do NOT support a SUPER tenant override. Their DTOs must
// not declare `tenantId`, and their services must not read `dto.tenantId`.
const UNTRUSTED_MODULES = [
  'backend/src/users',
  'backend/src/documents',
  'backend/src/finance',
  'backend/src/notifications',
  'backend/src/attendance',
];

// Modules that DO support a SUPER override. Their DTOs MAY declare
// `tenantId`, and their service MUST validate via tenant.findUnique
// every place it reads it.
const TRUSTED_MODULES = [
  { module: 'backend/src/vehicles', expectOverrideSites: 4 /* createVehicle, updateVehicle, createWorkshop, updateWorkshop */ },
];

function walk(dir, out = []) {
  const full = resolve(ROOT, dir);
  let entries; try { entries = readdirSync(full); } catch { return out; }
  for (const name of entries) {
    const p = join(full, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(join(dir, name), out);
    else if (name.endsWith('.ts')) out.push(join(dir, name));
  }
  return out;
}

// SPIKE-010 Phase F2 — these modules now legitimately accept a
// SUPER USER `?tenantId=` query via buildSuperUserTenantWhere +
// assertRequestedTenantExists. The DTO declaration is OK provided the
// service file reads it INSIDE a call to one of those two helpers.
const SUPER_OVERRIDE_HELPERS = /\bbuildSuperUserTenantWhere\(|\bassertRequestedTenantExists\(/;

// ── Untrusted modules: DTOs may declare tenantId only if the matching
//    service goes through the SUPER-override helpers ─────────────────────
for (const mod of UNTRUSTED_MODULES) {
  const dtoDir = `${mod}/dto`;
  const dtoFiles = walk(dtoDir);
  const svcFiles = walk(mod).filter(f => f.endsWith('.service.ts'));
  const moduleHasSuperOverride = svcFiles.some(f => SUPER_OVERRIDE_HELPERS.test(read(f)));

  let hits = 0;
  for (const f of dtoFiles) {
    const src = read(f);
    if (/\btenantId\??:\s*string/.test(src) && !moduleHasSuperOverride) {
      fail(`UNTRUSTED ${f}: declares tenantId field but no service in ${mod} calls buildSuperUserTenantWhere/assertRequestedTenantExists — would let a client value through whitelist into a service that has no SUPER override path`);
      hits++;
    }
  }
  if (hits === 0) {
    if (moduleHasSuperOverride) ok(`${mod}/dto/*: tenantId accepted via the validated buildSuperUserTenantWhere pattern`);
    else ok(`${mod}/dto/*: no DTO declares tenantId (whitelist strips spoofs)`);
  }
}

// ── Untrusted modules: services that read dto.tenantId must also use the
//    SUPER-override helpers in the same file ──────────────────────────────
for (const mod of UNTRUSTED_MODULES) {
  const svcDir = mod;
  const files = walk(svcDir).filter(f => f.endsWith('.service.ts'));
  let hits = 0;
  for (const f of files) {
    const src = read(f);
    const readsField = /\bdto\.tenantId\b|\(dto as any\)\.tenantId|\bfilter\.tenantId\b|\(filter as any\)\.tenantId/.test(src);
    if (readsField && !SUPER_OVERRIDE_HELPERS.test(src)) {
      fail(`UNTRUSTED ${f}: reads dto/filter.tenantId without going through buildSuperUserTenantWhere/assertRequestedTenantExists`);
      hits++;
    }
  }
  if (hits === 0) ok(`${mod}/*.service.ts: any tenantId read is gated through the SUPER-override helpers`);
}

// ── Trusted modules: SUPER override sites must validate via tenant.findUnique ──
for (const { module: mod, expectOverrideSites } of TRUSTED_MODULES) {
  const files = walk(mod).filter(f => f.endsWith('.service.ts'));
  let overrideReads = 0;
  let findUniqueChecks = 0;
  for (const f of files) {
    const src = read(f);
    overrideReads += (src.match(/\(dto as any\)\.tenantId/g) ?? []).length
                   + (src.match(/\bdto\.tenantId\b/g) ?? []).length;
    findUniqueChecks += (src.match(/this\.prisma\.tenant\.findUnique/g) ?? []).length;
  }
  if (overrideReads < expectOverrideSites) {
    fail(`TRUSTED ${mod}: expected at least ${expectOverrideSites} SUPER-override reads of dto.tenantId, found ${overrideReads}`);
  } else {
    ok(`TRUSTED ${mod}: ${overrideReads} SUPER-override read(s) of dto.tenantId`);
  }
  if (findUniqueChecks < expectOverrideSites) {
    fail(`TRUSTED ${mod}: expected at least ${expectOverrideSites} prisma.tenant.findUnique validations, found ${findUniqueChecks} — every SUPER override must validate the target tenant`);
  } else {
    ok(`TRUSTED ${mod}: ${findUniqueChecks} prisma.tenant.findUnique validation(s)`);
  }

  // Trusted DTOs may declare tenantId — confirm they do (so the field
  // actually arrives) AND that it's @IsOptional + @IsString to match
  // the rest of the codebase.
  const dtoFiles = walk(`${mod}/dto`);
  let declared = 0;
  for (const f of dtoFiles) {
    const src = read(f);
    const m = src.match(/@IsOptional\(\)\s*@IsString\(\)\s*tenantId\?:\s*string/g);
    declared += m ? m.length : 0;
  }
  if (declared < expectOverrideSites / 2) {
    fail(`TRUSTED ${mod}/dto: expected at least ${Math.ceil(expectOverrideSites/2)} DTO(s) declaring "@IsOptional() @IsString() tenantId?: string", found ${declared}`);
  } else {
    ok(`TRUSTED ${mod}/dto: ${declared} DTO(s) properly declare tenantId`);
  }
}

console.log('');
if (problems > 0) {
  console.log(`${problems} check(s) failed.`);
  process.exit(1);
}
console.log('All dto-tenant-whitelist checks passed.');
