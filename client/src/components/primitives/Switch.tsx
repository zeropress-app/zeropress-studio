import { useId, type ReactNode } from 'react';
import { classNames } from './class-names';

/**
 * On/off switch.
 *
 * Connect only the label through htmlFor and supporting text through aria-describedby. A wrapping
 * label would include the entire description in the accessible name. Generate IDs internally to
 * avoid duplicates.
 *
 * Settings, Menus, and Widget areas share this primitive.
 */
export function Switch(input: {
  /** Translated label, used as the accessible name. */
  label: string;
  /** Translated supporting description, excluded from the name. */
  description?: string;
  checked: boolean;
  disabled?: boolean;
  /**
   * row presents a bordered cell on a subtle surface when the switch is the section's main
   * control. inline omits that cell so it can share a grid with other fields.
   */
  density?: 'row' | 'inline';
  onChange: (checked: boolean) => void;
}) {
  const base = useId().replaceAll(':', '');
  const controlId = `${base}-control`;
  const descriptionId = `${base}-description`;

  return (
    <div
      className={classNames(
        'studio-switch',
        input.density === 'inline' && 'studio-switch-inline',
      )}
    >
      <div className="studio-switch-text">
        <label className="studio-switch-label" htmlFor={controlId}>
          {input.label}
        </label>
        {input.description ? (
          <p className="studio-switch-description" id={descriptionId}>
            {input.description}
          </p>
        ) : null}
      </div>
      <input
        className="studio-switch-control"
        id={controlId}
        aria-describedby={input.description ? descriptionId : undefined}
        type="checkbox"
        role="switch"
        checked={input.checked}
        disabled={input.disabled}
        onChange={(event) => input.onChange(event.target.checked)}
      />
    </div>
  );
}

/**
 * List of adjoining switches.
 *
 * Owns borders so adjacent rows do not overlap. Accept children directly to allow a final row of
 * supplementary guidance.
 */
export function SwitchGroup(input: { children: ReactNode }) {
  return <div className="studio-switch-group">{input.children}</div>;
}
