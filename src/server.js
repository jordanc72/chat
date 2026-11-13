import dotenv from 'dotenv'
import { createApp } from './app.js'
import { RagService } from './rag-service.js'

dotenv.config()

const main = async () => {
  const host = process.env.CHATBOT_HOST || '127.0.0.1'
  const port = Number(process.env.CHATBOT_PORT || 3300)
  const maxConcurrent = Number(process.env.CHATBOT_MAX_CONCURRENT || 2)
  const refreshHours = Number(process.env.RAG_REFRESH_HOURS || 6)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CHATBOT_PORT is invalid.')
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) {
    throw new Error('CHATBOT_MAX_CONCURRENT must be between 1 and 8.')
  }
  if (!Number.isFinite(refreshHours) || refreshHours < 1 || refreshHours > 168) {
    throw new Error('RAG_REFRESH_HOURS must be between 1 and 168.')
  }

  const allowedOrigins = (process.env.CHATBOT_ALLOWED_ORIGINS || 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
  if (allowedOrigins.length === 0) throw new Error('Configure at least one CHATBOT_ALLOWED_ORIGINS value.')

  const rag = new RagService()
  await rag.initialize()
  const app = createApp({ rag, allowedOrigins, maxConcurrent })
  const server = app.listen(port, host, () => {
    console.info(`RAG API listening on http://${host}:${port}`)
  })

  await rag.refreshAll()
  const refreshTimer = setInterval(() => { void rag.refreshAll() }, refreshHours * 60 * 60 * 1000)

  const shutdown = () => {
    clearInterval(refreshTimer)
    server.close((error) => {
      if (error) {
        console.error('Could not shut down the RAG API cleanly:', error)
        process.exitCode = 1
      }
    })
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

main().catch((error) => {
  console.error('RAG API startup failed:', error)
  process.exitCode = 1
})
