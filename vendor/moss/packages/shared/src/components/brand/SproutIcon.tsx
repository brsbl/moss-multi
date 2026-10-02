// ported-from: packages/shared/src/components/brand/SproutIcon.tsx @ 762abb777
import SproutIconImage from '../../../../../logos/moss-sprout-icon.png';
import { cn } from '@/lib/utils';

export function SproutIcon({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('flex items-center justify-start', className)} {...props}>
      <img src={SproutIconImage} alt="Moss" className="h-6 w-auto" />
    </div>
  );
}

/** @deprecated Use SproutIcon instead */
export const MossWordmark = SproutIcon;

export default SproutIcon;
