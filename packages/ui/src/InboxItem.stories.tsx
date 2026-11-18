import { InboxItem } from './InboxItem.tsx';
export const Unread = () => <div className="w-80"><InboxItem unread time="2 min ago">Ada mentioned you</InboxItem></div>;
export const Read = () => <div className="w-80"><InboxItem unread={false} time="Yesterday">Ben accepted your invite</InboxItem></div>;
export const LongName = () => <div className="w-80"><InboxItem unread time="Just now">Alexandra Montgomery-Fitzwilliam replied to your comment</InboxItem></div>;
export const Unreachable = () => <div className="w-80"><InboxItem unread time="1 h ago" note="This note didn’t open. It may have been deleted, or your access changed.">Ada suggested changes</InboxItem></div>;
