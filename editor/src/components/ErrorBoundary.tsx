import React from 'react';

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
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
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary] Caught:', error, info);
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  handleDismiss = () => {
    this.setState({ hasError: false, error: null });
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
          <div style={{ display: 'flex', gap: 12 }}>
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
