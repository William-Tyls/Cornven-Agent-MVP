import { NavLink, Outlet } from 'react-router';

import {
  AlertIcon,
  ChatIcon,
  CheckCircleIcon,
  ChevronLeftIcon,
  HomeIcon,
  ListIcon,
  SendIcon,
  SettingsIcon,
  UploadIcon,
} from '../components/icons';

const navItems = [
  { to: '/', label: 'Dashboard', icon: HomeIcon },
  { to: '/import', label: 'POS Import', icon: UploadIcon },
  { to: '/import/errors', label: 'Import History', icon: AlertIcon },
  { to: '/settlements', label: 'Settlement Runs', icon: ListIcon },
  { to: '/approvals', label: 'Approvals', icon: CheckCircleIcon },
  { to: '/rules', label: 'Settlement Rules', icon: SettingsIcon },
  { to: '/deliveries', label: 'Report Delivery', icon: SendIcon },
  { to: '/assistant', label: 'Chatbot', icon: ChatIcon },
];

export function AppLayout() {
  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="app-sidebar__brand">
          <span>Cornven</span>
          <ChevronLeftIcon className="app-sidebar__collapse" />
        </div>
        <nav className="app-sidebar__nav">
          {navItems.map((item) => {
            const ItemIcon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/' || item.to === '/settlements'}
                className={({ isActive }) =>
                  isActive ? 'app-sidebar__link is-active' : 'app-sidebar__link'
                }
              >
                <ItemIcon />
                <span>{item.label}</span>
              </NavLink>
            );
          })}
        </nav>
      </aside>

      <div className="app-body">
        <header className="app-topbar">
          <span className="app-topbar__title">Cornven · Plan B demo</span>
          <div className="app-topbar__user">
            <span>Local demo staff</span>
            <span className="app-topbar__avatar">S</span>
          </div>
        </header>
        <main className="app-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
