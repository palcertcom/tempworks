/**
 * ApplicationDataView
 * ─────────────────────────────────────────────────────────────────
 * One-stop render of every field the applicant form captures. The
 * Applicant / Candidate / Employee profiles each surface this under a
 * dedicated "Application" tab so operators can see the complete
 * submission without bouncing to the Edit page.
 *
 * Every section is guarded — nothing renders if the underlying fields
 * are empty — so the view stays compact for partial submissions while
 * still growing to a full dossier when the applicant filled in
 * everything.
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Badge } from '../ui/badge';
import {
  User, Phone, MapPin, Shield, CreditCard, Briefcase, Award,
  Globe, GraduationCap, Star, Info, FileText, Heart,
} from 'lucide-react';
import i18n from '../../../i18n';

const tv = (key: string, opts?: Record<string, unknown>): string =>
  i18n.t(`applicants.applicationView.${key}`, { ns: 'pages', ...(opts ?? {}) }) as string;

// ── Field helpers ────────────────────────────────────────────────────────────

function Field({ label, value }: { label: string; value?: ReactNode }) {
  const empty = value === undefined || value === null || value === '' || value === '—';
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-sm ${empty ? 'text-muted-foreground italic' : 'font-medium'}`}>
        {empty ? '—' : value}
      </p>
    </div>
  );
}

const yn = (v: any) => v === 'yes' || v === true ? tv('yes') : v === 'no' || v === false ? tv('no') : undefined;
const joinSpace = (...parts: any[]) => parts.filter(Boolean).join(' ').trim();
const joinComma = (...parts: any[]) => parts.filter(Boolean).join(', ');
const expiry = (date?: string, noExpiry?: boolean) => noExpiry ? tv('labels.noExpiry') : (date || undefined);
const asArray = (v: any): any[] => Array.isArray(v) ? v : [];

// ── Section wrapper ──────────────────────────────────────────────────────────

function Section({
  title, icon: Icon, children, span, id,
}: {
  title: string;
  icon: any;
  children: ReactNode;
  span?: boolean;
  id?: string;
}) {
  return (
    <Card id={id} className={`${span ? 'lg:col-span-2 ' : ''}scroll-mt-24`}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="w-4 h-4" />{title}
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

// Renders when any of the provided values is truthy, otherwise returns null.
function hasAny(...vals: any[]): boolean {
  return vals.some(v => Array.isArray(v) ? v.length > 0 : !!v);
}

// ── Component ────────────────────────────────────────────────────────────────

interface Props {
  applicationData?: any;
  /** Already-derived full applicant name for the header. Optional; no
   *  header is rendered when omitted. */
  fullName?: string;
}

export function ApplicationDataView({ applicationData, fullName }: Props) {
  const { t } = useTranslation('pages');
  const ad = applicationData ?? {};

  if (!applicationData || Object.keys(ad).length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-muted-foreground text-sm">
          {t('applicants.applicationView.empty')}
        </CardContent>
      </Card>
    );
  }

  const educations = asArray(ad.education);
  const workHistory = asArray(ad.workHistory);
  const languages = asArray(ad.languages);
  const skills = asArray(ad.skills);
  const qualifications = asArray(ad.qualifications);
  const otherCitizenships = asArray(ad.otherCitizenships);
  const transportTypes = asArray(ad.transportTypes);
  const truckBrands = asArray(ad.truckBrands);
  const trailerTypes = asArray(ad.trailerTypes);
  const gpsSystems = asArray(ad.selectedGpsSystems);
  const workRegime = asArray(ad.workRegime);
  const licenseCategories = asArray(ad.licenseCategories);

  return (
    <div className="space-y-6">
      {fullName && (
        <div className="text-sm text-muted-foreground">
          {t('applicants.applicationView.submittedBy')} <span className="font-medium text-foreground">{fullName}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ── Personal ───────────────────────────────────────────── */}
        <Section title={t('applicants.applicationView.sections.personal')} icon={User} span>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Field label={t('applicants.applicationView.labels.firstName')} value={ad.firstName} />
            <Field label={t('applicants.applicationView.labels.middleName')} value={ad.middleName} />
            <Field label={t('applicants.applicationView.labels.lastName')} value={ad.lastName} />
            <Field label={t('applicants.applicationView.labels.dateOfBirth')} value={ad.dateOfBirth} />
            <Field label={t('applicants.applicationView.labels.gender')} value={ad.gender} />
            <Field label={t('applicants.applicationView.labels.citizenship')} value={ad.citizenship} />
            {otherCitizenships.length > 0 && (
              <div className="col-span-2 md:col-span-3">
                <p className="text-xs text-muted-foreground">{t('applicants.applicationView.labels.otherCitizenships')}</p>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {otherCitizenships.map((c: string) => <Badge key={c} variant="outline">{c}</Badge>)}
                </div>
              </div>
            )}
            <Field label={t('applicants.applicationView.labels.countryOfBirth')} value={ad.countryOfBirth} />
            <Field label={t('applicants.applicationView.labels.cityOfBirth')} value={ad.cityOfBirth} />
            <Field label={t('applicants.applicationView.labels.jobCategory')} value={ad.jobTypeId ? undefined : undefined /* resolved elsewhere */} />
          </div>
        </Section>

        {/* ── Addresses ─────────────────────────────────────────── */}
        {hasAny(ad.homeAddress?.line1, ad.homeAddress?.city, ad.currentAddress?.line1) && (
          <Section title={t('applicants.applicationView.sections.addresses')} icon={MapPin} span id="section-travel">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('applicants.applicationView.subsections.permanentAddress')}</p>
                <Field label={t('applicants.applicationView.labels.street')} value={joinComma(ad.homeAddress?.line1, ad.homeAddress?.line2)} />
                <Field label={t('applicants.applicationView.labels.city')} value={ad.homeAddress?.city} />
                <Field label={t('applicants.applicationView.labels.postalCode')} value={ad.homeAddress?.postalCode} />
                <Field label={t('applicants.applicationView.labels.country')} value={ad.homeAddress?.country} />
              </div>
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('applicants.applicationView.subsections.currentAddress')} {ad.sameAsHomeAddress && <span className="text-[10px] font-normal normal-case">{t('applicants.applicationView.subsections.sameAsPermanentInline')}</span>}
                </p>
                {ad.sameAsHomeAddress ? (
                  <p className="text-sm text-muted-foreground italic">{t('applicants.applicationView.subsections.sameAsPermanent')}</p>
                ) : (
                  <>
                    <Field label={t('applicants.applicationView.labels.street')} value={joinComma(ad.currentAddress?.line1, ad.currentAddress?.line2)} />
                    <Field label={t('applicants.applicationView.labels.city')} value={ad.currentAddress?.city} />
                    <Field label={t('applicants.applicationView.labels.postalCode')} value={ad.currentAddress?.postalCode} />
                    <Field label={t('applicants.applicationView.labels.country')} value={ad.currentAddress?.country} />
                  </>
                )}
              </div>
            </div>

            {ad.livedAbroadRecently === 'yes' && (
              <div className="mt-6 pt-4 border-t space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('applicants.applicationView.subsections.livedAbroad')}</p>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <Field label={t('applicants.applicationView.labels.country')} value={ad.abroadCountry} />
                  <Field label={t('applicants.applicationView.labels.from')} value={ad.abroadDateFrom} />
                  <Field label={t('applicants.applicationView.labels.to')} value={ad.abroadDateTo} />
                  <Field label={t('applicants.applicationView.labels.address')} value={joinComma(ad.abroadAddress?.line1, ad.abroadAddress?.city, ad.abroadAddress?.country)} />
                </div>
              </div>
            )}
          </Section>
        )}

        {/* ── Contact & Communications ─────────────────────────── */}
        <Section title={t('applicants.applicationView.sections.contact')} icon={Phone} span>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Field label={t('applicants.applicationView.labels.email')} value={ad.email} />
            <Field label={t('applicants.applicationView.labels.phone')} value={joinSpace(ad.phoneCode, ad.phone)} />
            <Field
              label={t('applicants.applicationView.labels.whatsapp')}
              value={ad.phoneIsWhatsApp
                ? `${joinSpace(ad.phoneCode, ad.phone)} ${t('applicants.applicationView.labels.sameAsPhone')}`
                : joinSpace(ad.whatsappCode, ad.whatsapp)}
            />
            <Field label={t('applicants.applicationView.labels.emergencyContact')} value={joinSpace(ad.emergencyFirstName, ad.emergencyLastName)} />
            <Field label={t('applicants.applicationView.labels.relationship')} value={ad.emergencyRelation} />
            <Field label={t('applicants.applicationView.labels.emergencyPhone')} value={joinSpace(ad.emergencyPhoneCode, ad.emergencyPhone)} />
            <Field label={t('applicants.applicationView.labels.emergencyEmail')} value={ad.emergencyEmail} />
          </div>
        </Section>

        {/* ── Identification & Legal ───────────────────────────── */}
        <Section title={t('applicants.applicationView.sections.idLegal')} icon={Shield} span>
          <div className="space-y-5">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">{t('applicants.applicationView.subsections.passport')}</p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <Field label={t('applicants.applicationView.labels.number')} value={ad.passportNumber} />
                <Field label={t('applicants.applicationView.labels.issuingCountry')} value={ad.passportCountry} />
                <Field label={t('applicants.applicationView.labels.issueDate')} value={ad.passportIssueDate} />
                <Field label={t('applicants.applicationView.labels.expiry')} value={expiry(ad.passportExpiryDate, ad.passportNoExpiry)} />
              </div>
            </div>

            {ad.hasIdCard === 'yes' && (
              <div className="pt-3 border-t">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">{t('applicants.applicationView.subsections.nationalIdCard')}</p>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                  <Field label={t('applicants.applicationView.labels.number')} value={ad.idCardNumber} />
                  <Field label={t('applicants.applicationView.labels.country')} value={ad.idCardCountry} />
                  <Field label={t('applicants.applicationView.labels.expiry')} value={expiry(ad.idCardExpiryDate, ad.idCardNoExpiry)} />
                </div>
              </div>
            )}

            {ad.hasEuVisa === 'yes' && (
              <div className="pt-3 border-t">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">{t('applicants.applicationView.subsections.euVisa')}</p>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <Field label={t('applicants.applicationView.labels.type')} value={ad.euVisaType} />
                  <Field label={t('applicants.applicationView.labels.country')} value={ad.euVisaCountry} />
                  <Field label={t('applicants.applicationView.labels.number')} value={ad.euVisaNumber} />
                  <Field label={t('applicants.applicationView.labels.expiry')} value={expiry(ad.euVisaExpiryDate, ad.euVisaNoExpiry)} />
                  {ad.purposeOfIssue && <div className="col-span-2 md:col-span-4"><Field label={t('applicants.applicationView.labels.purposeOfIssue')} value={ad.purposeOfIssue} /></div>}
                </div>
              </div>
            )}

            {ad.hasEuResidence === 'yes' && (
              <div className="pt-3 border-t">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">{t('applicants.applicationView.subsections.euResidence')}</p>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <Field label={t('applicants.applicationView.labels.type')} value={ad.euResidenceType} />
                  <Field label={t('applicants.applicationView.labels.number')} value={ad.euResidenceNumber} />
                  <Field label={t('applicants.applicationView.labels.country')} value={ad.euResidenceCountry} />
                  <Field label={t('applicants.applicationView.labels.city')} value={ad.euResidenceCity} />
                  <Field label={t('applicants.applicationView.labels.issueDate')} value={ad.euResidenceIssueDate} />
                  <Field label={t('applicants.applicationView.labels.expiry')} value={expiry(ad.euResidenceExpiryDate, ad.euResidenceNoExpiry)} />
                </div>
              </div>
            )}

            {ad.hasWorkPermit === 'yes' && (
              <div className="pt-3 border-t">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">{t('applicants.applicationView.subsections.euWorkPermit')}</p>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <Field label={t('applicants.applicationView.labels.type')} value={ad.workPermitType} />
                  <Field label={t('applicants.applicationView.labels.number')} value={ad.workPermitNumber} />
                  <Field label={t('applicants.applicationView.labels.country')} value={ad.workPermitCountry} />
                  <Field label={t('applicants.applicationView.labels.issueDate')} value={ad.workPermitIssueDate} />
                  <Field label={t('applicants.applicationView.labels.expiry')} value={expiry(ad.workPermitExpiryDate, ad.workPermitNoExpiry)} />
                </div>
              </div>
            )}

            {(hasAny(yn(ad.hasHomeCriminalRecord), yn(ad.hasEuCriminalRecord))) && (
              <div className="pt-3 border-t">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">{t('applicants.applicationView.subsections.criminalRecords')}</p>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                  <Field label={t('applicants.applicationView.labels.homeRecord')} value={yn(ad.hasHomeCriminalRecord)} />
                  {ad.hasHomeCriminalRecord === 'yes' && <>
                    <Field label={t('applicants.applicationView.labels.dateOfIssue')} value={ad.homeCriminalRecordDate} />
                    <Field label={t('applicants.applicationView.labels.countryOfIssue')} value={ad.homeCriminalRecordCountry} />
                  </>}
                  <Field label={t('applicants.applicationView.labels.euRecord')} value={yn(ad.hasEuCriminalRecord)} />
                  {ad.hasEuCriminalRecord === 'yes' && <>
                    <Field label={t('applicants.applicationView.labels.dateOfIssue')} value={ad.euCriminalRecordDate} />
                    <Field label={t('applicants.applicationView.labels.countryOfIssue')} value={ad.euCriminalRecordCountry} />
                  </>}
                </div>
              </div>
            )}
          </div>
        </Section>

        {/* ── Driving Licence ──────────────────────────────────── */}
        {ad.hasDrivingLicense === 'yes' && (
          <Section title={t('applicants.applicationView.sections.drivingLicence')} icon={CreditCard} id="section-driving">
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-4">
                <Field label={t('applicants.applicationView.labels.number')} value={ad.licenseNumber} />
                <Field label={t('applicants.applicationView.labels.issuingCountry')} value={ad.licenseCountry} />
                <Field label={t('applicants.applicationView.labels.firstIssueDate')} value={ad.licenseFirstIssueDate} />
                <Field label={t('applicants.applicationView.labels.issueDate')} value={ad.licenseIssueDate} />
                <Field label={t('applicants.applicationView.labels.expiry')} value={expiry(ad.licenseExpiryDate, ad.licenseNoExpiry)} />
              </div>
              {licenseCategories.length > 0 && (
                <div className="pt-2 border-t">
                  <p className="text-xs text-muted-foreground mb-1">{t('applicants.applicationView.labels.categories')}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {licenseCategories.map((c: string) => <Badge key={c} variant="outline">{c}</Badge>)}
                  </div>
                </div>
              )}
              {qualifications.length > 0 && (
                <div className="pt-2 border-t space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('applicants.applicationView.subsections.professionalQualifications')}</p>
                  {qualifications.map((q: any, i: number) => (
                    <div key={q.id ?? i} className="p-3 border rounded-md space-y-1">
                      <p className="text-sm font-medium">{q.type || t('applicants.applicationView.labels.qualification')}{q.number ? ` · ${q.number}` : ''}</p>
                      <p className="text-xs text-muted-foreground">
                        {joinComma(q.country, q.issueDate && t('applicants.applicationView.labels.issuedPrefix', { date: q.issueDate }), expiry(q.expiryDate, q.noExpiry) && t('applicants.applicationView.labels.expiresPrefix', { date: expiry(q.expiryDate, q.noExpiry) }))}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Section>
        )}

        {/* ── Driving Experience ───────────────────────────────── */}
        {hasAny(ad.drivingExpType, ad.euExpYears, ad.domesticExpYears) && (
          <Section title={t('applicants.applicationView.sections.drivingExperience')} icon={Briefcase}>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-4">
                <Field label={t('applicants.applicationView.labels.experienceType')} value={ad.drivingExpType} />
                <Field label={t('applicants.applicationView.labels.gearbox')} value={ad.gearboxType} />
                {(ad.drivingExpType === 'eu' || ad.drivingExpType === 'both') && <>
                  <Field label={t('applicants.applicationView.labels.euYears')} value={ad.euExpYears} />
                  <Field label={t('applicants.applicationView.labels.euTotalKm')} value={ad.euExpKm} />
                  <Field label={t('applicants.applicationView.labels.euCountries')} value={ad.euExpCountries} />
                </>}
                {(ad.drivingExpType === 'domestic' || ad.drivingExpType === 'both') && <>
                  <Field label={t('applicants.applicationView.labels.domesticYears')} value={ad.domesticExpYears} />
                  <Field label={t('applicants.applicationView.labels.domesticKm')} value={ad.domesticExpKm} />
                  <Field label={t('applicants.applicationView.labels.domesticCountry')} value={ad.domesticExpCountry} />
                </>}
                <Field label={t('applicants.applicationView.labels.trafficAccidents3yr')} value={yn(ad.trafficAccidents)} />
              </div>
              {ad.trafficAccidents === 'yes' && ad.accidentDescription && (
                <Field label={t('applicants.applicationView.labels.accidentDescription')} value={ad.accidentDescription} />
              )}
              {transportTypes.length > 0 && (
                <div className="pt-2 border-t">
                  <p className="text-xs text-muted-foreground mb-1">{t('applicants.applicationView.labels.transportTypes')}</p>
                  <div className="flex flex-wrap gap-1.5">{transportTypes.map((tt: string) => <Badge key={tt} variant="outline">{tt}</Badge>)}</div>
                </div>
              )}
              {truckBrands.length > 0 && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">{t('applicants.applicationView.labels.truckBrands')}</p>
                  <div className="flex flex-wrap gap-1.5">{truckBrands.map((tt: string) => <Badge key={tt} variant="outline">{tt}</Badge>)}</div>
                  {ad.otherBrand && <p className="text-xs text-muted-foreground mt-1">{t('applicants.applicationView.labels.otherPrefix', { name: ad.otherBrand })}</p>}
                </div>
              )}
              {trailerTypes.length > 0 && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">{t('applicants.applicationView.labels.trailerTypes')}</p>
                  <div className="flex flex-wrap gap-1.5">{trailerTypes.map((tt: string) => <Badge key={tt} variant="outline">{tt}</Badge>)}</div>
                  {ad.mostUsedTrailer && <p className="text-xs text-muted-foreground mt-1">{t('applicants.applicationView.labels.mostUsedPrefix', { name: ad.mostUsedTrailer })}</p>}
                </div>
              )}
              {gpsSystems.length > 0 && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">{t('applicants.applicationView.labels.gpsSystems')}</p>
                  <div className="flex flex-wrap gap-1.5">{gpsSystems.map((tt: string) => <Badge key={tt} variant="outline">{tt}</Badge>)}</div>
                </div>
              )}
              {workRegime.length > 0 && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">{t('applicants.applicationView.labels.workRegime')}</p>
                  <div className="flex flex-wrap gap-1.5">{workRegime.map((tt: string) => <Badge key={tt} variant="outline">{tt}</Badge>)}</div>
                </div>
              )}
            </div>
          </Section>
        )}

        {/* ── Education ────────────────────────────────────────── */}
        {educations.length > 0 && (
          <Section title={t('applicants.applicationView.sections.education')} icon={GraduationCap} span id="section-education">
            <div className="space-y-3">
              {educations.map((e: any, i: number) => (
                <div key={e.id ?? i} className="p-3 border rounded-md">
                  <p className="text-sm font-semibold">{e.level || e.degree || t('applicants.applicationView.labels.education')} — {e.institution || ''}</p>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-2">
                    <Field label={t('applicants.applicationView.labels.fieldOfStudy')} value={e.fieldOfStudy} />
                    <Field label={t('applicants.applicationView.labels.country')} value={e.country} />
                    <Field label={t('applicants.applicationView.labels.startDate')} value={e.startDate} />
                    <Field label={t('applicants.applicationView.labels.endDate')} value={e.current || e.ongoing ? t('applicants.applicationView.labels.ongoing') : e.endDate} />
                  </div>
                  {e.degree && e.level !== e.degree && <Field label={t('applicants.applicationView.labels.degreeCertificate')} value={e.degree} />}
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* ── Work History ─────────────────────────────────────── */}
        {workHistory.length > 0 && (
          <Section title={t('applicants.applicationView.sections.workExperience')} icon={Briefcase} span id="section-work-experience">
            <div className="space-y-3">
              {workHistory.map((w: any, i: number) => (
                <div key={w.id ?? i} className="p-3 border rounded-md">
                  <p className="text-sm font-semibold">{w.jobTitle || t('applicants.applicationView.labels.position')} — {w.company || ''}</p>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-2">
                    <Field label={t('applicants.applicationView.labels.country')} value={w.country} />
                    <Field label={t('applicants.applicationView.labels.start')} value={w.startDate} />
                    <Field label={t('applicants.applicationView.labels.end')} value={w.current ? t('applicants.applicationView.labels.current') : w.endDate} />
                    <Field label={t('applicants.applicationView.labels.companyPhone')} value={joinSpace(w.companyPhoneCode, w.companyPhone)} />
                  </div>
                  {w.responsibilities && (
                    <div className="mt-2">
                      <p className="text-xs text-muted-foreground">{t('applicants.applicationView.labels.responsibilities')}</p>
                      <p className="text-sm whitespace-pre-wrap">{w.responsibilities}</p>
                    </div>
                  )}
                  {w.reasonForLeaving && (
                    <Field label={t('applicants.applicationView.labels.reasonForLeaving')} value={w.reasonForLeaving} />
                  )}
                  {(w.referenceName || w.referencePhone || w.referenceEmail) && (
                    <div className="mt-2 pt-2 border-t">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">{t('applicants.applicationView.subsections.reference')}</p>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        <Field label={t('applicants.applicationView.labels.name')} value={w.referenceName} />
                        <Field label={t('applicants.applicationView.labels.phone')} value={joinSpace(w.referencePhoneCode, w.referencePhone)} />
                        <Field label={t('applicants.applicationView.labels.email')} value={w.referenceEmail} />
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* ── Languages ────────────────────────────────────────── */}
        {languages.length > 0 && (
          <Section title={t('applicants.applicationView.sections.languages')} icon={Globe}>
            <div className="space-y-2">
              {languages.map((l: any, i: number) => (
                <div key={l.id ?? i} className="flex items-center justify-between p-2 border rounded">
                  <div>
                    <p className="text-sm font-medium">{l.language}{l.motherTongue ? t('applicants.applicationView.labels.motherTongue') : ''}</p>
                    <p className="text-xs text-muted-foreground">
                      {joinComma(
                        l.speakingLevel && t('applicants.applicationView.labels.speakingPrefix', { level: l.speakingLevel }),
                        l.readingLevel && t('applicants.applicationView.labels.readingPrefix', { level: l.readingLevel }),
                        l.writingLevel && t('applicants.applicationView.labels.writingPrefix', { level: l.writingLevel }),
                        l.listeningLevel && t('applicants.applicationView.labels.listeningPrefix', { level: l.listeningLevel }),
                        l.proficiency,
                      )}
                    </p>
                  </div>
                  {l.hasCertificate && <Badge variant="outline">{t('applicants.applicationView.labels.certificate')}</Badge>}
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* ── Skills ───────────────────────────────────────────── */}
        {skills.length > 0 && (
          <Section title={t('applicants.applicationView.sections.skills')} icon={Star}>
            <div className="flex flex-wrap gap-2">
              {skills.map((s: any, i: number) => (
                <Badge key={s.id ?? i} variant="outline" className="text-sm">
                  {s.skill}{s.level ? ` · ${s.level}` : ''}
                </Badge>
              ))}
            </div>
          </Section>
        )}

        {/* ── First Aid & Tools ────────────────────────────────── */}
        {hasAny(yn(ad.hasFirstAid), ad.toolsDescription) && (
          <Section title={t('applicants.applicationView.sections.firstAidTools')} icon={Heart}>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-4">
                <Field label={t('applicants.applicationView.labels.firstAidCert')} value={yn(ad.hasFirstAid)} />
                {ad.hasFirstAid === 'yes' && (
                  <Field label={t('applicants.applicationView.labels.expiry')} value={expiry(ad.firstAidExpiry, ad.firstAidNoExpiry)} />
                )}
              </div>
              {ad.toolsDescription && (
                <div>
                  <p className="text-xs text-muted-foreground">{t('applicants.applicationView.labels.toolsEquipment')}</p>
                  <p className="text-sm whitespace-pre-wrap">{ad.toolsDescription}</p>
                </div>
              )}
            </div>
          </Section>
        )}

        {/* ── Work Preferences ─────────────────────────────────── */}
        <Section title={t('applicants.applicationView.sections.workPreferences')} icon={Award}>
          <div className="grid grid-cols-2 gap-4">
            <Field label={t('applicants.applicationView.labels.preferredStartDate')} value={ad.preferredStartDate} />
            <Field label={t('applicants.applicationView.labels.availability')} value={ad.availability} />
            <Field label={t('applicants.applicationView.labels.willingToRelocate')} value={yn(ad.willingToRelocate)} />
            <Field label={t('applicants.applicationView.labels.preferredLocations')} value={ad.preferredLocations} />
            <Field label={t('applicants.applicationView.labels.weekendDriving')} value={yn(ad.weekendDriving)} />
            <Field label={t('applicants.applicationView.labels.nightDriving')} value={yn(ad.nightDriving)} />
            <Field label={t('applicants.applicationView.labels.salaryExpectation')} value={ad.salaryExpectation} />
            <Field label={t('applicants.applicationView.labels.howDidYouHear')} value={ad.howDidYouHear} />
          </div>
        </Section>

        {/* ── Additional Notes ─────────────────────────────────── */}
        {ad.additionalNotes && (
          <Section title={t('applicants.applicationView.sections.additionalNotes')} icon={Info} span>
            <p className="text-sm whitespace-pre-wrap">{ad.additionalNotes}</p>
          </Section>
        )}

        {/* ── Declarations ─────────────────────────────────────── */}
        {hasAny(ad.declarationAccepted, ad.agreeDataProcessing, ad.agreeBackground, ad.agreeDataSharing) && (
          <Section title={t('applicants.applicationView.sections.declarations')} icon={FileText} span>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label={t('applicants.applicationView.labels.truthfulInfo')} value={ad.declarationAccepted ? t('applicants.applicationView.labels.agreed') : t('applicants.applicationView.labels.notAgreed')} />
              <Field label={t('applicants.applicationView.labels.dataProcessingConsent')} value={ad.agreeDataProcessing ? t('applicants.applicationView.labels.agreed') : t('applicants.applicationView.labels.notAgreed')} />
              <Field label={t('applicants.applicationView.labels.backgroundDeclaration')} value={ad.agreeBackground ? t('applicants.applicationView.labels.agreed') : t('applicants.applicationView.labels.notAgreed')} />
              <Field label={t('applicants.applicationView.labels.dataSharing')} value={ad.agreeDataSharing ? t('applicants.applicationView.labels.agreed') : t('applicants.applicationView.labels.notAgreed')} />
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}
