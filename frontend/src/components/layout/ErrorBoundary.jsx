import { Component } from 'react';

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[lease-management] Unhandled error:', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--red-600)' }}>
          <h2>Something went wrong</h2>
          <p style={{ color: 'var(--text-secondary)', marginTop: 8 }}>{this.state.error.message}</p>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            style={{ marginTop: 16, padding: '8px 16px', borderRadius: 8, border: 'none', background: 'var(--blue-600)', color: '#fff', fontWeight: 700 }}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
