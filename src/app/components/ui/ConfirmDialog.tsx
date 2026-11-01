/** In-app confirmation dialog with an imperative Promise-based API.
 *
 *  Usage:
 *    import { confirm } from '../../components/ui/ConfirmDialog';
 *    if (!(await confirm({
 *      title: 'Delete document?',
 *      description: `"${doc.name}" will be removed. This cannot be undone.`,
 *      confirmText: 'Delete',
 *      tone: 'destructive',
 *    }))) return;
 *
 *  The host component `<ConfirmDialogHost />` must be mounted once at
 *  the app root. Only one confirmation is rendered at a time — if a
 *  second call comes in while one is open, the first resolves `false`.
 *
 *  The `confirm` name intentionally shadows the browser global so the
 *  only diff at each call site is adding `await` and passing an object.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './alert-dialog';

export type ConfirmOptions = {
  title?: string;
  description?: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  /** 'destructive' styles the confirm button red (deletes etc.). */
  tone?: 'default' | 'destructive';
};

type PendingState = ConfirmOptions & { resolve: (value: boolean) => void };

type Store = {
  setPending: ((p: PendingState | null) => void) | null;
  current: PendingState | null;
};

// Share state across module instances (Vite HMR can produce duplicates).
const store: Store = (() => {
  const globalKey = '__confirmDialogStore_v1__';
  const host: any =
    typeof window !== 'undefined' ? window :
    typeof globalThis !== 'undefined' ? globalThis : {};
  if (!host[globalKey]) host[globalKey] = { setPending: null, current: null };
  return host[globalKey] as Store;
})();

/** Imperative confirmation prompt. Returns true if the user confirms,
 *  false if they cancel, close the dialog, or press Escape. */
export function confirm(options: ConfirmOptions = {}): Promise<boolean> {
  if (!store.setPending) {
    if (typeof window !== 'undefined' && window.console) {
      window.console.warn('<ConfirmDialogHost/> is not mounted; confirm() resolved to false.');
    }
    return Promise.resolve(false);
  }
  // Auto-cancel any open prompt so the new one takes its place.
  if (store.current) {
    store.current.resolve(false);
    store.current = null;
  }
  return new Promise<boolean>(resolve => {
    const pending: PendingState = { ...options, resolve };
    store.current = pending;
    store.setPending!(pending);
  });
}

/** Mount once at the app root, alongside <Toaster />. */
export function ConfirmDialogHost() {
  const { t } = useTranslation('ui');
  const [pending, setPending] = useState<PendingState | null>(null);
  const resolvedRef = useRef(false);

  // Register synchronously so a click that fires before effects run still works.
  useLayoutEffect(() => {
    store.setPending = setPending;
    return () => {
      if (store.setPending === setPending) store.setPending = null;
    };
  }, []);

  useLayoutEffect(() => {
    resolvedRef.current = false;
  }, [pending]);

  const close = (ok: boolean) => {
    if (!pending || resolvedRef.current) return;
    resolvedRef.current = true;
    pending.resolve(ok);
    store.current = null;
    setPending(null);
  };

  const isDestructive = pending?.tone === 'destructive';

  return (
    <AlertDialog
      open={!!pending}
      onOpenChange={(open) => { if (!open) close(false); }}
    >
      <AlertDialogContent className="z-[100]">
        <AlertDialogHeader>
          <AlertDialogTitle>{pending?.title ?? t('confirmDialog.title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {pending?.description ?? ''}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => close(false)}>
            {pending?.cancelText ?? t('confirmDialog.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={() => close(true)}
            className={isDestructive
              ? 'bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20'
              : undefined}
          >
            {pending?.confirmText ?? t('confirmDialog.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
