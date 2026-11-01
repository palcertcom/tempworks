import { useEffect } from 'react';
import { useNavigate } from 'react-router';

/**
 * This route now redirects to the Workflows section.
 * Workflow stages are configured per-workflow at /dashboard/settings/workflows/:id
 */
export function WorkflowConfiguration() {
  const navigate = useNavigate();
  useEffect(() => {
    navigate('/dashboard/workflows', { replace: true });
  }, [navigate]);
  return null;
}
