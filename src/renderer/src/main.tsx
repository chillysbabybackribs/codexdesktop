import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { AutoCopySelection } from './AutoCopySelection'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <AutoCopySelection />
  </StrictMode>
)
