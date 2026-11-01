/** Centralised phone-code (dial code) list used by every phone input.
 *  Source: ITU-T E.164, with country labels and ISO 3166-1 alpha-2 codes
 *  so the UI can render a flag next to each option.
 *  Usage: import { PHONE_CODES } from '@/data/phoneCodes';
 */
export interface PhoneCode {
  label: string;  // Country name
  code:  string;  // Dial code including the leading '+'
  iso:   string;  // ISO 3166-1 alpha-2
}

export const PHONE_CODES: PhoneCode[] = [
  { label: 'Afghanistan', code: '+93', iso: 'AF' },
  { label: 'Albania', code: '+355', iso: 'AL' },
  { label: 'Algeria', code: '+213', iso: 'DZ' },
  { label: 'Andorra', code: '+376', iso: 'AD' },
  { label: 'Angola', code: '+244', iso: 'AO' },
  { label: 'Antigua and Barbuda', code: '+1', iso: 'AG' },
  { label: 'Argentina', code: '+54', iso: 'AR' },
  { label: 'Armenia', code: '+374', iso: 'AM' },
  { label: 'Australia', code: '+61', iso: 'AU' },
  { label: 'Austria', code: '+43', iso: 'AT' },
  { label: 'Azerbaijan', code: '+994', iso: 'AZ' },
  { label: 'Bahamas', code: '+1', iso: 'BS' },
  { label: 'Bahrain', code: '+973', iso: 'BH' },
  { label: 'Bangladesh', code: '+880', iso: 'BD' },
  { label: 'Barbados', code: '+1', iso: 'BB' },
  { label: 'Belarus', code: '+375', iso: 'BY' },
  { label: 'Belgium', code: '+32', iso: 'BE' },
  { label: 'Belize', code: '+501', iso: 'BZ' },
  { label: 'Benin', code: '+229', iso: 'BJ' },
  { label: 'Bhutan', code: '+975', iso: 'BT' },
  { label: 'Bolivia', code: '+591', iso: 'BO' },
  { label: 'Bosnia and Herzegovina', code: '+387', iso: 'BA' },
  { label: 'Botswana', code: '+267', iso: 'BW' },
  { label: 'Brazil', code: '+55', iso: 'BR' },
  { label: 'Brunei', code: '+673', iso: 'BN' },
  { label: 'Bulgaria', code: '+359', iso: 'BG' },
  { label: 'Burkina Faso', code: '+226', iso: 'BF' },
  { label: 'Burundi', code: '+257', iso: 'BI' },
  { label: 'Cambodia', code: '+855', iso: 'KH' },
  { label: 'Cameroon', code: '+237', iso: 'CM' },
  { label: 'Canada', code: '+1', iso: 'CA' },
  { label: 'Cape Verde', code: '+238', iso: 'CV' },
  { label: 'Central African Republic', code: '+236', iso: 'CF' },
  { label: 'Chad', code: '+235', iso: 'TD' },
  { label: 'Chile', code: '+56', iso: 'CL' },
  { label: 'China', code: '+86', iso: 'CN' },
  { label: 'Colombia', code: '+57', iso: 'CO' },
  { label: 'Comoros', code: '+269', iso: 'KM' },
  { label: 'Congo (DRC)', code: '+243', iso: 'CD' },
  { label: 'Congo (Republic)', code: '+242', iso: 'CG' },
  { label: 'Costa Rica', code: '+506', iso: 'CR' },
  { label: 'Croatia', code: '+385', iso: 'HR' },
  { label: 'Cuba', code: '+53', iso: 'CU' },
  { label: 'Cyprus', code: '+357', iso: 'CY' },
  { label: 'Czech Republic', code: '+420', iso: 'CZ' },
  { label: 'Denmark', code: '+45', iso: 'DK' },
  { label: 'Djibouti', code: '+253', iso: 'DJ' },
  { label: 'Dominica', code: '+1', iso: 'DM' },
  { label: 'Dominican Republic', code: '+1', iso: 'DO' },
  { label: 'Ecuador', code: '+593', iso: 'EC' },
  { label: 'Egypt', code: '+20', iso: 'EG' },
  { label: 'El Salvador', code: '+503', iso: 'SV' },
  { label: 'Equatorial Guinea', code: '+240', iso: 'GQ' },
  { label: 'Eritrea', code: '+291', iso: 'ER' },
  { label: 'Estonia', code: '+372', iso: 'EE' },
  { label: 'Eswatini', code: '+268', iso: 'SZ' },
  { label: 'Ethiopia', code: '+251', iso: 'ET' },
  { label: 'Fiji', code: '+679', iso: 'FJ' },
  { label: 'Finland', code: '+358', iso: 'FI' },
  { label: 'France', code: '+33', iso: 'FR' },
  { label: 'Gabon', code: '+241', iso: 'GA' },
  { label: 'Gambia', code: '+220', iso: 'GM' },
  { label: 'Georgia', code: '+995', iso: 'GE' },
  { label: 'Germany', code: '+49', iso: 'DE' },
  { label: 'Ghana', code: '+233', iso: 'GH' },
  { label: 'Greece', code: '+30', iso: 'GR' },
  { label: 'Grenada', code: '+1', iso: 'GD' },
  { label: 'Guatemala', code: '+502', iso: 'GT' },
  { label: 'Guinea', code: '+224', iso: 'GN' },
  { label: 'Guinea-Bissau', code: '+245', iso: 'GW' },
  { label: 'Guyana', code: '+592', iso: 'GY' },
  { label: 'Haiti', code: '+509', iso: 'HT' },
  { label: 'Honduras', code: '+504', iso: 'HN' },
  { label: 'Hungary', code: '+36', iso: 'HU' },
  { label: 'Iceland', code: '+354', iso: 'IS' },
  { label: 'India', code: '+91', iso: 'IN' },
  { label: 'Indonesia', code: '+62', iso: 'ID' },
  { label: 'Iran', code: '+98', iso: 'IR' },
  { label: 'Iraq', code: '+964', iso: 'IQ' },
  { label: 'Ireland', code: '+353', iso: 'IE' },
  { label: 'Israel', code: '+972', iso: 'IL' },
  { label: 'Italy', code: '+39', iso: 'IT' },
  { label: 'Jamaica', code: '+1', iso: 'JM' },
  { label: 'Japan', code: '+81', iso: 'JP' },
  { label: 'Jordan', code: '+962', iso: 'JO' },
  { label: 'Kazakhstan', code: '+7', iso: 'KZ' },
  { label: 'Kenya', code: '+254', iso: 'KE' },
  { label: 'Kiribati', code: '+686', iso: 'KI' },
  { label: 'Kosovo', code: '+383', iso: 'XK' },
  { label: 'Kuwait', code: '+965', iso: 'KW' },
  { label: 'Kyrgyzstan', code: '+996', iso: 'KG' },
  { label: 'Laos', code: '+856', iso: 'LA' },
  { label: 'Latvia', code: '+371', iso: 'LV' },
  { label: 'Lebanon', code: '+961', iso: 'LB' },
  { label: 'Lesotho', code: '+266', iso: 'LS' },
  { label: 'Liberia', code: '+231', iso: 'LR' },
  { label: 'Libya', code: '+218', iso: 'LY' },
  { label: 'Liechtenstein', code: '+423', iso: 'LI' },
  { label: 'Lithuania', code: '+370', iso: 'LT' },
  { label: 'Luxembourg', code: '+352', iso: 'LU' },
  { label: 'Madagascar', code: '+261', iso: 'MG' },
  { label: 'Malawi', code: '+265', iso: 'MW' },
  { label: 'Malaysia', code: '+60', iso: 'MY' },
  { label: 'Maldives', code: '+960', iso: 'MV' },
  { label: 'Mali', code: '+223', iso: 'ML' },
  { label: 'Malta', code: '+356', iso: 'MT' },
  { label: 'Marshall Islands', code: '+692', iso: 'MH' },
  { label: 'Mauritania', code: '+222', iso: 'MR' },
  { label: 'Mauritius', code: '+230', iso: 'MU' },
  { label: 'Mexico', code: '+52', iso: 'MX' },
  { label: 'Micronesia', code: '+691', iso: 'FM' },
  { label: 'Moldova', code: '+373', iso: 'MD' },
  { label: 'Monaco', code: '+377', iso: 'MC' },
  { label: 'Mongolia', code: '+976', iso: 'MN' },
  { label: 'Montenegro', code: '+382', iso: 'ME' },
  { label: 'Morocco', code: '+212', iso: 'MA' },
  { label: 'Mozambique', code: '+258', iso: 'MZ' },
  { label: 'Myanmar', code: '+95', iso: 'MM' },
  { label: 'Namibia', code: '+264', iso: 'NA' },
  { label: 'Nauru', code: '+674', iso: 'NR' },
  { label: 'Nepal', code: '+977', iso: 'NP' },
  { label: 'Netherlands', code: '+31', iso: 'NL' },
  { label: 'New Zealand', code: '+64', iso: 'NZ' },
  { label: 'Nicaragua', code: '+505', iso: 'NI' },
  { label: 'Niger', code: '+227', iso: 'NE' },
  { label: 'Nigeria', code: '+234', iso: 'NG' },
  { label: 'North Korea', code: '+850', iso: 'KP' },
  { label: 'North Macedonia', code: '+389', iso: 'MK' },
  { label: 'Norway', code: '+47', iso: 'NO' },
  { label: 'Oman', code: '+968', iso: 'OM' },
  { label: 'Pakistan', code: '+92', iso: 'PK' },
  { label: 'Palau', code: '+680', iso: 'PW' },
  { label: 'Palestine', code: '+970', iso: 'PS' },
  { label: 'Panama', code: '+507', iso: 'PA' },
  { label: 'Papua New Guinea', code: '+675', iso: 'PG' },
  { label: 'Paraguay', code: '+595', iso: 'PY' },
  { label: 'Peru', code: '+51', iso: 'PE' },
  { label: 'Philippines', code: '+63', iso: 'PH' },
  { label: 'Poland', code: '+48', iso: 'PL' },
  { label: 'Portugal', code: '+351', iso: 'PT' },
  { label: 'Qatar', code: '+974', iso: 'QA' },
  { label: 'Romania', code: '+40', iso: 'RO' },
  { label: 'Russia', code: '+7', iso: 'RU' },
  { label: 'Rwanda', code: '+250', iso: 'RW' },
  { label: 'Saint Kitts and Nevis', code: '+1', iso: 'KN' },
  { label: 'Saint Lucia', code: '+1', iso: 'LC' },
  { label: 'Saint Vincent', code: '+1', iso: 'VC' },
  { label: 'Samoa', code: '+685', iso: 'WS' },
  { label: 'San Marino', code: '+378', iso: 'SM' },
  { label: 'Saudi Arabia', code: '+966', iso: 'SA' },
  { label: 'Senegal', code: '+221', iso: 'SN' },
  { label: 'Serbia', code: '+381', iso: 'RS' },
  { label: 'Seychelles', code: '+248', iso: 'SC' },
  { label: 'Sierra Leone', code: '+232', iso: 'SL' },
  { label: 'Singapore', code: '+65', iso: 'SG' },
  { label: 'Slovakia', code: '+421', iso: 'SK' },
  { label: 'Slovenia', code: '+386', iso: 'SI' },
  { label: 'Solomon Islands', code: '+677', iso: 'SB' },
  { label: 'Somalia', code: '+252', iso: 'SO' },
  { label: 'South Africa', code: '+27', iso: 'ZA' },
  { label: 'South Korea', code: '+82', iso: 'KR' },
  { label: 'South Sudan', code: '+211', iso: 'SS' },
  { label: 'Spain', code: '+34', iso: 'ES' },
  { label: 'Sri Lanka', code: '+94', iso: 'LK' },
  { label: 'Sudan', code: '+249', iso: 'SD' },
  { label: 'Suriname', code: '+597', iso: 'SR' },
  { label: 'Sweden', code: '+46', iso: 'SE' },
  { label: 'Switzerland', code: '+41', iso: 'CH' },
  { label: 'Syria', code: '+963', iso: 'SY' },
  { label: 'Taiwan', code: '+886', iso: 'TW' },
  { label: 'Tajikistan', code: '+992', iso: 'TJ' },
  { label: 'Tanzania', code: '+255', iso: 'TZ' },
  { label: 'Thailand', code: '+66', iso: 'TH' },
  { label: 'Timor-Leste', code: '+670', iso: 'TL' },
  { label: 'Togo', code: '+228', iso: 'TG' },
  { label: 'Tonga', code: '+676', iso: 'TO' },
  { label: 'Trinidad and Tobago', code: '+1', iso: 'TT' },
  { label: 'Tunisia', code: '+216', iso: 'TN' },
  { label: 'Turkey', code: '+90', iso: 'TR' },
  { label: 'Turkmenistan', code: '+993', iso: 'TM' },
  { label: 'Tuvalu', code: '+688', iso: 'TV' },
  { label: 'Uganda', code: '+256', iso: 'UG' },
  { label: 'Ukraine', code: '+380', iso: 'UA' },
  { label: 'United Arab Emirates', code: '+971', iso: 'AE' },
  { label: 'United Kingdom', code: '+44', iso: 'GB' },
  { label: 'United States', code: '+1', iso: 'US' },
  { label: 'Uruguay', code: '+598', iso: 'UY' },
  { label: 'Uzbekistan', code: '+998', iso: 'UZ' },
  { label: 'Vanuatu', code: '+678', iso: 'VU' },
  { label: 'Venezuela', code: '+58', iso: 'VE' },
  { label: 'Vietnam', code: '+84', iso: 'VN' },
  { label: 'Yemen', code: '+967', iso: 'YE' },
  { label: 'Zambia', code: '+260', iso: 'ZM' },
  { label: 'Zimbabwe', code: '+263', iso: 'ZW' },
];

/** Pick the longest matching code from the start of a phone string. */
export function matchPhoneCode(phone: string | null | undefined): PhoneCode | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  if (!trimmed.startsWith('+')) return null;
  // Sort longest first so '+380' wins over '+38' etc.
  const sorted = [...PHONE_CODES].sort((a, b) => b.code.length - a.code.length);
  return sorted.find(c => trimmed.startsWith(c.code)) ?? null;
}

/** Split a phone string into dial code + rest. */
export function splitPhone(phone: string | null | undefined): { code: string; number: string } {
  // Normalize first so a stored duplicate like "+90 +905394308925"
  // splits cleanly to { code: '+90', number: '5394308925' } instead of
  // leaving "+905394308925" in the national field (which would re-join
  // into another duplicate on the next save).
  const e164 = toE164(phone);
  const source = e164 || (phone ?? '').trim();
  const match = matchPhoneCode(source);
  if (!match) return { code: '', number: source };
  const rest = source.slice(match.code.length).trim();
  return { code: match.code, number: rest };
}

/**
 * Normalize any phone input to canonical E.164 (`+<digits>`), collapsing
 * duplicated country codes. Handles the real-world messes we've seen:
 *   "+90 +905394308925"  → "+905394308925"
 *   "+49 +49123456789"   → "+49123456789"
 *   "+90 539 430 89 25"  → "+905394308925"
 *   "00905394308925"     → "+905394308925"
 *   "5394308925" + code  → "+905394308925"  (via fallbackCode)
 * Returns '' when there's nothing usable. Never throws.
 */
export function toE164(
  raw: string | null | undefined,
  fallbackCode?: string | null,
): string {
  if (!raw) return '';
  let s = String(raw).trim();
  if (!s) return '';
  // International access prefix 00 → +
  s = s.replace(/^00/, '+');
  // Strip everything except digits and '+'
  s = s.replace(/[^\d+]/g, '');
  if (!s) return '';
  // Collapse a duplicated leading dial code: when a second '+' appears,
  // the trailing segment is itself a full international number — prefer
  // it if it parses to a known code, otherwise treat the head as the
  // code and drop the stray '+'.
  let guard = 0;
  let plusIdx = s.indexOf('+', 1);
  while (plusIdx !== -1 && guard++ < 5) {
    const head = s.slice(0, plusIdx);
    const tail = s.slice(plusIdx);
    s = matchPhoneCode(tail) ? tail : head + tail.replace(/\+/g, '');
    plusIdx = s.indexOf('+', 1);
  }
  if (!s.startsWith('+')) {
    const fb = (fallbackCode ?? '').replace(/[^\d+]/g, '');
    if (fb.startsWith('+')) return `${fb}${s}`;
    return s; // no code resolvable — leave the bare digits
  }
  return s;
}

/**
 * Join a separate dial-code selector value and a national-number input
 * into one canonical string, refusing to duplicate the code if the user
 * pasted a full international number into the national field.
 *   joinPhone('+90', '5394308925')      → '+90 5394308925'
 *   joinPhone('+90', '+905394308925')   → '+90 5394308925'
 *   joinPhone('+90', '')                → '' (no number yet)
 */
export function joinPhone(code: string | null | undefined, national: string | null | undefined): string {
  const c = (code ?? '').trim();
  const n = (national ?? '').trim();
  if (!n) return '';
  // If the national part itself carries a code, normalize the whole
  // thing and re-split so we never emit "+90 +90…".
  if (n.includes('+') || /^00/.test(n)) {
    const e164 = toE164(n, c);
    const sp = splitPhone(e164);
    if (sp.code) return `${sp.code} ${sp.number}`.trim();
    return e164;
  }
  return c ? `${c} ${n}`.trim() : n;
}

/**
 * Human-readable display: `+90 539 430 89 25`. Always dedupes first, so
 * a stored "+90 +905394308925" still renders cleanly. National digits
 * are grouped in threes (a trailing 1-digit group is merged into the
 * previous so we never show a lone digit). Returns '' for empty input,
 * or the raw trimmed string when no code can be resolved.
 */
export function formatPhoneDisplay(raw: string | null | undefined): string {
  if (!raw) return '';
  const e164 = toE164(raw);
  if (!e164) return String(raw).trim();
  const m = matchPhoneCode(e164);
  if (!m) return e164;
  const national = e164.slice(m.code.length);
  if (!national) return m.code;
  const groups: string[] = [];
  for (let i = 0; i < national.length; i += 3) groups.push(national.slice(i, i + 3));
  if (groups.length > 1 && groups[groups.length - 1].length === 1) {
    groups[groups.length - 2] += groups.pop();
  }
  return `${m.code} ${groups.join(' ')}`;
}

