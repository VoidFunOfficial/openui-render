export function Mark({ size = 48 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect width="48" height="48" rx="14" fill="#28604F" />
      <path d="M9 14c5-1 10 0 15 4 5-4 10-5 15-4v20c-5-1-10 0-15 4-5-4-10-5-15-4Z" fill="none" stroke="#F6F2D8" strokeWidth="2.4" />
      <path d="M24 18v20" stroke="#F6F2D8" strokeWidth="2.4" />
      <path d="m31 11 2 4 4 1-4 2-2 4-1-4-4-2 4-1Z" fill="#CDE8A6" />
    </svg>
  );
}
