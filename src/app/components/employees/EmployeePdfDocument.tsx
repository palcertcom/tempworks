/**
 * Employee PDF Document
 * React-PDF document used for single-profile and bulk employee exports.
 * Mirrors the layout conventions of ApplicantPDF for visual consistency.
 */
import { Document, Page, Text, View, StyleSheet, Image, pdf } from '@react-pdf/renderer';
import { PDFDocument } from 'pdf-lib';
import i18n from '../../../i18n';
import { formatDate } from '../../../i18n/formatters';

const tp = (k: string, opts?: Record<string, unknown>): string =>
  i18n.t(`employees.pdf.${k}`, { ns: 'pages', ...(opts ?? {}) }) as string;

const API_BASE = (import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1').replace('/api/v1', '');

const S = StyleSheet.create({
  page: { fontFamily: 'Helvetica', fontSize: 9, padding: 36, color: '#1a1a2e', backgroundColor: '#fff' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, paddingBottom: 12, borderBottom: '2pt solid #2563EB' },
  headerLeft: { flex: 1 },
  headerPhoto: { width: 64, height: 64, borderRadius: 32, border: '2pt solid #2563EB', objectFit: 'cover' },
  appTitle: { fontSize: 18, fontFamily: 'Helvetica-Bold', color: '#2563EB', marginBottom: 2 },
  appSubtitle: { fontSize: 9, color: '#64748b' },
  appDate: { fontSize: 8, color: '#94a3b8', marginTop: 4 },
  section: { marginBottom: 14 },
  sectionTitle: { fontSize: 11, fontFamily: 'Helvetica-Bold', color: '#2563EB', marginBottom: 6, paddingBottom: 3, borderBottom: '1pt solid #dbeafe' },
  subTitle: { fontSize: 9, fontFamily: 'Helvetica-Bold', color: '#374151', marginTop: 6, marginBottom: 3 },
  grid2: { flexDirection: 'row', flexWrap: 'wrap', gap: 0 },
  field: { width: '50%', marginBottom: 5, paddingRight: 8 },
  fieldFull: { width: '100%', marginBottom: 5 },
  label: { fontSize: 7, color: '#64748b', textTransform: 'uppercase', marginBottom: 1 },
  value: { fontSize: 9, color: '#1e293b' },
  valueMuted: { fontSize: 9, color: '#94a3b8', fontStyle: 'italic' },
  footer: { position: 'absolute', bottom: 20, left: 36, right: 36, flexDirection: 'row', justifyContent: 'space-between', borderTop: '1pt solid #e2e8f0', paddingTop: 6 },
  footerText: { fontSize: 7, color: '#94a3b8' },
});

const F = ({ label, value }: { label: string; value?: string | null }) => (
  <View style={S.field}>
    <Text style={S.label}>{label}</Text>
    <Text style={value ? S.value : S.valueMuted}>{value || '—'}</Text>
  </View>
);

const FF = ({ label, value }: { label: string; value?: string | null }) => (
  <View style={S.fieldFull}>
    <Text style={S.label}>{label}</Text>
    <Text style={value ? S.value : S.valueMuted}>{value || '—'}</Text>
  </View>
);

const fmtDate = (v: any) => {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d.getTime()) ? String(v) : formatDate(d);
};

export function EmployeePDF({ employee, photoDataUrl }: { employee: any; photoDataUrl?: string }) {
  const e = employee ?? {};
  const now = formatDate();
  const fullName = [e.firstName, e.lastName].filter(Boolean).join(' ') || '—';
  const status = typeof e.status === 'string' ? e.status.replace(/_/g, ' ').toLowerCase() : '';
  const address = [e.addressLine1, e.addressLine2].filter(Boolean).join(', ');

  return (
    <Document title={`${fullName} — Employee Profile`}>
      <Page size="A4" style={S.page}>
        <View style={S.header}>
          <View style={S.headerLeft}>
            <Text style={S.appTitle}>{fullName}</Text>
            <Text style={S.appSubtitle}>Employee ID: {e.employeeNumber ?? e.id ?? '—'}</Text>
            <Text style={S.appDate}>Status: {status || '—'} · Generated: {now}</Text>
          </View>
          {photoDataUrl && <Image src={photoDataUrl} style={S.headerPhoto} />}
        </View>

        <View style={S.section}>
          <Text style={S.sectionTitle}>{tp('personalInformation')}</Text>
          <View style={S.grid2}>
            <F label="First Name" value={e.firstName} />
            <F label="Last Name" value={e.lastName} />
            <F label="Date of Birth" value={fmtDate(e.dateOfBirth)} />
            <F label="Citizenship" value={e.nationality || e.citizenship} />
            <F label="Gender" value={e.gender} />
            <F label="Job Category" value={e.jobType?.name} />
            <F label="License Number" value={e.licenseNumber} />
            <F label="License Category" value={e.licenseCategory} />
            <F label="Years Experience" value={e.yearsExperience != null ? `${e.yearsExperience} years` : ''} />
          </View>
        </View>

        <View style={S.section}>
          <Text style={S.sectionTitle}>{tp('contactDetails')}</Text>
          <View style={S.grid2}>
            <F label="Email" value={e.email} />
            <F label="Phone" value={e.phone} />
          </View>
          {(address || e.city || e.country || e.postalCode) && (
            <>
              <Text style={S.subTitle}>Address</Text>
              <View style={S.grid2}>
                {address && <FF label="Street" value={address} />}
                <F label="City" value={e.city} />
                <F label="Postal Code" value={e.postalCode} />
                <F label="Country" value={e.country} />
              </View>
            </>
          )}
          {(e.emergencyContact || e.emergencyPhone) && (
            <>
              <Text style={S.subTitle}>{tp('emergencyContact')}</Text>
              <View style={S.grid2}>
                <F label="Name" value={e.emergencyContact} />
                <F label="Phone" value={e.emergencyPhone} />
              </View>
            </>
          )}
        </View>

        <View style={S.section}>
          <Text style={S.sectionTitle}>Employment</Text>
          <View style={S.grid2}>
            <F label="Agency" value={e.agency?.name} />
            <F label="Department" value={e.department} />
            <F label="Position" value={e.position || e.jobTitle} />
            <F label="Hire Date" value={fmtDate(e.hireDate || e.startDate)} />
            <F label="Status" value={status} />
            <F label="Contract Type" value={e.contractType} />
          </View>
        </View>

        <View style={S.footer} fixed>
          <Text style={S.footerText}>{tp('footer')}</Text>
          <Text
            style={S.footerText}
            render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
          />
        </View>
      </Page>
    </Document>
  );
}

// ── Shared blob builder ──────────────────────────────────────────────────────
// Renders the employee's react-pdf profile, optionally embeds the
// profile photo in the header, and appends every supplied supporting
// document (PDFs verbatim, images on their own A4 page). Shared by the
// bulk "Export PDFs" flow on the Employees list.
export async function buildEmployeePdfBlob(employee: any, documents: any[] = []): Promise<Blob> {
  let photoDataUrl: string | undefined;
  if (employee?.photoUrl) {
    try {
      const res = await fetch(employee.photoUrl?.startsWith('http') ? employee.photoUrl : `${API_BASE}${employee.photoUrl}`);
      const blob = await res.blob();
      photoDataUrl = await new Promise<string>(resolve => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.readAsDataURL(blob);
      });
    } catch { /* photo optional */ }
  }

  const profileBlob = await pdf(<EmployeePDF employee={employee} photoDataUrl={photoDataUrl} />).toBlob();
  if (!documents || documents.length === 0) return profileBlob;

  const mergedPdf = await PDFDocument.create();
  const profileBytes = await profileBlob.arrayBuffer();
  const profilePdf = await PDFDocument.load(profileBytes);
  const profilePages = await mergedPdf.copyPages(profilePdf, profilePdf.getPageIndices());
  profilePages.forEach(p => mergedPdf.addPage(p));

  for (const doc of documents) {
    try {
      const res = await fetch(`${doc.fileUrl?.startsWith('http') ? '' : API_BASE}${doc.fileUrl}`);
      const bytes = await res.arrayBuffer();
      const mime = doc.mimeType ?? '';
      if (mime === 'application/pdf') {
        const docPdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
        const pages = await mergedPdf.copyPages(docPdf, docPdf.getPageIndices());
        pages.forEach(p => mergedPdf.addPage(p));
      } else if (mime.startsWith('image/')) {
        const page = mergedPdf.addPage([595, 842]);
        const img = mime === 'image/png' ? await mergedPdf.embedPng(bytes) : await mergedPdf.embedJpg(bytes);
        const { width, height } = img.scaleToFit(523, 770);
        page.drawImage(img, { x: (595 - width) / 2, y: (842 - height) / 2, width, height });
      }
      // docx / unknown types silently skipped — pdf-lib can't embed them.
    } catch {
      // Keep going on a per-doc failure so one bad file doesn't ruin the bundle.
    }
  }

  const mergedBytes = await mergedPdf.save();
  return new Blob([mergedBytes], { type: 'application/pdf' });
}
