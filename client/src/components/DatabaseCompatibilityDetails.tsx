import { useTranslation } from 'react-i18next';

export type DatabaseCompatibilityDetailsProps = {
  studioVersion?: string;
  currentVersion: number;
  targetVersion: number;
};

export function DatabaseCompatibilityDetails(
  input: DatabaseCompatibilityDetailsProps,
) {
  const { t } = useTranslation('system', {
    keyPrefix: 'states.blocked.DATABASE_NEWER_THAN_CODE',
  });
  const versions = [
    { label: t('versions.studio'), value: input.studioVersion ?? t('versions.unknown') },
    { label: t('versions.database'), value: input.currentVersion },
    { label: t('versions.worker'), value: input.targetVersion },
  ];

  return (
    <>
      <section aria-label={t('versions.title')}>
        <dl className="standalone-status-schema-comparison">
          {versions.map(({ label, value }) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <ol
        className="standalone-status-upgrade-steps"
        aria-label={t('stepsLabel')}
      >
        {(['deploy', 'binding'] as const).map((step, index) => (
          <li key={step}>
            <span
              className="standalone-status-upgrade-step-number"
              aria-hidden="true"
            >
              {index + 1}
            </span>
            <div className="standalone-status-upgrade-step-copy">
              <h3>{t(`steps.${step}.title`)}</h3>
              <p>{t(`steps.${step}.description`)}</p>
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}
