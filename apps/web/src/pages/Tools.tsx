import { Link } from 'react-router-dom';
import { PageHeader } from '../components/ui';
import { NAV } from '../lib/nav';

export default function Tools() {
  return (
    <div>
      <PageHeader title="All Tools" subtitle={`${NAV.reduce((a, g) => a + g.items.length, 0)} analytics & trading tools`} />
      <div className="space-y-4">
        {NAV.map((g) => (
          <section key={g.title}>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">{g.title}</h2>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {g.items.map((it) => (
                <Link key={it.to} to={it.to} className="card flex items-start gap-3 px-3 py-3 hover:border-accent/60">
                  <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">{it.icon}</span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">{it.label}</span>
                    <span className="block text-xs text-muted">{it.desc}</span>
                  </span>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
