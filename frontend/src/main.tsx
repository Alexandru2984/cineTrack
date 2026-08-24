import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import { PwaProvider } from './components/PwaLifecycle'
import { queryClient } from './lib/queryClient'
import { loadLocale } from './lib/i18n'
import { initialLocale } from './store/locale'
import './index.css'

// The dictionary has to be in hand before the first paint, or every string
// renders as its raw key for a frame. It is one dynamic import, cached after
// the first visit, and it replaces shipping both languages to everybody.
await loadLocale(initialLocale())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <PwaProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </PwaProvider>
    </QueryClientProvider>
  </StrictMode>,
)
