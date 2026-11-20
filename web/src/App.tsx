import { Link, Navigate, Route, Routes } from 'react-router-dom';
import ProjectsPage from './pages/ProjectsPage';
import ProjectPage from './pages/ProjectPage';
import PcbPage from './pages/PcbPage';
import ConnectionEditorPage from './pages/ConnectionEditorPage';
import WiringDiagramPage from './pages/WiringDiagramPage';
import ProjectMapPage from './pages/ProjectMapPage';
import AdminPage from './pages/AdminPage';
import { ProjectMenu, QuickSwitcherButton, RecentDrawer } from './components/navigation';
import { ShortcutsButton } from './components/shortcuts';
import { MentionsButton } from './components/comments';
import { OfflineBanner } from './components/offline';
import { AuthGate, UserMenu } from './auth';
import { ReasonProvider } from './components/reason';

export default function App() {
  return (
    <AuthGate>
      <ReasonProvider>
        <div className="app">
          <header className="topbar no-print">
            <Link to="/" className="brand">
              <span className="brand-mark" /> Wire-Node
            </Link>
            <ProjectMenu />
            <nav className="topnav">
              <QuickSwitcherButton />
              <MentionsButton />
              <ShortcutsButton />
              <UserMenu />
            </nav>
          </header>
          <OfflineBanner />
          <RecentDrawer />
          <main className="main">
            <Routes>
              <Route path="/" element={<ProjectsPage />} />
              <Route path="/projects/:pid" element={<ProjectPage />} />
              <Route path="/projects/:pid/pcbs/:pcbId" element={<PcbPage />} />
              <Route path="/projects/:pid/connections/:cid" element={<WiringDiagramPage />} />
              <Route path="/projects/:pid/connections/:cid/edit" element={<ConnectionEditorPage />} />
              <Route path="/projects/:pid/map" element={<ProjectMapPage />} />
              <Route path="/admin" element={<AdminPage />} />
              <Route path="/backup" element={<Navigate to="/admin?tab=backups" replace />} />
              <Route path="*" element={<p className="page">Page not found. <Link to="/">Go home</Link></p>} />
            </Routes>
          </main>
          <footer className="app-footer no-print">Made by Zdeněk Pazourek</footer>
        </div>
      </ReasonProvider>
    </AuthGate>
  );
}
