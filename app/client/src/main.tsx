import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import './styles.css';
import { AuthProvider, useAuth } from './auth';
import { Layout } from './Layout';
import { Login } from './pages/Login';
import { ForYou, Projects } from './pages/Home';
import { Board, List, ProjectLayout, Settings, Summary } from './pages/ProjectPages';
import { IssuePage } from './pages/IssuePage';
import { Search } from './pages/Search';
import { Backlog } from './pages/Backlog';
import { Reports } from './pages/Reports';
import { Timeline } from './pages/Timeline';
import { Filters } from './pages/Filters';
import { DashboardList, DashboardView } from './pages/Dashboards';
import { NotificationSettings, Outbox } from './pages/Email';

function App() {
  const { user, ready } = useAuth();
  if (!ready) return <div className="splash">Loading…</div>;
  if (!user) return <Login />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Navigate to="/for-you" replace />} />
        <Route path="/for-you" element={<ForYou />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/projects/:key" element={<ProjectLayout />}>
          <Route index element={<Navigate to="board" replace />} />
          <Route path="board" element={<Board />} />
          <Route path="list" element={<List />} />
          <Route path="summary" element={<Summary />} />
          <Route path="settings" element={<Settings />} />
          <Route path="backlog" element={<Backlog />} />
          <Route path="timeline" element={<Timeline />} />
          <Route path="reports" element={<Reports />} />
          <Route path="reports/:sprintId" element={<Reports />} />
        </Route>
        <Route path="/browse/:key" element={<IssuePage />} />
        <Route path="/issues" element={<Search />} />
        <Route path="/filters" element={<Filters />} />
        <Route path="/dashboards" element={<DashboardList />} />
        <Route path="/dashboards/:id" element={<DashboardView />} />
        <Route path="/settings/notifications" element={<NotificationSettings />} />
        <Route path="/admin/outbox" element={<Outbox />} />
        <Route path="*" element={<div className="page"><h1>Page not found</h1></div>} />
      </Route>
    </Routes>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
