import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { authApi, userApi } from '../api/client.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(() => localStorage.getItem('smartpool_token'));
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState(null);

  const logout = useCallback(() => {
    localStorage.removeItem('smartpool_token');
    setToken(null);
    setUser(null);
    setAuthError(null);
  }, []);

  const loadUser = useCallback(async () => {
    const storedToken = localStorage.getItem('smartpool_token');
    if (!storedToken) {
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      const res = await authApi.getMe();
      if (res?.data?.user) {
        setUser(res.data.user);
        setAuthError(null);
      } else {
        logout();
      }
    } catch (err) {
      console.warn('Authentication check failed:', err.message);
      logout();
    } finally {
      setLoading(false);
    }
  }, [logout]);

  useEffect(() => {
    loadUser();

    const handleUnauthorized = () => {
      logout();
    };

    window.addEventListener('smartpool:unauthorized', handleUnauthorized);
    return () => window.removeEventListener('smartpool:unauthorized', handleUnauthorized);
  }, [loadUser, logout]);

  const login = async (email, password) => {
    setAuthError(null);
    const res = await authApi.login(email, password);
    const { token: newToken, user: userData } = res.data;

    localStorage.setItem('smartpool_token', newToken);
    setToken(newToken);
    setUser(userData);
    return userData;
  };

  const register = async (formData) => {
    setAuthError(null);
    const res = await authApi.register({
      ...formData,
      role: 'customer',
    });
    const { token: newToken, user: userData } = res.data;

    localStorage.setItem('smartpool_token', newToken);
    setToken(newToken);
    setUser(userData);
    return userData;
  };

  const updateProfile = async (updates) => {
    const res = await userApi.updateProfile(updates);
    const updatedUser = res.data;
    setUser(updatedUser);
    return updatedUser;
  };

  const value = {
    user,
    token,
    isAuthenticated: Boolean(user && token),
    loading,
    authError,
    login,
    register,
    logout,
    updateProfile,
    refreshUser: loadUser,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
