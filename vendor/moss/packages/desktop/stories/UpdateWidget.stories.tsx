// ported-from: packages/desktop/stories/UpdateWidget.stories.tsx @ 762abb777
import type { Story } from '@ladle/react';
import { useEffect, useState } from 'react';
import { UpdateWidget } from '../src/renderer/components/UpdateWidget';
import type { UpdateReadyInfo } from '../src/types/electron-api';

export const meta = {
  title: 'Components/UpdateWidget'
};

const BASE_INFO: UpdateReadyInfo = {
  version: '0.8.9',
  highlights:
    'Pin notes to the top of the sidebar, add text to sketches, a polished UI & more.',
  changelogUrl: 'https://www.mossnotes.app/changelog#0-8-9'
};

function UpdateWidgetFrame({ info }: { info: UpdateReadyInfo }) {
  const [visible, setVisible] = useState(true);
  const [installClicks, setInstallClicks] = useState(0);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const storyWindow = window as typeof window & {
      electronAPI?: Window['electronAPI'];
    };
    const previousElectronApi = storyWindow.electronAPI;
    const install = async () => {
      setInstallClicks((count) => count + 1);
    };

    if (previousElectronApi) {
      storyWindow.electronAPI = {
        ...previousElectronApi,
        update: {
          ...previousElectronApi.update,
          install
        }
      };
    } else {
      storyWindow.electronAPI = {
        update: {
          install,
          onReady: () => () => {}
        }
      } as unknown as Window['electronAPI'];
    }

    return () => {
      storyWindow.electronAPI = previousElectronApi;
    };
  }, []);

  return (
    <div className="relative flex min-h-96 w-full flex-col gap-3 rounded-xl border border-border-subtle bg-surface-linen p-4">
      <p className="text-xs text-ink-muted">
        Install click count: <span className="font-medium text-ink-default">{installClicks}</span>
      </p>
      {!visible && (
        <button
          type="button"
          onClick={() => setVisible(true)}
          className="w-fit rounded-md border border-border-default px-2 py-1 text-xs text-ink-muted transition-colors hover:bg-surface-panel hover:text-ink-default"
        >
          Show update widget
        </button>
      )}
      {visible ? (
        <UpdateWidget
          info={info}
          onDismiss={() => {
            setVisible(false);
          }}
        />
      ) : null}
    </div>
  );
}

export const Installable: Story = () => <UpdateWidgetFrame info={{ ...BASE_INFO, canInstall: true }} />;

export const InfoOnly: Story = () => <UpdateWidgetFrame info={{ ...BASE_INFO, canInstall: false }} />;
