import type { LucideIcon } from 'lucide-react';

/**
 * Shared boundary for Studio UI icons.
 *
 * Icons support adjacent text or control labels and are always decorative in the accessibility
 * tree. LogoMark remains a separate product-identity SVG.
 */
export function StudioIcon(input: {
  icon: LucideIcon;
  className?: string;
}) {
  const Icon = input.icon;

  return (
    <Icon
      className={input.className}
      aria-hidden="true"
      focusable="false"
      strokeWidth={1.75}
    />
  );
}
