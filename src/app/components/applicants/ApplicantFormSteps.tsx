import { useState, useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { settingsApi } from '../../services/api';
import { User, Phone, Shield, CreditCard, Briefcase, GraduationCap, Star, Info, FileText, CheckCircle2, Check, Upload, Plus, X, Trash2 } from 'lucide-react';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Checkbox } from '../ui/checkbox';
import { Textarea } from '../ui/textarea';
import { AddressForm, AddressData, EMPTY_ADDRESS } from '../ui/AddressForm';
import { CountrySelect } from '../ui/CountrySelect';
import { EU_COUNTRIES } from '../../data/countries';
import { PHONE_CODES } from '../../data/phoneCodes';
import i18n from '../../../i18n';
import { enumLabel } from '../../../i18n/enumLabel';
import { countryName } from '../../../i18n/formatters';
import { DateInput } from '../ui/date-input';
import { PhoneCodeCombobox } from '../ui/PhoneCodeCombobox';

/** Shorthand for translating keys under pages.applicants.form.* */
const tf = (key: string, opts?: Record<string, unknown>): string =>
  i18n.t(`applicants.form.${key}`, { ns: 'pages', ...(opts ?? {}) }) as string;

// ── Types ────────────────────────────────────────────────────────────────────

export interface UploadedFileItem {
  id: string;
  type: string;
  file: File | null;
  sectionKey?: string;
  /** Public URL when the file has been persisted to an application
   *  draft on the server — restored on resume so the UI can surface
   *  previously-uploaded files without re-prompting. */
  url?: string;
  /** Display name for already-uploaded draft files (mirrors
   *  `file.name`). */
  savedName?: string;
  /** Server-side id of the draft document; enables per-row delete. */
  draftDocId?: string;
}

export interface JobType {
  id: string;
  name: string;
}

export interface QualificationEntry {
  id: string;
  type: string;
  issueDate: string;
  expiryDate: string;
  noExpiry: boolean;
  country: string;
}

export interface EducationEntry {
  id: string;
  level: string;
  institution: string;
  fieldOfStudy: string;
  country: string;
  startDate: string;
  endDate: string;
  ongoing: boolean;
  degree: string;
}

export interface WorkHistoryEntry {
  id: string;
  company: string;
  jobTitle: string;
  companyStreet: string;
  companyCity: string;
  companyPostalCode: string;
  country: string;
  companyPhoneCode: string;
  companyPhone: string;
  startDate: string;
  endDate: string;
  current: boolean;
  responsibilities: string;
  reasonForLeaving: string;
  referenceName: string;
  referencePhoneCode: string;
  referencePhone: string;
  referenceEmail: string;
}

export interface SkillEntry {
  id: string;
  skill: string;
  level: string;
  isCustom?: boolean;
}

export interface LanguageEntry {
  id: string;
  language: string;
  motherTongue: boolean;
  speakingLevel: string;
  readingLevel: string;
  writingLevel: string;
  listeningLevel: string;
  hasCertificate: boolean;
  certificate: string;
}

export interface FormSettings {
  visaTypes: string[];
  familyRelations: string[];
  drivingQualifications: string[];
  gpsSystemTypes: string[];
  howDidYouHear: string[];
  educationLevels: string[];
  declarationText: string;
  skills: string[];
  transportTypes: string[];
  truckBrands: string[];
  trailerTypes: string[];
}

export const DEFAULT_FORM_SETTINGS: FormSettings = {
  visaTypes: ['Tourist', 'Business', 'Work', 'Student', 'Transit', 'Family Reunification', 'Schengen', 'Long-stay', 'Other'],
  familyRelations: ['Spouse', 'Partner', 'Parent', 'Child', 'Sibling', 'Friend', 'Colleague', 'Other'],
  drivingQualifications: ['Tachograph Card', 'C95 / CPC Card', 'ADR Certificate', 'Medical Certificate', 'DVLA Check', 'Transport Manager CPC'],
  gpsSystemTypes: ['TomTom', 'Garmin', 'Webfleet', 'Sygic', 'HERE', 'Google Maps', 'Other'],
  howDidYouHear: ['Facebook', 'LinkedIn', 'Job Portal', 'Friend / Referral', 'Recruitment Agency', 'Google Search', 'Company Website', 'Other'],
  transportTypes: ['International', 'Domestic', 'Bilateral', 'Cabotage', 'Hazardous', 'Refrigerated'],
  truckBrands: ['Volvo', 'Scania', 'DAF', 'MAN', 'Mercedes-Benz', 'Iveco'],
  trailerTypes: ['Curtain Sider', 'Reefer', 'Tanker', 'Container', 'Walking Floor', 'Lowdeck', 'Mega', 'Swap Body'],
  educationLevels: ["Primary School", "Secondary School", "High School / A-Levels", "Vocational Training", "Associate Degree", "Bachelor's Degree", "Master's Degree", "Doctoral Degree", "Professional Certification", "Other"],
  declarationText: 'I declare that the information provided in this application is true, complete and accurate to the best of my knowledge. I understand that providing false or misleading information may result in my application being rejected or employment being terminated.',
  skills: ['Microsoft Office', 'Email', 'GPS / Navigation', 'Transport Management Software', 'Tachograph Software', 'Teamwork', 'Communication', 'Time Management', 'Problem Solving', 'Customer Service', 'Self-motivated', 'Adaptability'],
};

export interface ApplicantFormData {
  jobTypeId: string;
  firstName: string;
  middleName: string;
  lastName: string;
  dateOfBirth: string;
  gender: string;
  citizenship: string;
  otherCitizenships: string[];
  countryOfBirth: string;
  cityOfBirth: string;
  homeAddress: AddressData;
  currentAddress: AddressData;
  sameAsHomeAddress: boolean;
  phoneCode: string;
  phone: string;
  phoneIsWhatsApp: boolean;
  whatsappCode: string;
  whatsapp: string;
  email: string;
  emailConfirm: string;
  emergencyFirstName: string;
  emergencyLastName: string;
  emergencyRelation: string;
  emergencyPhoneCode: string;
  emergencyPhone: string;
  emergencyEmail: string;
  passportNumber: string;
  passportIssueDate: string;
  passportExpiryDate: string;
  passportNoExpiry: boolean;
  passportCountry: string;
  hasIdCard: string;
  idCardNumber: string;
  idCardExpiryDate: string;
  idCardNoExpiry: boolean;
  idCardCountry: string;
  hasEuVisa: string;
  euVisaType: string;
  euVisaCountry: string;
  euVisaNumber: string;
  euVisaExpiryDate: string;
  euVisaNoExpiry: boolean;
  hasEuResidence: string;
  euResidenceType: string;
  euResidenceNumber: string;
  euResidenceIssueDate: string;
  euResidenceExpiryDate: string;
  euResidenceNoExpiry: boolean;
  euResidenceCountry: string;
  euResidenceCity: string;
  hasWorkPermit: string;
  workPermitType: string;
  workPermitNumber: string;
  workPermitIssueDate: string;
  workPermitExpiryDate: string;
  workPermitNoExpiry: boolean;
  workPermitCountry: string;
  hasHomeCriminalRecord: string;
  homeCriminalRecordDate: string;
  homeCriminalRecordCountry: string;
  hasEuCriminalRecord: string;
  euCriminalRecordDate: string;
  euCriminalRecordCountry: string;
  purposeOfIssue: string;
  hasDrivingLicense: string;
  licenseNumber: string;
  licenseFirstIssueDate: string;
  licenseIssueDate: string;
  licenseExpiryDate: string;
  licenseNoExpiry: boolean;
  licenseCountry: string;
  licenseCategories: string[];
  qualifications: QualificationEntry[];
  drivingExpType: string;
  euExpYears: string;
  euExpCountries: string;
  euExpKm: string;
  domesticExpYears: string;
  domesticExpKm: string;
  domesticExpCountry: string;
  transportTypes: string[];
  truckBrands: string[];
  otherBrand: string;
  selectedGpsSystems: string[];
  trailerTypes: string[];
  mostUsedTrailer: string;
  gearboxType: string;
  weekendDriving: boolean;
  nightDriving: boolean;
  workRegime: string[];
  trafficAccidents: string;
  accidentDescription: string;
  education: EducationEntry[];
  workHistory: WorkHistoryEntry[];
  languages: LanguageEntry[];
  skills: SkillEntry[];
  hasFirstAid: string;
  firstAidExpiry: string;
  firstAidNoExpiry: boolean;
  toolsDescription: string;
  preferredStartDate: string;
  howDidYouHear: string;
  availability: string;
  willingToRelocate: boolean;
  preferredLocations: string;
  salaryExpectation: string;
  additionalNotes: string;
  declarationAccepted: boolean;
  agreeDataProcessing: boolean;
  agreeBackground: boolean;
  agreeDataSharing: boolean;
  livedAbroadRecently: string;
  abroadCountry: string;
  abroadAddress: AddressData;
  abroadDateFrom: string;
  abroadDateTo: string;
}

export const EMPTY_FORM: ApplicantFormData = {
  jobTypeId: '',
  firstName: '',
  middleName: '',
  lastName: '',
  dateOfBirth: '',
  gender: '',
  citizenship: '',
  otherCitizenships: [],
  countryOfBirth: '',
  cityOfBirth: '',
  homeAddress: { ...EMPTY_ADDRESS },
  currentAddress: { ...EMPTY_ADDRESS },
  sameAsHomeAddress: false,
  // Phone country codes start empty so the dropdown shows a 'Code'
  // prompt — same convention as every other phone field on the site.
  phoneCode: '',
  phone: '',
  phoneIsWhatsApp: false,
  whatsappCode: '',
  whatsapp: '',
  email: '',
  emailConfirm: '',
  emergencyFirstName: '',
  emergencyLastName: '',
  emergencyRelation: '',
  emergencyPhoneCode: '',
  emergencyPhone: '',
  emergencyEmail: '',
  passportNumber: '',
  passportIssueDate: '',
  passportExpiryDate: '',
  passportNoExpiry: false,
  passportCountry: '',
  hasIdCard: '',
  idCardNumber: '',
  idCardExpiryDate: '',
  idCardNoExpiry: false,
  idCardCountry: '',
  hasEuVisa: '',
  euVisaType: '',
  euVisaCountry: '',
  euVisaNumber: '',
  euVisaExpiryDate: '',
  euVisaNoExpiry: false,
  hasEuResidence: '',
  euResidenceType: '',
  euResidenceNumber: '',
  euResidenceIssueDate: '',
  euResidenceExpiryDate: '',
  euResidenceNoExpiry: false,
  euResidenceCountry: '',
  euResidenceCity: '',
  hasWorkPermit: '',
  workPermitType: '',
  workPermitNumber: '',
  workPermitIssueDate: '',
  workPermitExpiryDate: '',
  workPermitNoExpiry: false,
  workPermitCountry: '',
  hasHomeCriminalRecord: '',
  homeCriminalRecordDate: '',
  homeCriminalRecordCountry: '',
  hasEuCriminalRecord: '',
  euCriminalRecordDate: '',
  euCriminalRecordCountry: '',
  purposeOfIssue: '',
  hasDrivingLicense: '',
  licenseNumber: '',
  licenseFirstIssueDate: '',
  licenseIssueDate: '',
  licenseExpiryDate: '',
  licenseNoExpiry: false,
  licenseCountry: '',
  licenseCategories: [],
  qualifications: [],
  drivingExpType: '',
  euExpYears: '',
  euExpCountries: '',
  euExpKm: '',
  domesticExpYears: '',
  domesticExpKm: '',
  domesticExpCountry: '',
  transportTypes: [],
  truckBrands: [],
  otherBrand: '',
  selectedGpsSystems: [],
  trailerTypes: [],
  mostUsedTrailer: '',
  gearboxType: '',
  weekendDriving: false,
  nightDriving: false,
  workRegime: [],
  trafficAccidents: '',
  accidentDescription: '',
  education: [],
  workHistory: [],
  languages: [],
  skills: [],
  hasFirstAid: '',
  firstAidExpiry: '',
  firstAidNoExpiry: false,
  toolsDescription: '',
  preferredStartDate: '',
  howDidYouHear: '',
  availability: '',
  willingToRelocate: false,
  preferredLocations: '',
  salaryExpectation: '',
  additionalNotes: '',
  declarationAccepted: false,
  agreeDataProcessing: false,
  agreeBackground: false,
  agreeDataSharing: false,
  livedAbroadRecently: '',
  abroadCountry: '',
  abroadAddress: { ...EMPTY_ADDRESS },
  abroadDateFrom: '',
  abroadDateTo: '',
};

const TAB_DEFS = [
  { id: 1, labelKey: 'tabs.personal', Icon: User },
  { id: 2, labelKey: 'tabs.contact', Icon: Phone },
  { id: 3, labelKey: 'tabs.idLegal', Icon: Shield },
  { id: 4, labelKey: 'tabs.drivingLicense', Icon: CreditCard },
  { id: 5, labelKey: 'tabs.drivingExp', Icon: Briefcase },
  { id: 6, labelKey: 'tabs.education', Icon: GraduationCap },
  { id: 7, labelKey: 'tabs.experience', Icon: Briefcase },
  { id: 8, labelKey: 'tabs.skills', Icon: Star },
  { id: 9, labelKey: 'tabs.additional', Icon: Info },
  { id: 10, labelKey: 'tabs.documents', Icon: FileText },
  { id: 11, labelKey: 'tabs.review', Icon: CheckCircle2 },
];

export function getVisibleTabs(
  formData: Pick<ApplicantFormData, 'hasDrivingLicense'>,
  skipReview = false,
): number[] {
  const all = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  // Internal (dashboard) users don't need the applicant-facing Review
  // + Declaration page — they submit the form directly from Documents.
  const base = skipReview ? all.filter(t => t !== 11) : all;
  if (formData.hasDrivingLicense !== 'yes') return base.filter(t => t !== 5);
  return base;
}

/** Returns validation error messages for the current step before allowing navigation to the next step. */
export function getStepErrors(
  actualTab: number,
  d: ApplicantFormData,
  uploadedFiles: UploadedFileItem[],
  photoFile: File | null,
  requiredDocuments?: string[],
): string[] {
  const errors: string[] = [];
  // A file counts as present if (a) the user just picked one (f.file) OR
  // (b) it was already persisted to the draft / server in a previous
  // session (savedName / url present). Without the second branch the
  // form falsely reports "please upload" after a draft is reopened.
  const hasFile = (key: string) =>
    uploadedFiles.some(f => f.sectionKey === key && (!!f.file || !!f.savedName || !!f.url));
  const validEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  /** Push an error if both dates are set and issue >= expiry. Skips the
   *  check when the matching 'noExpiry' flag is on or when either value
   *  is missing (other validators cover those cases). */
  const checkDateOrder = (label: string, issue?: string, expiry?: string, noExpiry?: boolean) => {
    if (noExpiry) return;
    if (!issue || !expiry) return;
    const a = Date.parse(issue);
    const b = Date.parse(expiry);
    if (!isNaN(a) && !isNaN(b) && a >= b) {
      errors.push(tf('validation.issueBeforeExpiry', { label }));
    }
  };

  // ── Tab 1: Personal ───────────────────────────────────────────────────────
  if (actualTab === 1) {
    if (!d.jobTypeId) errors.push(tf('validation.selectJobCategory'));
    if (!photoFile) errors.push(tf('validation.photoRequired'));
    if (!d.firstName?.trim()) errors.push(tf('validation.firstNameRequired'));
    if (!d.lastName?.trim()) errors.push(tf('validation.lastNameRequired'));
    if (!d.dateOfBirth) errors.push(tf('validation.dobRequired'));
    if (!d.citizenship) errors.push(tf('validation.citizenshipRequired'));
    if (!d.homeAddress?.line1?.trim()) errors.push(tf('validation.permanentAddressLine1'));
    if (!d.homeAddress?.city?.trim()) errors.push(tf('validation.permanentAddressCity'));
    if (!d.homeAddress?.country?.trim()) errors.push(tf('validation.permanentAddressCountry'));
    if (!d.livedAbroadRecently) errors.push(tf('validation.abroadAnswerRequired'));
    if (d.livedAbroadRecently === 'yes') {
      // The standalone abroadCountry was removed in favour of the
      // canonical country field inside abroadAddress. Mirror the value
      // for backwards compat with PDF/review consumers below.
      const abroadCountry = d.abroadAddress?.country?.trim() || d.abroadCountry?.trim() || '';
      if (!abroadCountry) errors.push(tf('validation.abroadCountryRequired'));
      if (!d.abroadAddress?.line1?.trim()) errors.push(tf('validation.abroadAddressLine1Required', { defaultValue: 'Previous-country address line 1 is required' }));
      if (!d.abroadDateFrom) errors.push(tf('validation.abroadDateFromRequired'));
      if (!d.abroadDateTo) errors.push(tf('validation.abroadDateToRequired'));
    }
  }

  // ── Tab 2: Contact ────────────────────────────────────────────────────────
  if (actualTab === 2) {
    if (!d.phone?.trim()) errors.push(tf('validation.phoneRequired'));
    if (!d.email?.trim()) errors.push(tf('validation.emailRequired'));
    else if (!validEmail(d.email)) errors.push(tf('validation.emailInvalid'));
    if (!d.emailConfirm?.trim()) errors.push(tf('validation.confirmEmailRequired'));
    else if (d.email !== d.emailConfirm) errors.push(tf('validation.emailsDoNotMatch'));
    if (!d.phoneIsWhatsApp && !d.whatsapp?.trim())
      errors.push(tf('validation.whatsappRequired'));
    if (!d.emergencyFirstName?.trim()) errors.push(tf('validation.emergencyFirstNameRequired'));
    if (!d.emergencyLastName?.trim()) errors.push(tf('validation.emergencyLastNameRequired'));
    if (!d.emergencyRelation) errors.push(tf('validation.emergencyRelationRequired'));
    if (!d.emergencyPhone?.trim()) errors.push(tf('validation.emergencyPhoneRequired'));
  }

  // ── Tab 3: Identification & Legal Status ──────────────────────────────────
  if (actualTab === 3) {
    if (!d.passportNumber?.trim()) errors.push(tf('validation.passportNumberRequired'));
    // Passport upload is mandatory across the application form — not only
    // when the job ad declares it as a required document. Accept either
    // the job-ad-keyed slot (`required:<name>`) or the generic `passport`
    // slot used when no required-docs list applies.
    const passportDocName = requiredDocuments?.find(n => n.toLowerCase() === 'passport');
    const passportUploaded =
      (passportDocName && hasFile(`required:${passportDocName}`)) ||
      hasFile('passport');
    if (!passportUploaded) {
      errors.push(tf('validation.requiredPassportUpload'));
    }
    const nationalIdDocName = requiredDocuments?.find(n => n.toLowerCase().includes('national id'));
    if (nationalIdDocName && !hasFile(`required:${nationalIdDocName}`))
      errors.push(tf('validation.requiredNationalIdUpload'));
    if (!d.hasIdCard) errors.push(tf('validation.hasIdCardAnswer'));
    if (!d.hasEuVisa) errors.push(tf('validation.hasEuVisaAnswer'));
    if (!d.hasEuResidence) errors.push(tf('validation.hasEuResidenceAnswer'));
    if (!d.hasWorkPermit) errors.push(tf('validation.hasWorkPermitAnswer'));
    if (!d.hasHomeCriminalRecord) errors.push(tf('validation.hasHomeCriminalAnswer'));
    if (!d.hasEuCriminalRecord) errors.push(tf('validation.hasEuCriminalAnswer'));
    if (!nationalIdDocName && d.hasIdCard === 'yes' && !hasFile('idCard'))
      errors.push(tf('validation.uploadIdCard'));
    if (d.hasEuVisa === 'yes' && !hasFile('euVisa'))
      errors.push(tf('validation.uploadEuVisa'));
    if (d.hasEuResidence === 'yes' && !hasFile('euResidence'))
      errors.push(tf('validation.uploadEuResidence'));
    if (d.hasWorkPermit === 'yes' && !hasFile('workPermit'))
      errors.push(tf('validation.uploadWorkPermit'));
    if (d.hasHomeCriminalRecord === 'yes' && !hasFile('homeCriminalRecord'))
      errors.push(tf('validation.uploadHomeCriminal'));
    if (d.hasEuCriminalRecord === 'yes' && !hasFile('euCriminalRecord'))
      errors.push(tf('validation.uploadEuCriminal'));

    checkDateOrder(tf('validation.passportLabel'),     d.passportIssueDate,     d.passportExpiryDate,     d.passportNoExpiry);
    checkDateOrder(tf('validation.euResidenceLabel'),  d.euResidenceIssueDate,  d.euResidenceExpiryDate,  d.euResidenceNoExpiry);
    checkDateOrder(tf('validation.workPermitLabel'),   d.workPermitIssueDate,   d.workPermitExpiryDate,   d.workPermitNoExpiry);
  }

  // ── Tab 4: Driving License ────────────────────────────────────────────────
  if (actualTab === 4) {
    if (!d.hasDrivingLicense) errors.push(tf('validation.hasDrivingLicenseAnswer'));
    const dlDocName = requiredDocuments?.find(n => n.toLowerCase().includes('driving'));
    if (dlDocName && !hasFile(`required:${dlDocName}`))
      errors.push(tf('validation.requiredDrivingUpload'));
    if (d.hasDrivingLicense === 'yes') {
      if (!d.licenseNumber?.trim()) errors.push(tf('validation.licenseNumberRequired'));
      if (!d.licenseCountry) errors.push(tf('validation.licenseCountryRequired'));
      if (!d.licenseCategories || d.licenseCategories.length === 0)
        errors.push(tf('validation.licenseCategoryRequired'));
      if (!dlDocName && !hasFile('drivingLicense'))
        errors.push(tf('validation.uploadLicense'));

      // First Issue Date → Issue Date → Expiry Date
      if (d.licenseFirstIssueDate && d.licenseIssueDate) {
        const a = Date.parse(d.licenseFirstIssueDate);
        const b = Date.parse(d.licenseIssueDate);
        if (!isNaN(a) && !isNaN(b) && a > b) {
          errors.push(tf('validation.licenseFirstIssueOrder'));
        }
      }
      checkDateOrder(tf('validation.drivingLicenseLabel'), d.licenseIssueDate, d.licenseExpiryDate, d.licenseNoExpiry);
      (d.qualifications ?? []).forEach((q, i) => {
        const qLabel = tf('validation.qualificationLabel', { n: i + 1, type: q.type ? ` (${q.type})` : '' });
        checkDateOrder(qLabel, q.issueDate, q.expiryDate, q.noExpiry);
      });
    }
  }

  // ── Tab 5: Driving Experience (only visible when hasDrivingLicense = yes) ─
  if (actualTab === 5) {
    if (!d.trafficAccidents)
      errors.push(tf('validation.trafficAccidentsAnswer'));

    if (!d.drivingExpType) {
      errors.push(tf('validation.experienceTypeRequired'));
    } else {
      if (d.drivingExpType === 'eu' || d.drivingExpType === 'both') {
        if (!d.euExpYears?.toString().trim())   errors.push(tf('validation.euYearsRequired'));
        if (!d.euExpKm?.toString().trim())      errors.push(tf('validation.euKmRequired'));
        if (!d.euExpCountries?.toString().trim()) errors.push(tf('validation.euCountryRequired'));
      }
      if (d.drivingExpType === 'domestic' || d.drivingExpType === 'both') {
        if (!d.domesticExpYears?.toString().trim())   errors.push(tf('validation.domesticYearsRequired'));
        if (!d.domesticExpKm?.toString().trim())      errors.push(tf('validation.domesticKmRequired'));
        if (!d.domesticExpCountry?.toString().trim()) errors.push(tf('validation.domesticCountryRequired'));
      }
    }
  }

  // ── Tab 6: Education ──────────────────────────────────────────────────────
  if (actualTab === 6) {
    d.education?.forEach((entry, i) => {
      const n = i + 1;
      if (!entry.level?.trim())         errors.push(tf('validation.educationLevel', { n }));
      if (!entry.institution?.trim())   errors.push(tf('validation.educationInstitution', { n }));
      if (!entry.fieldOfStudy?.trim())  errors.push(tf('validation.educationFieldOfStudy', { n }));
      if (!entry.country?.trim())       errors.push(tf('validation.educationCountry', { n }));
      if (!entry.startDate)             errors.push(tf('validation.educationStartDate', { n }));
      if (!entry.ongoing && !entry.endDate) errors.push(tf('validation.educationEndDate', { n }));
      if (entry.startDate && !entry.ongoing && entry.endDate) {
        const a = Date.parse(entry.startDate);
        const b = Date.parse(entry.endDate);
        if (!isNaN(a) && !isNaN(b) && a > b) {
          errors.push(tf('validation.educationStartBeforeEnd', { n }));
        }
      }
    });
  }

  // ── Tab 7: Work Experience ────────────────────────────────────────────────
  if (actualTab === 7) {
    d.workHistory.forEach((entry, i) => {
      const n = i + 1;
      if (!entry.companyStreet?.trim()) errors.push(tf('validation.workCompanyStreet', { n }));
      if (!entry.companyCity?.trim()) errors.push(tf('validation.workCompanyCity', { n }));
      if (!entry.companyPostalCode?.trim()) errors.push(tf('validation.workCompanyPostal', { n }));
      if (!entry.country?.trim()) errors.push(tf('validation.workCountry', { n }));
      if (!entry.companyPhone?.trim()) errors.push(tf('validation.workCompanyPhone', { n }));
    });
  }

  // ── Tab 8: Skills ─────────────────────────────────────────────────────────
  if (actualTab === 8) {
    if (!d.hasFirstAid) errors.push(tf('validation.firstAidAnswer'));
    if (d.hasFirstAid === 'yes' && !hasFile('firstAid'))
      errors.push(tf('validation.uploadFirstAid'));

    d.languages?.forEach((lang, i) => {
      const n = i + 1;
      if (!lang.language?.trim()) errors.push(tf('validation.languageRequired', { n }));
      if (!lang.motherTongue) {
        if (!lang.speakingLevel)  errors.push(tf('validation.languageSpeaking', { n }));
        if (!lang.readingLevel)   errors.push(tf('validation.languageReading', { n }));
        if (!lang.writingLevel)   errors.push(tf('validation.languageWriting', { n }));
        if (!lang.listeningLevel) errors.push(tf('validation.languageListening', { n }));
      }
      if (lang.hasCertificate && !lang.certificate?.trim())
        errors.push(tf('validation.languageCertificate', { n }));
    });
  }

  // ── Tab 9: Additional ─────────────────────────────────────────────────────
  if (actualTab === 9) {
    if (!d.preferredStartDate) errors.push(tf('validation.preferredStartDateRequired'));
    if (!d.howDidYouHear) errors.push(tf('validation.howDidYouHearRequired'));
  }

  // ── Tab 10: Documents ─────────────────────────────────────────────────────
  if (actualTab === 10) {
    // Passport upload is mandatory on every application, regardless of
    // the job ad's required-docs list.
    const passportDocName = requiredDocuments?.find(n => n.toLowerCase() === 'passport');
    const passportUploaded =
      (passportDocName && hasFile(`required:${passportDocName}`)) ||
      hasFile('passport');
    if (!passportUploaded) {
      errors.push(tf('validation.requiredPassportUpload'));
    }
    if (requiredDocuments && requiredDocuments.length > 0) {
      for (const docName of requiredDocuments) {
        if (!hasFile(`required:${docName}`))
          errors.push(tf('validation.requiredDocByName', { name: docName }));
      }
    }
  }

  return errors;
}

/** Field-level errors keyed by form field name. Consumed by the Step
 *  components to render the error message inline below the matching
 *  input. Kept separate from getStepErrors (which returns flat strings
 *  for toasts / summary banners) so we don't break existing callers.
 *  For qualification rows the key is prefixed: `qualifications.<id>.<field>`.
 */
export function getStepFieldErrors(
  actualTab: number,
  d: ApplicantFormData,
): Record<string, string> {
  const out: Record<string, string> = {};
  const before = (issue?: string, expiry?: string, noExpiry?: boolean) => {
    if (noExpiry) return false;
    if (!issue || !expiry) return false;
    const a = Date.parse(issue);
    const b = Date.parse(expiry);
    return !isNaN(a) && !isNaN(b) && a >= b;
  };

  const issueBefore = tf('fieldErr.issueBefore');
  const expiryAfter = tf('fieldErr.expiryAfter');

  // Tab 3 — Identification date pairs
  if (actualTab === 3) {
    if (before(d.passportIssueDate, d.passportExpiryDate, d.passportNoExpiry)) {
      out['passportIssueDate'] = issueBefore;
      out['passportExpiryDate'] = expiryAfter;
    }
    if (before(d.euResidenceIssueDate, d.euResidenceExpiryDate, d.euResidenceNoExpiry)) {
      out['euResidenceIssueDate'] = issueBefore;
      out['euResidenceExpiryDate'] = expiryAfter;
    }
    if (before(d.workPermitIssueDate, d.workPermitExpiryDate, d.workPermitNoExpiry)) {
      out['workPermitIssueDate'] = issueBefore;
      out['workPermitExpiryDate'] = expiryAfter;
    }
  }

  // Tab 4 — Driving License
  if (actualTab === 4 && d.hasDrivingLicense === 'yes') {
    if (!d.licenseNumber?.trim())   out['licenseNumber']   = tf('fieldErr.licenseNumberRequired');
    if (!d.licenseCountry)          out['licenseCountry']  = tf('fieldErr.issuingCountryRequired');
    if (!d.licenseCategories || d.licenseCategories.length === 0)
      out['licenseCategories'] = tf('fieldErr.selectAtLeastOneCategory');
    if (d.licenseFirstIssueDate && d.licenseIssueDate) {
      const a = Date.parse(d.licenseFirstIssueDate);
      const b = Date.parse(d.licenseIssueDate);
      if (!isNaN(a) && !isNaN(b) && a > b) {
        out['licenseFirstIssueDate'] = tf('fieldErr.firstIssueOrder');
      }
    }
    if (before(d.licenseIssueDate, d.licenseExpiryDate, d.licenseNoExpiry)) {
      out['licenseIssueDate']  = issueBefore;
      out['licenseExpiryDate'] = expiryAfter;
    }
    (d.qualifications ?? []).forEach((q) => {
      if (before(q.issueDate, q.expiryDate, q.noExpiry)) {
        out[`qualifications.${q.id}.issueDate`]  = issueBefore;
        out[`qualifications.${q.id}.expiryDate`] = expiryAfter;
      }
    });
  }

  // Tab 5 — Driving Experience
  if (actualTab === 5) {
    if (!d.drivingExpType) out['drivingExpType'] = tf('fieldErr.pickExperienceType');
    if (d.drivingExpType === 'eu' || d.drivingExpType === 'both') {
      if (!d.euExpYears?.toString().trim())      out['euExpYears']      = tf('fieldErr.yearsRequired');
      if (!d.euExpKm?.toString().trim())         out['euExpKm']         = tf('fieldErr.totalKmRequired');
      if (!d.euExpCountries?.toString().trim()) out['euExpCountries'] = tf('fieldErr.countryRequired');
    }
    if (d.drivingExpType === 'domestic' || d.drivingExpType === 'both') {
      if (!d.domesticExpYears?.toString().trim())   out['domesticExpYears']   = tf('fieldErr.yearsRequired');
      if (!d.domesticExpKm?.toString().trim())      out['domesticExpKm']      = tf('fieldErr.totalKmRequired');
      if (!d.domesticExpCountry?.toString().trim()) out['domesticExpCountry'] = tf('fieldErr.countryRequired');
    }
  }

  // Tab 8 — Skills & Qualifications (per-row required fields when a
  // language entry exists)
  if (actualTab === 8) {
    (d.languages ?? []).forEach((lang) => {
      const k = (f: string) => `languages.${lang.id}.${f}`;
      if (!lang.language?.trim()) out[k('language')] = tf('fieldErr.selectLanguage');
      if (!lang.motherTongue) {
        if (!lang.speakingLevel)  out[k('speakingLevel')]  = tf('fieldErr.levelRequired');
        if (!lang.readingLevel)   out[k('readingLevel')]   = tf('fieldErr.levelRequired');
        if (!lang.writingLevel)   out[k('writingLevel')]   = tf('fieldErr.levelRequired');
        if (!lang.listeningLevel) out[k('listeningLevel')] = tf('fieldErr.levelRequired');
      }
      if (lang.hasCertificate && !lang.certificate?.trim())
        out[k('certificate')] = tf('fieldErr.certificateRequired');
    });
  }

  // Tab 6 — Education (per-row required fields when an entry exists)
  if (actualTab === 6) {
    (d.education ?? []).forEach((e) => {
      const k = (f: string) => `education.${e.id}.${f}`;
      if (!e.level?.trim())        out[k('level')]        = tf('fieldErr.levelRequired');
      if (!e.institution?.trim())  out[k('institution')]  = tf('fieldErr.institutionRequired');
      if (!e.fieldOfStudy?.trim()) out[k('fieldOfStudy')] = tf('fieldErr.fieldOfStudyRequired');
      if (!e.country?.trim())      out[k('country')]      = tf('fieldErr.countryRequired');
      if (!e.startDate)            out[k('startDate')]    = tf('fieldErr.startDateRequired');
      if (!e.ongoing && !e.endDate) out[k('endDate')]     = tf('fieldErr.endDateRequired');
      if (e.startDate && !e.ongoing && e.endDate) {
        const a = Date.parse(e.startDate);
        const b = Date.parse(e.endDate);
        if (!isNaN(a) && !isNaN(b) && a > b) {
          out[k('startDate')] = tf('fieldErr.startBeforeEnd');
          out[k('endDate')]   = tf('fieldErr.endAfterStart');
        }
      }
    });
  }

  return out;
}

const LICENSE_CATEGORIES = ['AM', 'A1', 'A2', 'A', 'B1', 'B', 'BE', 'C1', 'C1E', 'C', 'CE', 'D1', 'D1E', 'D', 'DE', 'T'];


const PROFICIENCY_LEVELS = ['A1 - Beginner', 'A2 - Elementary', 'B1 - Intermediate', 'B2 - Upper Intermediate', 'C1 - Advanced', 'C2 - Mastery', 'Native'];

const LANGUAGES = ['Albanian', 'Arabic', 'Bosnian', 'Bulgarian', 'Chinese (Cantonese)', 'Chinese (Mandarin)', 'Croatian', 'Czech', 'Danish', 'Dutch', 'English', 'Estonian', 'Finnish', 'French', 'German', 'Greek', 'Hungarian', 'Italian', 'Latvian', 'Lithuanian', 'Macedonian', 'Maltese', 'Norwegian', 'Persian', 'Polish', 'Portuguese', 'Romanian', 'Russian', 'Serbian', 'Slovak', 'Slovenian', 'Spanish', 'Swedish', 'Turkish', 'Ukrainian', 'Urdu', 'Other'];

const SKILL_LEVELS = ['Beginner', 'Intermediate', 'Advanced', 'Expert'];

// ── Step Indicator ────────────────────────────────────────────────────────────

export function StepIndicator({ currentStep, visibleTabs, onStepClick }: { currentStep: number; visibleTabs: number[]; onStepClick?: (step: number) => void }) {
  const { t } = useTranslation('pages');
  const total = visibleTabs.length;
  const progress = Math.round((currentStep / total) * 100);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-gray-700">{t('applicants.form.stepIndicator.stepOf', { current: currentStep, total })}</span>
        <span className="text-sm text-gray-500">{t('applicants.form.stepIndicator.percentComplete', { percent: progress })}</span>
      </div>
      <div className="w-full h-1.5 bg-gray-200 rounded-full overflow-hidden">
        <div className="h-full bg-blue-600 rounded-full transition-all duration-500" style={{ width: `${progress}%` }} />
      </div>
      {/* pt-2 + px-1 reserve space for the focus/hover ring that renders
          outside the 36px circle, otherwise overflow-x-auto clips the
          top of the ring on the currently-focused step. */}
      <div className="hidden md:flex items-start justify-between overflow-x-auto gap-1 pt-2 px-1">
        {visibleTabs.map((tabId, index) => {
          const def = TAB_DEFS.find(t => t.id === tabId)!;
          const visIdx = index + 1;
          const isCompleted = visIdx < currentStep;
          const isCurrent = visIdx === currentStep;
          const { Icon } = def;
          return (
            <button
              key={tabId}
              type="button"
              onClick={() => onStepClick?.(visIdx)}
              className={`flex flex-col items-center gap-1 flex-1 min-w-0 ${onStepClick ? 'cursor-pointer group' : 'cursor-default'}`}
            >
              <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 transition-all ${isCompleted ? 'bg-green-500' : isCurrent ? 'bg-blue-600' : 'bg-gray-100 border-2 border-gray-200'} ${onStepClick && !isCurrent ? 'group-hover:ring-2 group-hover:ring-blue-300' : ''}`}>
                {isCompleted ? <Check className="w-4 h-4 text-white" /> : <Icon className={`w-4 h-4 ${isCurrent ? 'text-white' : 'text-gray-400'}`} />}
              </div>
              <span className={`text-xs font-medium text-center leading-tight truncate w-full ${isCompleted ? 'text-green-600' : isCurrent ? 'text-blue-600' : 'text-gray-400'}`}>
                {t(`applicants.form.${def.labelKey}`)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function SectionTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-6">
      <h2 className="text-xl font-bold text-gray-900">{title}</h2>
      {subtitle && <p className="text-sm text-blue-600 mt-0.5">{subtitle}</p>}
    </div>
  );
}

function SubSection({ title }: { title: string }) {
  return <div className="flex items-center gap-2 pb-2 border-b border-gray-200 mb-4"><h3 className="text-base font-semibold text-gray-800">{title}</h3></div>;
}

/** Inline red error message shown below a field. Renders nothing when
 *  the key has no entry in the errors map. */
function FieldError({ errors, name }: { errors?: Record<string, string>; name: string }) {
  const msg = errors?.[name];
  if (!msg) return null;
  return <p className="text-xs text-red-600 mt-1">{msg}</p>;
}

function RadioYN({ name, value, onChange, disabledValues = [] }: { name: string; value: string; onChange: (v: string) => void; disabledValues?: string[] }) {
  const { t } = useTranslation('pages');
  const labels: Record<string, string> = {
    yes: t('applicants.form.common.yesShort'),
    no: t('applicants.form.common.noShort'),
  };
  return (
    <div className="flex gap-4">
      {['yes', 'no'].map(v => {
        const disabled = disabledValues.includes(v);
        return (
          <label key={v} className={`flex items-center gap-2 ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}>
            <input type="radio" name={name} value={v} checked={value === v} onChange={() => onChange(v)} disabled={disabled} className="w-4 h-4 accent-blue-600" />
            <span className="capitalize text-sm">{labels[v] ?? v}</span>
          </label>
        );
      })}
    </div>
  );
}

function ExpiryFields({ expiryDate, noExpiry, onExpiry, onNoExpiry }: { expiryDate: string; noExpiry: boolean; onExpiry: (v: string) => void; onNoExpiry: (v: boolean) => void }) {
  const { t } = useTranslation('pages');
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <DateInput value={noExpiry ? '' : expiryDate} onChange={e => onExpiry(e.target.value)} disabled={noExpiry} className="flex-1" placeholder={t('applicants.form.common.expiryDatePh')} />
        <label className="flex items-center gap-1.5 whitespace-nowrap cursor-pointer text-sm text-gray-600">
          <Checkbox checked={noExpiry} onCheckedChange={c => { onNoExpiry(!!c); if (c) onExpiry(''); }} />
          {t('applicants.form.common.noExpiry')}
        </label>
      </div>
    </div>
  );
}

function InlineDocUpload({ label, sectionKey, uploadedFiles, onFilesChange }: {
  label?: string;
  sectionKey: string;
  uploadedFiles: UploadedFileItem[];
  onFilesChange: (files: UploadedFileItem[]) => void;
}) {
  const { t } = useTranslation('pages');
  const effectiveLabel = label ?? t('applicants.form.common.uploadDocument');
  // Find any entry with this sectionKey, including placeholder entries (file=null).
  // This ensures required-doc placeholders are updated in-place rather than duplicated.
  const entry = uploadedFiles.find(f => f.sectionKey === sectionKey);
  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (entry) {
      onFilesChange(uploadedFiles.map(f => f.sectionKey === sectionKey ? { ...f, file, type: effectiveLabel } : f));
    } else {
      onFilesChange([...uploadedFiles, { id: crypto.randomUUID(), type: effectiveLabel, sectionKey, file }]);
    }
    e.target.value = '';
  };
  // Required-doc entries (sectionKey starts with 'required:') keep their placeholder entry so
  // Step 10 can still render the slot — just clear the file. Optional entries are removed entirely.
  const handleRemove = () => {
    if (sectionKey.startsWith('required:')) {
      onFilesChange(uploadedFiles.map(f => f.sectionKey === sectionKey ? { ...f, file: null } : f));
    } else {
      onFilesChange(uploadedFiles.filter(f => f.sectionKey !== sectionKey));
    }
  };
  // Saved-to-draft entries arrive from the server without a File
  // object. We still show them as "uploaded" so the user can see the
  // name and remove it — the removal hits the draft-delete endpoint.
  const savedLabel = entry?.savedName ?? (entry?.url ? entry.url.split('/').pop() : undefined);
  const hasSavedOnly = !entry?.file && !!savedLabel;
  return (
    <div className="space-y-1 md:col-span-2">
      <Label className="text-xs">{effectiveLabel}</Label>
      {entry?.file ? (
        <div className="flex items-center gap-2 p-2 border rounded-lg bg-green-50 border-green-200">
          <FileText className="w-4 h-4 text-green-600 shrink-0" />
          <span className="text-sm text-green-700 truncate flex-1">{entry.file.name}</span>
          <button type="button" onClick={handleRemove} className="p-0.5 text-gray-400 hover:text-red-500"><X className="w-4 h-4" /></button>
        </div>
      ) : hasSavedOnly ? (
        <div className="flex items-center gap-2 p-2 border rounded-lg bg-blue-50 border-blue-200">
          <FileText className="w-4 h-4 text-blue-600 shrink-0" />
          <span className="text-sm text-blue-700 truncate flex-1">{savedLabel} <span className="text-[11px] text-blue-500">{t('applicants.form.common.savedSuffix')}</span></span>
          <button type="button" onClick={handleRemove} className="p-0.5 text-gray-400 hover:text-red-500"><X className="w-4 h-4" /></button>
        </div>
      ) : (
        <label className="flex items-center gap-2 p-2 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-colors">
          <Upload className="w-4 h-4 text-gray-400" />
          <span className="text-sm text-gray-500">{t('applicants.form.common.uploadHint')}</span>
          <input type="file" accept=".pdf,.jpg,.jpeg,.png" className="sr-only" onChange={handleFile} />
        </label>
      )}
    </div>
  );
}

// ── Step Components ───────────────────────────────────────────────────────────

/** Resolve a JobType's display name in the active UI locale.
 *
 *  Lookup order:
 *  1. The catalog entry `enums.jobCategory.<canonical-en-name>` (covers the
 *     standard driver-industry roles shipped in the catalog).
 *  2. Fall back to whatever name the API returned — which is already
 *     localized when the JobType row in the DB has a stored translation,
 *     and otherwise the canonical English name. This keeps admin-created
 *     custom categories (e.g. "test", or any agency-specific role) rendering
 *     correctly even when the catalog has no entry. */
function localizeJobCategoryName(name: string, tEnums: ReturnType<typeof useTranslation>['t']): string {
  return tEnums(`jobCategory.${name}`, { defaultValue: name });
}

function Step1Personal({ d, u, jobTypes, photoFile, onPhotoChange, existingPhotoUrl, jobAdTitle }: {
  d: ApplicantFormData;
  u: (fn: (p: ApplicantFormData) => ApplicantFormData) => void;
  jobTypes: JobType[];
  photoFile?: File | null;
  onPhotoChange?: (file: File | null) => void;
  existingPhotoUrl?: string;
  jobAdTitle?: string;
}) {
  const { t } = useTranslation('pages');
  const { t: tEnums } = useTranslation('enums');
  const set = (field: keyof ApplicantFormData) => (value: any) => u(prev => ({ ...prev, [field]: value }));

  // Build preview URL: newly selected file takes priority over existing URL
  const previewUrl = photoFile ? URL.createObjectURL(photoFile) : existingPhotoUrl ?? null;

  return (
    <div className="space-y-8">
      <SectionTitle title={t('applicants.form.step1.title')} subtitle={t('applicants.form.step1.subtitle')} />

      {/* ── Job Category / Job Title ── */}
      <div className="space-y-2">
        {jobAdTitle ? (
          <>
            <SubSection title={t('applicants.form.step1.jobTitle')} />
            <Input value={jobAdTitle} disabled className="bg-muted text-muted-foreground cursor-not-allowed" />
          </>
        ) : (
          <>
            <SubSection title={t('applicants.form.step1.jobCategory')} />
            <Select value={d.jobTypeId} onValueChange={set('jobTypeId')} disabled={jobTypes.length === 0}>
              <SelectTrigger>
                <SelectValue placeholder={jobTypes.length === 0 ? t('applicants.form.step1.loadingCategories') : t('applicants.form.step1.jobCategoryPh')} />
              </SelectTrigger>
              <SelectContent>
                {jobTypes.map(jt => <SelectItem key={jt.id} value={jt.id}>{localizeJobCategoryName(jt.name, tEnums)}</SelectItem>)}
              </SelectContent>
            </Select>
          </>
        )}
      </div>

      {/* ── Photo Upload ── */}
      <div className="space-y-3">
        <SubSection title={t('applicants.form.step1.applicantPhoto')} />
        <div className="flex items-start gap-6">
          {/* Preview circle */}
          <div className={`w-28 h-28 rounded-full shrink-0 border-2 flex items-center justify-center overflow-hidden ${previewUrl ? 'border-blue-400' : 'border-dashed border-gray-300 bg-gray-50'}`}>
            {previewUrl ? (
              <img src={previewUrl} alt={t('applicants.form.step1.applicantPhoto')} className="w-full h-full object-cover" />
            ) : (
              <User className="w-10 h-10 text-gray-300" />
            )}
          </div>
          <div className="flex-1 space-y-3">
            <div>
              <p className="text-sm font-medium text-gray-700">{t('applicants.form.step1.uploadPhoto')} <span className="text-red-500">*</span></p>
              <p className="text-xs text-gray-500 mt-0.5">{t('applicants.form.step1.photoHint')}</p>
            </div>
            <label className="inline-flex cursor-pointer">
              <div className={`flex items-center gap-2 px-4 py-2 rounded-lg border-2 text-sm font-medium transition-colors ${photoFile ? 'border-green-400 bg-green-50 text-green-700' : 'border-blue-300 bg-blue-50 text-blue-700 hover:border-blue-500'}`}>
                <Upload className="w-4 h-4 shrink-0" />
                {photoFile ? photoFile.name : t('applicants.form.step1.choosePhoto')}
              </div>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="sr-only"
                onChange={e => {
                  const f = e.target.files?.[0] ?? null;
                  onPhotoChange?.(f);
                }}
              />
            </label>
            {photoFile && (
              <button
                type="button"
                onClick={() => onPhotoChange?.(null)}
                className="flex items-center gap-1.5 text-xs text-red-500 hover:text-red-700"
              >
                <X className="w-3.5 h-3.5" /> {t('applicants.form.step1.removePhoto')}
              </button>
            )}
            {!photoFile && !existingPhotoUrl && (
              <p className="text-xs text-red-500">{t('applicants.form.step1.photoRequired')}</p>
            )}
          </div>
        </div>
      </div>
      <div className="space-y-4">
        <SubSection title={t('applicants.form.step1.fullName')} />
        <div className="grid md:grid-cols-3 gap-4">
          <div className="space-y-1">
            <Label className="text-xs">{t('applicants.form.step1.firstName')} *</Label>
            <Input placeholder={t('applicants.form.step1.firstNamePh')} value={d.firstName} onChange={e => set('firstName')(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t('applicants.form.step1.middleName')}</Label>
            <Input placeholder={t('applicants.form.step1.middleNamePh')} value={d.middleName} onChange={e => set('middleName')(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t('applicants.form.step1.lastName')} *</Label>
            <Input placeholder={t('applicants.form.step1.lastNamePh')} value={d.lastName} onChange={e => set('lastName')(e.target.value)} />
          </div>
        </div>
      </div>
      <div className="space-y-4">
        <SubSection title={t('applicants.form.step1.personalDetails')} />
        <div className="grid md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label className="text-xs">{t('applicants.form.step1.dateOfBirth')} *</Label>
            <DateInput value={d.dateOfBirth} onChange={e => set('dateOfBirth')(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t('applicants.form.step1.gender')}</Label>
            <Select value={d.gender} onValueChange={set('gender')}>
              <SelectTrigger><SelectValue placeholder={t('applicants.form.step1.genderPh')} /></SelectTrigger>
              <SelectContent>
                <SelectItem value="MALE">{i18n.t('gender.MALE', { ns: 'enums', defaultValue: 'Male' })}</SelectItem>
                <SelectItem value="FEMALE">{i18n.t('gender.FEMALE', { ns: 'enums', defaultValue: 'Female' })}</SelectItem>
                <SelectItem value="OTHER">{i18n.t('gender.OTHER', { ns: 'enums', defaultValue: 'Other' })}</SelectItem>
                <SelectItem value="PREFER_NOT_TO_SAY">{i18n.t('gender.PREFER_NOT_TO_SAY', { ns: 'enums', defaultValue: 'Prefer not to say' })}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label className="text-xs">{t('applicants.form.step1.citizenship')} *</Label>
            <div className="space-y-2">
              <CountrySelect value={d.citizenship} onChange={set('citizenship')} placeholder={t('applicants.form.step1.citizenshipPh')} />
              {(d.otherCitizenships ?? []).map((c, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <div className="flex-1">
                    <CountrySelect
                      value={c}
                      onChange={v => {
                        const updated = [...(d.otherCitizenships ?? [])];
                        updated[idx] = v;
                        set('otherCitizenships')(updated);
                      }}
                      placeholder={t('applicants.form.step1.addCitizenship')}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => set('otherCitizenships')((d.otherCitizenships ?? []).filter((_, i) => i !== idx))}
                    className="p-1.5 text-gray-400 hover:text-red-500 shrink-0"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => set('otherCitizenships')([...(d.otherCitizenships ?? []), ''])}
                className="flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-800 mt-1"
              >
                <Plus className="w-3.5 h-3.5" /> {t('applicants.form.step1.addAnotherCitizenship')}
              </button>
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t('applicants.form.step1.countryOfBirth')}</Label>
            <CountrySelect value={d.countryOfBirth} onChange={set('countryOfBirth')} placeholder={t('applicants.form.step1.countryOfBirth')} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t('applicants.form.step1.cityOfBirth')}</Label>
            <Input placeholder={t('applicants.form.step1.cityOfBirthPh')} value={d.cityOfBirth} onChange={e => set('cityOfBirth')(e.target.value)} />
          </div>
        </div>
      </div>
      <div className="space-y-4">
        <SubSection title={t('applicants.form.step1.permanentAddress')} />
        <AddressForm label="" value={d.homeAddress} onChange={set('homeAddress')} required />
      </div>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <SubSection title={t('applicants.form.step1.currentAddress')} />
          <label className="flex items-center gap-2 text-sm cursor-pointer -mt-4">
            <Checkbox
              checked={d.sameAsHomeAddress}
              onCheckedChange={c => {
                u(prev => ({
                  ...prev,
                  sameAsHomeAddress: !!c,
                  currentAddress: c ? { ...prev.homeAddress } : { ...EMPTY_ADDRESS },
                }));
              }}
            />
            {t('applicants.form.step1.sameAsPermanentShort')}
          </label>
        </div>
        {!d.sameAsHomeAddress && <AddressForm label="" value={d.currentAddress} onChange={set('currentAddress')} required />}
        {d.sameAsHomeAddress && <div className="p-3 bg-gray-50 rounded border text-sm text-gray-600">{t('applicants.form.step1.sameAsPermanent')}</div>}
      </div>
      <div className="space-y-4">
        <SubSection title={t('applicants.form.step1.previousResidence')} />
        <div className="space-y-3">
          <Label className="text-sm font-medium">{t('applicants.form.step1.livedAbroadQuestion')}</Label>
          <RadioYN name="livedAbroadRecently" value={d.livedAbroadRecently} onChange={set('livedAbroadRecently')} />
        </div>
        {d.livedAbroadRecently === 'yes' && (
          <div className="space-y-4 pt-2 border-s-2 border-blue-100 ps-4">
            {/* Previous Country of Residence — the country picker lives
                inside AddressForm so we don't render a duplicate one
                above it. The address itself is required when the
                applicant says yes. */}
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step1.abroadAddress')} *</Label>
              <AddressForm
                label=""
                value={d.abroadAddress ?? { ...EMPTY_ADDRESS }}
                onChange={(next) => u((prev) => ({
                  ...prev,
                  abroadAddress: next,
                  // Mirror the address country into the standalone
                  // abroadCountry field so existing PDF/review/payload
                  // consumers keep working.
                  abroadCountry: next?.country ?? '',
                }))}
                required
              />
            </div>
            <div className="grid md:grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label className="text-xs">{t('applicants.form.step1.abroadDateFrom')} *</Label>
                <DateInput value={d.abroadDateFrom} onChange={e => set('abroadDateFrom')(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t('applicants.form.step1.abroadDateTo')} *</Label>
                <DateInput value={d.abroadDateTo} onChange={e => set('abroadDateTo')(e.target.value)} />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Step2Contact({ d, u, settings }: { d: ApplicantFormData; u: (fn: (p: ApplicantFormData) => ApplicantFormData) => void; settings: FormSettings }) {
  const { t } = useTranslation('pages');
  const { t: tEnums } = useTranslation('enums');
  const set = (field: keyof ApplicantFormData) => (value: any) => u(prev => ({ ...prev, [field]: value }));
  const [touched, setTouched] = useState({ email: false, emailConfirm: false, emergencyEmail: false });
  const touch = (field: 'email' | 'emailConfirm' | 'emergencyEmail') => () => setTouched(t => ({ ...t, [field]: true }));
  const emailInvalid = (touched.email || !!d.email) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email);
  const confirmMismatch = (touched.emailConfirm || !!d.emailConfirm) && d.email !== d.emailConfirm;
  const emergencyEmailInvalid = (touched.emergencyEmail || !!d.emergencyEmail) && !!d.emergencyEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.emergencyEmail);
  return (
    <div className="space-y-8">
      <SectionTitle title={t('applicants.form.step2.title')} subtitle={t('applicants.form.step2.subtitle')} />
      <div className="space-y-4">
        <SubSection title={t('applicants.form.step2.phoneEmail')} />
        <div className="grid md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label className="text-xs">{t('applicants.form.step2.phone')} *</Label>
            <div className="flex gap-2">
              {/* Phase 3 #7 — searchable country code picker (replaces static Select). */}
              <PhoneCodeCombobox value={d.phoneCode} onChange={set('phoneCode')} className="w-36 shrink-0" />
              <Input placeholder={t('applicants.form.step2.phonePh')} value={d.phone} onChange={e => set('phone')(e.target.value)} />
            </div>
          </div>
          <div className="md:col-span-2">
            <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
              <Checkbox
                checked={d.phoneIsWhatsApp}
                onCheckedChange={c => u(prev => ({ ...prev, phoneIsWhatsApp: !!c, whatsapp: !!c ? '' : prev.whatsapp }))}
              />
              <span>{t('applicants.form.step2.whatsappQuestion')}</span>
            </label>
          </div>
          {!d.phoneIsWhatsApp && (
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step2.whatsappNumber')} *</Label>
              <div className="flex gap-2">
                <PhoneCodeCombobox value={d.whatsappCode} onChange={set('whatsappCode')} className="w-36 shrink-0" />
                <Input placeholder={t('applicants.form.step2.whatsappNumberPh')} value={d.whatsapp} onChange={e => set('whatsapp')(e.target.value)} />
              </div>
            </div>
          )}
          <div className="space-y-1">
            <Label className="text-xs">{t('applicants.form.step2.email')} *</Label>
            <Input
              type="email"
              placeholder={t('applicants.form.step2.emailPh')}
              value={d.email}
              onChange={e => set('email')(e.target.value)}
              onBlur={touch('email')}
              className={emailInvalid ? 'border-red-400 focus-visible:ring-red-400' : ''}
            />
            {emailInvalid && <p className="text-xs text-red-500 mt-1">{t('applicants.form.step2.emailInvalid')}</p>}
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t('applicants.form.step2.confirmEmail')} *</Label>
            <Input
              type="email"
              placeholder={t('applicants.form.step2.confirmEmailPh')}
              value={d.emailConfirm}
              onChange={e => set('emailConfirm')(e.target.value)}
              onBlur={touch('emailConfirm')}
              onPaste={e => e.preventDefault()}
              className={confirmMismatch ? 'border-red-400 focus-visible:ring-red-400' : ''}
            />
            {confirmMismatch && <p className="text-xs text-red-500 mt-1">{t('applicants.form.step2.emailsDoNotMatch')}</p>}
          </div>
        </div>
      </div>
      <div className="space-y-4">
        <SubSection title={t('applicants.form.step2.emergencyContact')} />
        <div className="grid md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label className="text-xs">{t('applicants.form.step2.emergencyFirstName')} *</Label>
            <Input placeholder={t('applicants.form.step2.emergencyFirstNamePh')} value={d.emergencyFirstName} onChange={e => set('emergencyFirstName')(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t('applicants.form.step2.emergencyLastName')} *</Label>
            <Input placeholder={t('applicants.form.step2.emergencyLastNamePh')} value={d.emergencyLastName} onChange={e => set('emergencyLastName')(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t('applicants.form.step2.emergencyRelation')} *</Label>
            <Select value={d.emergencyRelation} onValueChange={set('emergencyRelation')}>
              <SelectTrigger><SelectValue placeholder={t('applicants.form.step2.emergencyRelationPh')} /></SelectTrigger>
              <SelectContent>
                {(settings.familyRelations ?? []).map(r => <SelectItem key={r} value={r}>{tEnums(`familyRelation.${r}`, { defaultValue: r })}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t('applicants.form.step2.emergencyPhone')} *</Label>
            <div className="flex gap-2">
              <PhoneCodeCombobox value={d.emergencyPhoneCode} onChange={set('emergencyPhoneCode')} className="w-36 shrink-0" />
              <Input placeholder={t('applicants.form.step2.emergencyPhonePh')} value={d.emergencyPhone} onChange={e => set('emergencyPhone')(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t('applicants.form.step2.emergencyEmail')}</Label>
            <Input
              type="email"
              placeholder={t('applicants.form.step2.emergencyEmailPh')}
              value={d.emergencyEmail}
              onChange={e => set('emergencyEmail')(e.target.value)}
              onBlur={touch('emergencyEmail')}
              className={emergencyEmailInvalid ? 'border-red-400 focus-visible:ring-red-400' : ''}
            />
            {emergencyEmailInvalid && <p className="text-xs text-red-500 mt-1">{t('applicants.form.step2.emailInvalid')}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

function Step3Identification({ d, u, settings, uploadedFiles, onFilesChange, requiredDocuments = [], fieldErrors }: { d: ApplicantFormData; u: (fn: (p: ApplicantFormData) => ApplicantFormData) => void; settings: FormSettings; uploadedFiles: UploadedFileItem[]; onFilesChange: (files: UploadedFileItem[]) => void; requiredDocuments?: string[]; fieldErrors?: Record<string, string> }) {
  const { t } = useTranslation('pages');
  const set = (field: keyof ApplicantFormData) => (value: any) => u(prev => ({ ...prev, [field]: value }));
  // Wire job-ad required docs to their required: sectionKeys so uploads on this tab
  // satisfy the required-doc checks in both getStepErrors and the Documents (Tab 10) gate.
  const passportDocName = requiredDocuments.find(n => n.toLowerCase() === 'passport');
  const passportSectionKey = passportDocName ? `required:${passportDocName}` : 'passport';
  const nationalIdDocName = requiredDocuments.find(n => n.toLowerCase().includes('national id'));
  const nationalIdSectionKey = nationalIdDocName ? `required:${nationalIdDocName}` : 'idCard';
  // Auto-select "yes" and lock out "no" when National ID is required by the job ad
  useEffect(() => {
    if (nationalIdDocName && d.hasIdCard !== 'yes') {
      u(prev => ({ ...prev, hasIdCard: 'yes' }));
    }
  }, [nationalIdDocName]);
  return (
    <div className="space-y-8">
      <SectionTitle title={t('applicants.form.step3.title')} subtitle={t('applicants.form.step3.subtitle')} />
      <div className="space-y-4">
        <SubSection title={t('applicants.form.step3.passport')} />
        {/* Passport upload is mandatory for every application — banner
            always shown, not gated on the job ad's required-docs list. */}
        <div className="flex items-center gap-2 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />
          {t('applicants.form.step3.passportRequiredBanner')}
        </div>
        <div className="grid md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label className="text-xs">{t('applicants.form.step3.passportNumber')} *</Label>
            <Input placeholder={t('applicants.form.step3.passportNumberPh')} value={d.passportNumber} onChange={e => set('passportNumber')(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t('applicants.form.step3.issuingCountry')}</Label>
            <CountrySelect value={d.passportCountry} onChange={set('passportCountry')} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t('applicants.form.step3.issueDate')}</Label>
            <DateInput
              value={d.passportIssueDate}
              onChange={e => set('passportIssueDate')(e.target.value)}
              aria-invalid={!!fieldErrors?.passportIssueDate}
              className={fieldErrors?.passportIssueDate ? 'border-red-500 focus-visible:ring-red-500' : ''}
            />
            <FieldError errors={fieldErrors} name="passportIssueDate" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t('applicants.form.step3.expiryDate')}</Label>
            <ExpiryFields expiryDate={d.passportExpiryDate} noExpiry={d.passportNoExpiry} onExpiry={set('passportExpiryDate')} onNoExpiry={set('passportNoExpiry')} />
            <FieldError errors={fieldErrors} name="passportExpiryDate" />
          </div>
        </div>
        <InlineDocUpload label={passportDocName ? t('applicants.form.step3.uploadPassportRequired') : t('applicants.form.step3.uploadPassport')} sectionKey={passportSectionKey} uploadedFiles={uploadedFiles} onFilesChange={onFilesChange} />
      </div>
      <div className="space-y-4">
        <SubSection title={t('applicants.form.step3.nationalIdSection')} />
        {nationalIdDocName && (
          <div className="flex items-center gap-2 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />
            {t('applicants.form.step3.nationalIdRequiredBanner')}
          </div>
        )}
        <div className="space-y-2">
          <Label className="text-xs">{t('applicants.form.step3.nationalIdQuestion')}</Label>
          <RadioYN name="hasIdCard" value={d.hasIdCard} onChange={set('hasIdCard')} disabledValues={nationalIdDocName ? ['no'] : []} />
        </div>
        {d.hasIdCard === 'yes' && (
          <div className="grid md:grid-cols-2 gap-4 mt-3">
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step3.idNumber')}</Label>
              <Input placeholder={t('applicants.form.step3.idNumberPh')} value={d.idCardNumber} onChange={e => set('idCardNumber')(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step3.country')}</Label>
              <CountrySelect value={d.idCardCountry} onChange={set('idCardCountry')} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step3.expiryDate')}</Label>
              <ExpiryFields expiryDate={d.idCardExpiryDate} noExpiry={d.idCardNoExpiry} onExpiry={set('idCardExpiryDate')} onNoExpiry={set('idCardNoExpiry')} />
            </div>
            {/* Only render optional upload inside the yes-block when NOT a required doc */}
            {!nationalIdDocName && <InlineDocUpload label={t('applicants.form.step3.uploadIdCard')} sectionKey="idCard" uploadedFiles={uploadedFiles} onFilesChange={onFilesChange} />}
          </div>
        )}
        {/* Required upload shown unconditionally so user can upload regardless of yes/no answer */}
        {nationalIdDocName && (
          <InlineDocUpload label={t('applicants.form.step3.uploadNationalIdRequired')} sectionKey={nationalIdSectionKey} uploadedFiles={uploadedFiles} onFilesChange={onFilesChange} />
        )}
      </div>
      <div className="space-y-4">
        <SubSection title={t('applicants.form.step3.euVisa')} />
        <div className="space-y-2">
          <Label className="text-xs">{t('applicants.form.step3.euVisaQuestion')}</Label>
          <RadioYN name="hasEuVisa" value={d.hasEuVisa} onChange={set('hasEuVisa')} />
        </div>
        {d.hasEuVisa === 'yes' && (
          <div className="grid md:grid-cols-2 gap-4 mt-3">
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step3.visaType')}</Label>
              <Select value={d.euVisaType} onValueChange={set('euVisaType')}>
                <SelectTrigger><SelectValue placeholder={t('applicants.form.step3.visaTypePh')} /></SelectTrigger>
                <SelectContent>
                  {(settings.visaTypes ?? []).map(tp => <SelectItem key={tp} value={tp}>{tp}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step3.issuingCountry')}</Label>
              <CountrySelect value={d.euVisaCountry} onChange={set('euVisaCountry')} countries={EU_COUNTRIES} placeholder={t('applicants.form.step3.selectEuCountry')} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step3.visaNumber')}</Label>
              <Input placeholder={t('applicants.form.step3.visaNumberPh')} value={d.euVisaNumber} onChange={e => set('euVisaNumber')(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step3.expiryDate')}</Label>
              <ExpiryFields expiryDate={d.euVisaExpiryDate} noExpiry={d.euVisaNoExpiry} onExpiry={set('euVisaExpiryDate')} onNoExpiry={set('euVisaNoExpiry')} />
            </div>
            <div className="space-y-1 md:col-span-2">
              <Label className="text-xs">{t('applicants.form.step3.purposeOfIssue')} <span className="text-muted-foreground">{t('applicants.form.common.optional')}</span></Label>
              <Textarea rows={2} placeholder={t('applicants.form.step3.purposeOfIssuePh')} value={d.purposeOfIssue} onChange={e => set('purposeOfIssue')(e.target.value)} />
            </div>
            <InlineDocUpload label={t('applicants.form.step3.uploadEuVisa')} sectionKey="euVisa" uploadedFiles={uploadedFiles} onFilesChange={onFilesChange} />
          </div>
        )}
      </div>
      <div className="space-y-4">
        <SubSection title={t('applicants.form.step3.euResidence')} />
        <div className="space-y-2">
          <Label className="text-xs">{t('applicants.form.step3.euResidenceQuestion')}</Label>
          <RadioYN name="hasEuResidence" value={d.hasEuResidence} onChange={set('hasEuResidence')} />
        </div>
        {d.hasEuResidence === 'yes' && (
          <div className="grid md:grid-cols-2 gap-4 mt-3">
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step3.permitNumber')}</Label>
              <Input placeholder={t('applicants.form.step3.permitNumberPh')} value={d.euResidenceNumber} onChange={e => set('euResidenceNumber')(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step3.country')}</Label>
              <CountrySelect value={d.euResidenceCountry} onChange={set('euResidenceCountry')} countries={EU_COUNTRIES} placeholder={t('applicants.form.step3.selectEuCountry')} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step3.issueDate')}</Label>
              <DateInput
                value={d.euResidenceIssueDate}
                onChange={e => set('euResidenceIssueDate')(e.target.value)}
                aria-invalid={!!fieldErrors?.euResidenceIssueDate}
                className={fieldErrors?.euResidenceIssueDate ? 'border-red-500 focus-visible:ring-red-500' : ''}
              />
              <FieldError errors={fieldErrors} name="euResidenceIssueDate" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step3.cityOfIssue')}</Label>
              <Input placeholder={t('applicants.form.step3.cityOfIssuePh')} value={d.euResidenceCity} onChange={e => set('euResidenceCity')(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step3.expiryDate')}</Label>
              <ExpiryFields expiryDate={d.euResidenceExpiryDate} noExpiry={d.euResidenceNoExpiry} onExpiry={set('euResidenceExpiryDate')} onNoExpiry={set('euResidenceNoExpiry')} />
              <FieldError errors={fieldErrors} name="euResidenceExpiryDate" />
            </div>
            <InlineDocUpload label={t('applicants.form.step3.uploadResidencePermit')} sectionKey="euResidence" uploadedFiles={uploadedFiles} onFilesChange={onFilesChange} />
          </div>
        )}
      </div>
      <div className="space-y-4">
        <SubSection title={t('applicants.form.step3.workPermit')} />
        <div className="space-y-2">
          <Label className="text-xs">{t('applicants.form.step3.workPermitQuestion')}</Label>
          <RadioYN name="hasWorkPermit" value={d.hasWorkPermit} onChange={set('hasWorkPermit')} />
        </div>
        {d.hasWorkPermit === 'yes' && (
          <div className="grid md:grid-cols-2 gap-4 mt-3">
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step3.permitType')}</Label>
              <Input placeholder={t('applicants.form.step3.permitTypePh')} value={d.workPermitType} onChange={e => set('workPermitType')(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step3.permitNumber')}</Label>
              <Input placeholder={t('applicants.form.step3.permitNumberPh')} value={d.workPermitNumber} onChange={e => set('workPermitNumber')(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step3.issuingEuCountry')}</Label>
              <CountrySelect value={d.workPermitCountry} onChange={set('workPermitCountry')} countries={EU_COUNTRIES} placeholder={t('applicants.form.step3.selectEuCountry')} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step3.issueDate')}</Label>
              <DateInput
                value={d.workPermitIssueDate}
                onChange={e => set('workPermitIssueDate')(e.target.value)}
                aria-invalid={!!fieldErrors?.workPermitIssueDate}
                className={fieldErrors?.workPermitIssueDate ? 'border-red-500 focus-visible:ring-red-500' : ''}
              />
              <FieldError errors={fieldErrors} name="workPermitIssueDate" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step3.expiryDate')}</Label>
              <ExpiryFields expiryDate={d.workPermitExpiryDate} noExpiry={d.workPermitNoExpiry} onExpiry={set('workPermitExpiryDate')} onNoExpiry={set('workPermitNoExpiry')} />
              <FieldError errors={fieldErrors} name="workPermitExpiryDate" />
            </div>
            <InlineDocUpload label={t('applicants.form.step3.uploadWorkPermit')} sectionKey="workPermit" uploadedFiles={uploadedFiles} onFilesChange={onFilesChange} />
          </div>
        )}
      </div>
      <div className="space-y-4">
        <SubSection title={t('applicants.form.step3.criminalRecord')} />
        <div className="space-y-6">
          <div className="space-y-3">
            <Label className="text-xs font-medium">{t('applicants.form.step3.homeCriminalRecord')}</Label>
            <RadioYN name="hasHomeCriminalRecord" value={d.hasHomeCriminalRecord} onChange={set('hasHomeCriminalRecord')} />
            {d.hasHomeCriminalRecord === 'yes' && (
              <div className="grid md:grid-cols-2 gap-4 mt-2">
                <div className="space-y-1">
                  <Label className="text-xs">{t('applicants.form.step3.dateOfIssue')}</Label>
                  <DateInput value={d.homeCriminalRecordDate} onChange={e => set('homeCriminalRecordDate')(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">{t('applicants.form.step3.countryOfIssue')}</Label>
                  <CountrySelect value={d.homeCriminalRecordCountry} onChange={set('homeCriminalRecordCountry')} placeholder={t('applicants.form.common.selectCountry')} />
                </div>
                <InlineDocUpload label={t('applicants.form.step3.uploadHomeCriminal')} sectionKey="homeCriminalRecord" uploadedFiles={uploadedFiles} onFilesChange={onFilesChange} />
              </div>
            )}
          </div>
          <div className="space-y-3">
            <Label className="text-xs font-medium">{t('applicants.form.step3.euCriminalRecord')}</Label>
            <RadioYN name="hasEuCriminalRecord" value={d.hasEuCriminalRecord} onChange={set('hasEuCriminalRecord')} />
            {d.hasEuCriminalRecord === 'yes' && (
              <div className="grid md:grid-cols-2 gap-4 mt-2">
                <div className="space-y-1">
                  <Label className="text-xs">{t('applicants.form.step3.dateOfIssue')}</Label>
                  <DateInput value={d.euCriminalRecordDate} onChange={e => set('euCriminalRecordDate')(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">{t('applicants.form.step3.countryOfIssue')}</Label>
                  <CountrySelect value={d.euCriminalRecordCountry} onChange={set('euCriminalRecordCountry')} countries={EU_COUNTRIES} placeholder={t('applicants.form.step3.selectEuCountry')} />
                </div>
                <InlineDocUpload label={t('applicants.form.step3.uploadEuCriminal')} sectionKey="euCriminalRecord" uploadedFiles={uploadedFiles} onFilesChange={onFilesChange} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Step4DrivingLicense({ d, u, settings, uploadedFiles, onFilesChange, requiredDocuments = [], fieldErrors }: { d: ApplicantFormData; u: (fn: (p: ApplicantFormData) => ApplicantFormData) => void; settings: FormSettings; uploadedFiles: UploadedFileItem[]; onFilesChange: (files: UploadedFileItem[]) => void; requiredDocuments?: string[]; fieldErrors?: Record<string, string> }) {
  const { t } = useTranslation('pages');
  const { t: tEnums } = useTranslation('enums');
  const set = (field: keyof ApplicantFormData) => (value: any) => u(prev => ({ ...prev, [field]: value }));
  const dlDocName = requiredDocuments.find(n => n.toLowerCase().includes('driving'));
  const dlSectionKey = dlDocName ? `required:${dlDocName}` : 'drivingLicense';
  // Auto-select "yes" and lock out "no" when Driving License is required by the job ad
  useEffect(() => {
    if (dlDocName && d.hasDrivingLicense !== 'yes') {
      u(prev => ({ ...prev, hasDrivingLicense: 'yes' }));
    }
  }, [dlDocName]);
  const toggleCat = (cat: string) => {
    u(prev => ({
      ...prev,
      licenseCategories: prev.licenseCategories.includes(cat) ? prev.licenseCategories.filter(c => c !== cat) : [...prev.licenseCategories, cat],
    }));
  };
  const addQual = () => {
    u(prev => ({
      ...prev,
      qualifications: [...prev.qualifications, { id: crypto.randomUUID(), type: '', issueDate: '', expiryDate: '', noExpiry: false, country: '' }],
    }));
  };
  const updateQual = (id: string, field: keyof QualificationEntry, value: any) => {
    u(prev => ({ ...prev, qualifications: prev.qualifications.map(q => q.id === id ? { ...q, [field]: value } : q) }));
  };
  const removeQual = (id: string) => {
    u(prev => ({ ...prev, qualifications: prev.qualifications.filter(q => q.id !== id) }));
  };

  return (
    <div className="space-y-8">
      <SectionTitle title={t('applicants.form.step4.title')} subtitle={t('applicants.form.step4.subtitle')} />
      {dlDocName && (
        <div className="flex items-center gap-2 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />
          {t('applicants.form.step4.licenseRequiredBanner')}
        </div>
      )}
      <div className="space-y-3">
        <Label className="font-medium">{t('applicants.form.step4.hasDrivingLicenseQuestion')} *</Label>
        <div className="flex gap-6">
          {['yes', 'no'].map(v => {
            const disabled = dlDocName ? v === 'no' : false;
            return (
              <label key={v} className={`flex-1 flex items-center justify-center gap-2 p-4 border-2 rounded-xl text-sm font-medium transition-all ${disabled ? 'opacity-40 cursor-not-allowed border-gray-200' : 'cursor-pointer'} ${d.hasDrivingLicense === v ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-gray-200 hover:border-gray-300'}`}>
                <input type="radio" name="hasDrivingLicense" value={v} checked={d.hasDrivingLicense === v} onChange={() => !disabled && set('hasDrivingLicense')(v)} disabled={disabled} className="sr-only" />
                {v === 'yes' ? `✅ ${t('applicants.form.common.yes')}` : `❌ ${t('applicants.form.common.no')}`}
              </label>
            );
          })}
        </div>
      </div>
      {/* Required upload shown unconditionally when DL is a job-ad required document */}
      {dlDocName && (
        <InlineDocUpload label={t('applicants.form.step4.uploadLicenseRequired')} sectionKey={dlSectionKey} uploadedFiles={uploadedFiles} onFilesChange={onFilesChange} />
      )}
      {d.hasDrivingLicense === 'yes' && (
        <>
          <div className="space-y-4">
            <SubSection title={t('applicants.form.step4.licenseDetails')} />
            <div className="grid md:grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label className="text-xs">{t('applicants.form.step4.licenseNumber')} *</Label>
                <Input
                  placeholder={t('applicants.form.step4.licenseNumberPh')}
                  value={d.licenseNumber}
                  onChange={e => set('licenseNumber')(e.target.value)}
                  aria-invalid={!!fieldErrors?.licenseNumber}
                  className={fieldErrors?.licenseNumber ? 'border-red-500 focus-visible:ring-red-500' : ''}
                />
                <FieldError errors={fieldErrors} name="licenseNumber" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t('applicants.form.step4.issuingCountry')} *</Label>
                <CountrySelect value={d.licenseCountry} onChange={set('licenseCountry')} />
                <FieldError errors={fieldErrors} name="licenseCountry" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t('applicants.form.step4.firstIssueDate')} <span className="text-gray-400">{t('applicants.form.common.optional')}</span></Label>
                <DateInput
                  value={d.licenseFirstIssueDate}
                  onChange={e => set('licenseFirstIssueDate')(e.target.value)}
                  aria-invalid={!!fieldErrors?.licenseFirstIssueDate}
                  className={fieldErrors?.licenseFirstIssueDate ? 'border-red-500 focus-visible:ring-red-500' : ''}
                />
                <FieldError errors={fieldErrors} name="licenseFirstIssueDate" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t('applicants.form.step4.issueDate')}</Label>
                <DateInput
                  value={d.licenseIssueDate}
                  onChange={e => set('licenseIssueDate')(e.target.value)}
                  aria-invalid={!!fieldErrors?.licenseIssueDate}
                  className={fieldErrors?.licenseIssueDate ? 'border-red-500 focus-visible:ring-red-500' : ''}
                />
                <FieldError errors={fieldErrors} name="licenseIssueDate" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t('applicants.form.step4.expiryDate')}</Label>
                <ExpiryFields expiryDate={d.licenseExpiryDate} noExpiry={d.licenseNoExpiry} onExpiry={set('licenseExpiryDate')} onNoExpiry={set('licenseNoExpiry')} />
                <FieldError errors={fieldErrors} name="licenseExpiryDate" />
              </div>
              {/* Only show the optional upload inside the yes-block when not a required doc */}
              {!dlDocName && <InlineDocUpload label={t('applicants.form.step4.uploadLicense')} sectionKey="drivingLicense" uploadedFiles={uploadedFiles} onFilesChange={onFilesChange} />}
            </div>
          </div>
          <div className="space-y-3">
            <SubSection title={`${t('applicants.form.step4.categories')} *`} />
            <p className="text-xs text-muted-foreground -mt-3">{t('applicants.form.step4.selectAtLeastOneCategory')}</p>
            <div className="flex flex-wrap gap-2">
              {LICENSE_CATEGORIES.map(cat => (
                <label key={cat} className={`px-3 py-1.5 border-2 rounded-lg cursor-pointer text-sm font-medium transition-all ${d.licenseCategories.includes(cat) ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-gray-200 hover:border-gray-300'}`}>
                  <Checkbox checked={d.licenseCategories.includes(cat)} onCheckedChange={() => toggleCat(cat)} className="sr-only" />
                  {cat}
                </label>
              ))}
            </div>
            <FieldError errors={fieldErrors} name="licenseCategories" />
          </div>
          <div className="space-y-4">
            <SubSection title={t('applicants.form.step4.qualifications')} />
            {d.qualifications.map((q, i) => (
              <div key={q.id} className="p-4 border-2 border-gray-200 rounded-lg space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{t('applicants.form.step4.qualificationN', { n: i + 1 })}</span>
                  <button type="button" onClick={() => removeQual(q.id)} className="p-1 text-gray-400 hover:text-red-500">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
                <div className="grid md:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">{t('applicants.form.step4.qualificationType')}</Label>
                    <Select value={q.type} onValueChange={v => updateQual(q.id, 'type', v)}>
                      <SelectTrigger><SelectValue placeholder={t('applicants.form.step4.qualificationTypePh')} /></SelectTrigger>
                      <SelectContent>
                        {(settings.drivingQualifications ?? []).map(tp => <SelectItem key={tp} value={tp}>{tEnums(`drivingQualification.${tp}`, { defaultValue: tp })}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">{t('applicants.form.step3.country')}</Label>
                    <CountrySelect value={q.country} onChange={v => updateQual(q.id, 'country', v)} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">{t('applicants.form.step4.issueDate')}</Label>
                    <DateInput
                      value={q.issueDate}
                      onChange={e => updateQual(q.id, 'issueDate', e.target.value)}
                      aria-invalid={!!fieldErrors?.[`qualifications.${q.id}.issueDate`]}
                      className={fieldErrors?.[`qualifications.${q.id}.issueDate`] ? 'border-red-500 focus-visible:ring-red-500' : ''}
                    />
                    <FieldError errors={fieldErrors} name={`qualifications.${q.id}.issueDate`} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">{t('applicants.form.step4.expiryDate')}</Label>
                    <ExpiryFields expiryDate={q.expiryDate} noExpiry={q.noExpiry} onExpiry={v => updateQual(q.id, 'expiryDate', v)} onNoExpiry={v => updateQual(q.id, 'noExpiry', v)} />
                    <FieldError errors={fieldErrors} name={`qualifications.${q.id}.expiryDate`} />
                  </div>
                </div>
              </div>
            ))}
            <button type="button" onClick={addQual} className="w-full flex items-center justify-center gap-2 px-4 py-3 border-2 border-dashed border-blue-300 rounded-lg text-blue-600 text-sm font-medium hover:border-blue-500 hover:bg-blue-50">
              <Plus className="w-4 h-4" /> {t('applicants.form.step4.addQualification')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Step5DrivingExperience({ d, u, settings, fieldErrors }: { d: ApplicantFormData; u: (fn: (p: ApplicantFormData) => ApplicantFormData) => void; settings: FormSettings; fieldErrors?: Record<string, string> }) {
  const { t } = useTranslation('pages');
  const set = (field: keyof ApplicantFormData) => (value: any) => u(prev => ({ ...prev, [field]: value }));
  const toggle = (field: 'transportTypes' | 'truckBrands' | 'selectedGpsSystems' | 'trailerTypes' | 'workRegime', value: string) => {
    u(prev => {
      const arr = prev[field] as string[];
      return { ...prev, [field]: arr.includes(value) ? arr.filter(x => x !== value) : [...arr, value] };
    });
  };
  const addCustom = (field: 'transportTypes' | 'truckBrands' | 'trailerTypes', value: string) => {
    const v = value.trim();
    if (!v) return;
    u(prev => {
      const arr = prev[field] as string[];
      if (arr.includes(v)) return prev;
      return { ...prev, [field]: [...arr, v] };
    });
  };
  const [customInputs, setCustomInputs] = useState({ transportTypes: '', truckBrands: '', trailerTypes: '' });
  const setCustom = (field: keyof typeof customInputs) => (val: string) => setCustomInputs(p => ({ ...p, [field]: val }));
  const confirmCustom = (field: 'transportTypes' | 'truckBrands' | 'trailerTypes') => {
    addCustom(field, customInputs[field]);
    setCustomInputs(p => ({ ...p, [field]: '' }));
  };

  return (
    <div className="space-y-8">
      <SectionTitle title={t('applicants.form.step5.title')} subtitle={t('applicants.form.step5.subtitle')} />
      <div className="space-y-3">
        <SubSection title={t('applicants.form.step5.experienceType')} />
        <div className="grid md:grid-cols-3 gap-3">
          {[
            { v: 'eu', l: t('applicants.form.step5.expEuLabel') },
            { v: 'domestic', l: t('applicants.form.step5.expDomestic') },
            { v: 'both', l: t('applicants.form.step5.expBoth') },
          ].map(({ v, l }) => (
            <label key={v} className={`flex items-center gap-2 p-4 border-2 rounded-xl cursor-pointer text-sm font-medium transition-all ${d.drivingExpType === v ? 'border-blue-600 bg-blue-50' : 'border-gray-200 hover:border-gray-300'}`}>
              <input type="radio" name="drivingExpType" value={v} checked={d.drivingExpType === v} onChange={() => set('drivingExpType')(v)} className="w-4 h-4 accent-blue-600" />
              {l}
            </label>
          ))}
        </div>
      </div>
      {(d.drivingExpType === 'eu' || d.drivingExpType === 'both') && (
        <div className="space-y-4">
          <SubSection title={`${t('applicants.form.step5.expEU')} *`} />
          <div className="grid md:grid-cols-3 gap-4">
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step5.euYears')} *</Label>
              <Input
                type="number" min="0" placeholder={t('applicants.form.step5.euYears')}
                value={d.euExpYears}
                onChange={e => set('euExpYears')(e.target.value)}
                aria-invalid={!!fieldErrors?.euExpYears}
                className={fieldErrors?.euExpYears ? 'border-red-500 focus-visible:ring-red-500' : ''}
              />
              <FieldError errors={fieldErrors} name="euExpYears" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step5.euKm')} *</Label>
              <Input
                placeholder={t('applicants.form.step5.euKmPh')}
                value={d.euExpKm}
                onChange={e => set('euExpKm')(e.target.value)}
                aria-invalid={!!fieldErrors?.euExpKm}
                className={fieldErrors?.euExpKm ? 'border-red-500 focus-visible:ring-red-500' : ''}
              />
              <FieldError errors={fieldErrors} name="euExpKm" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step5.euCountry')} *</Label>
              <CountrySelect value={d.euExpCountries} onChange={set('euExpCountries')} />
              <FieldError errors={fieldErrors} name="euExpCountries" />
            </div>
          </div>
        </div>
      )}
      {(d.drivingExpType === 'domestic' || d.drivingExpType === 'both') && (
        <div className="space-y-4">
          <SubSection title={`${t('applicants.form.step5.expDomestic')} *`} />
          <div className="grid md:grid-cols-3 gap-4">
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step5.domesticYears')} *</Label>
              <Input
                type="number" min="0" placeholder={t('applicants.form.step5.domesticYears')}
                value={d.domesticExpYears}
                onChange={e => set('domesticExpYears')(e.target.value)}
                aria-invalid={!!fieldErrors?.domesticExpYears}
                className={fieldErrors?.domesticExpYears ? 'border-red-500 focus-visible:ring-red-500' : ''}
              />
              <FieldError errors={fieldErrors} name="domesticExpYears" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step5.domesticKm')} *</Label>
              <Input
                placeholder={t('applicants.form.step5.domesticKmPh')}
                value={d.domesticExpKm}
                onChange={e => set('domesticExpKm')(e.target.value)}
                aria-invalid={!!fieldErrors?.domesticExpKm}
                className={fieldErrors?.domesticExpKm ? 'border-red-500 focus-visible:ring-red-500' : ''}
              />
              <FieldError errors={fieldErrors} name="domesticExpKm" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step5.domesticCountry')} *</Label>
              <CountrySelect value={d.domesticExpCountry} onChange={set('domesticExpCountry')} />
              <FieldError errors={fieldErrors} name="domesticExpCountry" />
            </div>
          </div>
        </div>
      )}
      <div className="space-y-3">
        <SubSection title={t('applicants.form.step5.transportTypes')} />
        <div className="flex flex-wrap gap-2">
          {d.transportTypes.map(tp => (
            <span key={tp} className="flex items-center gap-1 px-3 py-1.5 bg-blue-50 border border-blue-200 rounded-lg text-sm">
              {tp}
              <button type="button" onClick={() => toggle('transportTypes', tp)} className="text-gray-400 hover:text-red-500 ms-1">
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
          {(settings.transportTypes ?? []).filter(tp => !d.transportTypes.includes(tp)).map(tp => (
            <button key={tp} type="button" onClick={() => toggle('transportTypes', tp)}
              className="px-3 py-1.5 border-2 border-dashed border-gray-300 rounded-lg text-sm text-gray-600 hover:border-blue-400 hover:text-blue-600 hover:bg-blue-50 transition-all">
              + {tp}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <Input placeholder={t('applicants.form.step5.addCustomType')} value={customInputs.transportTypes} onChange={e => setCustom('transportTypes')(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && confirmCustom('transportTypes')} className="text-sm" />
          {customInputs.transportTypes.trim() && (
            <button type="button" onClick={() => confirmCustom('transportTypes')}
              className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">{t('applicants.form.step5.add')}</button>
          )}
        </div>
      </div>
      <div className="space-y-3">
        <SubSection title={t('applicants.form.step5.truckBrands')} />
        <div className="flex flex-wrap gap-2">
          {d.truckBrands.map(b => (
            <span key={b} className="flex items-center gap-1 px-3 py-1.5 bg-blue-50 border border-blue-200 rounded-lg text-sm">
              {b}
              <button type="button" onClick={() => toggle('truckBrands', b)} className="text-gray-400 hover:text-red-500 ms-1">
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
          {(settings.truckBrands ?? []).filter(b => !d.truckBrands.includes(b)).map(b => (
            <button key={b} type="button" onClick={() => toggle('truckBrands', b)}
              className="px-3 py-1.5 border-2 border-dashed border-gray-300 rounded-lg text-sm text-gray-600 hover:border-blue-400 hover:text-blue-600 hover:bg-blue-50 transition-all">
              + {b}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <Input placeholder={t('applicants.form.step5.addCustomBrand')} value={customInputs.truckBrands} onChange={e => setCustom('truckBrands')(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && confirmCustom('truckBrands')} className="text-sm" />
          {customInputs.truckBrands.trim() && (
            <button type="button" onClick={() => confirmCustom('truckBrands')}
              className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">{t('applicants.form.step5.add')}</button>
          )}
        </div>
      </div>
      <div className="space-y-3">
        <SubSection title={t('applicants.form.step5.gearbox')} />
        <div className="flex gap-3">
          {[
            { v: 'Manual', l: t('applicants.form.step5.gearboxManual') },
            { v: 'Automatic', l: t('applicants.form.step5.gearboxAutomatic') },
            { v: 'Both', l: t('applicants.form.step5.gearboxBoth') },
          ].map(({ v, l }) => (
            <label key={v} className={`flex-1 flex items-center justify-center gap-2 p-3 border-2 rounded-xl cursor-pointer text-sm font-medium transition-all ${d.gearboxType === v ? 'border-blue-600 bg-blue-50' : 'border-gray-200 hover:border-gray-300'}`}>
              <input type="radio" name="gearboxType" value={v} checked={d.gearboxType === v} onChange={() => set('gearboxType')(v)} className="w-4 h-4 accent-blue-600" />
              {l}
            </label>
          ))}
        </div>
      </div>
      <div className="space-y-3">
        <SubSection title={t('applicants.form.step5.gpsSystems')} />
        <div className="flex flex-wrap gap-2">
          {d.selectedGpsSystems.map(g => (
            <span key={g} className="flex items-center gap-1 px-3 py-1.5 bg-blue-50 border border-blue-200 rounded-lg text-sm">
              {g}
              <button type="button" onClick={() => toggle('selectedGpsSystems', g)} className="text-gray-400 hover:text-red-500 ms-1">
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
          {(settings.gpsSystemTypes ?? []).filter(g => !d.selectedGpsSystems.includes(g)).map(g => (
            <button key={g} type="button" onClick={() => toggle('selectedGpsSystems', g)}
              className="px-3 py-1.5 border-2 border-dashed border-gray-300 rounded-lg text-sm text-gray-600 hover:border-blue-400 hover:text-blue-600 hover:bg-blue-50 transition-all">
              + {g}
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-3">
        <SubSection title={t('applicants.form.step5.trailerTypes')} />
        <div className="flex flex-wrap gap-2">
          {d.trailerTypes.map(tp => (
            <span key={tp} className="flex items-center gap-1 px-3 py-1.5 bg-blue-50 border border-blue-200 rounded-lg text-sm">
              {tp}
              <button type="button" onClick={() => toggle('trailerTypes', tp)} className="text-gray-400 hover:text-red-500 ms-1">
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
          {(settings.trailerTypes ?? []).filter(tp => !d.trailerTypes.includes(tp)).map(tp => (
            <button key={tp} type="button" onClick={() => toggle('trailerTypes', tp)}
              className="px-3 py-1.5 border-2 border-dashed border-gray-300 rounded-lg text-sm text-gray-600 hover:border-blue-400 hover:text-blue-600 hover:bg-blue-50 transition-all">
              + {tp}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <Input placeholder={t('applicants.form.step5.addCustomTrailer')} value={customInputs.trailerTypes} onChange={e => setCustom('trailerTypes')(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && confirmCustom('trailerTypes')} className="text-sm" />
          {customInputs.trailerTypes.trim() && (
            <button type="button" onClick={() => confirmCustom('trailerTypes')}
              className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">{t('applicants.form.step5.add')}</button>
          )}
        </div>
        <div className="grid md:grid-cols-2 gap-3 mt-2">
          <Input placeholder={t('applicants.form.step5.mostUsedTrailer')} value={d.mostUsedTrailer} onChange={e => set('mostUsedTrailer')(e.target.value)} />
        </div>
      </div>
      <div className="space-y-4">
        <SubSection title={t('applicants.form.step5.workPreferences')} />
        <div className="grid md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label className="text-xs">{t('applicants.form.step5.trafficAccidentsQuestion')}</Label>
            <RadioYN name="trafficAccidents" value={d.trafficAccidents} onChange={set('trafficAccidents')} />
          </div>
          {d.trafficAccidents === 'yes' && (
            <div className="space-y-1 md:col-span-2">
              <Label className="text-xs">{t('applicants.form.step5.accidentDetails')}</Label>
              <Textarea rows={2} placeholder={t('applicants.form.step5.accidentDetailsPh')} value={d.accidentDescription} onChange={e => set('accidentDescription')(e.target.value)} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Step6Education({ d, u, settings, uploadedFiles, onFilesChange, fieldErrors }: { d: ApplicantFormData; u: (fn: (p: ApplicantFormData) => ApplicantFormData) => void; settings: FormSettings; uploadedFiles: UploadedFileItem[]; onFilesChange: (files: UploadedFileItem[]) => void; fieldErrors?: Record<string, string> }) {
  const { t } = useTranslation('pages');
  const { t: tEnums } = useTranslation('enums');
  const addEntry = () => {
    u(prev => ({
      ...prev,
      education: [...prev.education, { id: crypto.randomUUID(), level: '', institution: '', fieldOfStudy: '', country: '', startDate: '', endDate: '', ongoing: false, degree: '' }],
    }));
  };
  const updateEntry = (id: string, field: keyof EducationEntry, value: any) => {
    u(prev => ({ ...prev, education: prev.education.map(e => e.id === id ? { ...e, [field]: value } : e) }));
  };
  const removeEntry = (id: string) => {
    u(prev => ({ ...prev, education: prev.education.filter(e => e.id !== id) }));
  };

  const errClass = (name: string) =>
    fieldErrors?.[name] ? 'border-red-500 focus-visible:ring-red-500' : '';

  return (
    <div className="space-y-6">
      <SectionTitle title={t('applicants.form.step6.title')} subtitle={t('applicants.form.step6.subtitle')} />
      {d.education.map((entry, i) => {
        const k = (f: string) => `education.${entry.id}.${f}`;
        return (
        <div key={entry.id} className="p-5 border-2 border-gray-200 rounded-xl space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">{t('applicants.form.step6.entryN', { n: i + 1 })}</span>
            <button
              type="button"
              onClick={() => removeEntry(entry.id)}
              title={t('applicants.form.step6.removeEntry')}
              aria-label={t('applicants.form.step6.removeEntry')}
              className="p-1.5 rounded-md text-gray-400 hover:text-red-600 hover:bg-red-50"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
          <div className="grid md:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step6.level')} *</Label>
              <Select value={entry.level} onValueChange={v => updateEntry(entry.id, 'level', v)}>
                <SelectTrigger className={errClass(k('level'))}><SelectValue placeholder={t('applicants.form.step6.levelPh')} /></SelectTrigger>
                <SelectContent>
                  {(settings.educationLevels ?? []).map(l => <SelectItem key={l} value={l}>{tEnums(`educationLevel.${l}`, { defaultValue: l })}</SelectItem>)}
                </SelectContent>
              </Select>
              <FieldError errors={fieldErrors} name={k('level')} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step6.institution')} *</Label>
              <Input
                placeholder={t('applicants.form.step6.institutionPh')}
                value={entry.institution}
                onChange={e => updateEntry(entry.id, 'institution', e.target.value)}
                aria-invalid={!!fieldErrors?.[k('institution')]}
                className={errClass(k('institution'))}
              />
              <FieldError errors={fieldErrors} name={k('institution')} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step6.fieldOfStudy')} *</Label>
              <Input
                placeholder={t('applicants.form.step6.fieldOfStudyPh')}
                value={entry.fieldOfStudy}
                onChange={e => updateEntry(entry.id, 'fieldOfStudy', e.target.value)}
                aria-invalid={!!fieldErrors?.[k('fieldOfStudy')]}
                className={errClass(k('fieldOfStudy'))}
              />
              <FieldError errors={fieldErrors} name={k('fieldOfStudy')} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step6.country')} *</Label>
              <CountrySelect value={entry.country} onChange={v => updateEntry(entry.id, 'country', v)} />
              <FieldError errors={fieldErrors} name={k('country')} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step6.startDate')} *</Label>
              <DateInput
                value={entry.startDate}
                onChange={e => updateEntry(entry.id, 'startDate', e.target.value)}
                aria-invalid={!!fieldErrors?.[k('startDate')]}
                className={errClass(k('startDate'))}
              />
              <FieldError errors={fieldErrors} name={k('startDate')} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step6.endDate')} *</Label>
              <div className="flex items-center gap-2">
                <DateInput
                  value={entry.ongoing ? '' : entry.endDate}
                  onChange={e => updateEntry(entry.id, 'endDate', e.target.value)}
                  disabled={entry.ongoing}
                  className={`flex-1 ${errClass(k('endDate'))}`}
                  aria-invalid={!!fieldErrors?.[k('endDate')]}
                />
                <label className="flex items-center gap-1.5 text-xs whitespace-nowrap cursor-pointer">
                  <Checkbox checked={entry.ongoing} onCheckedChange={c => updateEntry(entry.id, 'ongoing', !!c)} />
                  {t('applicants.form.step6.ongoing')}
                </label>
              </div>
              <FieldError errors={fieldErrors} name={k('endDate')} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step6.degree')}</Label>
              <Input placeholder={t('applicants.form.step6.degreePh')} value={entry.degree} onChange={e => updateEntry(entry.id, 'degree', e.target.value)} />
            </div>
            <InlineDocUpload label={t('applicants.form.step6.uploadCertificate')} sectionKey={`education-${entry.id}`} uploadedFiles={uploadedFiles} onFilesChange={onFilesChange} />
          </div>
        </div>
        );
      })}
      {d.education.length === 0 && <p className="text-sm text-gray-400 text-center py-6 border-2 border-dashed border-gray-200 rounded-xl">{t('applicants.form.common.noEntries')}</p>}
      <button type="button" onClick={addEntry} className="w-full flex items-center justify-center gap-2 px-4 py-3 border-2 border-dashed border-blue-300 rounded-lg text-blue-600 text-sm font-medium hover:border-blue-500 hover:bg-blue-50">
        <Plus className="w-4 h-4" /> {t('applicants.form.step6.addEducation')}
      </button>
    </div>
  );
}

function Step7WorkHistory({ d, u, uploadedFiles, onFilesChange }: { d: ApplicantFormData; u: (fn: (p: ApplicantFormData) => ApplicantFormData) => void; uploadedFiles: UploadedFileItem[]; onFilesChange: (files: UploadedFileItem[]) => void }) {
  const { t } = useTranslation('pages');
  const addEntry = () => {
    u(prev => ({
      ...prev,
      workHistory: [...prev.workHistory, { id: crypto.randomUUID(), company: '', jobTitle: '', companyStreet: '', companyCity: '', companyPostalCode: '', country: '', companyPhoneCode: '', companyPhone: '', startDate: '', endDate: '', current: false, responsibilities: '', reasonForLeaving: '', referenceName: '', referencePhoneCode: '', referencePhone: '', referenceEmail: '' }],
    }));
  };
  const updateEntry = (id: string, field: keyof WorkHistoryEntry, value: any) => {
    u(prev => ({ ...prev, workHistory: prev.workHistory.map(e => e.id === id ? { ...e, [field]: value } : e) }));
  };
  const removeEntry = (id: string) => {
    u(prev => ({ ...prev, workHistory: prev.workHistory.filter(e => e.id !== id) }));
  };

  return (
    <div className="space-y-6">
      <SectionTitle title={t('applicants.form.step7.title')} subtitle={t('applicants.form.step7.subtitle')} />
      {d.workHistory.map((entry, i) => (
        <div key={entry.id} className="p-5 border-2 border-gray-200 rounded-xl space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">{t('applicants.form.step7.positionN', { n: i + 1 })}</span>
            <button type="button" onClick={() => removeEntry(entry.id)} className="p-1 text-gray-400 hover:text-red-500">
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
          <div className="grid md:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step7.company')}</Label>
              <Input placeholder={t('applicants.form.step7.companyPh')} value={entry.company} onChange={e => updateEntry(entry.id, 'company', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step7.jobTitle')}</Label>
              <Input placeholder={t('applicants.form.step7.titlePh')} value={entry.jobTitle} onChange={e => updateEntry(entry.id, 'jobTitle', e.target.value)} />
            </div>
            <div className="space-y-1 md:col-span-2">
              <Label className="text-xs">{t('applicants.form.step7.companyAddress')} *</Label>
              <Input placeholder={t('applicants.form.step7.companyAddressPh')} value={entry.companyStreet} onChange={e => updateEntry(entry.id, 'companyStreet', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step7.city')} *</Label>
              <Input placeholder={t('applicants.form.step7.cityPh')} value={entry.companyCity} onChange={e => updateEntry(entry.id, 'companyCity', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step7.postalCode')} *</Label>
              <Input placeholder={t('applicants.form.step7.postalCodePh')} value={entry.companyPostalCode} onChange={e => updateEntry(entry.id, 'companyPostalCode', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step7.country')} *</Label>
              <CountrySelect value={entry.country} onChange={v => updateEntry(entry.id, 'country', v)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step7.companyPhone')} *</Label>
              <div className="flex gap-2">
                <PhoneCodeCombobox value={entry.companyPhoneCode} onChange={v => updateEntry(entry.id, 'companyPhoneCode', v)} className="w-36 shrink-0" />
                <Input placeholder={t('applicants.form.step7.companyPhonePh')} value={entry.companyPhone} onChange={e => updateEntry(entry.id, 'companyPhone', e.target.value)} className="flex-1" />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step7.startDate')}</Label>
              <DateInput value={entry.startDate} onChange={e => updateEntry(entry.id, 'startDate', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step7.endDate')}</Label>
              <div className="flex items-center gap-2">
                <DateInput value={entry.current ? '' : entry.endDate} onChange={e => updateEntry(entry.id, 'endDate', e.target.value)} disabled={entry.current} className="flex-1" />
                <label className="flex items-center gap-1.5 text-xs whitespace-nowrap cursor-pointer">
                  <Checkbox checked={entry.current} onCheckedChange={c => updateEntry(entry.id, 'current', !!c)} />
                  {t('applicants.form.step7.current')}
                </label>
              </div>
            </div>
            <div className="space-y-1 md:col-span-2">
              <Label className="text-xs">{t('applicants.form.step7.responsibilities')}</Label>
              <Textarea rows={2} placeholder={t('applicants.form.step7.responsibilitiesPh')} value={entry.responsibilities} onChange={e => updateEntry(entry.id, 'responsibilities', e.target.value)} />
            </div>
            <div className="space-y-1 md:col-span-2">
              <Label className="text-xs">{t('applicants.form.step7.reasonForLeaving')}</Label>
              <Input placeholder={t('applicants.form.step7.reasonForLeavingPh')} value={entry.reasonForLeaving} onChange={e => updateEntry(entry.id, 'reasonForLeaving', e.target.value)} />
            </div>
            <div className="space-y-1 md:col-span-2">
              <Label className="text-xs font-semibold">{t('applicants.form.step7.reference')} <span className="text-gray-400 font-normal">{t('applicants.form.common.optional')}</span></Label>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step7.referenceName')}</Label>
              <Input placeholder={t('applicants.form.step7.referenceNamePh')} value={entry.referenceName} onChange={e => updateEntry(entry.id, 'referenceName', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step7.referencePhone')}</Label>
              <div className="flex gap-2">
                <PhoneCodeCombobox value={entry.referencePhoneCode} onChange={v => updateEntry(entry.id, 'referencePhoneCode', v)} className="w-36 shrink-0" />
                <Input placeholder={t('applicants.form.step7.referencePhonePh')} value={entry.referencePhone} onChange={e => updateEntry(entry.id, 'referencePhone', e.target.value)} className="flex-1" />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step7.referenceEmail')}</Label>
              <Input
                type="email"
                placeholder={t('applicants.form.step7.referenceEmailPh')}
                value={entry.referenceEmail}
                onChange={e => updateEntry(entry.id, 'referenceEmail', e.target.value)}
                className={entry.referenceEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry.referenceEmail) ? 'border-red-400 focus-visible:ring-red-400' : ''}
              />
              {entry.referenceEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry.referenceEmail) && (
                <p className="text-xs text-red-500 mt-0.5">{t('applicants.form.step2.emailInvalid')}</p>
              )}
            </div>
            <InlineDocUpload
              label={t('applicants.form.step7.workDocLabel', { name: entry.company || t('applicants.form.step7.positionN', { n: i + 1 }) })}
              sectionKey={`work-exp-${entry.id}`}
              uploadedFiles={uploadedFiles}
              onFilesChange={onFilesChange}
            />
          </div>
        </div>
      ))}
      {d.workHistory.length === 0 && <p className="text-sm text-gray-400 text-center py-6 border-2 border-dashed border-gray-200 rounded-xl">{t('applicants.form.common.noEntries')}</p>}
      <button type="button" onClick={addEntry} className="w-full flex items-center justify-center gap-2 px-4 py-3 border-2 border-dashed border-blue-300 rounded-lg text-blue-600 text-sm font-medium hover:border-blue-500 hover:bg-blue-50">
        <Plus className="w-4 h-4" /> {t('applicants.form.step7.addExperience')}
      </button>
    </div>
  );
}

function Step8Skills({ d, u, settings, uploadedFiles, onFilesChange, fieldErrors }: { d: ApplicantFormData; u: (fn: (p: ApplicantFormData) => ApplicantFormData) => void; settings: FormSettings; uploadedFiles: UploadedFileItem[]; onFilesChange: (files: UploadedFileItem[]) => void; fieldErrors?: Record<string, string> }) {
  const { t } = useTranslation('pages');
  const set = (field: keyof ApplicantFormData) => (value: any) => u(prev => ({ ...prev, [field]: value }));
  const addPresetSkill = (skill: string) => {
    u(prev => ({ ...prev, skills: [...prev.skills, { id: crypto.randomUUID(), skill, level: '', isCustom: false }] }));
  };
  const addCustomSkill = () => {
    u(prev => ({ ...prev, skills: [...prev.skills, { id: crypto.randomUUID(), skill: '', level: '', isCustom: true }] }));
  };
  const updateSkill = (id: string, field: keyof SkillEntry, value: any) => {
    u(prev => ({ ...prev, skills: prev.skills.map(s => s.id === id ? { ...s, [field]: value } : s) }));
  };
  const removeSkill = (id: string) => {
    u(prev => ({ ...prev, skills: prev.skills.filter(s => s.id !== id) }));
  };
  const addLang = () => {
    u(prev => ({
      ...prev,
      languages: [...prev.languages, { id: crypto.randomUUID(), language: '', motherTongue: false, speakingLevel: '', readingLevel: '', writingLevel: '', listeningLevel: '', hasCertificate: false, certificate: '' }],
    }));
  };
  const updateLang = (id: string, field: keyof LanguageEntry, value: any) => {
    u(prev => ({ ...prev, languages: prev.languages.map(l => l.id === id ? { ...l, [field]: value } : l) }));
  };
  const removeLang = (id: string) => {
    u(prev => ({ ...prev, languages: prev.languages.filter(l => l.id !== id) }));
  };

  return (
    <div className="space-y-8">
      <SectionTitle title={t('applicants.form.step8.title')} subtitle={t('applicants.form.step8.subtitle')} />
      <div className="space-y-4">
        <SubSection title={t('applicants.form.step8.languages')} />
        {d.languages.map((lang, i) => {
          const k = (f: string) => `languages.${lang.id}.${f}`;
          const errClass = (name: string) =>
            fieldErrors?.[name] ? 'border-red-500 focus-visible:ring-red-500' : '';
          const skillLabels: Record<string, string> = {
            Speaking: t('applicants.form.step8.speaking'),
            Reading: t('applicants.form.step8.reading'),
            Writing: t('applicants.form.step8.writing'),
            Listening: t('applicants.form.step8.listening'),
          };
          return (
          <div key={lang.id} className="p-4 border-2 border-gray-200 rounded-lg space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{t('applicants.form.step8.languageN', { n: i + 1 })}</span>
              <button
                type="button"
                onClick={() => removeLang(lang.id)}
                title={t('applicants.form.step6.removeEntry')}
                aria-label={t('applicants.form.step6.removeEntry')}
                className="p-1.5 rounded-md text-gray-400 hover:text-red-600 hover:bg-red-50"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
            <div className="grid md:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">{t('applicants.form.step8.language')} *</Label>
                <Select value={lang.language} onValueChange={v => updateLang(lang.id, 'language', v)}>
                  <SelectTrigger className={errClass(k('language'))}><SelectValue placeholder={t('applicants.form.step8.languagePh')} /></SelectTrigger>
                  <SelectContent>
                    {LANGUAGES.map(l => <SelectItem key={l} value={l}>{enumLabel('language', l)}</SelectItem>)}
                  </SelectContent>
                </Select>
                <FieldError errors={fieldErrors} name={k('language')} />
              </div>
              <div className="flex items-center gap-2 mt-5">
                <Checkbox checked={lang.motherTongue} onCheckedChange={c => updateLang(lang.id, 'motherTongue', !!c)} />
                <Label className="text-xs cursor-pointer">{t('applicants.form.step8.motherTongue')}</Label>
              </div>
              {(['Speaking', 'Reading', 'Writing', 'Listening'] as const).map(skill => {
                const levelKey = `${skill.toLowerCase()}Level`;
                return (
                  <div key={skill} className="space-y-1">
                    <Label className="text-xs">{skillLabels[skill]}{!lang.motherTongue && ' *'}</Label>
                    <Select value={(lang as any)[levelKey]} onValueChange={v => updateLang(lang.id, levelKey as keyof LanguageEntry, v)}>
                      <SelectTrigger className={errClass(k(levelKey))}><SelectValue placeholder={t('applicants.form.step8.levelPh')} /></SelectTrigger>
                      <SelectContent>
                        {PROFICIENCY_LEVELS.map(l => <SelectItem key={l} value={l}>{enumLabel('proficiency', l)}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <FieldError errors={fieldErrors} name={k(levelKey)} />
                  </div>
                );
              })}
              <div className="flex items-center gap-2 mt-1 md:col-span-2">
                <Checkbox checked={lang.hasCertificate} onCheckedChange={c => updateLang(lang.id, 'hasCertificate', !!c)} />
                <Label className="text-xs cursor-pointer">{t('applicants.form.step8.hasCertificate')}</Label>
              </div>
              {lang.hasCertificate && (
                <div className="space-y-1 md:col-span-2">
                  <Label className="text-xs">{t('applicants.form.step8.certificate')} *</Label>
                  <Input
                    placeholder={t('applicants.form.step8.certificatePh')}
                    value={lang.certificate}
                    onChange={e => updateLang(lang.id, 'certificate', e.target.value)}
                    aria-invalid={!!fieldErrors?.[k('certificate')]}
                    className={errClass(k('certificate'))}
                  />
                  <FieldError errors={fieldErrors} name={k('certificate')} />
                </div>
              )}
            </div>
          </div>
          );
        })}
        <button type="button" onClick={addLang} className="w-full flex items-center justify-center gap-2 px-4 py-3 border-2 border-dashed border-blue-300 rounded-lg text-blue-600 text-sm font-medium hover:border-blue-500 hover:bg-blue-50">
          <Plus className="w-4 h-4" /> {t('applicants.form.step8.addLanguage')}
        </button>
      </div>
      <div className="space-y-4">
        <SubSection title={t('applicants.form.step8.skills')} />
        {d.skills.map(entry => (
          <div key={entry.id} className="flex items-center gap-2">
            {entry.isCustom ? (
              <Input
                value={entry.skill}
                onChange={e => updateSkill(entry.id, 'skill', e.target.value)}
                placeholder={t('applicants.form.step8.skillPh')}
                className="flex-1"
              />
            ) : (
              <span className="flex-1 text-sm px-3 py-2 bg-blue-50 border border-blue-200 rounded-md">{entry.skill}</span>
            )}
            <Select value={entry.level} onValueChange={v => updateSkill(entry.id, 'level', v)}>
              <SelectTrigger className="w-36"><SelectValue placeholder={t('applicants.form.step8.levelPh')} /></SelectTrigger>
              <SelectContent>
                {SKILL_LEVELS.map(l => <SelectItem key={l} value={l}>{enumLabel('skillLevel', l)}</SelectItem>)}
              </SelectContent>
            </Select>
            <button type="button" onClick={() => removeSkill(entry.id)} className="p-1 text-gray-400 hover:text-red-500 flex-shrink-0">
              <X className="w-4 h-4" />
            </button>
          </div>
        ))}
        {(settings.skills ?? []).filter(s => !d.skills.some(e => e.skill === s)).length > 0 && (
          <div className="flex flex-wrap gap-2 pt-1">
            {(settings.skills ?? []).filter(s => !d.skills.some(e => e.skill === s)).map(s => (
              <button key={s} type="button" onClick={() => addPresetSkill(s)}
                className="px-3 py-1.5 border-2 border-dashed border-gray-300 rounded-lg text-sm text-gray-600 hover:border-blue-400 hover:text-blue-600 hover:bg-blue-50 transition-all">
                + {s}
              </button>
            ))}
          </div>
        )}
        <button type="button" onClick={addCustomSkill} className="w-full flex items-center justify-center gap-2 px-4 py-3 border-2 border-dashed border-blue-300 rounded-lg text-blue-600 text-sm font-medium hover:border-blue-500 hover:bg-blue-50">
          <Plus className="w-4 h-4" /> {t('applicants.form.step8.addCustomSkill')}
        </button>
      </div>
      <div className="space-y-3">
        <SubSection title={t('applicants.form.step8.firstAidSection')} />
        <div className="space-y-2">
          <Label className="text-xs">{t('applicants.form.step8.firstAidQuestion')}</Label>
          <RadioYN name="hasFirstAid" value={d.hasFirstAid} onChange={set('hasFirstAid')} />
        </div>
        {d.hasFirstAid === 'yes' && (
          <div className="grid md:grid-cols-2 gap-4 mt-2">
            <div className="space-y-1">
              <Label className="text-xs">{t('applicants.form.step8.firstAidExpiry')}</Label>
              <ExpiryFields expiryDate={d.firstAidExpiry} noExpiry={d.firstAidNoExpiry} onExpiry={set('firstAidExpiry')} onNoExpiry={set('firstAidNoExpiry')} />
            </div>
            <InlineDocUpload label={t('applicants.form.step8.uploadFirstAid')} sectionKey="firstAid" uploadedFiles={uploadedFiles} onFilesChange={onFilesChange} />
          </div>
        )}
      </div>
      <div className="space-y-2">
        <SubSection title={t('applicants.form.step8.tools')} />
        <Textarea rows={3} placeholder={t('applicants.form.step8.toolsPh')} value={d.toolsDescription} onChange={e => set('toolsDescription')(e.target.value)} />
      </div>
    </div>
  );
}

function Step9Additional({ d, u, settings }: { d: ApplicantFormData; u: (fn: (p: ApplicantFormData) => ApplicantFormData) => void; settings: FormSettings }) {
  const { t } = useTranslation('pages');
  const set = (field: keyof ApplicantFormData) => (value: any) => u(prev => ({ ...prev, [field]: value }));
  return (
    <div className="space-y-8">
      <SectionTitle title={t('applicants.form.step9.title')} subtitle={t('applicants.form.step9.subtitle')} />
      <div className="grid md:grid-cols-2 gap-6">
        <div className="space-y-1">
          <Label className="text-xs">{t('applicants.form.step9.preferredStartDate')} *</Label>
          <DateInput value={d.preferredStartDate} onChange={e => set('preferredStartDate')(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t('applicants.form.step9.availability')}</Label>
          <Select value={d.availability} onValueChange={set('availability')}>
            <SelectTrigger><SelectValue placeholder={t('applicants.form.step9.availabilityPh')} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="1 Week">{t('applicants.form.step9.avail1Week')}</SelectItem>
              <SelectItem value="2 Weeks">{t('applicants.form.step9.avail2Weeks')}</SelectItem>
              <SelectItem value="3 Weeks">{t('applicants.form.step9.avail3Weeks')}</SelectItem>
              <SelectItem value="1 Month">{t('applicants.form.step9.avail1Month')}</SelectItem>
              <SelectItem value="2 Months">{t('applicants.form.step9.avail2Months')}</SelectItem>
              <SelectItem value="3 Months">{t('applicants.form.step9.avail3Months')}</SelectItem>
              <SelectItem value="6 Months">{t('applicants.form.step9.avail6Months')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t('applicants.form.step9.howDidYouHear')} *</Label>
          <Select value={d.howDidYouHear} onValueChange={set('howDidYouHear')}>
            <SelectTrigger><SelectValue placeholder={t('applicants.form.step9.howDidYouHearPh')} /></SelectTrigger>
            <SelectContent>
              {(settings.howDidYouHear ?? []).map(o => <SelectItem key={o} value={o}>{o}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t('applicants.form.step9.salary')}</Label>
          <Input placeholder={t('applicants.form.step9.salaryPh')} value={d.salaryExpectation} onChange={e => set('salaryExpectation')(e.target.value)} />
        </div>
        <div className="space-y-2 md:col-span-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <Checkbox checked={d.willingToRelocate} onCheckedChange={c => set('willingToRelocate')(!!c)} />
            <span className="text-sm">{t('applicants.form.step9.willingToRelocate')}</span>
          </label>
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label className="text-xs">{t('applicants.form.step9.workRegime')}</Label>
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 cursor-pointer text-sm">
              <Checkbox checked={d.weekendDriving} onCheckedChange={c => set('weekendDriving')(!!c)} />
              {t('applicants.form.step9.weekendDriving')}
            </label>
            <label className="flex items-center gap-2 cursor-pointer text-sm">
              <Checkbox checked={d.nightDriving} onCheckedChange={c => set('nightDriving')(!!c)} />
              {t('applicants.form.step9.nightDriving')}
            </label>
          </div>
        </div>
        <div className="space-y-1 md:col-span-2">
          <Label className="text-xs">{t('applicants.form.step9.additionalNotes')}</Label>
          <Textarea rows={4} placeholder={t('applicants.form.step9.additionalNotesPh')} value={d.additionalNotes} onChange={e => set('additionalNotes')(e.target.value)} />
        </div>
      </div>
    </div>
  );
}

const FALLBACK_DOC_TYPES = ['Passport', "Driver's License", 'Tachograph Card', 'C95 / CPC Card', 'ADR Certificate', 'Visa', 'Work Permit', 'Residence Card', 'Medical Certificate', 'First Aid Certificate', 'Other'];

function Step10Documents({ uploadedFiles, onFilesChange, requiredDocuments = [] }: { uploadedFiles: UploadedFileItem[]; onFilesChange: (files: UploadedFileItem[]) => void; requiredDocuments?: string[] }) {
  const { t } = useTranslation('pages');
  const [docTypes, setDocTypes] = useState<string[]>(FALLBACK_DOC_TYPES);

  useEffect(() => {
    settingsApi.getDocumentTypes()
      .then((data: any[]) => {
        const names = data.filter(d => d.isActive !== false).map(d => d.name).filter(Boolean);
        if (names.length > 0) setDocTypes(names);
      })
      .catch(() => {});
  }, []);

  const addDoc = () => {
    onFilesChange([...uploadedFiles, { id: crypto.randomUUID(), type: '', file: null }]);
  };
  const updateItem = (id: string, patch: Partial<UploadedFileItem>) => {
    onFilesChange(uploadedFiles.map(f => f.id === id ? { ...f, ...patch } : f));
  };
  const removeItem = (id: string) => {
    onFilesChange(uploadedFiles.filter(f => f.id !== id));
  };

  // Separate required (locked) entries from optional ones
  const optionalItems = uploadedFiles.filter(f => !f.sectionKey?.startsWith('required:'));

  return (
    <div className="space-y-6">
      <SectionTitle title={t('applicants.form.step10.title')} subtitle={t('applicants.form.step10.subtitle')} />

      {/* Required documents section */}
      {requiredDocuments.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-red-700">{t('applicants.form.step10.requiredDocs')}</span>
            <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-medium">{t('applicants.form.step10.mandatory')}</span>
          </div>
          <p className="text-xs text-red-600">{t('applicants.form.step10.requiredDocsHelp')}</p>
          {requiredDocuments.map(docName => {
            const item = uploadedFiles.find(f => f.sectionKey === `required:${docName}`);
            if (!item) return null;
            return (
              <div key={docName} className={`p-4 border-2 rounded-lg space-y-3 ${item.file ? 'border-green-300 bg-green-50' : 'border-red-200 bg-red-50'}`}>
                <div className="flex items-center gap-2">
                  <FileText className={`w-4 h-4 shrink-0 ${item.file ? 'text-green-600' : 'text-red-500'}`} />
                  <span className={`text-sm font-medium ${item.file ? 'text-green-800' : 'text-red-800'}`}>{docName}</span>
                  {item.file
                    ? <span className="ms-auto text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">{t('applicants.form.step10.uploaded')}</span>
                    : <span className="ms-auto text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-medium">{t('applicants.form.step10.requiredBadge')}</span>
                  }
                </div>
                <label className="block cursor-pointer">
                  <div className={`flex items-center gap-2 px-3 py-2 rounded border text-sm transition-colors ${item.file ? 'bg-green-50 border-green-300 text-green-800' : 'bg-white border-red-300 text-red-500 hover:border-red-400'}`}>
                    {item.file ? (
                      <><Check className="w-4 h-4 text-green-600 shrink-0" /><span className="truncate">{item.file.name}</span><span className="ms-auto text-xs">{(item.file.size / 1024 / 1024).toFixed(1)} MB</span></>
                    ) : (
                      <><Upload className="w-4 h-4" /><span>{t('applicants.form.step10.chooseFileRequired')}</span></>
                    )}
                  </div>
                  <input type="file" accept=".pdf,.jpg,.jpeg,.png" className="sr-only" onChange={e => updateItem(item.id, { file: e.target.files?.[0] ?? null })} />
                </label>
              </div>
            );
          })}
        </div>
      )}

      {/* Optional documents */}
      <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-800">
        {t('applicants.form.step10.uploadHint')}
      </div>
      {optionalItems.map((item) => (
        <div key={item.id} className="p-4 border-2 border-dashed border-gray-300 rounded-lg space-y-3">
          <div className="flex items-start gap-3">
            <div className="flex-1 space-y-1">
              <Label className="text-xs">{t('applicants.form.step10.documentType')} *</Label>
              {item.sectionKey && !item.sectionKey.startsWith('required:') ? (
                <div className="flex items-center gap-2 px-3 py-2 bg-blue-50 border border-blue-200 rounded-md">
                  <FileText className="w-4 h-4 text-blue-500 shrink-0" />
                  <span className="text-sm text-blue-800 font-medium">{item.type.replace(/^Upload\s+/i, '')}</span>
                  <span className="ms-auto text-xs text-blue-500 italic">{t('applicants.form.step10.autoDetected')}</span>
                </div>
              ) : (
                <Select value={item.type} onValueChange={type => updateItem(item.id, { type })}>
                  <SelectTrigger><SelectValue placeholder={t('applicants.form.step10.selectType')} /></SelectTrigger>
                  <SelectContent>
                    {docTypes.map(tp => <SelectItem key={tp} value={tp}>{tp}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}
            </div>
            <button type="button" onClick={() => removeItem(item.id)} className="mt-5 p-1.5 text-gray-400 hover:text-red-500">
              <X className="w-4 h-4" />
            </button>
          </div>
          <label className="block cursor-pointer">
            <div className={`flex items-center gap-2 px-3 py-2 rounded border text-sm transition-colors ${item.file ? 'bg-green-50 border-green-300 text-green-800' : 'bg-gray-50 border-gray-200 text-gray-500 hover:border-blue-300'}`}>
              {item.file ? (
                <><Check className="w-4 h-4 text-green-600 shrink-0" /><span className="truncate">{item.file.name}</span><span className="ms-auto text-xs">{(item.file.size / 1024 / 1024).toFixed(1)} MB</span></>
              ) : (
                <><Upload className="w-4 h-4" /><span>{t('applicants.form.step10.chooseFile')}</span></>
              )}
            </div>
            <input type="file" accept=".pdf,.jpg,.jpeg,.png" className="sr-only" onChange={e => updateItem(item.id, { file: e.target.files?.[0] ?? null })} />
          </label>
        </div>
      ))}
      {optionalItems.length === 0 && requiredDocuments.length === 0 && <p className="text-sm text-gray-400 text-center py-8 border-2 border-dashed border-gray-200 rounded-lg">{t('applicants.form.step10.noDocuments')}</p>}
      <button type="button" onClick={addDoc} className="w-full flex items-center justify-center gap-2 px-4 py-3 border-2 border-dashed border-blue-300 rounded-lg text-blue-600 text-sm font-medium hover:border-blue-500 hover:bg-blue-50">
        <Plus className="w-4 h-4" /> {t('applicants.form.step10.addDocument')}
      </button>
    </div>
  );
}

async function downloadApplicationSummary(d: ApplicantFormData, uploadedFiles: UploadedFileItem[]) {
  const S = (k: string) => tf(`step11.summary.${k}`);
  const yesNo = (v: 'yes' | 'no' | string | boolean | null | undefined): string => {
    if (v === true || v === 'yes') return S('yes');
    if (v === false || v === 'no') return S('no');
    return (v as string) ?? '';
  };
  const field = (label: string, value: string | undefined | null | boolean) => {
    const v = typeof value === 'boolean' ? (value ? S('yes') : S('no')) : value;
    if (!v) return '';
    return `<div class="field"><span class="label">${label}</span><span class="value">${v}</span></div>`;
  };
  const section = (title: string, content: string) =>
    content.trim() ? `<div class="section"><h2>${title}</h2>${content}</div>` : '';

  // Read image files as data URLs for embedding
  const readAsDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

  const filesWithData = await Promise.all(
    uploadedFiles.filter(f => f.file).map(async f => {
      const isImage = f.file!.type.startsWith('image/');
      const dataUrl = isImage ? await readAsDataUrl(f.file!).catch(() => null) : null;
      return { label: f.type || f.sectionKey || S('documentDefault'), name: f.file!.name, isImage, isPdf: f.file!.type === 'application/pdf', dataUrl };
    })
  );

  const dir = i18n.dir();
  const lang = i18n.resolvedLanguage ?? i18n.language ?? 'en';

  const html = `<!DOCTYPE html><html lang="${lang}" dir="${dir}"><head><meta charset="UTF-8"/><title>${S('title')}</title>
<style>
  body{font-family:Arial,sans-serif;margin:32px;color:#1f2937;font-size:13px;}
  h1{color:#1a56db;margin-bottom:4px;}
  .ref{font-size:12px;color:#6b7280;margin-bottom:24px;}
  h2{font-size:13px;font-weight:700;color:#1a56db;border-bottom:1px solid #e5e7eb;padding-bottom:4px;margin:20px 0 8px;}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
  .field{display:flex;flex-direction:column;gap:2px;}
  .label{font-size:10px;text-transform:uppercase;color:#6b7280;font-weight:600;}
  .value{color:#111827;}
  .entry{border:1px solid #e5e7eb;border-radius:6px;padding:8px 12px;margin-bottom:6px;}
  .entry-title{font-weight:700;margin-bottom:4px;}
  @media print{body{margin:16px;}}
</style></head><body>
<h1>${S('title')}</h1>
<p class="ref">${S('submittedBy')}: ${[d.firstName, d.middleName, d.lastName].filter(Boolean).join(' ')} &nbsp;|&nbsp; ${d.email}</p>
<div class="grid">
${section(S('personalSection'), `<div class="grid">
  ${field(S('firstName'), d.firstName)}${field(S('middleName'), d.middleName)}${field(S('lastName'), d.lastName)}
  ${field(S('dateOfBirth'), d.dateOfBirth)}${field(S('gender'), enumLabel('gender', d.gender) || d.gender)}${field(S('citizenship'), [d.citizenship, ...(d.otherCitizenships ?? [])].filter(Boolean).join(', '))}
  ${field(S('countryOfBirth'), d.countryOfBirth)}${field(S('cityOfBirth'), d.cityOfBirth)}
  ${field(S('livedAbroad'), yesNo(d.livedAbroadRecently))}
  ${d.livedAbroadRecently === 'yes' ? field(S('abroadCountry'), d.abroadCountry) + field(S('abroadAddress'), [d.abroadAddress?.line1, d.abroadAddress?.city, d.abroadAddress?.country].filter(Boolean).join(', ')) + field(S('periodAbroad'), d.abroadDateFrom && d.abroadDateTo ? d.abroadDateFrom + ' \u2013 ' + d.abroadDateTo : '') : ''}
</div>`)}
${section(S('contactSection'), `<div class="grid">
  ${field(S('email'), d.email)}${field(S('phone'), d.phone ? `${d.phoneCode} ${d.phone}` : '')}
  ${field(S('whatsapp'), d.phoneIsWhatsApp ? `${d.phoneCode} ${d.phone} (${S('sameAsPhone')})` : d.whatsapp ? `${d.whatsappCode} ${d.whatsapp}` : '')}
  ${field(S('emergencyContact'), d.emergencyContact)}${field(S('emergencyPhone'), d.emergencyPhone)}
</div>`)}
</div>
${d.hasDrivingLicense === 'yes' ? section(S('drivingLicenseSection'), `<div class="grid">
  ${field(S('licenseNumber'), d.licenseNumber)}${field(S('issuingCountry'), d.licenseCountry)}
  ${field(S('categories'), d.licenseCategories?.join(', '))}${field(S('issueDate'), d.licenseIssueDate)}
  ${field(S('firstIssueDate'), d.licenseFirstIssueDate)}${field(S('expiry'), d.licenseNoExpiry ? S('noExpiry') : d.licenseExpiryDate)}
</div>`) : ''}
${d.drivingExpType ? section(S('drivingExpSection'), `<div class="grid">
  ${field(S('experienceType'), d.drivingExpType)}
  ${(d.drivingExpType === 'eu' || d.drivingExpType === 'both') ? field(S('euYears'), d.euExpYears) + field(S('euKm'), d.euExpKm) + field(S('euCountry'), d.euExpCountries) : ''}
  ${(d.drivingExpType === 'domestic' || d.drivingExpType === 'both') ? field(S('domesticYears'), d.domesticExpYears) + field(S('domesticKm'), d.domesticExpKm) + field(S('domesticCountry'), d.domesticExpCountry) : ''}
  ${field(S('transportTypes'), d.transportTypes?.join(', '))}${field(S('truckBrands'), d.truckBrands?.join(', '))}
  ${field(S('gearbox'), d.gearboxType)}
</div>`) : ''}
${d.education.length > 0 ? section(S('educationSection'), d.education.map(e => `<div class="entry"><div class="entry-title">${e.level || S('degree')} — ${e.institution || ''}</div>${field(S('field'), e.fieldOfStudy)}${field(S('country'), e.country)}${field(S('period'), [e.startDate, e.current ? S('present') : e.endDate].filter(Boolean).join(' – '))}</div>`).join('')) : ''}
${d.workHistory.length > 0 ? section(S('workSection'), d.workHistory.map(w => `<div class="entry"><div class="entry-title">${w.jobTitle || S('position')} — ${w.company || ''}</div>${field(S('country'), w.country)}${field(S('period'), [w.startDate, w.current ? S('present') : w.endDate].filter(Boolean).join(' – '))}${field(S('reasonForLeaving'), w.reasonForLeaving)}${field(S('reference'), w.referenceName ? `${w.referenceName} | ${w.referencePhone} | ${w.referenceEmail}` : '')}</div>`).join('')) : ''}
${d.languages.length > 0 ? section(S('languagesSection'), d.languages.map(l => `<div class="entry"><div class="entry-title">${enumLabel('language', l.language) || l.language}${l.motherTongue ? ` (${S('motherTongue')})` : ''}</div>${l.motherTongue ? '' : `${field(S('speaking'), enumLabel('proficiency', l.speakingLevel) || l.speakingLevel)}${field(S('reading'), enumLabel('proficiency', l.readingLevel) || l.readingLevel)}${field(S('writing'), enumLabel('proficiency', l.writingLevel) || l.writingLevel)}${field(S('listening'), enumLabel('proficiency', l.listeningLevel) || l.listeningLevel)}`}</div>`).join('')) : ''}
${d.skills.length > 0 ? section(S('skillsSection'), `<div class="grid">${d.skills.map(s => field(s.skill, (enumLabel('skillLevel', s.level) || s.level) || '—')).join('')}</div>`) : ''}
${section(S('additionalSection'), `<div class="grid">
  ${field(S('preferredStartDate'), d.preferredStartDate)}${field(S('availability'), d.availability)}
  ${field(S('salaryExpectation'), d.salaryExpectation)}${field(S('willingToRelocate'), yesNo(d.willingToRelocate))}
  ${field(S('weekendDriving'), yesNo(d.weekendDriving))}${field(S('nightDriving'), yesNo(d.nightDriving))}
  ${field(S('howDidYouHear'), d.howDidYouHear)}
</div>`)}
${filesWithData.length > 0 ? section(S('documentsSection'), filesWithData.map(f => `
<div class="entry">
  <div class="entry-title">${f.label} — <span style="font-weight:normal;color:#6b7280;">${f.name}</span></div>
  ${f.isImage && f.dataUrl ? `<img src="${f.dataUrl}" style="max-width:100%;max-height:320px;margin-top:8px;border-radius:4px;border:1px solid #e5e7eb;" />` : ''}
  ${f.isPdf ? `<p style="color:#6b7280;font-size:12px;margin:4px 0 0;">${S('pdfNote')}</p>` : ''}
</div>`).join('')) : ''}
</body></html>`;

  // Open the summary in a new browser tab. We render via a Blob URL
  // rather than window.open('') + document.write so we don't steal
  // focus by navigating an about:blank page, and we deliberately skip
  // window.print() — auto-triggering the print dialog used to block
  // the user from returning to the form tab to submit the application.
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener,noreferrer');
  // Revoke after a delay so the new tab has time to load the blob
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function ReviewField({ label, value }: { label: string; value?: string | null | boolean }) {
  const { t } = useTranslation('pages');
  const display = typeof value === 'boolean' ? (value ? t('applicants.form.common.yes') : t('applicants.form.common.no')) : value;
  if (!display) return null;
  return (
    <div className="p-3 bg-gray-50 rounded-lg">
      <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">{label}</p>
      <p className="text-sm font-semibold text-gray-900 mt-0.5">{display}</p>
    </div>
  );
}

function ReviewSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-bold text-blue-700 border-b border-blue-100 pb-1">{title}</h3>
      {children}
    </div>
  );
}

function Step11Review({ d, u, settings, photoFile, existingPhotoUrl, uploadedFiles = [] }: {
  d: ApplicantFormData;
  u: (fn: (p: ApplicantFormData) => ApplicantFormData) => void;
  settings: FormSettings;
  photoFile?: File | null;
  existingPhotoUrl?: string;
  uploadedFiles?: UploadedFileItem[];
}) {
  const { t } = useTranslation('pages');
  const set = (field: keyof ApplicantFormData) => (value: any) => u(prev => ({ ...prev, [field]: value }));
  const previewUrl = photoFile ? URL.createObjectURL(photoFile) : existingPhotoUrl ?? null;

  const STATEMENTS: { field: 'declarationAccepted' | 'agreeDataProcessing' | 'agreeBackground' | 'agreeDataSharing'; label: ReactNode }[] = [
    { field: 'declarationAccepted', label: t('applicants.form.step11.stmt1') },
    {
      field: 'agreeDataProcessing',
      label: (
        <span>
          {t('applicants.form.step11.stmt2Pre')}{' '}
          <a href="/data-processing-agreement" target="_blank" rel="noopener noreferrer" className="underline text-blue-700 hover:text-blue-900" onClick={e => e.stopPropagation()}>
            {t('applicants.form.step11.stmt2Link')}
          </a>
        </span>
      ),
    },
    { field: 'agreeBackground', label: t('applicants.form.step11.stmt3') },
    { field: 'agreeDataSharing', label: t('applicants.form.step11.stmt4') },
  ];

  const F = t('applicants.form.step11.fields', { returnObjects: true }) as Record<string, string>;

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <SectionTitle title={t('applicants.form.step11.title')} subtitle={t('applicants.form.step11.subtitle')} />
        <button
          type="button"
          onClick={() => downloadApplicationSummary(d, uploadedFiles)}
          className="flex items-center gap-2 px-4 py-2 border-2 border-blue-300 rounded-lg text-blue-600 text-sm font-medium hover:border-blue-500 hover:bg-blue-50 transition-all flex-shrink-0"
        >
          <FileText className="w-4 h-4" />
          {t('applicants.form.step11.downloadApplication')}
        </button>
      </div>

      {/* Photo */}
      {previewUrl ? (
        <div className="flex items-center gap-4 p-4 bg-gray-50 rounded-lg border">
          <img src={previewUrl} alt={t('applicants.form.step11.applicantPhoto')} className="w-16 h-16 rounded-full object-cover border-2 border-blue-200" />
          <div>
            <p className="text-xs text-gray-500 font-medium uppercase">{t('applicants.form.step11.applicantPhoto')}</p>
            <p className="text-sm font-semibold text-green-700 mt-0.5">{t('applicants.form.step11.photoUploaded')}</p>
          </div>
        </div>
      ) : (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-sm text-red-700 font-medium">{t('applicants.form.step11.photoMissing')}</p>
        </div>
      )}

      {/* Personal */}
      <ReviewSection title={t('applicants.form.step11.personalSection')}>
        <div className="grid md:grid-cols-2 gap-3">
          <ReviewField label={F.fullName} value={[d.firstName, d.middleName, d.lastName].filter(Boolean).join(' ')} />
          <ReviewField label={F.dateOfBirth} value={d.dateOfBirth} />
          <ReviewField label={F.gender} value={d.gender} />
          <ReviewField label={F.citizenship} value={[d.citizenship, ...(d.otherCitizenships ?? [])].filter(Boolean).join(', ')} />
          <ReviewField label={F.countryOfBirth} value={d.countryOfBirth} />
          <ReviewField label={F.cityOfBirth} value={d.cityOfBirth} />
          <ReviewField label={F.livedAbroad} value={d.livedAbroadRecently} />
          {d.livedAbroadRecently === 'yes' && <>
            <ReviewField label={F.abroadCountry} value={d.abroadCountry} />
            <ReviewField label={F.abroadAddress} value={[d.abroadAddress?.line1, d.abroadAddress?.city, d.abroadAddress?.country].filter(Boolean).join(', ')} />
            <ReviewField label={F.periodAbroad} value={d.abroadDateFrom && d.abroadDateTo ? `${d.abroadDateFrom} – ${d.abroadDateTo}` : d.abroadDateFrom || d.abroadDateTo} />
          </>}
        </div>
      </ReviewSection>

      {/* Contact */}
      <ReviewSection title={t('applicants.form.step11.contactSection')}>
        <div className="grid md:grid-cols-2 gap-3">
          <ReviewField label={F.email} value={d.email} />
          <ReviewField label={F.phone} value={d.phone ? `${d.phoneCode} ${d.phone}` : undefined} />
          <ReviewField label={F.whatsapp} value={d.phoneIsWhatsApp ? `${d.phoneCode} ${d.phone} (${t('applicants.form.step11.sameAsPhone')})` : d.whatsapp ? `${d.whatsappCode} ${d.whatsapp}` : undefined} />
          <ReviewField label={F.emergencyContact} value={d.emergencyContact} />
          <ReviewField label={F.emergencyPhone} value={d.emergencyPhone} />
        </div>
      </ReviewSection>

      {/* Driving License */}
      {d.hasDrivingLicense === 'yes' && (
        <ReviewSection title={t('applicants.form.step11.drivingLicenseSection')}>
          <div className="grid md:grid-cols-2 gap-3">
            <ReviewField label={F.licenseNumber} value={d.licenseNumber} />
            <ReviewField label={F.issuingCountry} value={d.licenseCountry} />
            <ReviewField label={F.categories} value={d.licenseCategories?.join(', ')} />
            <ReviewField label={F.firstIssueDate} value={d.licenseFirstIssueDate} />
            <ReviewField label={F.issueDate} value={d.licenseIssueDate} />
            <ReviewField label={F.expiry} value={d.licenseNoExpiry ? F.noExpiry : d.licenseExpiryDate} />
          </div>
        </ReviewSection>
      )}

      {/* Driving Experience */}
      {d.drivingExpType && (
        <ReviewSection title={t('applicants.form.step11.drivingExpSection')}>
          <div className="grid md:grid-cols-2 gap-3">
            <ReviewField label={F.type} value={d.drivingExpType} />
            {(d.drivingExpType === 'eu' || d.drivingExpType === 'both') && <>
              <ReviewField label={F.euYears} value={d.euExpYears} />
              <ReviewField label={F.euKm} value={d.euExpKm} />
              <ReviewField label={F.euCountry} value={d.euExpCountries} />
            </>}
            {(d.drivingExpType === 'domestic' || d.drivingExpType === 'both') && <>
              <ReviewField label={F.domesticYears} value={d.domesticExpYears} />
              <ReviewField label={F.domesticKm} value={d.domesticExpKm} />
              <ReviewField label={F.domesticCountry} value={d.domesticExpCountry} />
            </>}
            <ReviewField label={F.transportTypes} value={d.transportTypes?.join(', ')} />
            <ReviewField label={F.truckBrands} value={d.truckBrands?.join(', ')} />
            <ReviewField label={F.gearbox} value={d.gearboxType} />
            <ReviewField label={F.trafficAccidents} value={d.trafficAccidents} />
            {d.trafficAccidents === 'yes' && <ReviewField label={F.accidentDetails} value={d.accidentDescription} />}
          </div>
        </ReviewSection>
      )}

      {/* Education */}
      {(d.education?.length ?? 0) > 0 && (
        <ReviewSection title={t('applicants.form.step11.educationSection')}>
          {d.education!.map(e => (
            <div key={e.id} className="p-3 bg-gray-50 rounded-lg space-y-1">
              <p className="text-sm font-semibold text-gray-900">{e.level} — {e.institution}</p>
              {e.fieldOfStudy && <p className="text-xs text-gray-500">{e.fieldOfStudy}</p>}
              {e.country && <p className="text-xs text-gray-500">{e.country} · {e.startDate} – {e.current ? t('applicants.form.step11.presentLabel') : e.endDate}</p>}
            </div>
          ))}
        </ReviewSection>
      )}

      {/* Work History */}
      {(d.workHistory?.length ?? 0) > 0 && (
        <ReviewSection title={t('applicants.form.step11.workSection')}>
          {d.workHistory!.map(w => (
            <div key={w.id} className="p-3 bg-gray-50 rounded-lg space-y-1">
              <p className="text-sm font-semibold text-gray-900">{w.jobTitle} — {w.company}</p>
              <p className="text-xs text-gray-500">{w.country} · {w.startDate} – {w.current ? t('applicants.form.step11.presentLabel') : w.endDate}</p>
              {w.reasonForLeaving && <p className="text-xs text-gray-500">{F.leftReason}: {w.reasonForLeaving}</p>}
              {w.referenceName && <p className="text-xs text-gray-500">{F.ref}: {w.referenceName} · {w.referencePhone} · {w.referenceEmail}</p>}
            </div>
          ))}
        </ReviewSection>
      )}

      {/* Languages */}
      {(d.languages?.length ?? 0) > 0 && (
        <ReviewSection title={t('applicants.form.step11.languagesSection')}>
          <div className="grid md:grid-cols-2 gap-3">
            {d.languages!.map(l => {
              // Mother-tongue speakers don't rate themselves on the CEFR scale,
              // so suppress the per-skill line entirely. For all other languages,
              // only render the skills that actually have a level set.
              const skills = l.motherTongue
                ? []
                : ([
                    ['speakingPrefix', l.speakingLevel],
                    ['readingPrefix',  l.readingLevel],
                    ['writingPrefix',  l.writingLevel],
                    ['listeningPrefix', l.listeningLevel],
                  ] as const).filter(([, lvl]) => !!lvl);
              return (
                <div key={l.id} className="p-3 bg-gray-50 rounded-lg">
                  <p className="text-sm font-semibold text-gray-900">{enumLabel('language', l.language) || l.language}{l.motherTongue ? ` (${t('applicants.form.step11.phRefBadgeMother')})` : ''}</p>
                  {skills.length > 0 && (
                    <p className="text-xs text-gray-500 mt-0.5">
                      {skills.map(([prefix, lvl], idx) => (
                        <span key={prefix}>
                          {idx > 0 ? ' · ' : ''}
                          {t(`applicants.form.step11.${prefix}`)}: {enumLabel('proficiency', lvl) || lvl}
                        </span>
                      ))}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </ReviewSection>
      )}

      {/* Skills */}
      {(d.skills?.length ?? 0) > 0 && (
        <ReviewSection title={t('applicants.form.step11.skillsSection')}>
          <div className="grid md:grid-cols-2 gap-3">
            {d.skills!.map(s => (
              <div key={s.id} className="p-3 bg-gray-50 rounded-lg flex items-center justify-between">
                <span className="text-sm font-semibold text-gray-900">{s.skill}</span>
                {s.level && <span className="text-xs px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full">{enumLabel('skillLevel', s.level) || s.level}</span>}
              </div>
            ))}
          </div>
        </ReviewSection>
      )}

      {/* Additional */}
      <ReviewSection title={t('applicants.form.step11.additionalSection')}>
        <div className="grid md:grid-cols-2 gap-3">
          <ReviewField label={F.preferredStartDate} value={d.preferredStartDate} />
          <ReviewField label={F.availability} value={d.availability} />
          <ReviewField label={F.salaryExpectation} value={d.salaryExpectation} />
          <ReviewField label={F.willingToRelocate} value={d.willingToRelocate} />
          <ReviewField label={F.weekendDriving} value={d.weekendDriving} />
          <ReviewField label={F.nightDriving} value={d.nightDriving} />
          <ReviewField label={F.howDidYouHear} value={d.howDidYouHear} />
          {d.additionalNotes && <div className="md:col-span-2"><ReviewField label={F.additionalNotes} value={d.additionalNotes} /></div>}
        </div>
      </ReviewSection>

      {/* Uploaded Documents */}
      {uploadedFiles.filter(f => f.file).length > 0 && (
        <ReviewSection title={t('applicants.form.step11.documentsSection')}>
          <div className="space-y-2">
            {uploadedFiles.filter(f => f.file).map(f => (
              <div key={f.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg border">
                <FileText className="w-4 h-4 text-blue-500 flex-shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-gray-900">{f.type || f.sectionKey || t('applicants.form.step11.documentDefault')}</p>
                  <p className="text-xs text-gray-500">{f.file!.name}</p>
                </div>
              </div>
            ))}
          </div>
        </ReviewSection>
      )}

      {/* Declaration */}
      <div className="p-5 bg-amber-50 border border-amber-200 rounded-xl space-y-5">
        <div>
          <h4 className="text-sm font-bold text-amber-900 mb-1">{t('applicants.form.step11.declarationTitle')}</h4>
          <p className="text-xs text-amber-700">{t('applicants.form.step11.declarationSubtitle')}</p>
        </div>
        {settings.declarationText && (
          <p className="text-sm text-amber-800 leading-relaxed border-s-4 border-amber-300 ps-3">{settings.declarationText}</p>
        )}
        <div className="space-y-3">
          {STATEMENTS.map(({ field, label }) => (
            <label key={field} className={`flex items-start gap-3 cursor-pointer p-3 rounded-lg border transition-colors ${d[field] ? 'bg-green-50 border-green-300' : 'bg-white border-amber-200 hover:border-amber-400'}`}>
              <Checkbox checked={d[field] as boolean} onCheckedChange={c => set(field)(!!c)} className="mt-0.5 shrink-0" />
              <span className="text-sm text-gray-800 leading-relaxed">{label}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export interface ApplicantFormStepsProps {
  currentStep: number;
  visibleTabs: number[];
  formData: ApplicantFormData;
  onChange: (updater: (prev: ApplicantFormData) => ApplicantFormData) => void;
  jobTypes?: JobType[];
  uploadedFiles?: UploadedFileItem[];
  onFilesChange?: (files: UploadedFileItem[]) => void;
  settings?: FormSettings;
  photoFile?: File | null;
  onPhotoChange?: (file: File | null) => void;
  existingPhotoUrl?: string;
  jobAdTitle?: string;
  requiredDocuments?: string[];
  /** Field-level errors keyed by form field name. Build this from
   *  getStepFieldErrors(currentStep, formData). */
  fieldErrors?: Record<string, string>;
}

export function ApplicantFormSteps({
  currentStep,
  visibleTabs,
  formData: d,
  onChange: u,
  jobTypes = [],
  uploadedFiles = [],
  onFilesChange = () => {},
  settings = DEFAULT_FORM_SETTINGS,
  photoFile = null,
  onPhotoChange = () => {},
  existingPhotoUrl,
  jobAdTitle,
  requiredDocuments = [],
  fieldErrors,
}: ApplicantFormStepsProps) {
  const actualTab = visibleTabs[currentStep - 1] ?? 1;

  return (
    <>
      {actualTab === 1 && <Step1Personal d={d} u={u} jobTypes={jobTypes} photoFile={photoFile} onPhotoChange={onPhotoChange} existingPhotoUrl={existingPhotoUrl} jobAdTitle={jobAdTitle} />}
      {actualTab === 2 && <Step2Contact d={d} u={u} settings={settings} />}
      {actualTab === 3 && <Step3Identification d={d} u={u} settings={settings} uploadedFiles={uploadedFiles} onFilesChange={onFilesChange} requiredDocuments={requiredDocuments} fieldErrors={fieldErrors} />}
      {actualTab === 4 && <Step4DrivingLicense d={d} u={u} settings={settings} uploadedFiles={uploadedFiles} onFilesChange={onFilesChange} requiredDocuments={requiredDocuments} fieldErrors={fieldErrors} />}
      {actualTab === 5 && <Step5DrivingExperience d={d} u={u} settings={settings} fieldErrors={fieldErrors} />}
      {actualTab === 6 && <Step6Education d={d} u={u} settings={settings} uploadedFiles={uploadedFiles} onFilesChange={onFilesChange} fieldErrors={fieldErrors} />}
      {actualTab === 7 && <Step7WorkHistory d={d} u={u} uploadedFiles={uploadedFiles} onFilesChange={onFilesChange} />}
      {actualTab === 8 && <Step8Skills d={d} u={u} settings={settings} uploadedFiles={uploadedFiles} onFilesChange={onFilesChange} fieldErrors={fieldErrors} />}
      {actualTab === 9 && <Step9Additional d={d} u={u} settings={settings} />}
      {actualTab === 10 && <Step10Documents uploadedFiles={uploadedFiles} onFilesChange={onFilesChange} requiredDocuments={requiredDocuments} />}
      {actualTab === 11 && <Step11Review d={d} u={u} settings={settings} photoFile={photoFile} existingPhotoUrl={existingPhotoUrl} uploadedFiles={uploadedFiles} />}
    </>
  );
}
