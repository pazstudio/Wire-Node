import { Link, Route, Routes } from 'react-router-dom';
import ProjectsPage from './pages/ProjectsPage';
import ProjectPage from './pages/ProjectPage';
import PcbPage from './pages/PcbPage';
import ConnectionEditorPage from './pages/ConnectionEditorPage';
import WiringDiagramPage from './pages/WiringDiagramPage';
import ProjectMapPage from './pages/ProjectMapPage';
import BackupPage from './pages/BackupPage';

export default function App() {
  return (
    <div className="app">
      <header className="topbar no-print">
        <Link to="/" className="brand">
          <span className="brand-mark" /> Wire-Node
        </Link>
        <nav className="topnav">
          <Link to="/backup">Backup &amp; restore</Link>
        </nav>
      </header>
      <main className="main">
        <Routes>
          <Route path="/" element={<ProjectsPage />} />
          <Route path="/projects/:pid" element={<ProjectPage />} />
          <Route path="/projects/:pid/pcbs/:pcbId" element={<PcbPage />} />
          <Route path="/projects/:pid/connections/:cid" element={<WiringDiagramPage />} />
          <Route path="/projects/:pid/connections/:cid/edit" element={<ConnectionEditorPage />} />
          <Route path="/projects/:pid/map" element={<ProjectMapPage />} />
          <Route path="/backup" element={<BackupPage />} />
          <Route path="*" element={<p className="page">Page not found. <Link to="/">Go home</Link></p>} />
        </Routes>
      </main>
    </div>
  );
}
