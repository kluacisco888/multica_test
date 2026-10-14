import { PRODUCT_NAME } from '@dida/shared';

/**
 * Logo — our own (ADR-0001: no official name, logo or artwork). The product
 * name lives in `@dida/shared` (`PRODUCT_NAME`), shared with the server.
 */

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect x="2" y="2" width="28" height="28" rx="9" fill="var(--color-brand)" />
      <path d="m9.5 16.5 4.5 4.5 9-10" fill="none" stroke="var(--color-on-brand)" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Brand() {
  return (
    <span className="brand">
      <Logo />
      <span className="brand-name">{PRODUCT_NAME}</span>
    </span>
  );
}
