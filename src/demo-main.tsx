import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import App from './App';
import { installDemoApi } from './demo-api';
import { demoProjects } from './demo-data';

installDemoApi(demoProjects);
const root = document.getElementById('root');
if (!root) throw new Error('SceneForge root element was not found.');
createRoot(root).render(<StrictMode><App /></StrictMode>);
