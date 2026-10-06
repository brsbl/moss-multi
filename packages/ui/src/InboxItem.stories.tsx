import { InboxItem, UnreadBadge } from './InboxItem.tsx';
export const Unread = () => <InboxItem unread time="2 minutes ago">Ada shared “Roadmap” with you</InboxItem>;
export const Read = () => <InboxItem unread={false} time="Yesterday">Ben accepted your invite to “Launch brief”</InboxItem>;
export const LongTitle = () => <div className="w-72"><InboxItem unread time="Just now">Ada shared the vault “A very long vault name that wraps onto a second line” with you</InboxItem></div>;
export const Badge = () => <span className="relative inline-flex h-7 w-7"><UnreadBadge count={3} /></span>;
export const BadgeOverflow = () => <span className="relative inline-flex h-7 w-7"><UnreadBadge count={12} /></span>;
