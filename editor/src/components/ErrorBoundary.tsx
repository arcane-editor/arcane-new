import React from 'react';

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  /** React's component stack for the throw — the only thing that names the
   *  component responsible for an update loop. Held in state so it reaches the
   *  screen: a desktop build has no devtools console open, so a crash that logs
   *  the stack and shows only a message is a dead end for the person hitting it. */
  componentStack: string | null;
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Optional compact fallback (e.g. for a single panel) instead of the
   *  full-screen error UI. Keeps a localized failure from taking over the app. */
  fallback?: React.ReactNode;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, componentStack: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    // componentStack is not available here — componentDidCatch fills it in.
    return { hasError: true, error, componentStack: null };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary] Caught:', error, info);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null, componentStack: null });
    window.location.reload();
  };

  handleDismiss = () => {
    this.setState({ hasError: false, error: null, componentStack: null });
  };

  handleCopy = () => {
    const { error, componentStack } = this.state;
    void navigator.clipboard.writeText(
      [error?.message ?? '', error?.stack ?? '', componentStack ?? ''].join('\n\n'),
    );
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback !== undefined) {
        return this.props.fallback;
      }
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100vh',
            background: 'var(--bg-primary, #1e1e1e)',
            color: 'var(--text-primary, #d4d4d4)',
            padding: 24,
            gap: 16,
            textAlign: 'center',
            fontFamily: 'system-ui, -apple-system, sans-serif',
          }}
        >
          <h2 style={{ margin: 0 }}>Something went wrong</h2>
          <p style={{ maxWidth: 600, color: 'var(--text-secondary, #999)' }}>
            {this.state.error?.message ?? 'An unexpected error occurred.'}
          </p>
          {this.state.componentStack && (
            <details style={{ maxWidth: 720, width: '100%', textAlign: 'left' }}>
              <summary style={{ cursor: 'pointer', color: 'var(--text-secondary, #999)' }}>
                Component stack
              </summary>
              <pre
                style={{
                  maxHeight: 260,
                  overflow: 'auto',
                  padding: 12,
                  border: '1px solid var(--border, #444)',
                  borderRadius: 4,
                  background: 'var(--bg-input, #252526)',
                  color: 'var(--text-secondary, #999)',
                  fontFamily: 'var(--font-mono, monospace)',
                  fontSize: 11,
                  lineHeight: 1.5,
                  whiteSpace: 'pre-wrap',
                }}
              >
                {this.state.componentStack.trim()}
              </pre>
            </details>
          )}
          <div style={{ display: 'flex', gap: 12 }}>
            {this.state.componentStack && (
              <button
                onClick={this.handleCopy}
                style={{
                  padding: '8px 16px',
                  background: 'transparent',
                  color: 'var(--text-primary, #d4d4d4)',
                  border: '1px solid var(--border, #444)',
                  borderRadius: 4,
                  cursor: 'pointer',
                }}
              >
                Copy details
              </button>
            )}
            <button
              onClick={this.handleReload}
              style={{
                padding: '8px 16px',
                background: 'var(--button-primary-bg, #007acc)',
                color: 'var(--button-primary-text, #fff)',
                border: 'none',
                borderRadius: 4,
                cursor: 'pointer',
              }}
            >
              Reload
            </button>
            <button
              onClick={this.handleDismiss}
              style={{
                padding: '8px 16px',
                background: 'transparent',
                color: 'var(--text-primary, #d4d4d4)',
                border: '1px solid var(--border, #444)',
                borderRadius: 4,
                cursor: 'pointer',
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
