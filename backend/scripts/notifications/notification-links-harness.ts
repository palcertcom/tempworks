/**
 * EmailService.notificationLinks() smoke harness.
 *
 * Verifies the deep-link derivation used to turn per-notification
 * emails into one-click navigation (employee/candidate profile +
 * document). Exercises the private method via a tiny subclass.
 *
 * Run: npx ts-node backend/scripts/notifications/notification-links-harness.ts
 */
/* eslint-disable no-console */
import { EmailService } from '../../src/email/email.service';

// Minimal ConfigService stub → fixes the frontend origin.
const config: any = { get: (k: string, d?: any) => (k === 'FRONTEND_URL' ? 'https://app.example.com' : d) };

class Probe extends EmailService {
  links(ctx: any) { return (this as any).notificationLinks(ctx); }
}
const svc = new Probe(config);

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra?: string) {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
}

console.log('notification-links harness');

// Employee + document (the "New Document Uploaded" case)
{
  const links = svc.links({
    relatedEntity: 'EMPLOYEE', relatedEntityId: 'emp1',
    params: { entityName: 'Alexander Karabanov', documentId: 'doc1', documentName: 'passport.pdf' },
  });
  const person = links.find((l: any) => l.href.includes('/employees/emp1'));
  const doc = links.find((l: any) => l.href.includes('/documents/doc1'));
  check('employee profile link present', !!person && person.href === 'https://app.example.com/dashboard/employees/emp1', person?.href);
  check('employee link labelled with name', person?.label === 'View Alexander Karabanov', person?.label);
  check('document link present', !!doc && doc.href === 'https://app.example.com/dashboard/documents/doc1', doc?.href);
  check('document link labelled with name', doc?.label === 'Open “passport.pdf”', doc?.label);
}

// Applicant/candidate profile
{
  const links = svc.links({ relatedEntity: 'APPLICANT', relatedEntityId: 'app1', params: { entityName: 'Sara Ali' } });
  check('applicant → candidate profile link', links[0]?.href === 'https://app.example.com/dashboard/applicants/app1', links[0]?.href);
  check('applicant link labelled with name', links[0]?.label === 'View Sara Ali', links[0]?.label);
}

// Person resolved from params fallback (relatedEntity absent)
{
  const links = svc.links({ params: { entityType: 'EMPLOYEE', entityId: 'emp2', documentId: 'doc2' } });
  check('person from params.entityType/entityId', links.some((l: any) => l.href.includes('/employees/emp2')));
  check('doc from params.documentId', links.some((l: any) => l.href.includes('/documents/doc2')));
  check('unnamed person → generic label', links.find((l: any) => l.href.includes('/employees/emp2'))?.label === 'View employee profile');
}

// Nothing linkable
{
  check('no context → no links', svc.links(undefined).length === 0);
  check('financial event w/o entity → no links', svc.links({ params: { amount: 100 } }).length === 0);
}

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
