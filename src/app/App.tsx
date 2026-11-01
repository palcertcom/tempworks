import { useEffect } from 'react';
import { RouterProvider } from 'react-router';
import { router } from './routes';
import { Toaster } from './components/ui/sonner';
import { ConfirmDialogHost } from './components/ui/ConfirmDialog';
import { AuthProvider } from './contexts/AuthContext';
import { TenantSyncProvider } from './contexts/TenantSyncContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { LanguageProvider } from '../i18n/LanguageContext';
import { useBranding } from './hooks/useBranding';
import { resolveAssetUrl } from './services/api';

function FaviconSync() {
  const branding = useBranding();

  useEffect(() => {
    const { logoUrl } = branding;
    if (!logoUrl) return;
    const href = resolveAssetUrl(logoUrl);
    const link = document.getElementById('favicon') as HTMLLinkElement | null;
    if (link) link.href = href;
  }, [branding.logoUrl]);

  return null;
}

export default function App() {
  return (
    <ThemeProvider>
      <LanguageProvider>
        <AuthProvider>
          <TenantSyncProvider>
            <FaviconSync />
            <RouterProvider router={router} />
            <Toaster />
            <ConfirmDialogHost />
          </TenantSyncProvider>
        </AuthProvider>
      </LanguageProvider>
    </ThemeProvider>
  );
}
