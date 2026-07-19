import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import { PwaProvider } from './components/PwaLifecycle'
import { queryClient } from './lib/queryClient'
import './index.css'

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
