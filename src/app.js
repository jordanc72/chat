import cors from 'cors'
import express from 'express'
import rateLimit from 'express-rate-limit'
import helmet from 'helmet'
import { ServiceUnavailableError } from './rag-service.js'

const maximumQuestionLength = 1200
const maximumHistoryLength = 6
const maximumHistoryMessageLength = 1000

export const createApp = ({ rag, allowedOrigins, maxConcurrent = 2 }) => {
  const app = express()
  const origins = new Set(allowedOrigins)
  let activeRequests = 0

  app.disable('x-powered-by')
  app.set('trust proxy', 1)
  app.use(helmet())
  app.use(cors({
    origin: (origin, callback) => {
      if (!origin || origins.has(origin)) return callback(null, true)
      return callback(new Error('Origin not allowed.'))
    }
  }))
  app.use(express.json({ limit: '8kb' }))

  app.get('/health', (_request, response) => {
    const status = rag.status()
    response.status(status.ready ? 200 : 503).json(status)
  })

  app.post('/chat', rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_request, response) => response.status(429).json({
      error: 'Se alcanzó el límite de consultas. Intentá nuevamente en un minuto.'
    })
  }), async (request, response) => {
    const question = request.body?.question
    if (typeof question !== 'string' || !question.trim()) {
      return response.status(400).json({ error: 'La consulta es obligatoria.' })
    }
    if (question.length > maximumQuestionLength) {
      return response.status(413).json({ error: `La consulta no puede superar ${maximumQuestionLength} caracteres.` })
    }

    const history = request.body?.history ?? []
    if (!Array.isArray(history) || history.length > maximumHistoryLength) {
      return response.status(400).json({ error: `El historial debe contener como máximo ${maximumHistoryLength} mensajes.` })
    }
    if (history.some((turn) => (
      !turn
      || !['user', 'assistant'].includes(turn.role)
      || typeof turn.content !== 'string'
      || turn.content.length > maximumHistoryMessageLength
    ))) {
      return response.status(400).json({ error: 'El historial contiene un mensaje inválido.' })
    }
    if (activeRequests >= maxConcurrent) {
      return response.status(503).json({ error: 'El asistente está atendiendo otras consultas. Intentá nuevamente en unos segundos.' })
    }

    activeRequests += 1
    try {
      const result = await rag.answer(question.trim(), history)
      return response.json(result)
    } catch (error) {
      console.error('Chat request failed:', error)
      const unavailable = error instanceof ServiceUnavailableError
      return response.status(unavailable ? 503 : 502).json({
        error: unavailable
          ? 'El asistente local no está disponible en este momento.'
          : 'No se pudo procesar la consulta.'
      })
    } finally {
      activeRequests -= 1
    }
  })

  app.use((error, _request, response, _next) => {
    if (error.message === 'Origin not allowed.') {
      return response.status(403).json({ error: 'Origen no permitido.' })
    }
    if (error.type === 'entity.too.large') {
      return response.status(413).json({ error: 'La solicitud supera el tamaño permitido.' })
    }
    if (error instanceof SyntaxError && Object.hasOwn(error, 'body')) {
      return response.status(400).json({ error: 'El cuerpo JSON no es válido.' })
    }
    console.error('Unhandled HTTP error:', error)
    return response.status(500).json({ error: 'Error interno del servicio.' })
  })

  return app
}
