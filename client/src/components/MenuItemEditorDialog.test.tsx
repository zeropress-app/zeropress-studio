// @vitest-environment jsdom

import { useRef, useState } from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { menuReferenceKey, type MenuItem, type MenuReferenceResolution } from '../../../contracts/menus';
import { changeLocale } from '../i18n';
import { referencePost, referenceSearchResponse } from '../test/menu-reference-fixtures';
import { MenuItemEditorDialog } from './MenuItemEditorDialog';

const original: MenuItem = {
  id: '1'.repeat(32), title: 'Authored menu label',
  link: { kind: 'post', reference_id: 'e'.repeat(32) }, target: '_self', children: [],
  meta: { featured: true },
};
const available: MenuReferenceResolution = {
  kind: 'post', reference_id: 'e'.repeat(32), status: 'available',
  title: 'Original content', detail: 'original-content',
};

function setup(item = original, creating = false, resolution = available) {
  const onApply = vi.fn();
  const onClose = vi.fn();
  const onRetryReferences = vi.fn();
  const onSessionEnded = vi.fn();
  const onDirtyChange = vi.fn();
  function Harness() {
    const [open, setOpen] = useState(false);
    const trigger = useRef<HTMLButtonElement>(null);
    return <>
      <button ref={trigger} onClick={() => setOpen(true)}>Edit reference</button>
      {open && <MenuItemEditorDialog item={item} creating={creating}
        resolutions={new Map([[menuReferenceKey(resolution), resolution]])}
        referencesFailed={false} onRetryReferences={onRetryReferences}
        onSessionEnded={onSessionEnded} onDirtyChange={onDirtyChange} returnFocusRef={trigger}
        onApply={(next) => { onApply(next); setOpen(false); }}
        onClose={() => { onClose(); setOpen(false); }} />}
    </>;
  }
  render(<Harness />);
  return { onApply, onClose, onRetryReferences, onSessionEnded, onDirtyChange };
}

beforeEach(async () => { localStorage.clear(); await changeLocale('en'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Menu reference editing within one dialog', () => {
  it('keeps the editor draft and focus when search is canceled, then returns only an ID on apply', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((path: string) => Promise.resolve(referenceSearchResponse(path, [referencePost])));
    vi.stubGlobal('fetch', fetchMock);
    const callbacks = setup();
    await user.click(screen.getByRole('button', { name: 'Edit reference' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit item' });
    expect(within(dialog).getByRole('group', { name: 'Reference' })).toHaveTextContent('Original content');
    expect(screen.queryByRole('combobox', { name: 'Reference' })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    await user.type(screen.getByRole('textbox', { name: 'Title' }), ' edited');
    await user.click(screen.getByRole('checkbox', { name: 'Open in a new tab' }));
    await user.click(screen.getByText('Advanced metadata'));
    await user.clear(screen.getByRole('textbox', { name: 'Meta JSON (optional)' }));
    await user.type(screen.getByRole('textbox', { name: 'Meta JSON (optional)' }), '{{"featured":false}');

    await user.click(screen.getByRole('button', { name: 'Change linked content' }));
    await screen.findByRole('button', { name: 'Select Found Post' });
    expect(screen.getAllByRole('dialog')).toEqual([dialog]);
    expect(dialog).toHaveAccessibleName('Choose a Post');
    expect(screen.getByRole('searchbox', { name: 'Search content' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(dialog).toHaveAccessibleName('Edit item');
    expect(callbacks.onClose).not.toHaveBeenCalled();
    expect(callbacks.onApply).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Change linked content' })).toHaveFocus();
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Authored menu label edited');
    expect(screen.getByRole('checkbox', { name: 'Open in a new tab' })).toBeChecked();
    expect(screen.getByRole('textbox', { name: 'Meta JSON (optional)' })).toHaveValue('{"featured":false}');
    expect(screen.getByText('Advanced metadata').parentElement).toHaveAttribute('open');

    await user.click(screen.getByRole('button', { name: 'Change linked content' }));
    await user.click(await screen.findByRole('button', { name: 'Select Found Post' }));
    expect(screen.getByRole('group', { name: 'Reference' })).toHaveTextContent('Found Post');
    expect(screen.getByRole('button', { name: 'Change linked content' })).toHaveFocus();
    expect(callbacks.onApply).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Apply changes' }));
    expect(callbacks.onApply).toHaveBeenCalledExactlyOnceWith({
      ...original, title: 'Authored menu label edited', target: '_blank', meta: { featured: false },
      link: { kind: 'post', reference_id: referencePost.id },
    });
    expect(callbacks.onRetryReferences).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Edit reference' })).toHaveFocus();
    expect(fetchMock.mock.calls.every(([path]) => path.startsWith('/api/posts?'))).toBe(true);
  });

  it('uses a selected title for an untouched new item without overwriting a later authored label', async () => {
    const user = userEvent.setup();
    const second = { ...referencePost, id: 'b'.repeat(32), title: 'Second Post', slug: 'second-post' };
    vi.stubGlobal('fetch', vi.fn((path: string) => Promise.resolve(referenceSearchResponse(path, [referencePost, second]))));
    const callbacks = setup({ ...original, title: '', link: { kind: 'post', reference_id: '' } }, true);
    await user.click(screen.getByRole('button', { name: 'Edit reference' }));
    await user.click(screen.getByRole('button', { name: 'Find a Post' }));
    await user.click(await screen.findByRole('button', { name: 'Select Found Post' }));
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Found Post');
    await user.clear(screen.getByRole('textbox', { name: 'Title' }));
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'My menu label');
    await user.click(screen.getByRole('button', { name: 'Change linked content' }));
    expect(await screen.findByText('Currently linked')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Select Second Post' }));
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('My menu label');
    await user.click(screen.getByRole('button', { name: 'Add to end' }));
    expect(callbacks.onApply).toHaveBeenCalledExactlyOnceWith({
      ...original, title: 'My menu label', link: { kind: 'post', reference_id: second.id },
    });
  });

  it('discards a picked reference when the editor is canceled', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn((path: string) => Promise.resolve(referenceSearchResponse(path, [referencePost]))));
    const callbacks = setup();
    await user.click(screen.getByRole('button', { name: 'Edit reference' }));
    await user.click(screen.getByRole('button', { name: 'Change linked content' }));
    await user.click(await screen.findByRole('button', { name: 'Select Found Post' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(callbacks.onApply).not.toHaveBeenCalled();
    expect(callbacks.onRetryReferences).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Edit reference' }));
    expect(screen.getByRole('group', { name: 'Reference' })).toHaveTextContent('Original content');
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue(original.title);
  });

  it('refreshes exact-ID state after explicitly applying a previously missing target with the same ID', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn((path: string) => Promise.resolve(referenceSearchResponse(path, [referencePost]))));
    const item = { ...original, link: { kind: 'post' as const, reference_id: referencePost.id } };
    const callbacks = setup(item, false, { kind: 'post', reference_id: referencePost.id, status: 'missing' });
    await user.click(screen.getByRole('button', { name: 'Edit reference' }));
    expect(screen.getByText('Missing reference (remove or replace before saving)')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Change linked content' }));
    await user.click(await screen.findByRole('button', { name: 'Select Found Post' }));
    expect(screen.queryByText('Missing reference (remove or replace before saving)')).not.toBeInTheDocument();
    expect(callbacks.onRetryReferences).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Apply changes' }));
    expect(callbacks.onApply).toHaveBeenCalledExactlyOnceWith(item);
    expect(callbacks.onRetryReferences).toHaveBeenCalledOnce();
  });
});
