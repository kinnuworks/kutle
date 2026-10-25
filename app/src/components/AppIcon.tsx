/** Kütle mark: a battery cell with a balance beam across it (mass in, mass out). */
export function AppIcon({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" style={{ flex: "none", borderRadius: "22.5%", boxShadow: "inset 0 0 0 .5px rgba(0,0,0,.12)" }}>
      <defs>
        <linearGradient id="kutle-cu" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#F6A066" />
          <stop offset=".6" stopColor="#E07B39" />
          <stop offset="1" stopColor="#B85E22" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="7.2" fill="url(#kutle-cu)" />
      <rect x="10" y="7.5" width="12" height="19" rx="2.6" fill="none" stroke="#2A1200" strokeWidth="1.9" />
      <rect x="13.5" y="5" width="5" height="2.6" rx="1" fill="#2A1200" />
      <path d="M11.8 15.2h8.4" stroke="#2A1200" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M16 15.2l-2 5.3h4z" fill="#2A1200" />
      <circle cx="12.3" cy="17.6" r="1.25" fill="#2A1200" />
      <circle cx="19.7" cy="17.6" r="1.25" fill="#2A1200" />
    </svg>
  );
}
