import { useState, useEffect } from 'react';
import { Outlet, useNavigate } from 'react-router';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { authApi, getCurrentUser, clearTokens } from '../../services/api';
import { useAuthContext } from '../../contexts/AuthContext';
import { useIdleLogout } from '../../hooks/useIdleLogout';

export function MainLayout() {
  const navigate = useNavigate();
  const { user, updateUser } = useAuthContext();
  const [ready, setReady] = useState(false);

  // Auto-logout after N minutes of inactivity — value comes from the
  // SESSION_IDLE_TIMEOUT_MINUTES system setting, surfaced via /auth/me.
  useIdleLogout((user as any)?.sessionIdleTimeoutMinutes);

  // Load collapsed state from localStorage or default to false
  const [isCollapsed, setIsCollapsed] = useState(() => {
    const saved = localStorage.getItem('sidebarCollapsed');
    return saved ? JSON.parse(saved) : false;
  });

  // On every app load refresh the stored user (incl. permissions) from /auth/me
  useEffect(() => {
    const user = getCurrentUser();
    if (!user) {
      clearTokens();
      navigate('/login', { replace: true });
      return;
    }
    authApi.me()
      .then((freshUser) => updateUser(freshUser))
      .catch(() => {
        // Keep stale data if /auth/me fails; token refresh errors redirect to login
      })
      .finally(() => setReady(true));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Save collapsed state to localStorage
  useEffect(() => {
    localStorage.setItem('sidebarCollapsed', JSON.stringify(isCollapsed));
  }, [isCollapsed]);

  const toggleSidebar = () => {
    setIsCollapsed(!isCollapsed);
  };

  if (!ready) {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground">
        Loading...
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar isCollapsed={isCollapsed} onToggle={toggleSidebar} />
      <div className="flex flex-col flex-1 overflow-hidden">
        <Topbar />
        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}