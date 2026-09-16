import type { LucideIcon } from 'lucide-react';
import { StudioIcon } from '../components/primitives';

export function OperationsPageHeading(input: {
  icon: LucideIcon;
  kicker: string;
  title: string;
  description: string;
}) {
  return (
    <header className="operations-page-heading">
      <div className="operations-page-heading-main">
        <span className="operations-page-heading-icon">
          <StudioIcon icon={input.icon} />
        </span>
        <div>
          <p className="operations-page-kicker">{input.kicker}</p>
          <h1 className="operations-page-title">{input.title}</h1>
        </div>
      </div>
      <p className="operations-page-description">{input.description}</p>
    </header>
  );
}
