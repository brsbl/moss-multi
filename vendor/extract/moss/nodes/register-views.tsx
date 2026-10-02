import { Component, type ErrorInfo, type ReactNode } from 'react';
import { setNodeViewWrapper } from './node-views';
import './ChartNode.view';
import './CodeBlockNode.view';
import './EmbedPillNode.view';
import './HtmlBlockquoteNode.view';
import './ImageNode.view';
import './SketchNode.view';
import './VideoNode.view';
import './WebEmbedNode.view';

// Client only. Each decorator renders inside its own boundary, so one throwing view shows a placeholder
// instead of unmounting the editor (A§12; L§4.2). The placeholder reuses ImageNode's missing-image style.
class NodeViewBoundary extends Component<{ type: string; children?: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
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
