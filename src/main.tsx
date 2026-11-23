import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider } from './components/ui/toast';
import { TooltipProvider } from './components/ui/tooltip';
import { installDiagnostics } from './lib/diagnostics';
import './index.css';

installDiagnostics();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <ToastProvider position="bottom-center">
        <TooltipProvider>
          <App />
        </TooltipProvider>
      </ToastProvider>
    </ErrorBoundary>
  </StrictMode>,
);
