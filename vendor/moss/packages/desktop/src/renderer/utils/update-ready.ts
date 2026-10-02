// ported-from: packages/desktop/src/renderer/utils/update-ready.ts @ 762abb777
import type { UpdateReadyInfo } from '../../types/electron-api';

export const UPDATE_DISMISSED_INFO_KEY = 'moss:update-dismissed';
export const UPDATE_DISMISSED_INSTALLABLE_KEY = 'moss:update-dismissed-installable';

export const getUpdateDismissedStorageKey = (canInstall?: boolean): string =>
  canInstall ? UPDATE_DISMISSED_INSTALLABLE_KEY : UPDATE_DISMISSED_INFO_KEY;

export const shouldIgnoreIncomingUpdate = (
  incoming: UpdateReadyInfo,
  current: UpdateReadyInfo | null,
  dismissedVersion: string | null
): boolean => {
  if (dismissedVersion === incoming.version) {
    return true;
  }

  // Never downgrade the widget from an installable update to an info-only one.
  if (current?.canInstall && !incoming.canInstall) {
    return true;
  }

  return false;
};
