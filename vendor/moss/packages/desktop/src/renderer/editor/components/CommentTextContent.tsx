// ported-from: packages/desktop/src/renderer/editor/components/CommentTextContent.tsx @ 762abb777
import { FileText, Folder, User } from 'lucide-react';

import { InlinePill } from './InlinePill';
import { splitCommentMentionSegments, stripCommentMentionMarkers } from '../utils/comment-mentions';

export function CommentTextContent({
  text,
  mentionMaxLength = 32,
  onNavigateToMention
}: {
  text: string;
  mentionMaxLength?: number;
  onNavigateToMention?: (title: string, mentionId?: string) => void;
}) {
  return (
    <>
      {splitCommentMentionSegments(text).map((segment, index) => {
        if (segment.type === 'mention') {
          const mentionText = segment.value.startsWith('@') ? segment.value.slice(1) : segment.value;
          const pill = (
            <InlinePill
              variant="mention"
              size="mini"
              icon={segment.mentionType === 'person' ? User : segment.mentionType === 'folder' ? Folder : FileText /* moss-multi seam: comments */}
              iconClassName={segment.mentionType === 'folder' ? 'fill-file-link-primary/20' : undefined}
              maxLength={mentionMaxLength}
            >
              {mentionText}
            </InlinePill>
          );
          if (segment.mentionType === 'note' && onNavigateToMention) {
            return (
              <button
                key={`mention-${index}`}
                type="button"
                className="inline-flex cursor-pointer rounded-md align-baseline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15"
                aria-label={`Open note ${mentionText}`}
                data-comment-note-mention={mentionText}
                onClick={() => onNavigateToMention(mentionText, segment.mentionId)}
              >
                {pill}
              </button>
            );
          }
          return <span key={`mention-${index}`} data-mention-type={segment.mentionType /* moss-multi seam: comments */}>{pill}</span>;
        }

        return <span key={`text-${index}`}>{stripCommentMentionMarkers(segment.value)}</span>;
      })}
    </>
  );
}
