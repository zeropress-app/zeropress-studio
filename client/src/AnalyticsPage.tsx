import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ANALYTICS_DEFAULT_PERIOD,
  analyticsPeriodSchema,
  type AnalyticsPeriod,
  type AnalyticsSummary,
} from '../../contracts/analytics';
import { AnalyticsTrendChart } from './components/AnalyticsTrendChart';
import { useStudioDocumentTitle } from './StudioSiteIdentityContext';
import {
  Button,
  ButtonLink,
  DataTable,
  EmptyState,
  Field,
  InlineStatus,
  Notice,
  PageHeader,
  Panel,
} from './components/primitives';
import {
  AnalyticsClientError,
  analyticsErrorKey,
  requestAnalyticsSummary,
} from './lib/analytics-client';
import { STUDIO_PATHS } from './routing/studio-routes';
import './screens/analytics.css';

export function AnalyticsPage(input: { onSessionEnded: () => void }) {
  const { t, i18n } = useTranslation('analytics');
  const [period, setPeriod] = useState<AnalyticsPeriod>(
    ANALYTICS_DEFAULT_PERIOD,
  );
  const [attempt, setAttempt] = useState(0);
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [metric, setMetric] = useState<'pageviews' | 'visits'>('pageviews');
  useStudioDocumentTitle(t('title'));
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError(null);
    setSummary(null);
    void requestAnalyticsSummary(period, controller.signal)
      .then((response) => {
        if (!active) return;
        if (response.success) setSummary(response.data);
        else if (response.error.code === 'AUTHENTICATION_REQUIRED')
          input.onSessionEnded();
        else setError(response.error.code);
      })
      .catch((cause: unknown) => {
        if (active)
          setError(
            cause instanceof AnalyticsClientError
              ? cause.code
              : 'INTERNAL_ERROR',
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [period, attempt, input.onSessionEnded]);

  const number = (value: number) =>
    new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 0 }).format(
      value,
    );
  const date = (value: string) =>
    new Intl.DateTimeFormat(i18n.language, {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${value}T00:00:00Z`));
  const missing =
    error === 'ANALYTICS_NOT_CONFIGURED' ||
    error === 'ANALYTICS_SITE_NOT_CONFIGURED';
  const daily = summary?.daily ?? [];
  const ranking = (items: AnalyticsSummary['top_paths'], paths: boolean) =>
    items.length === 0 ? (
      <EmptyState title={t('noData.title')} />
    ) : (
      <DataTable
        caption={t(paths ? 'topPaths' : 'topReferrers')}
        minWidthPx={300}
      >
        <thead>
          <tr>
            <th scope="col">{t(paths ? 'url' : 'source')}</th>
            <th scope="col">{t('pageviews')}</th>
            <th scope="col">{t('visits')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.value}>
              <th scope="row">
                {paths &&
                item.value.startsWith('/') &&
                !item.value.startsWith('//') &&
                !item.value.includes('\\') ? (
                  <ButtonLink
                    to={`https://${summary!.hostname}${item.value}`}
                    variant="text"
                    external
                  >
                    {item.value}
                  </ButtonLink>
                ) : (
                  item.value || t('direct')
                )}
              </th>
              <td>{number(item.pageviews)}</td>
              <td>{number(item.visits)}</td>
            </tr>
          ))}
        </tbody>
      </DataTable>
    );

  return (
    <main id="studio-main-content" aria-labelledby="analytics-title">
      <PageHeader
        titleId="analytics-title"
        kicker={t('kicker')}
        title={t('title')}
      />
      <div className="analytics-stack">
        <div className="analytics-toolbar">
          <Field label={t('period')}>
            {(control) => (
              <select
                {...control}
                value={period}
                onChange={(event) =>
                  setPeriod(event.target.value as AnalyticsPeriod)
                }
              >
                {analyticsPeriodSchema.options.map((value) => (
                  <option key={value} value={value}>
                    {t(`periods.${value}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <ButtonLink to={STUDIO_PATHS.analyticsSettings}>
            {t('connection')}
          </ButtonLink>
        </div>
        {loading ? <InlineStatus>{t('loading')}</InlineStatus> : null}
        {missing ? (
          <EmptyState
            title={t('notConnected')}
            description={t(`errors.${analyticsErrorKey(error!)}`)}
            actions={
              <ButtonLink
                to={
                  error === 'ANALYTICS_SITE_NOT_CONFIGURED'
                    ? STUDIO_PATHS.generalSettings
                    : STUDIO_PATHS.analyticsSettings
                }
              >
                {t('configure')}
              </ButtonLink>
            }
          />
        ) : null}
        {error && !missing ? (
          <Notice
            tone="error"
            title={t('loadError')}
            actions={
              <Button
                type="button"
                onClick={() => setAttempt((value) => value + 1)}
              >
                {t('retry')}
              </Button>
            }
          >
            {t(`errors.${analyticsErrorKey(error)}`)}
          </Notice>
        ) : null}
        {summary ? (
          <>
            <div className="analytics-context">
              <span>
                {summary.hostname} · {summary.timezone}
              </span>
              <span>
                {t('updated', {
                  time: new Date(summary.generated_at_iso).toLocaleString(
                    i18n.language,
                  ),
                })}
              </span>
            </div>
            <div className="analytics-metrics">
              {(['pageviews', 'visits'] as const).map((name) => (
                <Panel key={name} title={t(name)}>
                  <strong className="analytics-value">
                    {number(summary.total[name])}
                  </strong>
                </Panel>
              ))}
            </div>
            {summary.total.pageviews === 0 ? (
              <Notice tone="info" title={t('noData.title')}>
                {t('noData.description')}
              </Notice>
            ) : null}
            <Panel title={t('trend')}>
              <div
                className="analytics-metric-picker"
                role="group"
                aria-label={t('chartMetric')}
              >
                {(['pageviews', 'visits'] as const).map((name) => (
                  <Button
                    type="button"
                    key={name}
                    size="sm"
                    variant={metric === name ? 'primary' : 'secondary'}
                    aria-pressed={metric === name}
                    onClick={() => setMetric(name)}
                  >
                    {t(name)}
                  </Button>
                ))}
              </div>
              <AnalyticsTrendChart
                daily={daily}
                metric={metric}
                label={t('chartLabel', { metric: t(metric) })}
                formatNumber={number}
                formatDate={date}
              />
              <details>
                <summary>{t('dailyValues')}</summary>
                <DataTable caption={t('trend')} minWidthPx={300}>
                  <thead>
                    <tr>
                      <th scope="col">{t('date')}</th>
                      <th scope="col">{t('pageviews')}</th>
                      <th scope="col">{t('visits')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {daily.map((day) => (
                      <tr key={day.date}>
                        <th scope="row">{day.date}</th>
                        <td>{number(day.pageviews)}</td>
                        <td>{number(day.visits)}</td>
                      </tr>
                    ))}
                  </tbody>
                </DataTable>
              </details>
            </Panel>
            <div className="analytics-rankings">
              <Panel title={t('topPaths')}>
                {ranking(summary.top_paths, true)}
              </Panel>
              <Panel title={t('topReferrers')}>
                {ranking(summary.top_referrers, false)}
              </Panel>
            </div>
            <p className="analytics-footnote">{t('sampling')}</p>
          </>
        ) : null}
      </div>
    </main>
  );
}
