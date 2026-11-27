type AuthScreenProps = {
  state: 'loading' | 'signedOut' | 'error';
  error: string;
  onRetry: () => void;
};

export function AuthScreen({ state, error, onRetry }: AuthScreenProps) {
  if (state === 'loading') {
    return (
      <main className="auth-page">
        <div className="auth-card"><span className="brand-mark">S</span><p>Checking your session…</p></div>
      </main>
    );
  }

  if (state === 'error') {
    return (
      <main className="auth-page">
        <section className="auth-card">
          <span className="brand-mark">S</span>
          <h1>Switchboard</h1>
          <p className="muted">We couldn’t connect to your inbox.</p>
          <p className="error-text">{error}</p>
          <button className="button button-primary" onClick={onRetry}>Try again</button>
        </section>
      </main>
    );
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <span className="brand-mark">S</span>
        <h1>Switchboard</h1>
        <p className="muted">A shared inbox for your support team.</p>
        {error && <p className="error-text">{error}</p>}
        <a className="button button-primary login-button" href="/auth/login">Sign in</a>
      </section>
    </main>
  );
}
