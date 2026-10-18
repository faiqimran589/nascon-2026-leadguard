import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import './styles.css';
import { AppProvider, useApp } from './lib/app.jsx';
import Layout from './components/Layout.jsx';
import { Loading } from './components/ui.jsx';
import { Login, Signup, AcceptInvite } from './pages/Auth.jsx';
import { PublicForm, PayThanks } from './pages/Public.jsx';
import Dashboard from './pages/Dashboard.jsx';
import { Leads, LeadDetail, Recovery, Escalations } from './pages/Leads.jsx';
import { Contacts, ContactDetail, Companies, CompanyDetail } from './pages/Contacts.jsx';
import { Opportunities, OpportunityDetail } from './pages/Opportunities.jsx';
import { Inbox, Appointments, Payments } from './pages/Engage.jsx';
import { Team, Roles, Rules, Audit, Workspace } from './pages/Admin.jsx';
import Pipelines from './pages/Pipelines.jsx';
import Integrations from './pages/Integrations.jsx';
import Profile from './pages/Profile.jsx';

function Protected() {
  const { me } = useApp();
  const loc = useLocation();
  if (me === undefined) return <Loading text="Loading LeadGuard…" />;
  if (!me) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return <Layout />;
}

function GuestOnly({ children }) {
  const { me } = useApp();
  if (me === undefined) return <Loading />;
  return me ? <Navigate to="/" replace /> : children;
}

function NotFound() {
  return <div className="card"><h1>Page not found</h1><p>The page you opened does not exist or you do not have access.</p></div>;
}

function App() {
  return (
    <Routes>
      <Route path="/login" element={<GuestOnly><Login /></GuestOnly>} />
      <Route path="/signup" element={<GuestOnly><Signup /></GuestOnly>} />
      <Route path="/invite/:token" element={<AcceptInvite />} />
      <Route path="/form/:token" element={<PublicForm />} />
      <Route path="/pay/thanks" element={<PayThanks />} />
      <Route element={<Protected />}>
        <Route index element={<Dashboard />} />
        <Route path="leads" element={<Leads />} />
        <Route path="leads/:id" element={<LeadDetail />} />
        <Route path="recovery" element={<Recovery />} />
        <Route path="escalations" element={<Escalations />} />
        <Route path="inbox" element={<Inbox />} />
        <Route path="inbox/:id" element={<Inbox />} />
        <Route path="contacts" element={<Contacts />} />
        <Route path="contacts/:id" element={<ContactDetail />} />
        <Route path="companies" element={<Companies />} />
        <Route path="companies/:id" element={<CompanyDetail />} />
        <Route path="opportunities" element={<Opportunities />} />
        <Route path="opportunities/:id" element={<OpportunityDetail />} />
        <Route path="appointments" element={<Appointments />} />
        <Route path="payments" element={<Payments />} />
        <Route path="team" element={<Team />} />
        <Route path="settings/roles" element={<Roles />} />
        <Route path="settings/pipelines" element={<Pipelines />} />
        <Route path="settings/rules" element={<Rules />} />
        <Route path="settings/workspace" element={<Workspace />} />
        <Route path="integrations" element={<Integrations />} />
        <Route path="audit" element={<Audit />} />
        <Route path="profile" element={<Profile />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <AppProvider><App /></AppProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
