import { useEffect, useRef } from 'react';

declare global {
  interface Window {
    grecaptcha: any;
    onRecaptchaLoad?: () => void;
  }
}

interface ReCaptchaV2Props {
  siteKey: string;
  onVerify: (token: string) => void;
  onExpired?: () => void;
}

const SCRIPT_ID = 'google-recaptcha-v2-script';

function ensureScript(onLoad: () => void) {
  if (window.grecaptcha?.render) {
    // Already fully loaded
    onLoad();
    return;
  }

  // Queue or replace callback
  const prev = window.onRecaptchaLoad;
  window.onRecaptchaLoad = () => {
    if (prev) prev();
    onLoad();
  };

  if (!document.getElementById(SCRIPT_ID)) {
    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = 'https://www.google.com/recaptcha/api.js?onload=onRecaptchaLoad&render=explicit';
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);
  }
}

export function ReCaptchaV2({ siteKey, onVerify, onExpired }: ReCaptchaV2Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    const render = () => {
      if (cancelled || !containerRef.current || widgetIdRef.current !== null) return;
      widgetIdRef.current = window.grecaptcha.render(containerRef.current, {
        sitekey: siteKey,
        callback: (token: string) => { if (!cancelled) onVerify(token); },
        'expired-callback': () => { if (!cancelled && onExpired) onExpired(); },
      });
    };

    ensureScript(render);

    return () => {
      cancelled = true;
      if (widgetIdRef.current !== null) {
        try { window.grecaptcha?.reset(widgetIdRef.current); } catch {}
        widgetIdRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey]);

  return (
    <div
      ref={containerRef}
      style={{ minHeight: 78 }}
    />
  );
}
