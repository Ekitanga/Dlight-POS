import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import 'express-async-errors'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { apiRouter } from './routes/index.js'
import { errorHandler } from './middleware/error.js'
import { logger } from './middleware/logger.js'
import { startSpeedafTrackingScheduler } from './services/speedafTracking.js'

dotenv.config()

const app = express()
const port = process.env.PORT || 4000
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const frontendDistPath = path.resolve(__dirname, '..', '..', 'frontend', 'dist')
const blockedStaticPaths = [
  /^\/\./,
  /^\/(?:config|env)\.(?:js|json)$/i,
  /^\/settings\.js$/i,
  /^\/js\/(?:config|env|settings)\.js$/i,
]

// Behind Caddy (or any reverse proxy) the socket address is the proxy, not the
// browser. Trusting exactly one hop makes req.ip the real client IP, which the
// login throttle and audit log depend on. Override with TRUST_PROXY if the
// deployment has a different number of proxies in front of the app.
function trustProxySetting(): boolean | number | string {
  const raw = process.env.TRUST_PROXY
  if (raw === undefined || raw === '') return process.env.NODE_ENV === 'production' ? 1 : false
  if (raw === 'true') return true
  if (raw === 'false') return false
  return /^\d+$/.test(raw) ? Number(raw) : raw
}
app.set('trust proxy', trustProxySetting())

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}))
app.use(express.json({ limit: '2mb' }))
app.use(logger)

app.use('/api', apiRouter)

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

if (process.env.NODE_ENV === 'production' && fs.existsSync(frontendDistPath)) {
  app.use((req, res, next) => {
    if (blockedStaticPaths.some((pattern) => pattern.test(req.path))) {
      res.status(404).json({ message: 'Not found' })
      return
    }
    next()
  })
  app.use(express.static(frontendDistPath, {
    dotfiles: 'deny',
    setHeaders: (res, filePath) => {
      if (path.basename(filePath) === 'index.html') {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
      }
    }
  }))
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next()
    res.sendFile(path.join(frontendDistPath, 'index.html'), {
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' }
    })
  })
}

app.use(errorHandler)

if (process.env.NODE_ENV !== 'test') {
  app.listen(port, () => {
    console.log(`Server running on port ${port}`)
    startSpeedafTrackingScheduler()
  })
}

export default app
