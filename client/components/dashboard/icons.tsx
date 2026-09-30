// Dashboard icons. Thin wrappers over lucide-react so the whole app pulls from
// one icon set. Line icons only, strokeColor is currentColor so the caller's
// text color drives it, and strokeWidth is tuned down to 1.6 to sit quiet
// against the flat-black surfaces (design rules). Named exports keep the old
// call sites stable; add new icons by re-exporting more lucide glyphs here.

import {
  Activity,
  AlertOctagon,
  ArrowLeft,
  BookOpen,
  Ban,
  Check,
  ChevronRight,
  Clock,
  Coins,
  DollarSign,
  LayoutGrid,
  Loader2,
  Plus,
  Search,
  Settings,
  Shield,
  ShieldCheck,
  Target,
  Wrench,
  X,
  type LucideIcon,
  type LucideProps,
} from "lucide-react";

export type IconProps = {
  className?: string;
  size?: number;
};

// Wrap a lucide glyph so it takes the dashboard's quiet defaults and the same
// { size, className } shape the old inline icons used.
function icon(Glyph: LucideIcon, defaults?: Partial<LucideProps>) {
  const Wrapped = ({ className, size = 16 }: IconProps) => (
    <Glyph
      size={size}
      strokeWidth={1.6}
      className={className}
      aria-hidden
      {...defaults}
    />
  );
  Wrapped.displayName = `Icon(${Glyph.displayName ?? "lucide"})`;
  return Wrapped;
}

// Original call-site names, now backed by lucide.
export const TargetIcon = icon(Target);
export const GridIcon = icon(LayoutGrid);
export const ActivityIcon = icon(Activity);
export const ShieldIcon = icon(Shield);
export const BookIcon = icon(BookOpen);
export const SettingsIcon = icon(Settings);
export const SearchIcon = icon(Search);
export const PlusIcon = icon(Plus);
export const ChevronRightIcon = icon(ChevronRight);
export const ArrowLeftIcon = icon(ArrowLeft);

// Added to beautify specific surfaces.
export const ShieldCheckIcon = icon(ShieldCheck);
export const HaltIcon = icon(AlertOctagon);
export const ClockIcon = icon(Clock);
export const CoinsIcon = icon(Coins);
export const DollarIcon = icon(DollarSign);
export const WrenchIcon = icon(Wrench);
export const CheckIcon = icon(Check);
export const BanIcon = icon(Ban);
export const XIcon = icon(X);
export const SpinnerIcon = icon(Loader2);
