// ported-from: packages/desktop/src/renderer/prompt/MentionNode.tsx @ 762abb777
import type { JSX } from 'react';
import type {
  DOMConversionMap,
  DOMExportOutput,
  EditorConfig,
  LexicalNode,
  NodeKey,
  SerializedLexicalNode,
  Spread
} from 'lexical';
import { $applyNodeReplacement, DecoratorNode } from 'lexical';
import { FileText, Folder } from 'lucide-react';

import { InlinePill } from '../editor/components';

export type MentionType = 'note' | 'directory' | 'folder';

export type SerializedMentionNode = Spread<
  {
    mentionId: string;
    mentionTitle: string;
    mentionType: MentionType;
    mentionDescription?: string;
  },
  SerializedLexicalNode
>;

export class MentionNode extends DecoratorNode<JSX.Element> {
  __mentionId: string;
  __mentionTitle: string;
  __mentionType: MentionType;
  __mentionDescription: string | undefined;

  static getType(): string {
    return 'mention';
  }

  static clone(node: MentionNode): MentionNode {
    return new MentionNode(
      node.__mentionId,
      node.__mentionTitle,
      node.__mentionType,
      node.__mentionDescription,
      node.__key
    );
  }

  constructor(
    mentionId: string,
    mentionTitle: string,
    mentionType: MentionType,
    mentionDescription?: string,
    key?: NodeKey
  ) {
    super(key);
    this.__mentionId = mentionId;
    this.__mentionTitle = mentionTitle;
    this.__mentionType = mentionType;
    this.__mentionDescription = mentionDescription;
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const span = document.createElement('span');
    span.className = 'mention-pill-wrapper';
    return span;
  }

  updateDOM(): false {
    return false;
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement('span');
    element.setAttribute('data-mention-id', this.__mentionId);
    element.setAttribute('data-mention-title', this.__mentionTitle);
    element.setAttribute('data-mention-type', this.__mentionType);
    if (this.__mentionDescription) {
      element.setAttribute('data-mention-description', this.__mentionDescription);
    }
    element.textContent = `@${this.__mentionTitle}`;
    return { element };
  }

  static importDOM(): DOMConversionMap | null {
    return {
      span: (node: Node) => {
        const element = node as HTMLElement;
        if (!element.hasAttribute('data-mention-id')) {
          return null;
        }
        return {
          conversion: (domNode: Node) => {
            const el = domNode as HTMLElement;
            const mentionId = el.getAttribute('data-mention-id') ?? '';
            const mentionTitle = el.getAttribute('data-mention-title') ?? '';
            const mentionType = (el.getAttribute('data-mention-type') ?? 'note') as MentionType;
            const mentionDescription = el.getAttribute('data-mention-description') ?? undefined;
            return {
              node: $createMentionNode(mentionId, mentionTitle, mentionType, mentionDescription)
            };
          },
          priority: 1
        };
      }
    };
  }

  static importJSON(serializedNode: SerializedMentionNode): MentionNode {
    return $createMentionNode(
      serializedNode.mentionId,
      serializedNode.mentionTitle,
      serializedNode.mentionType,
      serializedNode.mentionDescription
    );
  }

  exportJSON(): SerializedMentionNode {
    return {
      type: 'mention',
      version: 1,
      mentionId: this.__mentionId,
      mentionTitle: this.__mentionTitle,
      mentionType: this.__mentionType,
      mentionDescription: this.__mentionDescription
    };
  }

  getMentionId(): string {
    return this.__mentionId;
  }

  getMentionTitle(): string {
    return this.__mentionTitle;
  }

  getMentionType(): MentionType {
    return this.__mentionType;
  }

  getMentionDescription(): string | undefined {
    return this.__mentionDescription;
  }

  getTextContent(): string {
    return `@${this.__mentionTitle}`;
  }

  decorate(): JSX.Element {
    const isFolderMention = this.__mentionType === 'directory' || this.__mentionType === 'folder';
    const Icon = isFolderMention ? Folder : FileText;

    return (
      <InlinePill
        variant="mention"
        size="mini"
        icon={Icon}
        iconClassName={isFolderMention ? 'fill-file-link-primary/20' : undefined}
        title={this.__mentionDescription ?? this.__mentionTitle}
        maxLength={16}
        dataAttributes={{
          'data-mention-id': this.__mentionId,
          'data-mention-type': this.__mentionType
        }}
      >
        {this.__mentionTitle}
      </InlinePill>
    );
  }

  isIsolated(): boolean {
    return true;
  }

  isInline(): boolean {
    return true;
  }

  isKeyboardSelectable(): boolean {
    return true;
  }
}

export function $createMentionNode(
  mentionId: string,
  mentionTitle: string,
  mentionType: MentionType,
  mentionDescription?: string
): MentionNode {
  return $applyNodeReplacement(
    new MentionNode(mentionId, mentionTitle, mentionType, mentionDescription)
  );
}

export function $isMentionNode(
  node: LexicalNode | null | undefined
): node is MentionNode {
  return node instanceof MentionNode;
}
