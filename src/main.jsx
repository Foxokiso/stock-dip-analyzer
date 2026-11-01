import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './index.css'
import App from './App.jsx'
import { loadSettings } from './state/settingsSchema.js'
import { configureNetwork } from './state/network.js'

// The desks start requesting data as soon as they mount, while the main
// process is still on its built-in 12 s deadline. It handles one renderer's
// messages in order, so sending the saved timeout before the first render
// covers every request after launch.
configureNetwork(loadSettings().data.requestTimeoutSeconds)

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
