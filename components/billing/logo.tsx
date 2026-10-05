export function InkwellMark({ size = 24 }: { size?: number }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden>
      <rect width="32" height="32" rx="8" fill="#7c3aed" />
      <path d="M16 6c3.5 4.6 6 8.2 6 11.2a6 6 0 0 1-12 0C10 14.2 12.5 10.6 16 6z" fill="#fff" />
      <path d="M16 15v8" stroke="#7c3aed" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
