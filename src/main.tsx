import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import AppBootstrap from './AppBootstrap.tsx';
import './index.css';
import { setupCapacitorBootstrap } from './mobile/capacitorBootstrap';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppBootstrap />
  </StrictMode>,
);

void setupCapacitorBootstrap();
