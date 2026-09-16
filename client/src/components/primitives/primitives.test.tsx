// @vitest-environment jsdom

import { useRef, useState } from 'react';
import { Folder, Tags } from 'lucide-react';
import {
  cleanup,
  render,
  screen,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  ActionMenu,
  Button,
  ConfigurationReference,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  FilterTabs,
  Notice,
  PageHeader,
  Panel,
  Spinner,
  StatusPill,
  Tabs,
} from './index';
import { modalLayerElement } from './modal-layer';

afterEach(() => {
  cleanup();
});

describe('ConfigurationReference', () => {
  it('displays the setting name and recommended storage type as text', () => {
    render(
      <ConfigurationReference
        name="STUDIO_AUTH_SECRET"
        kind="worker_secret"
      />,
    );

    expect(screen.getByText('STUDIO_AUTH_SECRET').tagName).toBe('CODE');
    expect(screen.getByText('Secret')).toBeInTheDocument();
  });
});

describe('Field', () => {
  it('associates the label with the control and combines hint and error descriptions', () => {
    render(
      <Field label="Email" hint="Use your work address" error="Invalid format">
        {(control) => <input {...control} type="email" defaultValue="" />}
      </Field>,
    );

    const control = screen.getByLabelText('Email');
    expect(control).toHaveAttribute('aria-invalid', 'true');
    expect(control).toHaveAccessibleDescription(
      'Use your work address Invalid format',
    );
  });

  it('omits aria-invalid when there is no error', () => {
    render(
      <Field label="Title">
        {(control) => <input {...control} type="text" defaultValue="" />}
      </Field>,
    );

    const control = screen.getByLabelText('Title');
    expect(control).not.toHaveAttribute('aria-invalid');
    expect(control).not.toHaveAttribute('aria-describedby');
  });

  it('retains the hidden label and leading affordance in a compact toolbar', () => {
    const { container } = render(
      <Field label="Search posts" labelHidden leading={<span>Search</span>}>
        {(control) => <input {...control} type="search" defaultValue="" />}
      </Field>,
    );

    expect(screen.getByRole('searchbox', { name: 'Search posts' }))
      .toBeInTheDocument();
    expect(container.querySelector('.studio-field-leading'))
      .toHaveTextContent('Search');
    expect(screen.getByText('Search posts')).toHaveClass('visually-hidden');
  });

  it('preserves the label association in the document-title variant', () => {
    const { container } = render(
      <Field label="Post title" labelHidden variant="title">
        {(control) => <input {...control} type="text" defaultValue="" />}
      </Field>,
    );

    expect(screen.getByRole('textbox', { name: 'Post title' }))
      .toBeInTheDocument();
    expect(container.querySelector('.studio-field'))
      .toHaveClass('studio-field-title');
  });

  it('generates unique IDs when multiple fields are rendered', () => {
    render(
      <>
        <Field label="First item">
          {(control) => <input {...control} type="text" defaultValue="" />}
        </Field>
        <Field label="Second item">
          {(control) => <input {...control} type="text" defaultValue="" />}
        </Field>
      </>,
    );

    const first = screen.getByLabelText('First item');
    const second = screen.getByLabelText('Second item');
    expect(first.id).not.toBe(second.id);
  });
});

describe('FilterTabs', () => {
  it('preserves toggle-button semantics and counts in the underline variant', async () => {
    const onChange = vi.fn();
    const { container } = render(
      <FilterTabs
        label="Post status"
        value="all"
        appearance="underline"
        items={[
          { value: 'all', label: 'All', count: 4 },
          { value: 'draft', label: 'Drafts', count: 2 },
        ]}
        onChange={onChange}
      />,
    );

    expect(container.querySelector('.studio-filter-tabs'))
      .toHaveClass('studio-filter-tabs-underline');
    expect(screen.getByRole('button', { name: 'All 4' }))
      .toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Drafts 2' }));
    expect(onChange).toHaveBeenCalledWith('draft');
  });
});

describe('ActionMenu', () => {
  it('prevents opening when disabled and closes an already open menu', async () => {
    const onSelect = vi.fn();
    const items = [{ id: 'edit', kind: 'button' as const, label: 'Edit', onSelect }];
    const user = userEvent.setup();
    const { rerender } = render(<ActionMenu label="Comment actions" items={items} disabled />);
    const trigger = screen.getByRole('button', { name: 'Comment actions' });
    expect(trigger).toBeDisabled();
    await user.click(trigger);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    rerender(<ActionMenu label="Comment actions" items={items} />);
    await user.click(trigger);
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeInTheDocument();
    rerender(<ActionMenu label="Comment actions" items={items} disabled />);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(onSelect).not.toHaveBeenCalled();
    rerender(<ActionMenu label="Comment actions" items={items} />);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('opens a portal menu, runs actions, and restores focus on Escape', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <ActionMenu
        label="First post actions"
        items={[{
          id: 'delete',
          kind: 'button',
          label: 'Delete permanently',
          tone: 'critical',
          onSelect,
        }]}
      />,
    );

    const trigger = screen.getByRole('button', { name: 'First post actions' });
    await user.click(trigger);
    const menu = screen.getByRole('menu', { name: 'First post actions' });
    expect(menu.parentElement).toBe(document.body);
    expect(screen.getByRole('menuitem', { name: 'Delete permanently' }))
      .toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    await user.click(screen.getByRole('menuitem', { name: 'Delete permanently' }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('returns focus to the trigger after closing a Dialog opened by a menu item', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <ActionMenu
            label="First post actions"
            items={[{
              id: 'edit',
              kind: 'button',
              label: 'Edit',
              onSelect: () => setOpen(true),
            }]}
          />
          {open ? (
            <Dialog
              open
              onClose={() => setOpen(false)}
              title="Edit post"
              actions={(
                <Button type="button" onClick={() => setOpen(false)}>
                  Close
                </Button>
              )}
            />
          ) : null}
        </>
      );
    }

    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'First post actions' });
    await user.click(trigger);
    await user.click(screen.getByRole('menuitem', { name: 'Edit' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(trigger).toHaveFocus();
  });
});

describe('Dialog', () => {
  function Harness(input: { busy?: boolean; onClose: () => void }) {
    return (
      <Dialog
        open
        onClose={input.onClose}
        busy={input.busy}
        title="Delete this post?"
        description="This cannot be undone"
        kicker="Confirm"
        actions={(
          <>
            <Button type="button" onClick={input.onClose}>Cancel</Button>
            <Button type="button" variant="danger">Delete</Button>
          </>
        )}
      />
    );
  }

  it('exposes the title and description as the accessible name and description', () => {
    render(<Harness onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Delete this post?');
    expect(dialog).toHaveAccessibleDescription('This cannot be undone');
  });

  it('moves focus into the dialog when it opens', () => {
    render(<Harness onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('ignores Escape while busy', async () => {
    const onClose = vi.fn();
    render(<Harness busy onClose={onClose} />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('cycles Tab focus within the dialog', async () => {
    render(<Harness onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    const remove = within(dialog).getByRole('button', { name: 'Delete' });

    cancel.focus();
    await userEvent.tab();
    expect(remove).toHaveFocus();
    await userEvent.tab();
    expect(cancel).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(remove).toHaveFocus();
  });

  it('supports initialFocusRef to select the initial focus target', () => {
    function WithInitialFocus() {
      const ref = useRef<HTMLButtonElement>(null);
      return (
        <Dialog
          open
          onClose={() => {}}
          title="Confirm"
          initialFocusRef={ref}
          actions={(
            <>
              <Button type="button">First button</Button>
              <Button type="button" ref={ref}>Second button</Button>
            </>
          )}
        />
      );
    }
    render(<WithInitialFocus />);
    expect(screen.getByRole('button', { name: 'Second button' })).toHaveFocus();
  });

  it('restores the previous focus position when closed', async () => {
    function Toggle() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button type="button" onClick={() => setOpen(true)}>Open</Button>
          <Dialog
            open={open}
            onClose={() => setOpen(false)}
            title="Confirm"
            actions={<Button type="button" onClick={() => setOpen(false)}>Close</Button>}
          />
        </>
      );
    }
    render(<Toggle />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await userEvent.click(opener);
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(opener).toHaveFocus();
  });

  it('keeps focus in the input while typing inside the dialog', async () => {
    // onClose is usually an inline arrow function. Adding it to effect dependencies
    // would rerun the effect and initial focus placement on every render,
    // stealing focus from the control being edited.
    function WithTextField() {
      const [value, setValue] = useState('');
      const cancelRef = useRef<HTMLButtonElement>(null);
      return (
        <Dialog
          open
          onClose={() => {}}
          title="Write a comment"
          initialFocusRef={cancelRef}
        >
          <Field label="Content">
            {(control) => (
              <textarea
                {...control}
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            )}
          </Field>
          <Button ref={cancelRef} type="button">Cancel</Button>
        </Dialog>
      );
    }
    render(<WithTextField />);
    const textarea = screen.getByLabelText('Content');
    await userEvent.type(textarea, 'Enter multiple characters');
    expect(textarea).toHaveValue('Enter multiple characters');
    expect(textarea).toHaveFocus();
  });

  it('returns focus to the trigger after conditional mounting', async () => {
    // Many screens mount dialogs conditionally, after the trigger click.
    // Return-focus tracking inside the component lifecycle would then miss the trigger
    // and let focus fall back to the document body.
    function LateMounted() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <main inert={open}>
            <Button type="button" onClick={() => setOpen(true)}>Open</Button>
          </main>
          {open ? (
            <Dialog
              open
              onClose={() => setOpen(false)}
              title="Confirm"
              actions={(
                <Button type="button" onClick={() => setOpen(false)}>Close</Button>
              )}
            />
          ) : null}
        </>
      );
    }
    render(<LateMounted />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await userEvent.click(opener);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(opener).toHaveFocus();
  });

  it('uses returnFocusRef when the original trigger has been removed', async () => {
    function MenuOpened() {
      const [menuOpen, setMenuOpen] = useState(true);
      const [open, setOpen] = useState(false);
      const anchorRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <Button
            ref={anchorRef}
            type="button"
            onClick={() => setMenuOpen(true)}
          >
            Account
          </Button>
          {menuOpen ? (
            <Button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                setOpen(true);
              }}
            >
              Sign out
            </Button>
          ) : null}
          <Dialog
            open={open}
            onClose={() => setOpen(false)}
            title="Confirm"
            returnFocusRef={anchorRef}
            actions={<Button type="button" onClick={() => setOpen(false)}>Close</Button>}
          />
        </>
      );
    }
    render(<MenuOpened />);
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('button', { name: 'Account' })).toHaveFocus();
  });

  it('locks background scrolling while open and restores it on close', async () => {
    function Toggle() {
      const [open, setOpen] = useState(true);
      return (
        <Dialog
          open={open}
          onClose={() => setOpen(false)}
          title="Confirm"
          actions={<Button type="button" onClick={() => setOpen(false)}>Close</Button>}
        />
      );
    }
    render(<Toggle />);
    expect(document.body.style.overflow).toBe('hidden');
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(document.body.style.overflow).toBe('');
  });

  it('renders nothing while closed', () => {
    render(<Dialog open={false} onClose={() => {}} title="Confirm" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('portals into the modal layer regardless of the render location', () => {
    // A dialog left in the screen tree would become inert with the background.
    function Nested() {
      return (
        <main>
          <section>
            <Dialog open onClose={() => {}} title="Confirm" />
          </section>
        </main>
      );
    }
    render(<Nested />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.closest('main')).toBeNull();
    expect(dialog.closest('.studio-modal-layer')).not.toBeNull();
    expect(modalLayerElement()?.parentElement).toBe(document.body);
  });

  it('makes the background inert while open and restores it on close', async () => {
    function Toggle() {
      const [open, setOpen] = useState(true);
      return (
        <Dialog
          open={open}
          onClose={() => setOpen(false)}
          title="Confirm"
          actions={<Button type="button" onClick={() => setOpen(false)}>Close</Button>}
        />
      );
    }
    const { container } = render(<Toggle />);
    // The test container is a child of body and must be locked as background content.
    expect(container.hasAttribute('inert')).toBe(true);
    // Apply aria-hidden as well because accessibility-tree support for inert varies.
    expect(container).toHaveAttribute('aria-hidden', 'true');
    expect(modalLayerElement()?.hasAttribute('inert')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(container.hasAttribute('inert')).toBe(false);
    expect(container.hasAttribute('aria-hidden')).toBe(false);
  });

  it('keeps the background locked until the last nested dialog closes', async () => {
    // A modal may open another modal, such as a navigation warning above a save confirmation.
    function Stacked() {
      const [outer, setOuter] = useState(true);
      const [inner, setInner] = useState(true);
      return (
        <>
          <Dialog
            open={outer}
            onClose={() => setOuter(false)}
            title="Outer"
            actions={<Button type="button" onClick={() => setOuter(false)}>Close outer</Button>}
          />
          <Dialog
            open={inner}
            onClose={() => setInner(false)}
            title="Inner"
            actions={<Button type="button" onClick={() => setInner(false)}>Close inner</Button>}
          />
        </>
      );
    }
    const { container } = render(<Stacked />);
    expect(container.hasAttribute('inert')).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Close inner' }));
    // One modal remains open, so the background must stay locked.
    expect(container.hasAttribute('inert')).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Close outer' }));
    expect(container.hasAttribute('inert')).toBe(false);
  });

  it('preserves elements that were already inert before opening', async () => {
    // Preserve inert set directly by a screen.
    // Removing state owned by the screen would reopen the background.
    const preset = document.createElement('div');
    preset.setAttribute('inert', '');
    document.body.append(preset);
    try {
      function Toggle() {
        const [open, setOpen] = useState(true);
        return (
          <Dialog
            open={open}
            onClose={() => setOpen(false)}
            title="Confirm"
            actions={<Button type="button" onClick={() => setOpen(false)}>Close</Button>}
          />
        );
      }
      render(<Toggle />);
      expect(preset.hasAttribute('inert')).toBe(true);
      // Do not add aria-hidden to an element this layer did not lock.
      expect(preset.hasAttribute('aria-hidden')).toBe(false);
      await userEvent.click(screen.getByRole('button', { name: 'Close' }));
      expect(preset.hasAttribute('inert')).toBe(true);
    } finally {
      preset.remove();
    }
  });
});

describe('Notice', () => {
  it('announces errors as alerts and other notices as status updates', () => {
    const { unmount } = render(
      <Notice tone="error">Could not save</Notice>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save');
    unmount();

    render(<Notice tone="success">Saved</Notice>);
    expect(screen.getByRole('status')).toHaveTextContent('Saved');
  });

  it('describes the tone in text as well as color', () => {
    // Derive the announcement prefix from tone so callers cannot repeat the title.
    render(<Notice tone="warning" title="Needs attention">Body</Notice>);
    expect(screen.getByRole('status')).toHaveTextContent('Warning:');
  });
});

describe('StatusPill', () => {
  it('maps the tone to a class', () => {
    render(<StatusPill tone="positive">Published</StatusPill>);
    expect(screen.getByText('Published')).toHaveClass('studio-pill-positive');
  });

  it('supports a text prefix so color is not the only indicator', () => {
    render(<StatusPill tone="critical" srPrefix="Status">Spam</StatusPill>);
    expect(screen.getByText(/Spam/u)).toHaveTextContent('Status Spam');
  });
});

describe('Panel', () => {
  it('creates a named region when a title is provided', () => {
    render(<Panel title="Mail settings"><p>Body</p></Panel>);
    expect(screen.getByRole('region', { name: 'Mail settings' }))
      .toBeInTheDocument();
  });

  it('renders a supporting icon without changing the heading\'s accessible name', () => {
    render(
      <Panel
        title="Database backup"
        leading={<span data-testid="panel-leading" aria-hidden="true">*</span>}
      >
        <p>Body</p>
      </Panel>,
    );
    expect(screen.getByTestId('panel-leading').parentElement)
      .toHaveClass('studio-panel-leading');
    expect(screen.getByRole('region', { name: 'Database backup' }))
      .toBeInTheDocument();
  });

  it('avoids creating an unnamed region without a title', () => {
    render(<Panel><p>Body</p></Panel>);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('preserves the landmark structure in the split layout', () => {
    // Column layout is visual only. Preserve the heading association and section name.
    render(
      <Panel layout="split" title="Media delivery" description="Description">
        <p>Body</p>
      </Panel>,
    );
    const region = screen.getByRole('region', { name: 'Media delivery' });
    expect(region).toHaveClass('studio-panel', 'studio-panel-split');
  });
});

describe('PageHeader', () => {
  it('renders an h1 with the provided ID', () => {
    render(
      <PageHeader titleId="posts-title" title="Posts" description="List" />,
    );
    const heading = screen.getByRole('heading', { level: 1, name: 'Posts' });
    expect(heading).toHaveAttribute('id', 'posts-title');
  });
});

describe('DataTable', () => {
  it('names the table and makes its scroll region keyboard-accessible', () => {
    render(
      <DataTable caption="Post list" minWidthPx={620}>
        <thead><tr><th scope="col">Title</th></tr></thead>
        <tbody><tr><td>First post</td></tr></tbody>
      </DataTable>,
    );
    expect(screen.getByRole('table', { name: 'Post list' }))
      .toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Post list' }))
      .toHaveAttribute('tabindex', '0');
  });

  it('gives the scroll region one table boundary in the framed variant', () => {
    render(
      <DataTable caption="Post list" framed>
        <thead><tr><th scope="col">Title</th></tr></thead>
        <tbody><tr><td>First post</td></tr></tbody>
      </DataTable>,
    );
    expect(screen.getByRole('group', { name: 'Post list' }))
      .toHaveClass('studio-table-scroll-framed');
  });
});

describe('EmptyState', () => {
  it('renders a heading only when a heading level is provided', () => {
    // Avoid duplicate headings inside an already titled Panel, but include a heading
    // in the document outline when the empty state replaces a table or list section.
    const { unmount } = render(<EmptyState title="No results" />);
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    unmount();

    render(<EmptyState headingLevel={2} title="No results" />);
    expect(screen.getByRole('heading', { level: 2, name: 'No results' }))
      .toBeInTheDocument();
  });

  it('creates a status region only when explicitly requested', () => {
    const { unmount } = render(<EmptyState title="No results" />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    unmount();

    render(<EmptyState announce title="No results" />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});

describe('Tabs', () => {
  function Harness(input: {
    onChange?: (value: string) => void;
    disabled?: boolean;
  } = {}) {
    const [value, setValue] = useState('overview');
    return (
      <Tabs
        label="Newsletter views"
        value={value}
        items={[
          { value: 'overview', label: 'Overview' },
          { value: 'subscribers', label: 'Subscribers' },
          { value: 'runtime', label: 'Runtime' },
        ]}
        disabled={input.disabled}
        onChange={(next) => {
          setValue(next);
          input.onChange?.(next);
        }}
      >
        <p>{value} panel</p>
      </Tabs>
    );
  }

  it('associates the tablist with its tabpanel', () => {
    render(<Harness />);
    const list = screen.getByRole('tablist', { name: 'Newsletter views' });
    expect(list).toBeInTheDocument();
    const selected = screen.getByRole('tab', { selected: true });
    expect(selected).toHaveTextContent('Overview');
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAccessibleName('Overview');
    expect(selected).toHaveAttribute('aria-controls', panel.id);
  });

  it('shows decorative icons and localized counts while preserving the panel name', () => {
    const onChange = vi.fn();
    const items = [
      { value: 'category', label: 'Categories', icon: Folder, count: '0' },
      { value: 'tag', label: 'Tags', icon: Tags, count: '1,234' },
    ];
    const { rerender } = render(
      <Tabs label="Categories and tags" value="category" items={items} onChange={onChange}>
        <p>Category content</p>
      </Tabs>,
    );
    const category = screen.getByRole('tab', { name: 'Categories 0' });
    expect(category.querySelector('.studio-tab-icon')).toHaveAttribute('aria-hidden', 'true');
    expect(category.querySelector('.studio-tab-count')).toHaveTextContent('0');
    expect(screen.getByRole('tab', { name: 'Tags 1,234' })).toBeInTheDocument();
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('Categories 0');

    rerender(
      <Tabs label="Categories and tags" value="category" items={[
        { ...items[0], count: undefined }, items[1],
      ]} onChange={onChange}>
        <p>Category content</p>
      </Tabs>,
    );
    expect(screen.getByRole('tab', { name: 'Categories' })).toBe(category);
    expect(category.querySelector('.studio-tab-count')).not.toBeInTheDocument();
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('Categories');
  });

  it('keeps only the selected tab in the Tab sequence', () => {
    render(<Harness />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.getAttribute('tabindex')))
      .toEqual(['0', '-1', '-1']);
  });

  it('navigates with arrow keys and Home / End', async () => {
    render(<Harness />);
    screen.getByRole('tab', { name: 'Overview' }).focus();

    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { selected: true }))
      .toHaveTextContent('Subscribers');
    expect(screen.getByRole('tab', { name: 'Subscribers' })).toHaveFocus();

    await userEvent.keyboard('{End}');
    expect(screen.getByRole('tab', { selected: true }))
      .toHaveTextContent('Runtime');

    await userEvent.keyboard('{ArrowRight}');
    // Moving right from the last tab wraps to the first.
    expect(screen.getByRole('tab', { selected: true }))
      .toHaveTextContent('Overview');

    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { selected: true }))
      .toHaveTextContent('Runtime');

    await userEvent.keyboard('{Home}');
    expect(screen.getByRole('tab', { selected: true }))
      .toHaveTextContent('Overview');
  });

  it('changes the selection on click', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Runtime' }));
    expect(onChange).toHaveBeenCalledWith('runtime');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('runtime panel');
  });

  it('keeps the current tab selected while locked', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} disabled />);
    // The selected tab remains enabled, preserving roving tabindex.
    expect(screen.getByRole('tab', { name: 'Overview' })).toBeEnabled();
    expect(screen.getByRole('tab', { name: 'Subscribers' })).toBeDisabled();
    expect(screen.getByRole('tab', { name: 'Runtime' })).toBeDisabled();

    await userEvent.click(screen.getByRole('tab', { name: 'Runtime' }));
    expect(onChange).not.toHaveBeenCalled();

    screen.getByRole('tab', { name: 'Overview' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('tab', { selected: true }))
      .toHaveTextContent('Overview');
  });
});

describe('Button', () => {
  it('maps variant and size to classes', () => {
    render(
      <Button type="submit" variant="primary" size="sm">Save</Button>,
    );
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toHaveAttribute('type', 'submit');
    expect(button).toHaveClass(
      'studio-button',
      'studio-button-primary',
      'studio-button-sm',
    );
  });

  it('does not call the click handler when disabled', async () => {
    const onClick = vi.fn();
    render(<Button type="button" disabled onClick={onClick}>Save</Button>);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('keeps text actions as keyboard-operable buttons rather than links', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <Button type="button" variant="text" aria-label="Edit News" onClick={onClick}>
        News
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Edit News' });
    expect(button).toHaveClass('studio-button-text');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    await user.tab();
    expect(button).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledOnce();

    rerender(
      <Button type="button" variant="text" disabled aria-label="Edit News" onClick={onClick}>
        News
      </Button>,
    );
    await user.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe('Spinner', () => {
  it('keeps decorative content out of the parent control\'s accessible name', () => {
    const { container } = render(
      <Button type="submit"><Spinner />Saving</Button>,
    );
    // The spinner is decorative; adjacent text alone supplies the name.
    expect(screen.getByRole('button')).toHaveAccessibleName('Saving');
    expect(container.querySelector('.studio-spinner'))
      .toHaveAttribute('aria-hidden', 'true');
  });

  it('defaults to sm and supports lg', () => {
    const { container } = render(
      <>
        <Spinner />
        <Spinner size="lg" />
      </>,
    );
    const [small, large] = [...container.querySelectorAll('.studio-spinner')];
    expect(small).toHaveClass('studio-spinner-sm');
    expect(large).toHaveClass('studio-spinner-lg');
  });

  it('leaves spacing to its container', () => {
    // Margins on the previous spinner displaced it above adjacent text.
    // The container now owns spacing to preserve alignment.
    const { container } = render(<Spinner size="lg" />);
    const spinner = container.querySelector<HTMLElement>('.studio-spinner');
    expect(spinner?.style.margin).toBe('');
    expect(spinner?.getAttribute('style')).toBeNull();
  });
});
