// ported-from: packages/desktop/src/renderer/editor/plugins/CalloutControlsPlugin.tsx @ 762abb777
import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getNodeByKey,
  type LexicalEditor,
  type NodeMutation
} from 'lexical';
import { AlertTriangle, ChevronDown, Flag, Info } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@moss/shared/components/ui/dropdown-menu';
import {
  CALLOUT_TYPES,
  CalloutNode,
  type CalloutType,
  type PriorityLevel,
  PRIORITY_LEVELS,
  $isCalloutNode
} from '../nodes/CalloutNode';

type CalloutInfo = {
  key: string;
  headerElement: HTMLElement;
};

type CalloutData = {
  calloutType: CalloutType;
  level?: PriorityLevel;
};

const CALLOUT_LABELS: Record<CalloutType, string> = {
  warning: 'Warning',
  info: 'Info',
  priority: 'Priority'
};

const CALLOUT_ICONS: Record<CalloutType, typeof AlertTriangle> = {
  warning: AlertTriangle,
  info: Info,
  priority: Flag
};

const PRIORITY_LEVEL_LABELS: Record<PriorityLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical'
};

function readCalloutData(editor: LexicalEditor, nodeKey: string): CalloutData | null {
  let data: CalloutData | null = null;
  editor.getEditorState().read(() => {
    const node = $getNodeByKey(nodeKey);
    if (!$isCalloutNode(node)) {
      return;
    }
    data = {
      calloutType: node.getCalloutType(),
      level: node.getLevel()
    };
  });
  return data;
}

function CalloutControls({
  editor,
  nodeKey
}: {
  editor: LexicalEditor;
  nodeKey: string;
}): JSX.Element | null {
  const [data, setData] = useState<CalloutData | null>(() => readCalloutData(editor, nodeKey));
  const [isTypeDropdownOpen, setIsTypeDropdownOpen] = useState(false);
  const [isLevelDropdownOpen, setIsLevelDropdownOpen] = useState(false);
  // moss-multi seam: read-only-decorators (T3.8): a read-only callout names its type but offers no menu.
  const [editable, setEditable] = useState(() => editor.isEditable());
  useEffect(() => editor.registerEditableListener(setEditable), [editor]);

  const refresh = useCallback(() => {
    setData(readCalloutData(editor, nodeKey));
  }, [editor, nodeKey]);

  useEffect(() => {
    refresh();
    return editor.registerMutationListener(CalloutNode, (mutations) => {
      if (mutations.has(nodeKey)) {
        refresh();
      }
    });
  }, [editor, nodeKey, refresh]);

  const handleTypeChange = useCallback(
    (newType: CalloutType) => {
      if (!editor.isEditable()) return;
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if (!$isCalloutNode(node)) {
          return;
        }
        node.setCalloutType(newType);
        if (newType === 'priority' && !node.getLevel()) {
          node.setLevel('medium');
        }
      });
      editor.focus();
    },
    [editor, nodeKey]
  );

  const handleLevelChange = useCallback(
    (newLevel: PriorityLevel) => {
      if (!editor.isEditable()) return;
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if ($isCalloutNode(node)) {
          node.setLevel(newLevel);
        }
      });
      editor.focus();
    },
    [editor, nodeKey]
  );

  if (!data) {
    return null;
  }

  const IconComponent = CALLOUT_ICONS[data.calloutType];

  return (
    <div
      className="flex items-center gap-2"
      onClick={(event) => event.stopPropagation()}
    >
      <DropdownMenu open={isTypeDropdownOpen} onOpenChange={setIsTypeDropdownOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-1.5 rounded-md px-1 py-0.5 text-sm font-medium text-ink-default transition-colors hover:bg-surface-badge-muted"
            onClick={(event) => event.stopPropagation()}
            aria-label="Callout type"
            disabled={!editable /* moss-multi seam: read-only-decorators (T3.8) */}
          >
            <IconComponent className="h-4 w-4 text-ink-muted" />
            {CALLOUT_LABELS[data.calloutType]}
            <ChevronDown className="h-3 w-3 text-ink-faint" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {CALLOUT_TYPES.map((type) => {
            const TypeIcon = CALLOUT_ICONS[type];
            return (
              <DropdownMenuItem
                key={type}
                onClick={() => handleTypeChange(type)}
                className={data.calloutType === type ? 'bg-surface-note-selected-bright/50' : ''}
              >
                <TypeIcon className="mr-2 h-4 w-4 text-ink-muted" />
                {CALLOUT_LABELS[type]}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      {data.calloutType === 'priority' && (
        <DropdownMenu open={isLevelDropdownOpen} onOpenChange={setIsLevelDropdownOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-ink-muted transition-colors hover:bg-surface-badge-muted"
              onClick={(event) => event.stopPropagation()}
              aria-label="Priority level"
              disabled={!editable /* moss-multi seam: read-only-decorators (T3.8) */}
            >
              {PRIORITY_LEVEL_LABELS[data.level || 'medium']}
              <ChevronDown className="h-3 w-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {PRIORITY_LEVELS.map((level) => (
              <DropdownMenuItem
                key={level}
                onClick={() => handleLevelChange(level)}
                className={data.level === level ? 'bg-surface-note-selected-bright/50' : ''}
              >
                {PRIORITY_LEVEL_LABELS[level]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

export function CalloutControlsPlugin(): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const [callouts, setCallouts] = useState<CalloutInfo[]>([]);
  const headerSlotsRef = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    const rebuildCallouts = () => {
      const nextCallouts: CalloutInfo[] = [];
      for (const [key, headerElement] of headerSlotsRef.current) {
        if (headerElement.isConnected) {
          nextCallouts.push({ key, headerElement });
        }
      }
      setCallouts(nextCallouts);
    };

    return editor.registerMutationListener(
      CalloutNode,
      (mutations: Map<string, NodeMutation>) => {
        let needsFlush = false;

        for (const [nodeKey, mutation] of mutations) {
          if (mutation === 'destroyed') {
            headerSlotsRef.current.delete(nodeKey);
            needsFlush = true;
            continue;
          }

          const calloutDom = editor.getElementByKey(nodeKey);
          if (!calloutDom) {
            continue;
          }
          const header = calloutDom.querySelector('.moss-callout-header') as HTMLElement | null;
          if (!header) {
            continue;
          }
          headerSlotsRef.current.set(nodeKey, header);
        }

        if (needsFlush) {
          flushSync(() => rebuildCallouts());
        } else {
          rebuildCallouts();
        }
      }
    );
  }, [editor]);

  return (
    <>
      {callouts.map((callout) =>
        callout.headerElement.isConnected
          ? createPortal(
              <CalloutControls editor={editor} nodeKey={callout.key} />,
              callout.headerElement
            )
          : null
      )}
    </>
  );
}

export default CalloutControlsPlugin;
