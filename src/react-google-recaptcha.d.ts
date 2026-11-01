declare module 'react-google-recaptcha' {
  import * as React from 'react';

  export interface ReCAPTCHAProps {
    sitekey: string;
    onChange?: (token: string | null) => void;
    onExpired?: () => void;
    onError?: () => void;
    theme?: 'light' | 'dark';
    size?: 'compact' | 'normal' | 'invisible';
    tabindex?: number;
    hl?: string;
    badge?: 'bottomright' | 'bottomleft' | 'inline';
  }

  export default class ReCAPTCHA extends React.Component<ReCAPTCHAProps> {
    reset(): void;
    execute(): void;
    executeAsync(): Promise<string>;
    getValue(): string | null;
    getWidgetId(): number | null;
  }
}
