// Substituted for the generated nodes/register-views.tsx in the editor bundle (A§2.1, T3.12): the light views register
// at once, as there; charts, the canvas and HTML blocks register through lazy-views.ts, so their code loads on first
// use. Each decorator still renders inside its own boundary, as there.
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { setNodeViewWrapper } from '@moss-desktop/renderer/editor/nodes/node-views';
import '@moss-desktop/renderer/editor/nodes/CodeBlockNode.view';
import '@moss-desktop/renderer/editor/nodes/EmbedPillNode.view';
import '@moss-desktop/renderer/editor/nodes/ImageNode.view';
import '@moss-desktop/renderer/editor/nodes/VideoNode.view';
import '@moss-desktop/renderer/editor/nodes/WebEmbedNode.view';
import '@moss-editor/lazy-views';

class NodeViewBoundary extends Component<{ type: string; children?: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidUpdate(previous: { children?: ReactNode }): void {
    if (this.state.failed && previous.children !== this.props.children) this.setState({ failed: false });
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[node-view] ${this.props.type} failed to render`, error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <span
        contentEditable={false}
        data-node-view-error={this.props.type}
        className="inline-block rounded-md bg-surface-panel/70 px-3 py-2 text-sm text-ink-muted"
      >
        This block couldn't be displayed.
      </span>
    );
  }
}

setNodeViewWrapper((type, element) => <NodeViewBoundary type={type}>{element as ReactNode}</NodeViewBoundary>);
