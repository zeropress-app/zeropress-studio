export function LogoMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 800 800" fill="none" aria-hidden="true">
      <g transform="translate(-111 -105)">
        <path d="M141 282c96 55 195 108 313 112 161 6 302-36 430-111-113-57-229-110-343-167-18-11-43-8-61 2-113 55-226 109-339 164Z" fill="var(--studio-logo-top, #EA7951)" />
        <path d="M114 318v173c88 38 175 122 281 85 104-38 192-115 289-170-93 22-205 42-307 21-96-17-177-69-263-109Z" fill="var(--studio-logo-left, #F19A6B)" />
        <path d="M908 318c-103 55-204 115-301 183-71 50-144 100-225 125 67 33 160 39 232 12 102-38 195-95 294-148V318Z" fill="var(--studio-logo-right, #DC603F)" />
        <path d="M114 533c123 56 238 142 375 167v200L125 713c-7-3-11-9-11-22V533Z" fill="var(--studio-logo-bottom-left, #EC8757)" />
        <path d="M908 532v165c0 7-3 13-9 16L535 900V700c136-28 250-108 373-168Z" fill="var(--studio-logo-bottom-right, #CD553A)" />
      </g>
    </svg>
  );
}
