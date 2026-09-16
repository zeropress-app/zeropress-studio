import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Toaster, toast } from 'sonner';
import i18n from '../../i18n';

const STUDIO_TOASTER_ID = 'zeropress-studio';
// Reuse active toasts for updates; let Sonner assign fresh IDs after dismissal.
const activeToastIds = new Map<string, string | number>();

export type StudioToastTone = 'success' | 'info';

export type StudioToastInput = {
  /** Stable screen-local ID to prevent duplicate notices for the same action. */
  id: string;
  /** Short translated completion or information message. */
  message: string;
  /** Optional internal navigation link directly related to the result. */
  link?: { label: string; to: string };
};

function activeToastId(id: string): string | number | undefined {
  const current = activeToastIds.get(id);
  return current !== undefined && toast.getToasts().some((item) => item.id === current)
    ? current
    : undefined;
}

function accessibleMessage(
  tone: StudioToastTone,
  message: string,
  link?: StudioToastInput['link'],
) {
  const toneKey = tone === 'success' ? 'notice.success' : 'notice.info';
  return (
    <>
      <span className="visually-hidden">{i18n.t(toneKey)}</span>
      <span>{message}</span>
      {link ? (
        <Link className="studio-toast-action" to={link.to}>
          {link.label}
        </Link>
      ) : null}
    </>
  );
}

/**
 * Temporary notice that does not shift document content.
 *
 * Keep errors, warnings, and recovery guidance in inline Notice. Sonner's container is one polite
 * live region, so it is unsuitable for urgent results or information users must reread and act on.
 */
export const studioToast = {
  success(input: StudioToastInput): void {
    const id = toast.success(accessibleMessage('success', input.message, input.link), {
      id: activeToastId(input.id),
      toasterId: STUDIO_TOASTER_ID,
    });
    activeToastIds.set(input.id, id);
  },

  info(input: StudioToastInput): void {
    const id = toast.info(accessibleMessage('info', input.message, input.link), {
      id: activeToastId(input.id),
      toasterId: STUDIO_TOASTER_ID,
    });
    activeToastIds.set(input.id, id);
  },

  dismiss(id: string): void {
    const targetId = activeToastId(id);
    activeToastIds.delete(id);
    if (targetId !== undefined) {
      toast.dismiss(targetId);
    }
  },
};

/**
 * Connect existing completion state to the toast lifetime.
 *
 * Dismiss the toast with the same ID when message becomes null or the screen unmounts. Screens
 * retain their existing state transitions while replacing inline success notices.
 */
export function useStudioToast(input: {
  id: string;
  tone: StudioToastTone;
  message: string | null;
  link?: { label: string; to: string };
}): void {
  const { id, message, tone } = input;
  const linkLabel = input.link?.label;
  const linkTo = input.link?.to;

  useEffect(() => {
    if (message === null) {
      studioToast.dismiss(id);
      return;
    }
    studioToast[tone]({
      id,
      message,
      ...(linkLabel && linkTo
        ? { link: { label: linkLabel, to: linkTo } }
        : {}),
    });
  }, [id, linkLabel, linkTo, message, tone]);

  useEffect(() => () => studioToast.dismiss(id), [id]);
}

/** Toast viewport owned once by the currently displayed Studio surface. */
export function StudioToaster() {
  const { t, i18n } = useTranslation('common');

  useEffect(() => () => {
    // Sonner's store is module-global. Clear old notices on sign-out so they cannot
    // appear in the next session. Studio is its only consumer, so clear the entire queue.
    activeToastIds.clear();
    toast.dismiss();
  }, []);

  return (
    <Toaster
      id={STUDIO_TOASTER_ID}
      className="studio-toaster"
      position="bottom-right"
      duration={8_000}
      visibleToasts={3}
      gap={10}
      offset={24}
      mobileOffset={12}
      closeButton
      dir={i18n.dir()}
      containerAriaLabel={t('toast.regionLabel')}
      toastOptions={{
        unstyled: true,
        closeButtonAriaLabel: t('toast.close'),
        classNames: {
          toast: 'studio-toast',
          title: 'studio-toast-title',
          content: 'studio-toast-content',
          icon: 'studio-toast-icon',
          closeButton: 'studio-toast-close',
          success: 'studio-toast-success',
          info: 'studio-toast-info',
        },
      }}
    />
  );
}
