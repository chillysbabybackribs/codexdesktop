import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter/wght.css'
import '@fontsource-variable/inter/wght-italic.css'
import '@fontsource-variable/geist-mono/wght.css'
import '@fontsource-variable/geist-mono/wght-italic.css'
import App from './App'
import { AutoCopySelection } from './AutoCopySelection'
import { UiProvider } from './UiPrimitives'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <UiProvider>
      <App />
      <AutoCopySelection />
    </UiProvider>
  </StrictMode>
)
