import { Banner } from './Banner.tsx';
export const Offline = () => <Banner>Connection lost. Your edits are kept in this window and will sync when the connection returns.</Banner>;
export const Retrying = () => <Banner>Still connecting… Your note will open when sync finishes.</Banner>;
export const ConnectionLimit = () => <Banner action={<button type="button">Retry</button>}>This note has reached its connection limit.</Banner>;
