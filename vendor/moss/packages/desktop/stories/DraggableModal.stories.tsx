// ported-from: packages/desktop/stories/DraggableModal.stories.tsx @ 762abb777
import type { Story } from '@ladle/react';
import { DraggableModal, DraggableModalHeader } from '@moss/shared';

export const meta = {
  title: 'Shared/DraggableModal'
};

/**
 * Basic draggable modal with header. Drag the header to reposition.
 * The modal centers itself horizontally within the canvas area on mount.
 */
export const BasicModal: Story = () => (
  <DraggableModal className="w-96">
    <DraggableModalHeader onClose={() => console.log('Close clicked')} />
    <div className="p-6">
      <h2 className="mb-2 text-body font-medium text-ink-default">Basic Draggable Modal</h2>
      <p className="text-small text-ink-muted">
        Drag the header to reposition this modal.
      </p>
    </div>
  </DraggableModal>
);

/**
 * Modal header supports left content for navigation controls or status indicators.
 */
export const WithLeftContent: Story = () => (
  <DraggableModal className="w-96">
    <DraggableModalHeader
      onClose={() => console.log('Close clicked')}
      leftContent={<span className="text-micro text-ink-muted mr-auto">1 / 3</span>}
    />
    <div className="p-6">
      <h2 className="mb-2 text-body font-medium text-ink-default">Modal with Navigation</h2>
      <p className="text-small text-ink-muted">
        The header supports left content for navigation controls.
      </p>
    </div>
  </DraggableModal>
);

/**
 * Modal with scrollable content area.
 */
export const TallContent: Story = () => (
  <DraggableModal className="w-96 max-h-80">
    <DraggableModalHeader onClose={() => console.log('Close clicked')} />
    <div className="overflow-y-auto p-6">
      <h2 className="mb-2 text-body font-medium text-ink-default">Scrollable Content</h2>
      {Array.from({ length: 10 }).map((_, i) => (
        <p key={i} className="mb-4 text-small text-ink-muted">
          Paragraph {i + 1}: Lorem ipsum dolor sit amet.
        </p>
      ))}
    </div>
  </DraggableModal>
);

/**
 * Wide modal using standard timeline width tokens for consistency.
 */
export const WideModal: Story = () => (
  <DraggableModal className="w-timeline-width max-w-timeline-max">
    <DraggableModalHeader onClose={() => console.log('Close clicked')} />
    <div className="p-6">
      <h2 className="mb-2 text-body font-medium text-ink-default">Wide Modal</h2>
      <p className="text-small text-ink-muted">
        Uses standard timeline width tokens for consistent modal sizing.
      </p>
    </div>
  </DraggableModal>
);
