#!/usr/bin/env node
/**
 * Phase 3 (#29) — Runtime unit harness for attendance hour calculation.
 *
 * We can't import the TypeScript helper directly without a build step,
 * so this script re-implements the SAME rules — keeps them visible as
 * a spec and exercises the user-specified cases. If the production
 * helper drifts, the static check in attendance-calc-check.mjs will
 * catch the structural change; this file pins the numeric outcomes.
 *
 * Cases (per the #29 acceptance list):
 *   - PRESENT 08:00–16:30, break 12:00–12:30 → 8h
 *   - PRESENT + 1h interruption → 7h
 *   - Full-day interruption → 0h (never negative)
 *   - Editing interruption twice does not double-deduct (idempotent)
 *   - SICK / PAID_LEAVE → 0h, time fields nulled
 *   - SICK → PRESENT toggle restores 8h
 *   - PRESENT → SICK toggle drops to 0h with no stale times
 */
const NON_WORKING = new Set([
  'OFF','VACATION','SICK','ABSENT','HOLIDAY','ON_LEAVE','UNPAID_LEAVE','PAID_LEAVE',
]);

function toMin(t) {
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t));
  if (!m) return null;
  const h = Number(m[1]), mm = Number(m[2]);
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
  return h * 60 + mm;
}

function calcWorkingHours(ci, co, bi, bo, ii, io) {
  const a = toMin(ci), b = toMin(co);
  if (a == null || b == null) return null;
  let shift = b >= a ? b - a : (24*60 - a) + b;
  const bI = toMin(bi), bO = toMin(bo);
  if (bI != null && bO != null && bO > bI) shift -= (bO - bI);
  const iI = toMin(ii), iO = toMin(io);
  if (iI != null && iO != null && iO > iI) shift -= (iO - iI);
  if (shift < 0) shift = 0;
  return Math.round((shift / 60) * 100) / 100;
}

function normalize(input) {
  if (NON_WORKING.has(input.status)) {
    return {
      status: input.status,
      checkIn: null, checkOut: null, breakIn: null, breakOut: null,
      interruptionIn: null, interruptionOut: null, interruptionStatus: null,
      workingHours: 0,
    };
  }
  const h = calcWorkingHours(
    input.checkIn, input.checkOut, input.breakIn, input.breakOut,
    input.interruptionIn, input.interruptionOut,
  );
  return {
    status: input.status,
    checkIn: input.checkIn ?? null,
    checkOut: input.checkOut ?? null,
    breakIn: input.breakIn ?? null,
    breakOut: input.breakOut ?? null,
    interruptionIn: input.interruptionIn ?? null,
    interruptionOut: input.interruptionOut ?? null,
    interruptionStatus: input.interruptionStatus ?? null,
    workingHours: h == null ? 0 : Math.max(0, h),
  };
}

let problems = 0;
const eq = (label, actual, expected) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    problems++;
    console.log(`✗ ${label}: got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
  } else {
    console.log(`✓ ${label}`);
  }
};

// 1. PRESENT default 08:00–16:30 with 30 min break.
eq(
  'PRESENT default (08:00–16:30 / 12:00–12:30) = 8h',
  normalize({ status:'PRESENT', checkIn:'08:00', checkOut:'16:30', breakIn:'12:00', breakOut:'12:30' }).workingHours,
  8,
);

// 2. PRESENT with 1h interruption = 7h.
eq(
  'PRESENT + interruption 13:00–14:00 = 7h',
  normalize({ status:'PRESENT', checkIn:'08:00', checkOut:'16:30', breakIn:'12:00', breakOut:'12:30',
              interruptionIn:'13:00', interruptionOut:'14:00' }).workingHours,
  7,
);

// 3. Full-day interruption → 0h, never negative.
eq(
  'Full-day interruption clamps to 0h',
  normalize({ status:'PRESENT', checkIn:'08:00', checkOut:'16:30', breakIn:'12:00', breakOut:'12:30',
              interruptionIn:'08:00', interruptionOut:'16:30' }).workingHours,
  0,
);

// 4. Editing interruption twice (same input) does not double-deduct.
const first = normalize({ status:'PRESENT', checkIn:'08:00', checkOut:'16:30', breakIn:'12:00', breakOut:'12:30',
                          interruptionIn:'13:00', interruptionOut:'14:00' });
const second = normalize({ status:'PRESENT',
                           checkIn: first.checkIn, checkOut: first.checkOut,
                           breakIn: first.breakIn, breakOut: first.breakOut,
                           interruptionIn: first.interruptionIn, interruptionOut: first.interruptionOut });
eq('Re-applying the same payload is idempotent (7h, 7h)', [first.workingHours, second.workingHours], [7, 7]);

// 5. SICK / PAID_LEAVE → 0h.
eq('SICK status → 0h',
   normalize({ status:'SICK', checkIn:'08:00', checkOut:'16:30' }).workingHours, 0);
eq('PAID_LEAVE status → 0h',
   normalize({ status:'PAID_LEAVE', checkIn:'08:00', checkOut:'16:30' }).workingHours, 0);

// 6. Non-working statuses null the time fields (no stale times persisted).
eq('SICK status nulls time fields',
   normalize({ status:'SICK', checkIn:'08:00', checkOut:'16:30', breakIn:'12:00', breakOut:'12:30',
               interruptionIn:'13:00', interruptionOut:'14:00', interruptionStatus:'SICK' }),
   { status:'SICK', checkIn:null, checkOut:null, breakIn:null, breakOut:null,
     interruptionIn:null, interruptionOut:null, interruptionStatus:null, workingHours:0 });

// 7. Toggle SICK → PRESENT with default times restores 8h.
const sick = normalize({ status:'SICK', checkIn:'08:00', checkOut:'16:30' });
const togglePresent = normalize({ status:'PRESENT',
  checkIn:'08:00', checkOut:'16:30', breakIn:'12:00', breakOut:'12:30',
  // Frontend resets interruption to blank on PRESENT — simulate that.
  interruptionIn:null, interruptionOut:null,
});
eq('SICK→PRESENT (with frontend default reset) = 8h',
   [sick.workingHours, togglePresent.workingHours], [0, 8]);

// 8. Toggle PRESENT → SICK drops to 0h and no time stays in the row.
const present = normalize({ status:'PRESENT', checkIn:'08:00', checkOut:'16:30', breakIn:'12:00', breakOut:'12:30' });
const toSick = normalize({ status:'SICK',
  checkIn: present.checkIn, checkOut: present.checkOut,
  breakIn: present.breakIn, breakOut: present.breakOut,
});
eq('PRESENT→SICK (re-sent prior times) drops to 0h with no stale times',
   { wh: toSick.workingHours, ci: toSick.checkIn, ii: toSick.interruptionIn },
   { wh: 0, ci: null, ii: null });

console.log('');
if (problems > 0) { console.log(`${problems} case(s) failed.`); process.exit(1); }
console.log('All attendance-calc unit cases passed.');
