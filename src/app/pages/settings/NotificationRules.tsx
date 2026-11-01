import { useEffect } from 'react';
import { useNavigate } from 'react-router';

export function NotificationRules() {
  const navigate = useNavigate();

  useEffect(() => {
    navigate('/dashboard/notifications/settings', { replace: true });
  }, [navigate]);

  return null;
}
