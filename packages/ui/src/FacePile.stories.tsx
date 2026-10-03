import { FacePile, AvatarChip } from './FacePile.tsx';
const peers = ['Ada Lovelace', 'Ben', 'Cy', 'Dee', 'Eve'].map((name, clientId) => ({ clientId, name, color: `var(--${['chart-blue', 'chart-terra', 'chart-sage', 'chart-wheat', 'sketch-plum'][clientId]})`, isAgent: clientId === 2 }));
export const Alone = () => <FacePile peers={[]} />;
export const TwoPeople = () => <FacePile peers={peers.slice(0, 2)} />;
export const Overflow = () => <FacePile peers={peers} />;
export const Agent = () => <AvatarChip avatar={peers[2]} />;
