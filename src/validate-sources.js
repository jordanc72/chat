import dotenv from 'dotenv'
import {
  extractCalendarYear,
  extractWebPageText,
  extractPdfPages,
  validatePdfDocument,
  validateRegulation
} from './documents.js'
import { additionalWebSources } from './sources.js'

dotenv.config()

const main = async () => {
  const argumentsList = process.argv.slice(2)
  const requestedPdfPath = argumentsList.find((argument) => !argument.startsWith('--'))
  const pdfOnly = argumentsList.includes('--pdf-only')
  const pdfSources = requestedPdfPath
    ? [{ id: 'academic-regulation', path: requestedPdfPath, type: 'regulation' }]
    : [
        {
          id: 'academic-regulation',
          path: process.env.RAG_REGULATION_PDF,
          type: 'regulation'
        },
        {
          id: 'coexistence-regulation-68-2025',
          path: process.env.RAG_RESOLUTION_CS_68_2025_PDF,
          type: 'document'
        },
        {
          id: 'study-regime-cs-150',
          path: process.env.RAG_STUDY_REGIME_PDF,
          type: 'document'
        }
      ].filter(({ path }) => path)
  if (pdfSources.length === 0) {
    throw new Error('Pass a PDF path or configure at least one PDF source in rag-service/.env.')
  }
  const report = { documents: [] }

  for (const source of pdfSources) {
    const pages = await extractPdfPages(source.path)
    const validation = source.type === 'regulation'
      ? validateRegulation(pages)
      : validatePdfDocument(pages)
    report.documents.push({
      id: source.id,
      valid: validation.valid,
      pageCount: validation.pageCount,
      characterCount: validation.characterCount,
      emptyPages: validation.emptyPages,
      ...(source.type === 'regulation' && {
        articleCount: validation.articleCount,
        articleRange: validation.articleRange,
        missingArticles: validation.missingArticles,
        dateMarker: validation.dateMarker
      })
    })
  }

  if (!pdfOnly) {
    const url = process.env.RAG_CALENDAR_URL || 'https://unpaz.edu.ar/calendario-academico'
    const year = Number(process.env.RAG_CALENDAR_YEAR || new Date().getFullYear())
    const response = await fetch(url, {
      headers: { 'User-Agent': 'UNPAZ-RAG-Pilot/1.0', Accept: 'text/html' },
      signal: AbortSignal.timeout(20000)
    })
    if (!response.ok) throw new Error(`Calendar fetch failed with HTTP ${response.status}.`)
    const html = await response.text()
    const calendar = extractCalendarYear(html, year)
    report.calendar = {
      valid: calendar.text.length >= 500 && calendar.dateCount >= 5,
      year: calendar.year,
      characterCount: calendar.text.length,
      dateCount: calendar.dateCount
    }

    report.webPages = []
    for (const source of additionalWebSources) {
      const pageResponse = await fetch(source.url, {
        headers: { 'User-Agent': 'UNPAZ-RAG-Pilot/1.0', Accept: 'text/html' },
        signal: AbortSignal.timeout(20000)
      })
      if (!pageResponse.ok) {
        throw new Error(`${source.title} fetch failed with HTTP ${pageResponse.status}.`)
      }
      const pageHtml = await pageResponse.text()
      if (pageHtml.length > 5 * 1024 * 1024) {
        throw new Error(`${source.title} page exceeds the 5 MB limit.`)
      }
      const text = extractWebPageText(pageHtml)
      report.webPages.push({
        id: source.id,
        title: source.title,
        valid: true,
        characterCount: text.length
      })
    }
  }

  console.log(JSON.stringify(report, null, 2))
  if (report.documents.some((document) => !document.valid) || (report.calendar && !report.calendar.valid)) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('Source validation failed:', error)
  process.exitCode = 1
})
