import { createRoot } from 'react-dom/client';
import { App } from './gen/App';
import './gen/styles.css';

const rootElement = document.getElementById('root');
if (rootElement === null) throw new Error('missing #root element');
createRoot(rootElement).render(<App />);
