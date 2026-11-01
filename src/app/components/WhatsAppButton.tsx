/**
 * WhatsApp contact action.
 * Thin anchor that opens a wa.me deep link in a new tab — works on
 * desktop (WhatsApp Web) and mobile (native app). Renders disabled
 * with a tooltip when the phone number can't be normalised.
 */
import { Button } from './ui/button';
import { buildWhatsAppUrl } from '../utils/whatsapp';

/** Official WhatsApp brand glyph (Simple Icons / brand resources).
 *  Kept inline so we don't pull a dependency for one icon. */
function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.58-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893A11.821 11.821 0 0 0 20.885 3.488" />
    </svg>
  );
}

type Size = 'sm' | 'icon';

interface Props {
  phone?: string | null;
  defaultCountryCode?: string | null;
  message?: string;
  /** Optional display label — e.g. "WhatsApp". When omitted only the icon is shown. */
  label?: string;
  size?: Size;
  className?: string;
}

export function WhatsAppButton({ phone, defaultCountryCode, message, label, size = 'sm', className }: Props) {
  const href = buildWhatsAppUrl(phone, { defaultCountryCode, message });
  const disabled = !href;
  const title = disabled
    ? 'No valid WhatsApp number available'
    : `Open WhatsApp chat${phone ? ` with ${phone}` : ''}`;

  // Icon-only variant: render a plain anchor with explicit 44×44
  // dimensions so the WhatsApp glyph sits visibly bigger than the
  // adjacent View/Edit Button shells (which are 32px). Bypasses the
  // shared Button sizing so the icon can't be clipped by inherited
  // padding/height rules.
  if (size === 'icon') {
    const shared =
      'inline-flex items-center justify-center w-11 h-11 rounded-md transition-colors';
    if (disabled) {
      return (
        <span
          className={`${shared} text-muted-foreground opacity-50 cursor-not-allowed ${className ?? ''}`}
          title={title}
          aria-label={title}
        >
          <WhatsAppIcon className="w-8 h-8" />
        </span>
      );
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        title={title}
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className={`${shared} text-[#25D366] hover:text-[#1ebc59] hover:bg-[#25D366]/10 ${className ?? ''}`}
      >
        <WhatsAppIcon className="w-8 h-8" />
      </a>
    );
  }

  const base = (
    <>
      <WhatsAppIcon className="w-5 h-5 me-1.5" />
      {label ? <span>{label}</span> : null}
    </>
  );

  if (disabled) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={`text-muted-foreground ${className ?? ''}`}
        title={title}
        aria-label={title}
        disabled
      >
        {base}
      </Button>
    );
  }

  // Wrap an anchor so clicks use the native browser URL handler —
  // mobile will hand off to the WhatsApp app via the wa.me scheme.
  return (
    <Button
      type="button"
      asChild
      variant="ghost"
      size="sm"
      className={`text-[#25D366] hover:text-[#1ebc59] hover:bg-[#25D366]/10 ${className ?? ''}`}
      title={title}
    >
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        {base}
      </a>
    </Button>
  );
}
