import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type {
  DeploymentConfigurationKind,
} from '../../../../contracts/worker-configuration';
import { classNames } from './class-names';

function kindLabel(
  kind: DeploymentConfigurationKind,
  t: TFunction<'common'>,
): string {
  switch (kind) {
    case 'plain_variable':
      return t('workerConfiguration.kind.plainVariable');
    case 'worker_secret':
      return t('workerConfiguration.kind.workerSecret');
    case 'resource_binding':
      return t('workerConfiguration.kind.resourceBinding');
  }
}

/**
 * Display the Worker configuration type required by the product.
 *
 * This represents the deployment contract, not runtime detection. Always include translated text
 * rather than conveying the type through color or a lock icon alone.
 */
export function ConfigurationKindBadge(input: {
  kind: DeploymentConfigurationKind;
}) {
  const { t } = useTranslation('common');

  return (
    <span
      className={classNames(
        'studio-configuration-kind',
        `studio-configuration-kind-${input.kind}`,
      )}
    >
      {kindLabel(input.kind, t)}
    </span>
  );
}

/** Present the recommended storage type with the stable binding name. */
export function ConfigurationReference(input: {
  name: string;
  kind: DeploymentConfigurationKind;
}) {
  return (
    <span className="studio-configuration-reference">
      <ConfigurationKindBadge kind={input.kind} />
      <code className="studio-configuration-name">{input.name}</code>
    </span>
  );
}
