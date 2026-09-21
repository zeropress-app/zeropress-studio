// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changeLocale } from '../i18n';
import { STUDIO_PATHS } from '../routing/studio-routes';
import { Field, Panel } from './primitives';
import { SettingsScreen } from './SettingsScreen';

const paths = [
  STUDIO_PATHS.generalSettings,
  STUDIO_PATHS.publishingSettings,
  STUDIO_PATHS.analyticsSettings,
  STUDIO_PATHS.interfaceSettings,
  STUDIO_PATHS.brandingSettings,
  STUDIO_PATHS.mediaSettings,
  STUDIO_PATHS.outputSettings,
  STUDIO_PATHS.routingSettings,
  STUDIO_PATHS.customCodeSettings,
  STUDIO_PATHS.newsletterSettings,
];

const copy = {
  documentTitle: 'Settings — Studio',
  kicker: 'SETTINGS',
  title: 'Example settings',
  description: 'Edit this section.',
  loading: { title: 'Loading settings' },
  loadError: { title: 'Could not load settings' },
  saved: 'Settings saved.',
  validation: 'Review the form.',
  conflict: { title: 'Settings changed elsewhere', description: 'Your draft is kept.' },
  save: 'Save settings',
};

function TestSettings(input: {
  navigation?: 'site' | 'edge';
  load?: 'ready' | 'loading' | 'error';
  save?: 'idle' | 'conflict';
  onSave: () => void;
  onRetry: () => void;
}) {
  const [value, setValue] = useState('Saved value');
  return (
    <SettingsScreen
      navigation={input.navigation ?? 'site'}
      copy={copy}
      load={input.load ?? 'ready'}
      onRetry={input.onRetry}
      save={input.save ?? 'idle'}
      dirty={value !== 'Saved value'}
      onReset={() => setValue('Saved value')}
      onSubmit={(event) => {
        event.preventDefault();
        input.onSave();
      }}
    >
      <Panel title="Example section">
        <Field label="Example value">
          {(control) => (
            <input {...control} value={value} onChange={(event) => setValue(event.target.value)} />
          )}
        </Field>
      </Panel>
    </SettingsScreen>
  );
}

const routers: ReturnType<typeof createMemoryRouter>[] = [];
function setup(input: {
  initial?: string;
  navigation?: 'site' | 'edge';
  load?: 'ready' | 'loading' | 'error';
  save?: 'idle' | 'conflict';
} = {}) {
  const onSave = vi.fn();
  const onRetry = vi.fn();
  const routePaths = input.navigation === 'edge'
    ? [STUDIO_PATHS.mailSettings]
    : paths;
  const router = createMemoryRouter(routePaths.map((path) => ({
    path,
    element: <TestSettings key={path} {...input} onSave={onSave} onRetry={onRetry} />,
  })), { initialEntries: [input.initial ?? routePaths[0]] });
  routers.push(router);
  const result = render(<RouterProvider router={router} />);
  return { ...result, router, onSave, onRetry };
}

beforeEach(async () => {
  localStorage.clear();
  await changeLocale('en');
});
afterEach(() => {
  cleanup();
  routers.splice(0).forEach((router) => router.dispose());
});

describe('Site settings presentation', () => {
  it.each([
    { locale: 'en', nav: 'Site settings', picker: 'Settings section', current: 'Custom Code' },
    { locale: 'ko', nav: '사이트 설정', picker: '설정 항목', current: 'Custom Code' },
  ] as const)('keeps all site settings routes in the $locale selector and Operations outside it', async (input) => {
    await changeLocale(input.locale);
    setup({ initial: `${STUDIO_PATHS.customCodeSettings}/` });
    const nav = screen.getByRole('navigation', { name: input.nav });
    const picker = within(nav).getByRole('combobox', { name: input.picker });
    expect(picker).toHaveValue(STUDIO_PATHS.customCodeSettings);
    expect(within(picker).getAllByRole('option').map((option) => option.getAttribute('value')))
      .toEqual(paths);
    expect(within(nav).getByRole('link', { name: input.current }))
      .toHaveAttribute('aria-current', 'page');
    const external = nav.querySelector('a[target="_blank"]');
    expect(external).toHaveAttribute('href', '/system/operations');
    expect(external).toHaveAttribute('rel', 'noopener noreferrer');
    expect(within(picker).queryByRole('option', { name: /Recovery|복구/u })).toBeNull();
    expect(nav.querySelectorAll('.site-settings-sections a svg')).toHaveLength(paths.length);
  });

  it.each(['selector', 'link'] as const)('guards a section change through the %s without saving the draft', async (method) => {
    const { router, onSave } = setup();
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Example value' }), ' edited');

    async function leave() {
      if (method === 'selector') {
        await user.selectOptions(screen.getByRole('combobox', { name: 'Settings section' }), STUDIO_PATHS.mediaSettings);
      } else {
        await user.click(screen.getByRole('link', { name: 'Media' }));
      }
    }
    await leave();
    const dialog = screen.getByRole('dialog', { name: 'Leave without saving?' });
    expect(within(dialog).getByRole('button', { name: 'Keep editing' })).toHaveFocus();
    expect(router.state.location.pathname).toBe(STUDIO_PATHS.generalSettings);
    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByRole('combobox', { name: 'Settings section' }))
      .toHaveValue(STUDIO_PATHS.generalSettings);
    expect(screen.getByRole('textbox', { name: 'Example value' }))
      .toHaveValue('Saved value edited');

    await leave();
    await user.click(screen.getByRole('button', { name: 'Discard and leave' }));
    expect(router.state.location.pathname).toBe(STUDIO_PATHS.mediaSettings);
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Settings section' }))
        .toHaveValue(STUDIO_PATHS.mediaSettings);
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it('undoes only the current draft and keeps save explicit', async () => {
    const { onSave, router } = setup();
    const user = userEvent.setup();
    const field = screen.getByRole('textbox', { name: 'Example value' });
    expect(screen.getByRole('button', { name: 'Undo changes' })).toBeDisabled();
    await user.type(field, ' edited');
    await user.click(screen.getByRole('button', { name: 'Undo changes' }));
    expect(field).toHaveValue('Saved value');
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Settings section' }), STUDIO_PATHS.brandingSettings);
    expect(router.state.location.pathname).toBe(STUDIO_PATHS.brandingSettings);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it.each(['loading', 'error'] as const)('keeps section navigation available during %s', async (load) => {
    const { onRetry, onSave } = setup({ load });
    expect(screen.getByRole('combobox', { name: 'Settings section' })).toBeEnabled();
    expect(screen.queryByRole('textbox', { name: 'Example value' })).toBeNull();
    if (load === 'error') {
      await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
      expect(onRetry).toHaveBeenCalledOnce();
    } else {
      expect(screen.getByRole('status')).toHaveTextContent('Loading settings');
    }
    expect(onSave).not.toHaveBeenCalled();
  });

  it('keeps an independent Edge layout while sharing the responsive settings grammar', () => {
    const { container } = setup({ navigation: 'edge' });
    const nav = screen.getByRole('navigation', { name: 'Edge services' });
    expect(nav).toHaveClass('edge-settings-navigation');
    expect(within(nav).getByRole('combobox', { name: 'Edge services section' }))
      .toHaveValue(STUDIO_PATHS.mailSettings);
    expect(container.querySelector('.site-settings-layout')).toBeNull();
    expect(container.querySelector('.edge-settings-layout')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset changes' }).querySelector('svg'))
      .toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save settings' }).querySelector('svg'))
      .toBeInTheDocument();
    const operations = within(nav).getByRole('link', {
      name: 'Maintenance & Recovery (opens in a new window)',
    });
    expect(operations).toHaveAttribute('target', '_blank');
  });
});
