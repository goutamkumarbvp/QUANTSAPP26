import { Component, type ErrorInfo, type ReactNode } from 'react';

/** Keeps one failing widget/page from blanking the whole app. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('UI error', error, info.componentStack);
  }

  override componentDidUpdate(prev: { resetKey?: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="card card-pad mx-auto mt-6 max-w-lg text-center">
        <div className="text-lg font-semibold">Something went wrong on this screen</div>
        <p className="mt-1 text-sm text-muted">{this.state.error.message}</p>
        <button className="btn-primary mt-3" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
