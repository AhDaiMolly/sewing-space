import { createHashRouter, Navigate } from 'react-router-dom';
import App from './App';
import HomePage from './pages/HomePage';
import MaterialsList from './pages/MaterialsList';
import MaterialForm from './pages/MaterialForm';
import MaterialDetail from './pages/MaterialDetail';
import GarmentsPage from './pages/GarmentsPage';
import GarmentForm from './pages/GarmentForm';
import GarmentDetail from './pages/GarmentDetail';
import WorkbenchPage from './pages/WorkbenchPage';
import StatsPage from './pages/StatsPage';
import SettingsPage from './pages/SettingsPage';
import TemplateSettings from './pages/TemplateSettings';
import WizardPage from './pages/WizardPage';
import PatternPickerPage from './pages/pickers/PatternPickerPage';
import MaterialPickerPage from './pages/pickers/MaterialPickerPage';

export const router = createHashRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'materials', element: <MaterialsList /> },
      { path: 'materials/new', element: <MaterialForm /> },
      { path: 'materials/:id', element: <MaterialDetail /> },
      { path: 'materials/:id/edit', element: <MaterialForm /> },
      { path: 'garments', element: <GarmentsPage /> },
      { path: 'garments/new', element: <GarmentForm /> },
      { path: 'garments/:id', element: <GarmentDetail /> },
      { path: 'garments/:id/edit', element: <GarmentForm /> },
      { path: 'workbench', element: <WorkbenchPage /> },
      { path: 'stats', element: <StatsPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'settings/:sub', element: <SettingsPage /> },
      { path: 'settings/templates', element: <TemplateSettings /> },
      { path: 'wizard', element: <WizardPage /> },
      { path: 'pickers/patterns', element: <PatternPickerPage /> },
      { path: 'pickers/materials', element: <MaterialPickerPage /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);