import { BRAND, BRAND_ASSETS } from '../config/brand';

interface BrandMarkProps {
  className?: string;
  decorative?: boolean;
}

export default function BrandMark({ className = '', decorative = true }: BrandMarkProps) {
  return (
    <img
      src={BRAND_ASSETS.mark}
      alt={decorative ? '' : `${BRAND.name} mark`}
      aria-hidden={decorative || undefined}
      className={className}
    />
  );
}
