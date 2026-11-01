import { useState } from 'react';
import { useNavigate } from 'react-router';
import { authApi, clearTokens } from '../services/api';
import { useAuthContext } from '../contexts/AuthContext';

export function useAuth() {
  const { user, updateUser, clearUser } = useAuthContext();
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const login = async (email: string, password: string) => {
    setLoading(true);
    try {
      const { user: loggedInUser } = await authApi.login(email, password);
      updateUser(loggedInUser);
      navigate('/dashboard');
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || 'Login failed' };
    } finally {
      setLoading(false);
    }
  };

  const logout = async () => {
    try {
      await authApi.logout();
    } finally {
      clearTokens();
      clearUser();
      navigate('/login');
    }
  };

  const changePassword = async (currentPassword: string, newPassword: string) => {
    return authApi.changePassword(currentPassword, newPassword);
  };

  return { user, loading, login, logout, changePassword, isAuthenticated: !!user };
}
