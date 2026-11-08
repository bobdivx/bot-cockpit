import { render } from 'preact';
import { App } from './app';
import './styles.css';

const savedTheme = localStorage.getItem('cockpit-theme');
if (savedTheme === 'light' || savedTheme === 'dark')
  document.documentElement.dataset.theme = savedTheme;
if (localStorage.getItem('cockpit-motion') === 'reduce')
  document.documentElement.dataset.motion = 'reduce';

const root = document.getElementById('app');
if (root) render(<App />, root);
