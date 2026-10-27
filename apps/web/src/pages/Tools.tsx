import { Link } from 'react-router-dom';
import { PageHeader } from '../components/ui';
import { NAV, NAV_PAGES } from '../lib/nav';

export default function Tools() {
  return (
    <div>
      <PageHeader title="All Tools" subtitle={`${NAV_PAGES.length} analytics & trading tools`} />
      <div className="space-y-4">
        {NAV.map((g) => (
          <section key={g.title}>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">{g.title}</h2>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {g.items.map((it) => (
                <div key={it.label} className="card px-3 py-3">
                  <Link to={it.tabs[0].to} className="flex items-start gap-3 hover:text-accent">
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">{it.icon}</span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold">{it.label}</span>
                      <span className="block text-xs text-muted">{it.desc}</span>
                    </span>
                  </Link>
                  {it.tabs.length > 1 && (
                    <div className="mt-2 flex flex-wrap gap-1 pl-11">
                      {it.tabs.map((t) => (
                        <Link key={t.to} to={t.to} title={t.desc} className="chip bg-panel2 px-2 py-0.5 text-xs text-ink/85 hover:text-accent">
                          {t.label}
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
