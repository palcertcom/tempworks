import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as https from 'https';
import { tEmail, interpolate, type EmailLocale } from './email-i18n';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly apiKey: string;
  private readonly from: string;
  private readonly frontendUrl: string;

  constructor(private config: ConfigService) {
    this.apiKey = this.config.get<string>('RESEND_API_KEY', '') || process.env.RESEND_API_KEY || '';
    this.from = this.config.get<string>('SMTP_FROM', 'TempWorks <onboarding@resend.dev>') || process.env.SMTP_FROM || 'TempWorks <onboarding@resend.dev>';
    this.frontendUrl = this.config.get<string>('FRONTEND_URL', 'http://localhost:5173') || process.env.FRONTEND_URL || 'http://localhost:5173';

    if (this.apiKey) {
      this.logger.log(`Email service ready (Resend API). Key: ${this.apiKey.substring(0, 8)}... FROM: ${this.from}`);
    } else {
      this.logger.error(
        'RESEND_API_KEY not found in environment! ' +
        `ConfigService returned: "${this.config.get('RESEND_API_KEY')}" | process.env: "${process.env.RESEND_API_KEY}". ` +
        'Emails will NOT be sent. Restart the backend after fixing .env',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Public send methods
  // ---------------------------------------------------------------------------

  async sendActivationEmail(to: string, name: string, token: string, frontendUrl?: string, locale?: EmailLocale): Promise<void> {
    const url = `${frontendUrl ?? this.frontendUrl}/activate?token=${token}`;
    const t = tEmail(locale, 'activation');
    await this.sendMail(to, interpolate(t.subject, { name }), this.buildActivationTemplate(name, url, locale));
  }

  async sendPasswordResetEmail(to: string, name: string, token: string, frontendUrl?: string, isAdminInitiated = false, locale?: EmailLocale): Promise<void> {
    const url = `${frontendUrl ?? this.frontendUrl}/reset-password?token=${token}`;
    const t = tEmail(locale, isAdminInitiated ? 'passwordResetAdmin' : 'passwordReset');
    await this.sendMail(to, interpolate(t.subject, { name }), this.buildPasswordResetTemplate(name, url, isAdminInitiated, locale));
  }

  async sendTwoFactorCode(
    to: string,
    name: string,
    code: string,
    expiresInMinutes = 10,
    context: { ipAddress?: string } = {},
    locale?: EmailLocale,
  ): Promise<void> {
    const t = tEmail(locale, 'twoFactor');
    await this.sendMail(
      to,
      interpolate(t.subject, { name }),
      this.buildTwoFactorTemplate(name, code, expiresInMinutes, context, locale),
    );
  }

  async sendPasswordChangedConfirmation(
    to: string,
    name: string,
    context: { changedAt?: Date; ipAddress?: string; initiator?: 'self' | 'reset' | 'admin' } = {},
    frontendUrl?: string,
    locale?: EmailLocale,
  ): Promise<void> {
    const loginUrl = `${frontendUrl ?? this.frontendUrl}/login`;
    const t = tEmail(locale, 'passwordChanged');
    await this.sendMail(
      to,
      interpolate(t.subject, { name }),
      this.buildPasswordChangedTemplate(name, loginUrl, context, locale),
    );
  }

  async sendPasswordExpiredNotification(to: string, name: string, frontendUrl?: string, locale?: EmailLocale): Promise<void> {
    const url = `${frontendUrl ?? this.frontendUrl}/login`;
    const t = tEmail(locale, 'passwordExpired');
    await this.sendMail(to, interpolate(t.subject, { name }), this.buildPasswordExpiredTemplate(name, url, locale));
  }

  async sendAccountLockedEmail(to: string, name: string, locale?: EmailLocale): Promise<void> {
    const t = tEmail(locale, 'accountLocked');
    await this.sendMail(to, interpolate(t.subject, { name }), this.buildAccountLockedTemplate(name, locale));
  }

  async sendWelcomeEmail(to: string, name: string, locale?: EmailLocale): Promise<void> {
    const t = tEmail(locale, 'welcome');
    await this.sendMail(to, interpolate(t.subject, { name }), this.buildWelcomeTemplate(name, locale));
  }

  async sendApplicationConfirmation(to: string, name: string, reference: string, appData: Record<string, any>, locale?: EmailLocale): Promise<void> {
    const t = tEmail(locale, 'applicationConfirmation');
    await this.sendMail(to, interpolate(t.subject, { name, reference }), this.buildApplicationConfirmationTemplate(name, reference, appData, locale));
  }

  async sendNotificationEmail(
    to: string,
    name: string,
    title: string,
    message: string,
    eventType?: string,
    locale?: EmailLocale,
    context?: {
      relatedEntity?: string | null;
      relatedEntityId?: string | null;
      params?: Record<string, any> | null;
    },
  ): Promise<void> {
    await this.sendMail(to, title, this.buildNotificationTemplate(name, title, message, eventType, locale, context));
  }

  /**
   * Derive deep-link buttons from a notification's related entity +
   * params. Generic across every event type: a person (employee /
   * applicant / candidate) → their profile; a documentId in params →
   * the document. Returns absolute URLs so any email client can click
   * through. Empty when there is nothing linkable.
   */
  private notificationLinks(context?: {
    relatedEntity?: string | null;
    relatedEntityId?: string | null;
    params?: Record<string, any> | null;
  }): Array<{ label: string; href: string }> {
    if (!context) return [];
    const origin = this.frontendUrl.replace(/\/+$/, '');
    const p = context.params ?? {};
    const links: Array<{ label: string; href: string }> = [];

    // Person profile — from relatedEntity/relatedEntityId, falling back
    // to params.entityType/entityId (document events stamp the person
    // there).
    const personType = (context.relatedEntity || p.entityType || '').toString().toUpperCase();
    const personId = context.relatedEntityId || p.entityId || null;
    const personName = (typeof p.entityName === 'string' && p.entityName.trim())
      ? p.entityName.trim()
      : (typeof p.personName === 'string' && p.personName.trim() ? p.personName.trim() : null);
    if (personId) {
      if (personType === 'EMPLOYEE') {
        links.push({ label: personName ? `View ${personName}` : 'View employee profile', href: `${origin}/dashboard/employees/${personId}` });
      } else if (personType === 'APPLICANT' || personType === 'CANDIDATE') {
        links.push({ label: personName ? `View ${personName}` : 'View candidate profile', href: `${origin}/dashboard/applicants/${personId}` });
      }
    }

    // Document — from params.documentId.
    if (p.documentId) {
      const docName = typeof p.documentName === 'string' && p.documentName.trim() ? p.documentName.trim() : null;
      links.push({ label: docName ? `Open “${docName}”` : 'Open document', href: `${origin}/dashboard/documents/${p.documentId}` });
    }

    return links;
  }

  /**
   * Daily document-compliance digest. One email per recipient with
   * a table of every un-digested document-related notification —
   * replaces the per-row "Document Expired" / "Expiring Soon" emails
   * the worker used to send every 60s on the 6h cron's heels.
   *
   * `tenantLabel` is the recipient's home tenant name; the
   * cron only includes rows already scoped to that tenant via
   * the upstream notification fanout, so this is purely for
   * subject-line clarity.
   */
  async sendDocumentDigestEmail(
    to: string,
    name: string,
    rows: Array<{
      documentName: string;
      documentType: string;
      personName: string;
      personType: 'Employee' | 'Applicant' | 'Other';
      reason: string;
      expiryDate: string | null;
      tenantLabel?: string | null;
      agencyLabel?: string | null;
      documentPath?: string | null;
      personPath?: string | null;
    }>,
    tenantLabel?: string | null,
    locale?: EmailLocale,
  ): Promise<void> {
    if (!rows.length) return;
    const subject = tenantLabel
      ? `Daily Document Notifications Summary — ${tenantLabel}`
      : 'Daily Document Notifications Summary';
    await this.sendMail(to, subject, this.buildDocumentDigestTemplate(name, rows, locale));
  }

  // ---------------------------------------------------------------------------
  // Core send — calls Resend REST API directly (no SDK, no SMTP)
  // ---------------------------------------------------------------------------

  private sendMail(to: string, subject: string, html: string): Promise<void> {
    if (!this.apiKey) {
      const preview = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 500);
      this.logger.log(`[EMAIL FALLBACK] To: ${to} | Subject: ${subject}\nPreview: ${preview}`);
      return Promise.resolve();
    }

    const payload = JSON.stringify({ from: this.from, to, subject, html });

    return new Promise((resolve) => {
      const req = https.request(
        {
          hostname: 'api.resend.com',
          path: '/emails',
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            if (res.statusCode && res.statusCode < 300) {
              try {
                const parsed = JSON.parse(body);
                this.logger.log(`Email sent to ${to} | id: ${parsed?.id ?? 'n/a'}`);
              } catch {
                this.logger.log(`Email sent to ${to}`);
              }
            } else {
              this.logger.error(`Resend API error ${res.statusCode} for ${to}: ${body}`);
            }
            resolve();
          });
        },
      );

      req.on('error', (err) => {
        this.logger.error(`Failed to send email to ${to}: ${err.message}`);
        resolve(); // Graceful — never let email failure break main flow
      });

      req.write(payload);
      req.end();
    });
  }

  // ---------------------------------------------------------------------------
  // HTML Templates
  // ---------------------------------------------------------------------------

  private baseTemplate(title: string, body: string, locale?: EmailLocale, maxWidth = 600): string {
    const lc = locale ?? 'en';
    const dir = lc === 'ar' ? 'rtl' : 'ltr';
    return `<!DOCTYPE html>
<html lang="${lc}" dir="${dir}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:Arial,sans-serif;color:#333;">
  <div style="max-width:${maxWidth}px;margin:40px auto;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
    <div style="background:#1a56db;padding:24px 32px;">
      <h1 style="margin:0;color:#ffffff;font-size:22px;">TempWorks</h1>
    </div>
    <div style="padding:32px;line-height:1.6;">${body}</div>
    <div style="background:#f4f6f9;padding:20px 32px;font-size:12px;color:#666;text-align:center;">
      &copy; ${new Date().getFullYear()} TempWorks
    </div>
  </div>
</body>
</html>`;
  }

  private btn(text: string, url: string): string {
    return `<a href="${url}" style="display:inline-block;margin:16px 0;padding:12px 28px;background:#1a56db;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:bold;font-size:15px;">${text}</a>`;
  }

  private notice(text: string): string {
    return `<p style="background:#fff8e1;border-left:4px solid #f59e0b;padding:12px 16px;margin:16px 0;border-radius:4px;font-size:13px;">${text}</p>`;
  }

  private buildActivationTemplate(name: string, url: string, locale?: EmailLocale): string {
    const t = tEmail(locale, 'activation');
    return this.baseTemplate(t.heading ?? 'Activate Your Account', `
      <p style="margin:0 0 16px;">${interpolate(t.greeting ?? 'Hi {{name}},', { name: `<strong>${this.escape(name)}</strong>` })}</p>
      <p style="margin:0 0 16px;">${t.intro ?? ''}</p>
      ${this.btn(t.buttonLabel ?? 'Activate Account', url)}
      <p style="margin:16px 0 8px;">${t.fallbackLinkLabel ?? ''}</p>
      <p style="word-break:break-all;font-size:13px;"><a href="${url}" style="color:#1a56db;">${url}</a></p>
      <p style="margin:16px 0 0;color:#6b7280;font-size:13px;">${t.outro ?? ''}</p>
      <p style="margin:24px 0 0;color:#6b7280;font-size:13px;">${t.signoff ?? ''}</p>
    `, locale);
  }

  private buildPasswordResetTemplate(name: string, url: string, isAdminInitiated: boolean, locale?: EmailLocale): string {
    const t = tEmail(locale, isAdminInitiated ? 'passwordResetAdmin' : 'passwordReset');
    return this.baseTemplate(t.heading ?? 'Reset Your Password', `
      <p style="margin:0 0 16px;">${interpolate(t.greeting ?? 'Hi {{name}},', { name: `<strong>${this.escape(name)}</strong>` })}</p>
      <p style="margin:0 0 16px;">${t.intro ?? ''}</p>
      ${this.btn(t.buttonLabel ?? 'Reset Password', url)}
      <p style="margin:16px 0 8px;">${t.fallbackLinkLabel ?? ''}</p>
      <p style="word-break:break-all;font-size:13px;"><a href="${url}" style="color:#1a56db;">${url}</a></p>
      <p style="margin:16px 0 0;color:#6b7280;font-size:13px;">${t.outro ?? ''}</p>
      <p style="margin:24px 0 0;color:#6b7280;font-size:13px;">${t.signoff ?? ''}</p>
    `, locale);
  }

  private buildTwoFactorTemplate(
    name: string,
    code: string,
    expiresInMinutes: number,
    context: { ipAddress?: string },
    locale?: EmailLocale,
  ): string {
    const t = tEmail(locale, 'twoFactor');
    const ip = context.ipAddress ? this.escape(context.ipAddress) : 'Unknown';
    return this.baseTemplate(t.heading ?? 'Verification Code', `
      <p style="margin:0 0 16px;">${interpolate(t.greeting ?? 'Hi {{name}},', { name: `<strong>${this.escape(name)}</strong>` })}</p>
      <p style="margin:0 0 16px;">${interpolate(t.intro ?? '', { minutes: expiresInMinutes })}</p>
      <div style="margin:20px 0;padding:18px 24px;background:#f0f5ff;border:1px solid #c7d7ff;border-radius:8px;text-align:center;">
        <div style="font-family:Consolas,Menlo,monospace;font-size:32px;letter-spacing:10px;color:#1a56db;font-weight:700;">${this.escape(code)}</div>
      </div>
      <p style="margin:8px 0 0;color:#6b7280;font-size:13px;">IP: ${ip}</p>
      <p style="margin:16px 0 0;color:#6b7280;font-size:13px;">${t.outro ?? ''}</p>
      <p style="margin:24px 0 0;color:#6b7280;font-size:13px;">${t.signoff ?? ''}</p>
    `, locale);
  }

  private buildPasswordChangedTemplate(
    name: string,
    loginUrl: string,
    context: { changedAt?: Date; ipAddress?: string; initiator?: 'self' | 'reset' | 'admin' },
    locale?: EmailLocale,
  ): string {
    const t = tEmail(locale, 'passwordChanged');
    const when = (context.changedAt ?? new Date()).toUTCString();
    const ip = context.ipAddress ? this.escape(context.ipAddress) : 'Unknown';
    return this.baseTemplate(t.heading ?? 'Password Changed', `
      <p style="margin:0 0 16px;">${interpolate(t.greeting ?? 'Hi {{name}},', { name: `<strong>${this.escape(name)}</strong>` })}</p>
      <p style="margin:0 0 16px;">${t.intro ?? ''}</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;">
        <tr><td style="padding:6px 12px;color:#6b7280;white-space:nowrap;">${when}</td></tr>
        <tr><td style="padding:6px 12px;color:#6b7280;white-space:nowrap;">IP: ${ip}</td></tr>
      </table>
      ${this.btn(t.buttonLabel ?? 'Sign in', loginUrl)}
      <p style="margin:16px 0 0;color:#6b7280;font-size:13px;">${t.outro ?? ''}</p>
      <p style="margin:24px 0 0;color:#6b7280;font-size:13px;">${t.signoff ?? ''}</p>
    `, locale);
  }

  private buildPasswordExpiredTemplate(name: string, url: string, locale?: EmailLocale): string {
    const t = tEmail(locale, 'passwordExpired');
    return this.baseTemplate(t.heading ?? 'Password Expired', `
      <p style="margin:0 0 16px;">${interpolate(t.greeting ?? 'Hi {{name}},', { name: `<strong>${this.escape(name)}</strong>` })}</p>
      <p style="margin:0 0 16px;">${t.intro ?? ''}</p>
      ${this.btn(t.buttonLabel ?? 'Sign in', url)}
      <p style="margin:24px 0 0;color:#6b7280;font-size:13px;">${t.signoff ?? ''}</p>
    `, locale);
  }

  private buildAccountLockedTemplate(name: string, locale?: EmailLocale): string {
    const t = tEmail(locale, 'accountLocked');
    return this.baseTemplate(t.heading ?? 'Account Locked', `
      <p style="margin:0 0 16px;">${interpolate(t.greeting ?? 'Hi {{name}},', { name: `<strong>${this.escape(name)}</strong>` })}</p>
      <p style="margin:0 0 16px;">${t.intro ?? ''}</p>
      <p style="margin:16px 0 0;color:#6b7280;font-size:13px;">${t.outro ?? ''}</p>
      <p style="margin:24px 0 0;color:#6b7280;font-size:13px;">${t.signoff ?? ''}</p>
    `, locale);
  }

  private buildWelcomeTemplate(name: string, locale?: EmailLocale): string {
    const t = tEmail(locale, 'welcome');
    return this.baseTemplate(t.heading ?? 'Welcome', `
      <p>${interpolate(t.greeting ?? 'Hi {{name}},', { name: `<strong>${this.escape(name)}</strong>` })}</p>
      <p>${t.intro ?? ''}</p>
      <p style="margin:24px 0 0;color:#6b7280;font-size:13px;">${t.signoff ?? ''}</p>
    `, locale);
  }

  /**
   * HTML table for the daily document digest. Plain inline styles so
   * any email client renders consistently. The Reason column reads
   * from the row data, so a future "Missing document" event simply
   * needs the digest cron to set `reason: 'Missing document'`.
   */
  private buildDocumentDigestTemplate(
    name: string,
    rows: Array<{
      documentName: string;
      documentType: string;
      personName: string;
      personType: string;
      reason: string;
      expiryDate: string | null;
      tenantLabel?: string | null;
      agencyLabel?: string | null;
      documentPath?: string | null;
      personPath?: string | null;
    }>,
    locale?: EmailLocale,
  ): string {
    const showContext = rows.some(r => r.tenantLabel || r.agencyLabel);
    const th = (label: string) =>
      `<th style="text-align:left;padding:8px 10px;background:#f1f5f9;border-bottom:2px solid #cbd5e1;font-size:12px;color:#475569;text-transform:uppercase;letter-spacing:.04em;">${label}</th>`;
    const td = (value: string, opts: { muted?: boolean } = {}) =>
      `<td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:13px;color:${opts.muted ? '#64748b' : '#0f172a'};">${value}</td>`;
    // Turn a label into a deep link to the SPA when a path is given.
    // Relative paths are prefixed with the configured frontend origin so
    // the recipient lands on the document / profile with one click.
    const link = (label: string, path?: string | null) => {
      const text = this.escape(label || '—');
      if (!path) return text;
      const href = `${this.frontendUrl.replace(/\/+$/, '')}${path}`;
      return `<a href="${href}" style="color:#1a56db;text-decoration:underline;">${text}</a>`;
    };
    const reasonBadge = (reason: string) => {
      const tone =
        /expired/i.test(reason) ? { bg: '#fee2e2', fg: '#991b1b' } :
        /expiring/i.test(reason) ? { bg: '#fef3c7', fg: '#92400e' } :
        /missing|reject/i.test(reason) ? { bg: '#fee2e2', fg: '#991b1b' } :
        { bg: '#e0e7ff', fg: '#3730a3' };
      return `<span style="display:inline-block;padding:2px 8px;border-radius:9999px;background:${tone.bg};color:${tone.fg};font-size:12px;font-weight:600;">${this.escape(reason)}</span>`;
    };
    const body = `
      <p>${interpolate('Hi {{name}},', { name: `<strong>${this.escape(name)}</strong>` })}</p>
      <p>Please find below the daily summary of document notifications.</p>
      <table style="width:100%;border-collapse:collapse;margin:20px 0;border:1px solid #e2e8f0;border-radius:6px;overflow:hidden;">
        <thead><tr>
          ${th('Document Name')}
          ${th('Document Type')}
          ${th('Candidate/Employee')}
          ${th('Type')}
          ${th('Reason')}
          ${th('Expiry Date')}
          ${showContext ? th('Tenant / Agency') : ''}
        </tr></thead>
        <tbody>
          ${rows.map(r => `<tr>
            ${td(link(r.documentName || '—', r.documentPath))}
            ${td(this.escape(r.documentType || '—'))}
            ${td(link(r.personName || '—', r.personPath))}
            ${td(this.escape(r.personType || '—'), { muted: true })}
            ${td(reasonBadge(r.reason))}
            ${td(r.expiryDate ? this.escape(r.expiryDate) : '—', { muted: true })}
            ${showContext ? td(this.escape([r.tenantLabel, r.agencyLabel].filter(Boolean).join(' / ') || '—'), { muted: true }) : ''}
          </tr>`).join('')}
        </tbody>
      </table>
      <p style="margin:16px 0;color:#475569;font-size:13px;">
        Total entries: <strong>${rows.length}</strong>. Sign in to TempWorks to act on any of the items above.
      </p>
      <p style="margin:24px 0 0;color:#6b7280;font-size:13px;">Kind regards,<br/>The TempWorks Team</p>
    `;
    // Wider container than the default 600px so the 6-7 column table
    // has room to breathe and document/person names don't wrap.
    return this.baseTemplate('Daily Document Notifications Summary', body, locale, 900);
  }

  private buildNotificationTemplate(
    name: string, title: string, message: string, eventType?: string, locale?: EmailLocale,
    context?: { relatedEntity?: string | null; relatedEntityId?: string | null; params?: Record<string, any> | null },
  ): string {
    const iconMap: Record<string, string> = {
      DOCUMENT_EXPIRING_SOON:   '⚠️',
      DOCUMENT_EXPIRED:         '🔴',
      DOCUMENT_UPLOADED:        '📄',
      FINANCIAL_RECORD_CREATED: '💰',
      FINANCIAL_RECORD_UPDATED: '✏️',
      FINANCIAL_RECORD_DELETED: '🗑️',
      FINANCIAL_RECORD_DEDUCTED:'💸',
      FINANCIAL_HIGH_BALANCE:   '⚡',
    };
    const icon = eventType ? (iconMap[eventType] ?? '🔔') : '🔔';
    const t = tEmail(locale, 'notification');

    // Quick-links block: clickable buttons to the referenced profile /
    // document so the recipient reaches the record in one click.
    const links = this.notificationLinks(context);
    const linksHtml = links.length
      ? `<div style="margin:18px 0 4px;">${links.map(l =>
          `<a href="${l.href}" style="display:inline-block;margin:0 8px 8px 0;padding:9px 16px;background:#eef2ff;color:#1a56db;text-decoration:none;border-radius:6px;font-size:13px;font-weight:600;border:1px solid #dbe4ff;">${this.escape(l.label)} →</a>`,
        ).join('')}</div>`
      : '';

    return this.baseTemplate(title, `
      <p>${interpolate(t.greeting ?? 'Hi {{name}},', { name: `<strong>${this.escape(name)}</strong>` })}</p>
      <p style="font-size:28px;margin:0 0 16px;">${icon}</p>
      <p><strong>${this.escape(title)}</strong></p>
      <p>${this.escape(message)}</p>
      ${linksHtml}
      <p style="margin:24px 0 0;color:#6b7280;font-size:13px;">${t.signoff ?? ''}</p>
    `, locale);
  }

  private buildApplicationConfirmationTemplate(name: string, reference: string, d: Record<string, any>, locale?: EmailLocale): string {
    const row = (label: string, value: string | undefined | null) =>
      value ? `<tr><td style="padding:6px 12px;color:#6b7280;font-size:13px;white-space:nowrap;vertical-align:top;">${this.escape(label)}</td><td style="padding:6px 12px;font-size:13px;color:#111827;">${this.escape(String(value))}</td></tr>` : '';

    const section = (title: string, rows: string) =>
      rows.trim() ? `<h3 style="margin:24px 0 6px;font-size:14px;color:#1a56db;border-bottom:1px solid #e5e7eb;padding-bottom:4px;">${title}</h3><table style="width:100%;border-collapse:collapse;">${rows}</table>` : '';

    const personal = section('Personal Information', [
      row('Full Name', [d.firstName, d.middleName, d.lastName].filter(Boolean).join(' ')),
      row('Date of Birth', d.dateOfBirth),
      row('Gender', d.gender),
      row('Citizenship', d.citizenship),
      row('Country of Birth', d.countryOfBirth),
    ].join(''));

    const contact = section('Contact', [
      row('Email', d.email),
      row('Phone', d.phone ? `${d.phoneCode || ''} ${d.phone}`.trim() : undefined),
      row('Address', [d.address?.street, d.address?.city, d.address?.country].filter(Boolean).join(', ')),
    ].join(''));

    const driving = d.hasDrivingLicense === 'yes' ? section('Driving License', [
      row('License Number', d.licenseNumber),
      row('Categories', Array.isArray(d.licenseCategories) ? d.licenseCategories.join(', ') : d.licenseCategories),
      row('Issuing Country', d.licenseCountry),
      row('Experience Type', d.drivingExpType),
    ].join('')) : '';

    const edu = Array.isArray(d.education) && d.education.length
      ? section('Education', d.education.map((e: any) => row(e.level || 'Degree', [e.institution, e.country].filter(Boolean).join(' – '))).join(''))
      : '';

    const work = Array.isArray(d.workHistory) && d.workHistory.length
      ? section('Work Experience', d.workHistory.map((w: any) => row(w.jobTitle || 'Position', [w.company, w.country].filter(Boolean).join(' – '))).join(''))
      : '';

    const langs = Array.isArray(d.languages) && d.languages.length
      ? section('Languages', d.languages.map((l: any) => row(l.language, l.motherTongue ? 'Mother Tongue' : [l.speakingLevel, l.readingLevel].filter(Boolean).join(' / '))).join(''))
      : '';

    const skills = Array.isArray(d.skills) && d.skills.length
      ? section('Skills', d.skills.map((s: any) => row(s.skill, s.level || '—')).join(''))
      : '';

    const additional = section('Additional', [
      row('Preferred Start Date', d.preferredStartDate),
      row('Annual Salary Expectation (EUR)', d.salaryExpectation),
      row('Willing to Relocate', d.willingToRelocate ? 'Yes' : 'No'),
    ].join(''));

    const t = tEmail(locale, 'applicationConfirmation');
    return this.baseTemplate(t.heading ?? 'Application Received', `
      <p>${interpolate(t.greeting ?? 'Hi {{name}},', { name: `<strong>${this.escape(name)}</strong>` })}</p>
      <p>${interpolate(t.intro ?? '', { reference: this.escape(reference) })}</p>
      <div style="background:#f0f9ff;border-left:4px solid #1a56db;padding:12px 16px;border-radius:4px;margin:16px 0;">
        <p style="margin:0;font-size:13px;color:#1e40af;"><strong style="font-size:16px;">${this.escape(reference)}</strong></p>
      </div>
      ${personal}${contact}${driving}${edu}${work}${langs}${skills}${additional}
      <p style="margin:16px 0 0;color:#6b7280;font-size:13px;">${t.outro ?? ''}</p>
      <p style="margin:24px 0 0;color:#6b7280;font-size:13px;">${t.signoff ?? ''}</p>
    `, locale);
  }

  private escape(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
