import { Navigate, Route, Routes } from 'react-router-dom';
import { LiquidGlassDemoPage } from './pages/LiquidGlassDemoPage.js';
import { NavigationCardDemoPage } from './pages/NavigationCardDemoPage.js';
import { PlayerPage } from './pages/PlayerPage.js';
import { SetupPage } from './pages/SetupPage.js';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<PlayerPage />} />
      <Route path="/liquid-glass-demo" element={<LiquidGlassDemoPage />} />
      <Route path="/navigation-card-demo" element={<NavigationCardDemoPage />} />
      <Route path="/setup" element={<SetupPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
