import { NavLink, Outlet } from 'react-router-dom';

import { useAuth } from '../lib/auth';
import { visibleSections } from '../lib/permissions';
import { cn } from '../lib/utils';

export function AppShell() {
  const me = useAuth();
  const sections = visibleSections(me.permissions);

  return (
    <div className="min-h-screen bg-background text-foreground md:grid md:grid-cols-[16rem_1fr]">
      <aside className="border-b bg-card px-4 py-5 md:min-h-screen md:border-b-0 md:border-r">
        <div className="mb-6">
          <p className="text-sm font-semibold">LLM Wiki</p>
          <p className="text-xs text-muted-foreground">{me.email}</p>
        </div>
        <nav aria-label="Primary" className="space-y-6">
          {sections.map((section) => (
            <section key={section.group} aria-labelledby={`nav-${section.group}`}>
              <h2
                id={`nav-${section.group}`}
                className="mb-2 text-xs font-medium uppercase tracking-normal text-muted-foreground"
              >
                {section.group}
              </h2>
              <div className="space-y-1">
                {section.items.map((item) => (
                  <NavLink
                    key={item.path}
                    to={item.path}
                    className={({ isActive }) =>
                      cn(
                        'block rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                        isActive && 'bg-accent text-accent-foreground',
                      )
                    }
                  >
                    {item.label}
                  </NavLink>
                ))}
              </div>
            </section>
          ))}
        </nav>
      </aside>
      <main className="p-6">
        <Outlet />
      </main>
    </div>
  );
}
