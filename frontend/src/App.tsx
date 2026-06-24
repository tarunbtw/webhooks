import { Routes, Route } from 'react-router-dom'
import { ThemeProvider } from './components/ThemeProvider'
import { TooltipProvider } from './components/ui/tooltip'
import { HomePage } from './pages/HomePage'
import { EndpointPage } from './pages/EndpointPage'

export default function App() {
  return (
    <ThemeProvider>
      <TooltipProvider>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/e/:id" element={<EndpointPage />} />
        </Routes>
      </TooltipProvider>
    </ThemeProvider>
  )
}
