import { Navigate, Route, Routes } from 'react-router';

import { AppLayout } from './layout/AppLayout';
import { ApprovalsPage } from './pages/ApprovalsPage';
import { AssistantPage } from './pages/AssistantPage';
import { DeliveriesPage } from './pages/DeliveriesPage';
import { HomePage } from './pages/HomePage';
import { ImportErrorsPage } from './pages/ImportErrorsPage';
import { ImportPage } from './pages/ImportPage';
import { RulesPage } from './pages/RulesPage';
import { SettlementsPage } from './pages/SettlementsPage';

export function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<HomePage />} />
        <Route path="import" element={<ImportPage />} />
        <Route path="import/errors" element={<ImportErrorsPage />} />
        <Route path="settlements" element={<SettlementsPage />} />
        <Route path="settlements/preview" element={<Navigate to="/settlements" replace />} />
        <Route path="approvals" element={<ApprovalsPage />} />
        <Route path="rules" element={<RulesPage />} />
        <Route path="deliveries" element={<DeliveriesPage />} />
        <Route path="assistant" element={<AssistantPage />} />
      </Route>
    </Routes>
  );
}
