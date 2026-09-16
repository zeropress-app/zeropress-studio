import { useState } from 'react';

export function identityInitials(name: string): string {
  return name
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => [...word][0]?.toLocaleUpperCase() ?? '')
    .join('');
}

export function IdentityAvatar(input: {
  name: string;
  src?: string | null;
  className?: string;
}) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  return (
    <span
      className={['identity-avatar', input.className]
        .filter(Boolean)
        .join(' ')}
      aria-hidden="true"
    >
      {input.src && input.src !== failedSource ? (
        <img
          src={input.src}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setFailedSource(input.src ?? null)}
        />
      ) : identityInitials(input.name)}
    </span>
  );
}
