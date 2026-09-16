import {
  Component,
  Suspense,
  lazy,
  useMemo,
  useState,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import type { MonacoSourceLanguage } from '../editor/monaco-runtime';
import { Button, Notice, Spinner } from './primitives';

class MonacoLoadErrorBoundary extends Component<{
  resetKey: number;
  fallback: ReactNode;
  children: ReactNode;
}, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // The caller owns the retry UI. Never change or clear authored source.
  }

  componentDidUpdate(previous: Readonly<{ resetKey: number }>) {
    if (previous.resetKey !== this.props.resetKey && this.state.failed) {
      this.setState({ failed: false });
    }
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * Lazy Monaco surface for exact source fields outside the content editor.
 * The controlled textarea fallback deliberately has the same value contract,
 * so a chunk/runtime failure cannot strand or rewrite an administrator draft.
 */
export function LazyMonacoSourceEditor(input: {
  id: string;
  describedBy?: string;
  invalid?: boolean;
  value: string;
  documentType: MonacoSourceLanguage;
  disabled: boolean;
  label: string;
  fallbackRows: number;
  copy: {
    loading: string;
    failedTitle: string;
    failedDescription: string;
    retry: string;
  };
  onChange: (value: string) => void;
}) {
  const [retry, setRetry] = useState(0);
  const [runtimeUnavailable, setRuntimeUnavailable] = useState(false);
  const MonacoEditor = useMemo(() => lazy(async () => {
    const module = await import('./MonacoSourceEditor');
    return { default: module.MonacoSourceEditor };
  }), [retry]);

  const fallback = (
    <>
      <Notice
        tone="warning"
        title={input.copy.failedTitle}
        actions={(
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setRuntimeUnavailable(false);
              setRetry((value) => value + 1);
            }}
          >
            {input.copy.retry}
          </Button>
        )}
      >
        {input.copy.failedDescription}
      </Notice>
      <textarea
        id={input.id}
        aria-describedby={input.describedBy}
        aria-invalid={input.invalid}
        rows={input.fallbackRows}
        value={input.value}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        disabled={input.disabled}
        onChange={(event) => input.onChange(event.target.value)}
      />
    </>
  );

  if (runtimeUnavailable) return fallback;

  return (
    <MonacoLoadErrorBoundary resetKey={retry} fallback={fallback}>
      <Suspense fallback={(
        <div className="settings-code-editor-loading" role="status">
          <span className="content-editor-source-loading-inner">
            <Spinner />
            {input.copy.loading}
          </span>
        </div>
      )}>
        <MonacoEditor
          key={retry}
          id={input.id}
          describedBy={input.describedBy}
          invalid={input.invalid}
          value={input.value}
          documentType={input.documentType}
          disabled={input.disabled}
          label={input.label}
          onChange={input.onChange}
          onUnavailable={() => setRuntimeUnavailable(true)}
        />
      </Suspense>
    </MonacoLoadErrorBoundary>
  );
}
