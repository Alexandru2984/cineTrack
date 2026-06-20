import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * Catches render errors in the page subtree so a single bad API response (or any
 * thrown render) shows a recoverable fallback instead of unmounting the whole
 * app to a white screen. Mounted around <Routes> in App, so the navbar stays
 * usable and the user can navigate away (which resets the boundary).
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the error visible for debugging / analytics without crashing the app.
    console.error('Unhandled UI error:', error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="mx-auto max-w-md px-4 py-16 text-center">
        <AlertTriangle className="mx-auto h-12 w-12 text-[hsl(var(--destructive))]" />
        <h1 className="mt-4 text-2xl font-bold">Something went wrong</h1>
        <p className="mt-2 text-[hsl(var(--muted-foreground))]">
          This page hit an unexpected error. You can reload, or head back home.
        </p>
        <div className="mt-6 flex items-center justify-center gap-3">
          <button
            onClick={() => window.location.reload()}
            className="rounded-md bg-[hsl(var(--primary))] px-4 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            Reload page
          </button>
          <a
            href="/"
            className="rounded-md border border-[hsl(var(--border))] px-4 py-2 text-sm font-medium hover:bg-[hsl(var(--accent))]"
          >
            Go home
          </a>
        </div>
      </div>
    );
  }
}
