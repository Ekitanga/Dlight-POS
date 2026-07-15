import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import 'express-async-errors'

import { apiRouter } from './routes'
import { errorHandler } from './middleware/error'
import { logger } from './middleware/logger'

dotenv.config()

const app = express()
const port = process.env.PORT || 4000

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

app.use(errorHandler)

if (process.env.NODE_ENV !== 'test') {
  app.listen(port, () => {
    console.log(`Server running on port ${port}`)
  })
}

export default app
