import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { setupCapacitorBootstrap } from './mobile/capacitorBootstrap';
import { hydrateNativeLocalStorage } from './mobile/nativeStorageBridge';

const startApp = async () => {
  await hydrateNativeLocalStorage();

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

  void setupCapacitorBootstrap();
};

void startApp();
