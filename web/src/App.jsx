import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { api, getToken, clearToken } from './api.js';
import { Spinner } from './components/ui.jsx';
import AppLayout from './components/AppLayout.jsx';

import Login from './pages/Login.jsx';
import Onboarding from './pages/Onboarding.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Deals from './pages/Deals.jsx';
import NewDeal from './pages/NewDeal.jsx';
import DealDetail from './pages/DealDetail.jsx';
import Disputes from './pages/Disputes.jsx';
import NewDispute from './pages/NewDispute.jsx';
import DisputeDetail from './pages/DisputeDetail.jsx';
import Moderator from './pages/Moderator.jsx';
import Directory from './pages/Directory.jsx';
import PublicProfile from './pages/PublicProfile.jsx';
import Profile from './pages/Profile.jsx';
import Settings from './pages/Settings.jsx';
import Report from './pages/Report.jsx';

const AuthContext = createContext({ user: null, refresh: async () => {} });
export const useAuth = () => useContext(AuthContext);

function Shell() {
  const { user } = useAuth();
  if (!user?.name) return <Navigate to="/onboarding" replace />;
  return <AppLayout user={user} />;
}

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const location = useLocation();

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const { user } = await api('/api/auth/me');
      setUser(user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner label="ዘመን" />
      </div>
    );
  }

  const isPublic = location.pathname.startsWith('/login') || location.pathname.startsWith('/r/');
  if (!user && !isPublic) return <Navigate to="/login" replace />;

  return (
    <AuthContext.Provider value={{ user, refresh, signOut: () => { clearToken(); setUser(null); } }}>
      <Routes>
        <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
        <Route path="/r/:token" element={<Report />} />
        <Route path="/onboarding" element={user && !user.name ? <Onboarding /> : <Navigate to="/" replace />} />

        <Route element={<Shell />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/deals" element={<Deals />} />
          <Route path="/deals/new" element={<NewDeal />} />
          <Route path="/deals/:id" element={<DealDetail />} />
          <Route path="/disputes" element={<Disputes />} />
          <Route path="/disputes/new" element={<NewDispute />} />
          <Route path="/disputes/:id" element={<DisputeDetail />} />
          <Route path="/moderator" element={<Moderator />} />
          <Route path="/directory" element={<Directory />} />
          <Route path="/u/:id" element={<PublicProfile />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/settings" element={<Settings />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthContext.Provider>
  );
}
