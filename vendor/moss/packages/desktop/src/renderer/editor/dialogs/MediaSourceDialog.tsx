// ported-from: packages/desktop/src/renderer/editor/dialogs/MediaSourceDialog.tsx @ 762abb777
/**
 * MediaSourceDialog
 *
 * A two-step Radix dialog for choosing a media source:
 * 1. Choose source: "From computer" or "From URL"
 * 2. URL input (if URL selected): Enter and validate a supported media URL
 *
 * Used by the /media slash command to provide shared image/video insertion.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { useNotePaneDialogPosition } from '@moss/shared';
import { Dialog } from '@moss/shared/primitives';
import { X, Upload, Link, AlertCircle } from 'lucide-react';

import { DialogDimOverlay } from '../../components/DialogDimOverlay';
import { isHttpsImageUrl } from '../utils/remote-image-url';
import { isYouTubeUrl } from '../utils/video-url';

type DialogStep = 'choose' | 'url-input';

const MEDIA_SOURCE_DIALOG_MAX_WIDTH = 320;

export type MediaSourceResult =
  | { type: 'file' }
  | { type: 'url'; url: string }
  | null;

interface MediaSourceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectFile: () => void;
  onSelectUrl: (url: string) => void;
  collisionBoundary?: Element | null;
}

export function MediaSourceDialog({
  open,
  onOpenChange,
  onSelectFile,
  onSelectUrl,
  collisionBoundary
}: MediaSourceDialogProps) {
  const dialogPositionStyle = useNotePaneDialogPosition({
    open,
    maxWidthPx: MEDIA_SOURCE_DIALOG_MAX_WIDTH,
    boundaryElement: collisionBoundary
  });
  const [step, setStep] = useState<DialogStep>('choose');
  const [urlValue, setUrlValue] = useState('');
  const [urlError, setUrlError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileButtonRef = useRef<HTMLButtonElement>(null);
  const urlButtonRef = useRef<HTMLButtonElement>(null);

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setStep('choose');
      setUrlValue('');
      setUrlError(null);
    }
  }, [open]);

  // Focus "From computer" button when dialog opens on choose step
  useEffect(() => {
    if (step === 'choose' && open) {
      const timeoutId = setTimeout(() => {
        fileButtonRef.current?.focus();
      }, 50);
      return () => clearTimeout(timeoutId);
    }
  }, [step, open]);

  // Focus input when switching to URL step
  useEffect(() => {
    if (step === 'url-input' && open) {
      // Small delay to ensure the input is rendered
      const timeoutId = setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
      return () => clearTimeout(timeoutId);
    }
  }, [step, open]);

  const handleSelectFile = useCallback(() => {
    // Call onSelectFile BEFORE closing to avoid race condition
    onSelectFile();
    onOpenChange(false);
  }, [onOpenChange, onSelectFile]);

  const handleSelectUrlOption = useCallback(() => {
    setStep('url-input');
  }, []);

  const handleBack = useCallback(() => {
    setStep('choose');
    setUrlValue('');
    setUrlError(null);
  }, []);

  const handleUrlChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setUrlValue(e.target.value);
    setUrlError(null);
  }, []);

  const handleUrlSubmit = useCallback(() => {
    const trimmedUrl = urlValue.trim();

    if (!trimmedUrl) {
      setUrlError('Please enter a URL');
      return;
    }

    if (!trimmedUrl.startsWith('https://')) {
      setUrlError('URL must start with https://');
      return;
    }

    if (!isHttpsImageUrl(trimmedUrl) && !isYouTubeUrl(trimmedUrl)) {
      setUrlError('Enter an image URL (.png, .jpg, etc.) or a YouTube link');
      return;
    }

    // IMPORTANT: Call onSelectUrl BEFORE onOpenChange(false)
    // because handleOpenChange resolves the promise with null when closing
    onSelectUrl(trimmedUrl);
    onOpenChange(false);
  }, [urlValue, onOpenChange, onSelectUrl]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleUrlSubmit();
      } else if (e.key === 'Escape' && step === 'url-input') {
        e.preventDefault();
        handleBack();
      }
    },
    [handleUrlSubmit, handleBack, step]
  );

  const renderChooseStep = () => (
    <>
      <Dialog.Title className="text-sm font-semibold text-ink-default">Insert Media</Dialog.Title>
      <Dialog.Description className="mt-1 text-caption text-ink-muted">
        Choose a source
      </Dialog.Description>
      <div className="mt-3 flex flex-col gap-1.5" role="listbox" aria-label="Media source options">
        <button
          ref={fileButtonRef}
          type="button"
          role="option"
          onClick={handleSelectFile}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); urlButtonRef.current?.focus(); }
          }}
          className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-raised-control px-2.5 py-2 text-left transition hover:bg-surface-panel focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15"
        >
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-panel text-ink-faint">
            <Upload className="h-3.5 w-3.5" strokeWidth={1.75} />
          </div>
          <div className="min-w-0">
            <div className="text-small font-medium leading-tight text-ink-default">From computer</div>
            <div className="text-caption leading-snug text-ink-muted">Upload image or video files</div>
          </div>
        </button>
        <button
          ref={urlButtonRef}
          type="button"
          role="option"
          onClick={handleSelectUrlOption}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp') { e.preventDefault(); fileButtonRef.current?.focus(); }
          }}
          className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-raised-control px-2.5 py-2 text-left transition hover:bg-surface-panel focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15"
        >
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-panel text-ink-faint">
            <Link className="h-3.5 w-3.5" strokeWidth={1.75} />
          </div>
          <div className="min-w-0">
            <div className="text-small font-medium leading-tight text-ink-default">From URL</div>
            <div className="text-caption leading-snug text-ink-muted">Image URL or YouTube link</div>
          </div>
        </button>
      </div>
    </>
  );

  const renderUrlInputStep = () => (
    <>
      <Dialog.Title className="text-sm font-semibold text-ink-default">Media URL</Dialog.Title>
      <Dialog.Description className="mt-1 text-caption text-ink-muted">
        Paste an HTTPS image URL or YouTube link
      </Dialog.Description>
      <div className="mt-3">
        <input
          ref={inputRef}
          type="url"
          value={urlValue}
          onChange={handleUrlChange}
          onKeyDown={handleKeyDown}
          placeholder="https://example.com/image.png or YouTube link"
          className={`w-full rounded-lg border px-2 py-1.5 text-small text-ink-default placeholder:text-ink-faint/50 focus:outline-none focus:ring-1 focus:ring-ink-default/15 ${
            urlError ? 'border-status-error-border bg-status-error-surface' : 'border-border-subtle bg-surface-raised-control'
          }`}
        />
        {urlError && (
          <div className="mt-1.5 flex items-center gap-1.5 text-caption text-status-error-text">
            <AlertCircle className="h-3.5 w-3.5" />
            {urlError}
          </div>
        )}
      </div>
      <div className="mt-3 flex justify-between">
        <button
          type="button"
          onClick={handleBack}
          className="rounded-md border border-border-subtle bg-surface-raised-control px-2.5 py-1.5 text-caption font-medium text-ink-muted transition hover:bg-surface-panel hover:text-ink-default focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15"
        >
          Back
        </button>
        <button
          type="button"
          onClick={handleUrlSubmit}
          className="rounded-md bg-accent-brand px-2.5 py-1.5 text-caption font-medium text-ink-on-accent transition hover:bg-accent-brand-pressed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15"
        >
          Insert
        </button>
      </div>
    </>
  );

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <DialogDimOverlay />
        <Dialog.Content
          data-remote-web-surface-blocking-dialog="true"
          style={dialogPositionStyle}
          className="fixed left-1/2 top-1/2 z-[130] w-full max-w-xs -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border-subtle bg-surface-floating p-3 shadow-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]"
        >
          <Dialog.Close className="absolute right-2.5 top-2.5 rounded-md p-1 text-ink-faint/70 transition-colors hover:bg-surface-panel hover:text-ink-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15">
            <X className="h-3.5 w-3.5" strokeWidth={1.75} />
            <span className="sr-only">Close</span>
          </Dialog.Close>
          {step === 'choose' ? renderChooseStep() : renderUrlInputStep()}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default MediaSourceDialog;
