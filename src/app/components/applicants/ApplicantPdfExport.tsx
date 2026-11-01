/**
 * Applicant PDF Export
 * Generates a structured PDF of the applicant application data and
 * optionally merges selected uploaded documents into the same file.
 *
 * Arabic support: @react-pdf/renderer's bundled Helvetica has no
 * Arabic glyphs, so we register Noto Sans Arabic from jsDelivr's
 * fontsource CDN (Open Font License) and switch to it whenever the
 * active i18n locale is RTL. fontkit (used internally by react-pdf)
 * applies the OpenType GSUB shaping tables, so the rendered glyphs
 * include initial / medial / final / isolated forms automatically.
 */
import { useState, useEffect } from 'react';
import { Document, Page, Text, View, StyleSheet, pdf, Image, Font } from '@react-pdf/renderer';
import { PDFDocument } from 'pdf-lib';
import { useTranslation } from 'react-i18next';
import { FileText, Download, Loader2, X, CheckSquare, Square } from 'lucide-react';
import { Button } from '../ui/button';
import i18n from '../../../i18n';

const tp = (k: string, opts?: Record<string, unknown>): string =>
  i18n.t(`applicants.applicantPdf.${k}`, { ns: 'pages', ...(opts ?? {}) }) as string;
import { Checkbox } from '../ui/checkbox';
import { Label } from '../ui/label';
import { formatDate } from '../../../i18n/formatters';

const API_BASE = (import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1').replace('/api/v1', '');
const API_URL  = (import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1');

// ── Font registration (Arabic + Latin) ────────────────────────────────────────
// Registered once on first import. Subsequent imports/HMR no-op because
// react-pdf de-dupes families by name.
// Served from /public so the fetch is same-origin — avoids CDN CORS
// failures that previously aborted the PDF render in production.
const FONT_BASE = `${window.location.origin}/fonts`;
Font.register({
  family: 'NotoSansArabic',
  fonts: [
    { src: `${FONT_BASE}/NotoSansArabic-Regular.ttf`, fontWeight: 'normal' },
    { src: `${FONT_BASE}/NotoSansArabic-Bold.ttf`, fontWeight: 'bold' },
    // Arabic has no italic tradition — alias italic to the upright
    // faces so any `fontStyle: italic` in the stylesheet resolves.
    { src: `${FONT_BASE}/NotoSansArabic-Regular.ttf`, fontWeight: 'normal', fontStyle: 'italic' },
    { src: `${FONT_BASE}/NotoSansArabic-Bold.ttf`, fontWeight: 'bold', fontStyle: 'italic' },
  ],
});
// Disable hyphenation — react-pdf otherwise inserts hyphens inside
// Arabic words, breaking the shaping mid-glyph.
Font.registerHyphenationCallback((w: string) => [w]);

// Resolve current locale's direction lazily so a language change
// before opening the dialog uses the new direction.
const isRtl = (): boolean => i18n.dir() === 'rtl';
const baseFontFamily = (): string => (isRtl() ? 'NotoSansArabic' : 'Helvetica');
const boldFontFamily = (): string => (isRtl() ? 'NotoSansArabic' : 'Helvetica-Bold');

// ── PDF Styles ────────────────────────────────────────────────────────────────
// Style sheet is built lazily per export so it picks up the locale at
// the time the PDF is generated (not at module load).
const buildStyles = () => {
  const rtl = isRtl();
  const align = rtl ? ('right' as const) : ('left' as const);
  return StyleSheet.create({
  page: { fontFamily: baseFontFamily(), fontSize: 9, padding: 36, color: '#1a1a2e', backgroundColor: '#fff', textAlign: align },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, paddingBottom: 12, borderBottom: '2pt solid #2563EB' },
  headerLeft: { flex: 1 },
  headerPhoto: { width: 64, height: 64, borderRadius: 32, border: '2pt solid #2563EB', objectFit: 'cover' },
  appTitle: { fontSize: 18, fontFamily: boldFontFamily(), color: '#2563EB', marginBottom: 2 },
  appSubtitle: { fontSize: 9, color: '#64748b' },
  appDate: { fontSize: 8, color: '#94a3b8', marginTop: 4 },
  section: { marginBottom: 14 },
  sectionTitle: { fontSize: 11, fontFamily: boldFontFamily(), color: '#2563EB', marginBottom: 6, paddingBottom: 3, borderBottom: '1pt solid #dbeafe' },
  subTitle: { fontSize: 9, fontFamily: boldFontFamily(), color: '#374151', marginTop: 6, marginBottom: 3 },
  grid2: { flexDirection: 'row', flexWrap: 'wrap', gap: 0 },
  field: { width: '50%', marginBottom: 5, paddingRight: 8 },
  fieldFull: { width: '100%', marginBottom: 5 },
  label: { fontSize: 7, color: '#64748b', textTransform: 'uppercase', marginBottom: 1 },
  value: { fontSize: 9, color: '#1e293b' },
  valueMuted: { fontSize: 9, color: '#94a3b8', fontStyle: 'italic' },
  badge: { backgroundColor: '#dbeafe', color: '#1d4ed8', fontSize: 7, paddingHorizontal: 5, paddingVertical: 2, borderRadius: 3, marginRight: 3, marginBottom: 3 },
  badgesRow: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 2 },
  entryBox: { border: '1pt solid #e2e8f0', borderRadius: 4, padding: 8, marginBottom: 6 },
  entryNum: { fontSize: 8, fontFamily: boldFontFamily(), color: '#64748b', marginBottom: 4 },
  footer: { position: 'absolute', bottom: 20, left: 36, right: 36, flexDirection: 'row', justifyContent: 'space-between', borderTop: '1pt solid #e2e8f0', paddingTop: 6 },
  footerText: { fontSize: 7, color: '#94a3b8' },
  });
};

// Convenience: a default snapshot used by the module-level F/FF helpers.
// The component body re-builds it per render so live language switches
// don't need a page reload.
let S = buildStyles();

// ── Helpers ───────────────────────────────────────────────────────────────────

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

const yn = (v: string | boolean | undefined) =>
  v === 'yes' || v === true ? 'Yes' : v === 'no' || v === false ? 'No' : '—';

// ── PDF Document ──────────────────────────────────────────────────────────────

export function ApplicantPDF({ applicant, photoDataUrl }: { applicant: any; photoDataUrl?: string }) {
  const ad = applicant.applicationData ?? {};
  const now = formatDate();
  // Refresh the module-level `S` snapshot at render time so a language
  // switch is picked up without reloading the page.
  S = buildStyles();

  return (
    <Document title={`${applicant.fullName} — Application`}>
      {/* ── Page 1: Personal + Contact + Identification ── */}
      <Page size="A4" style={S.page}>
        {/* Header */}
        <View style={S.header}>
          <View style={S.headerLeft}>
            <Text style={S.appTitle}>{applicant.fullName}</Text>
            <Text style={S.appSubtitle}>Applicant ID: {applicant.candidateNumber ?? applicant.leadNumber ?? applicant.applicationNumber ?? applicant.id}</Text>
            <Text style={S.appDate}>Applied: {applicant.applicationDate} · Generated: {now}</Text>
          </View>
          {photoDataUrl && <Image src={photoDataUrl} style={S.headerPhoto} />}
        </View>

        {/* Personal */}
        <View style={S.section}>
          <Text style={S.sectionTitle}>{tp('personalInformation')}</Text>
          <View style={S.grid2}>
            <F label={tp('field.firstName')} value={applicant.firstName} />
            <F label={tp('field.lastName')} value={applicant.lastName} />
            <F label={tp('field.middleName')} value={applicant.middleName} />
            <F label={tp('field.gender')} value={ad.gender} />
            <F label={tp('field.dateOfBirth')} value={ad.dateOfBirth || applicant.dateOfBirth} />
            <F label={tp('field.countryOfBirth')} value={ad.countryOfBirth || applicant.countryOfBirth} />
            <F label={tp('field.cityOfBirth')} value={ad.cityOfBirth || applicant.cityOfBirth} />
            <F label={tp('field.citizenship')} value={ad.citizenship || applicant.citizenship} />
            <F label={tp('field.jobCategory')} value={applicant.jobType?.name} />
            <F label={tp('field.preferredStartDate')} value={applicant.preferredStartDate} />
            <F label={tp('field.availability')} value={applicant.availability} />
            <F label={tp('field.willingToRelocate')} value={yn(applicant.willingToRelocate)} />
          </View>
          {applicant.preferredLocations && <FF label={tp('field.preferredLocations')} value={applicant.preferredLocations} />}
          {applicant.salaryExpectation && <FF label={tp('field.salaryExpectation')} value={applicant.salaryExpectation} />}
        </View>

        {/* Contact */}
        <View style={S.section}>
          <Text style={S.sectionTitle}>{tp('contactDetails')}</Text>
          <View style={S.grid2}>
            <F label={tp('field.email')} value={applicant.email} />
            <F label={tp('field.phone')} value={applicant.phone} />
          </View>
          {(ad.homeAddress?.addressLine1 || ad.currentAddress?.addressLine1) && (
            <>
              {ad.homeAddress?.addressLine1 && (
                <>
                  <Text style={S.subTitle}>{tp('permanentAddress')}</Text>
                  <View style={S.grid2}>
                    <FF label={tp('field.address')} value={[ad.homeAddress.addressLine1, ad.homeAddress.addressLine2].filter(Boolean).join(', ')} />
                    <F label={tp('field.city')} value={ad.homeAddress.city} />
                    <F label={tp('field.postalCode')} value={ad.homeAddress.postalCode} />
                    <F label={tp('field.country')} value={ad.homeAddress.country} />
                  </View>
                </>
              )}
            </>
          )}
          {ad.emergencyFirstName && (
            <>
              <Text style={S.subTitle}>{tp('emergencyContact')}</Text>
              <View style={S.grid2}>
                <F label={tp('field.name')} value={`${ad.emergencyFirstName} ${ad.emergencyLastName}`} />
                <F label={tp('field.relationship')} value={ad.emergencyRelation} />
                <F label={tp('field.phone')} value={`${ad.emergencyPhoneCode ?? ''} ${ad.emergencyPhone ?? ''}`.trim()} />
                <F label={tp('field.email')} value={ad.emergencyEmail} />
              </View>
            </>
          )}
        </View>

        {/* Identification */}
        <View style={S.section}>
          <Text style={S.sectionTitle}>{tp('identification')}</Text>
          <Text style={S.subTitle}>Passport</Text>
          <View style={S.grid2}>
            <F label={tp('field.passportNumber')} value={ad.passportNumber} />
            <F label={tp('field.issuingCountry')} value={ad.passportCountry} />
            <F label={tp('field.issueDate')} value={ad.passportIssueDate} />
            <F label={tp('field.expiryDate')} value={ad.passportNoExpiry ? tp('field.noExpiry') : ad.passportExpiryDate} />
          </View>
          {ad.hasIdCard === 'yes' && (
            <>
              <Text style={S.subTitle}>{tp('nationalIdCard')}</Text>
              <View style={S.grid2}>
                <F label={tp('field.idNumber')} value={ad.idCardNumber} />
                <F label={tp('field.country')} value={ad.idCardCountry} />
                <F label={tp('field.expiry')} value={ad.idCardNoExpiry ? tp('field.noExpiry') : ad.idCardExpiryDate} />
              </View>
            </>
          )}
          {ad.hasEuVisa === 'yes' && (
            <>
              <Text style={S.subTitle}>{tp('euVisa')}</Text>
              <View style={S.grid2}>
                <F label={tp('field.type')} value={ad.euVisaType} />
                <F label={tp('field.issuingCountry')} value={ad.euVisaCountry} />
                <F label={tp('field.number')} value={ad.euVisaNumber} />
                <F label={tp('field.expiry')} value={ad.euVisaNoExpiry ? tp('field.noExpiry') : ad.euVisaExpiryDate} />
                {ad.purposeOfIssue && <FF label={tp('field.purposeOfIssue')} value={ad.purposeOfIssue} />}
              </View>
            </>
          )}
          {ad.hasEuResidence === 'yes' && (
            <>
              <Text style={S.subTitle}>{tp('euResidencePermit')}</Text>
              <View style={S.grid2}>
                <F label={tp('field.permitNumber')} value={ad.euResidenceNumber} />
                <F label={tp('field.country')} value={ad.euResidenceCountry} />
                <F label={tp('field.expiry')} value={ad.euResidenceNoExpiry ? tp('field.noExpiry') : ad.euResidenceExpiryDate} />
              </View>
            </>
          )}
          {ad.hasWorkPermit === 'yes' && (
            <>
              <Text style={S.subTitle}>{tp('euWorkPermit')}</Text>
              <View style={S.grid2}>
                <F label={tp('field.type')} value={ad.workPermitType} />
                <F label={tp('field.number')} value={ad.workPermitNumber} />
                <F label={tp('field.country')} value={ad.workPermitCountry} />
                <F label={tp('field.expiry')} value={ad.workPermitNoExpiry ? tp('field.noExpiry') : ad.workPermitExpiryDate} />
              </View>
            </>
          )}
          <View style={S.grid2}>
            <F label={tp('field.homeCriminalRecord')} value={yn(ad.hasHomeCriminalRecord)} />
            {ad.hasHomeCriminalRecord === 'yes' && <F label={tp('field.dateOfIssue')} value={ad.homeCriminalRecordDate} />}
            {ad.hasHomeCriminalRecord === 'yes' && <F label={tp('field.countryOfIssue')} value={ad.homeCriminalRecordCountry} />}
            <F label={tp('field.euCriminalRecord')} value={yn(ad.hasEuCriminalRecord)} />
            {ad.hasEuCriminalRecord === 'yes' && <F label={tp('field.dateOfIssue')} value={ad.euCriminalRecordDate} />}
            {ad.hasEuCriminalRecord === 'yes' && <F label={tp('field.countryOfIssue')} value={ad.euCriminalRecordCountry} />}
          </View>
        </View>

        <View style={S.footer} fixed>
          <Text style={S.footerText}>{tp('footer')}</Text>
          <Text style={S.footerText} render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>

      {/* ── Page 2: Driving + Education + Work ── */}
      <Page size="A4" style={S.page}>
        {/* Driving License */}
        {ad.hasDrivingLicense === 'yes' && (
          <View style={S.section}>
            <Text style={S.sectionTitle}>{tp('drivingLicense')}</Text>
            <View style={S.grid2}>
              <F label={tp('field.licenseNumber')} value={ad.licenseNumber} />
              <F label={tp('field.issuingCountry')} value={ad.licenseCountry} />
              <F label={tp('field.issueDate')} value={ad.licenseIssueDate} />
              <F label={tp('field.expiry')} value={ad.licenseNoExpiry ? tp('field.noExpiry') : ad.licenseExpiryDate} />
            </View>
            {ad.licenseCategories?.length > 0 && (
              <>
                <Text style={S.subTitle}>Categories</Text>
                <View style={S.badgesRow}>
                  {ad.licenseCategories.map((c: string) => <Text key={c} style={S.badge}>{c}</Text>)}
                </View>
              </>
            )}
            {ad.qualifications?.length > 0 && (
              <>
                <Text style={S.subTitle}>{tp('professionalQualifications')}</Text>
                {ad.qualifications.map((q: any, i: number) => (
                  <View key={i} style={S.entryBox}>
                    <View style={S.grid2}>
                      <F label={tp('field.type')} value={q.type} />
                      <F label={tp('field.country')} value={q.country} />
                      <F label={tp('field.issueDate')} value={q.issueDate} />
                      <F label={tp('field.expiry')} value={q.noExpiry ? tp('field.noExpiry') : q.expiryDate} />
                    </View>
                  </View>
                ))}
              </>
            )}
          </View>
        )}

        {/* Education */}
        {ad.education?.length > 0 && (
          <View style={S.section}>
            <Text style={S.sectionTitle}>Education</Text>
            {ad.education.map((e: any, i: number) => (
              <View key={i} style={S.entryBox}>
                <Text style={S.entryNum}>Entry {i + 1}</Text>
                <View style={S.grid2}>
                  <F label={tp('field.level')} value={e.level} />
                  <F label={tp('field.institution')} value={e.institution} />
                  <F label={tp('field.fieldOfStudy')} value={e.fieldOfStudy} />
                  <F label={tp('field.country')} value={e.country} />
                  <F label={tp('field.startDate')} value={e.startDate} />
                  <F label={tp('field.endDate')} value={e.ongoing ? 'Ongoing' : e.endDate} />
                  <FF label={tp('field.degreeCertificate')} value={e.degree} />
                </View>
              </View>
            ))}
          </View>
        )}

        {/* Work History */}
        {ad.workHistory?.length > 0 && (
          <View style={S.section}>
            <Text style={S.sectionTitle}>{tp('workExperience')}</Text>
            {ad.workHistory.map((w: any, i: number) => (
              <View key={i} style={S.entryBox}>
                <Text style={S.entryNum}>Position {i + 1}</Text>
                <View style={S.grid2}>
                  <F label={tp('field.company')} value={w.company} />
                  <F label={tp('field.jobTitle')} value={w.jobTitle} />
                  <F label={tp('field.country')} value={w.country} />
                  <F label={tp('field.startDate')} value={w.startDate} />
                  <F label={tp('field.endDate')} value={w.current ? 'Current' : w.endDate} />
                </View>
                {w.responsibilities && <FF label={tp('field.responsibilities')} value={w.responsibilities} />}
                {w.references && <FF label={tp('field.references')} value={w.references} />}
              </View>
            ))}
          </View>
        )}

        <View style={S.footer} fixed>
          <Text style={S.footerText}>{tp('footer')}</Text>
          <Text style={S.footerText} render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>

      {/* ── Page 3: Skills + Additional + Declaration ── */}
      <Page size="A4" style={S.page}>
        {/* Skills */}
        <View style={S.section}>
          <Text style={S.sectionTitle}>{tp('skillsQualifications')}</Text>
          {ad.languages?.length > 0 && (
            <>
              <Text style={S.subTitle}>Languages</Text>
              {ad.languages.map((l: any, i: number) => (
                <View key={i} style={{ flexDirection: 'row', marginBottom: 3 }}>
                  <Text style={{ ...S.value, width: '30%' }}>{l.language}</Text>
                  <Text style={{ ...S.valueMuted, width: '30%' }}>{l.proficiency}</Text>
                  {l.hasCertificate && <Text style={{ ...S.badge }}>Certificate</Text>}
                </View>
              ))}
            </>
          )}
          {ad.computerSkills?.length > 0 && (
            <>
              <Text style={S.subTitle}>{tp('computerSkills')}</Text>
              <View style={S.badgesRow}>
                {ad.computerSkills.map((s: string) => <Text key={s} style={S.badge}>{s}</Text>)}
              </View>
            </>
          )}
          {ad.softSkills?.length > 0 && (
            <>
              <Text style={S.subTitle}>{tp('softSkills')}</Text>
              <View style={S.badgesRow}>
                {ad.softSkills.map((s: string) => <Text key={s} style={S.badge}>{s}</Text>)}
              </View>
            </>
          )}
          <View style={S.grid2}>
            <F label={tp('field.firstAidCert')} value={yn(ad.hasFirstAid)} />
            {ad.hasFirstAid === 'yes' && <F label={tp('field.firstAidExpiry')} value={ad.firstAidNoExpiry ? tp('field.noExpiry') : ad.firstAidExpiry} />}
          </View>
          {ad.toolsDescription && <FF label={tp('field.toolsEquipment')} value={ad.toolsDescription} />}
        </View>

        {/* Additional */}
        <View style={S.section}>
          <Text style={S.sectionTitle}>{tp('additionalInformation')}</Text>
          <View style={S.grid2}>
            <F label={tp('field.howDidYouHear')} value={ad.howDidYouHear} />
            <F label={tp('field.additionalNotes')} value={ad.additionalNotes} />
          </View>
        </View>

        {/* Declaration */}
        <View style={S.section}>
          <Text style={S.sectionTitle}>Declaration</Text>
          <View style={S.grid2}>
            <F label={tp('field.informationDeclaration')} value={ad.declarationAccepted ? '✓ Agreed' : '✗ Not agreed'} />
            <F label={tp('field.dataProcessingConsent')} value={ad.agreeDataProcessing ? '✓ Agreed' : '✗ Not agreed'} />
            <F label={tp('field.backgroundDeclaration')} value={ad.agreeBackground ? '✓ Agreed' : '✗ Not agreed'} />
          </View>
        </View>

        <View style={S.footer} fixed>
          <Text style={S.footerText}>{tp('footer')}</Text>
          <Text style={S.footerText} render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

// ── Shared blob builder ──────────────────────────────────────────────────────
// Produces the final PDF blob for an applicant: renders the react-pdf
// document, optionally embeds the profile photo in the header, and
// appends every uploaded supporting document (PDFs verbatim, images on
// their own A4 page). Shared between the profile button and the bulk
// "Export PDFs" flow on the Leads / Candidates list so both produce
// identical output.
export async function buildApplicantPdfBlob(applicant: any, documents: any[] = []): Promise<Blob> {
  // 1. Profile photo for the header.
  let photoDataUrl: string | undefined;
  if (applicant.photoUrl) {
    try {
      const res = await fetch(applicant.photoUrl?.startsWith('http') ? applicant.photoUrl : `${API_BASE}${applicant.photoUrl}`);
      const blob = await res.blob();
      photoDataUrl = await new Promise<string>(resolve => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.readAsDataURL(blob);
      });
    } catch { /* photo optional */ }
  }

  // 2. Render the application pages.
  const appPdfBlob = await pdf(<ApplicantPDF applicant={applicant} photoDataUrl={photoDataUrl} />).toBlob();
  if (!documents || documents.length === 0) return appPdfBlob;

  // 3. Merge with supporting documents via pdf-lib.
  const mergedPdf = await PDFDocument.create();
  const appBytes = await appPdfBlob.arrayBuffer();
  const appPdfDoc = await PDFDocument.load(appBytes);
  const appPages = await mergedPdf.copyPages(appPdfDoc, appPdfDoc.getPageIndices());
  appPages.forEach(p => mergedPdf.addPage(p));

  // Route through the same-origin proxy: Spaces URLs are blocked by CORS
  // when fetched from the dashboard origin, so direct fetch silently
  // failed and the supporting docs never made it into the merged PDF.
  const token = localStorage.getItem('access_token');
  for (const doc of documents) {
    try {
      const res = await fetch(`${API_URL}/documents/${doc.id}/file`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = await res.arrayBuffer();
      const mime = doc.mimeType ?? res.headers.get('content-type') ?? '';
      if (mime === 'application/pdf') {
        const docPdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
        const pages = await mergedPdf.copyPages(docPdf, docPdf.getPageIndices());
        pages.forEach(p => mergedPdf.addPage(p));
      } else if (mime.startsWith('image/')) {
        const page = mergedPdf.addPage([595, 842]); // A4
        const img = mime === 'image/png' ? await mergedPdf.embedPng(bytes) : await mergedPdf.embedJpg(bytes);
        const { width, height } = img.scaleToFit(523, 770);
        page.drawImage(img, { x: (595 - width) / 2, y: (842 - height) / 2, width, height });
      }
      // docx / unknown types are silently skipped — pdf-lib can't embed them.
    } catch (e) {
      // Any single-doc failure should never abort the whole export —
      // the operator still gets every other doc + the application.
      console.warn(`[pdf-export] failed to merge document ${doc.id} (${doc.name}):`, e);
    }
  }

  const mergedBytes = await mergedPdf.save();
  return new Blob([mergedBytes], { type: 'application/pdf' });
}

// ── Export Dialog ─────────────────────────────────────────────────────────────

interface Props {
  applicant: any;
  documents: any[];
}

export function ApplicantPdfExportButton({ applicant, documents }: Props) {
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const [open, setOpen] = useState(false);
  // Pre-select every uploaded document by default so the "Download PDF"
  // button produces a complete bundle on first click. The operator can
  // still untick anything they don't want before generating.
  const [selectedDocs, setSelectedDocs] = useState<Set<string>>(() => new Set(documents.map(d => d.id)));
  const [generating, setGenerating] = useState(false);

  // Re-seed the selection whenever the documents array changes (late
  // fetch, new upload from another tab) or the dialog reopens, so the
  // dialog never shows with nothing ticked while there are docs.
  useEffect(() => {
    if (open) setSelectedDocs(new Set(documents.map(d => d.id)));
  }, [open, documents]);

  const toggleDoc = (id: string) => {
    setSelectedDocs(prev => {
      const s = new Set(prev);
      s.has(id) ? s.delete(id) : s.add(id);
      return s;
    });
  };

  const selectAll = () => setSelectedDocs(new Set(documents.map(d => d.id)));
  const clearAll = () => setSelectedDocs(new Set());

  const handleExport = async () => {
    setGenerating(true);
    try {
      const docsToMerge = documents.filter(d => selectedDocs.has(d.id));
      const blob = await buildApplicantPdfBlob(applicant, docsToMerge);
      downloadBlob(blob, `${applicant.fullName}_Application.pdf`);
      setOpen(false);
    } catch (e) {
      console.error(e);
    } finally {
      setGenerating(false);
    }
  };

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} className="gap-2">
        <Download className="w-4 h-4" />
        {tc('actions.downloadPdf')}
      </Button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between p-5 border-b">
              <div>
                <h3 className="font-semibold text-gray-900">{t('applicants.applicantPdf.dialog.title')}</h3>
                <p className="text-sm text-gray-500 mt-0.5">{t('applicants.applicantPdf.dialog.description')}</p>
              </div>
              <button onClick={() => setOpen(false)} className="p-1 text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
            </div>

            {/* Document selection */}
            <div className="flex-1 overflow-y-auto p-5 space-y-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-700">{t('applicants.applicantPdf.dialog.uploadedDocuments')}</span>
                <div className="flex gap-3">
                  <button onClick={selectAll} className="text-xs text-blue-600 hover:underline flex items-center gap-1"><CheckSquare className="w-3 h-3" /> All</button>
                  <button onClick={clearAll} className="text-xs text-gray-500 hover:underline flex items-center gap-1"><Square className="w-3 h-3" /> None</button>
                </div>
              </div>

              {documents.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-6">{t('applicants.applicantPdf.dialog.noUploadedDocuments')}</p>
              ) : (
                documents.map(doc => (
                  <label key={doc.id} className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${selectedDocs.has(doc.id) ? 'bg-blue-50 border-blue-300' : 'hover:bg-gray-50 border-gray-200'}`}>
                    <Checkbox checked={selectedDocs.has(doc.id)} onCheckedChange={() => toggleDoc(doc.id)} />
                    <FileText className="w-4 h-4 text-gray-400 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-800 truncate">{doc.name}</p>
                      <p className="text-xs text-gray-400">{doc.documentType?.name ?? '—'} · {doc.fileSize ? `${(doc.fileSize / 1024).toFixed(0)} KB` : ''}</p>
                    </div>
                  </label>
                ))
              )}
            </div>

            {/* Footer */}
            <div className="p-5 border-t flex items-center justify-between gap-3">
              <p className="text-xs text-gray-400">
                {selectedDocs.size > 0 ? `${selectedDocs.size} document${selectedDocs.size > 1 ? 's' : ''} will be appended` : 'Application data only'}
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setOpen(false)}>{tc('actions.cancel')}</Button>
                <Button size="sm" onClick={handleExport} disabled={generating} className="gap-2">
                  {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                  {generating ? tc('actions.generating') : tc('actions.downloadPdf')}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
