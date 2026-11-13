import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { load } from 'cheerio'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

const standardFontDataUrl = new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url).href
const monthNames = 'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre'

export const normalizeText = (text) => String(text || '')
  .replace(/\u00a0/g, ' ')
  .replace(/[ \t]+/g, ' ')
  .replace(/\s*\n\s*/g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim()

export const hashText = (text) => createHash('sha256').update(text).digest('hex')

export const splitIntoChunks = (text, { maxChars = 1200, overlapChars = 180 } = {}) => {
  const words = normalizeText(text).split(/\s+/).filter(Boolean)
  const chunks = []
  let start = 0

  while (start < words.length) {
    let end = start
    let length = 0

    while (end < words.length) {
      const nextLength = words[end].length + (end > start ? 1 : 0)
      if (end > start && length + nextLength > maxChars) break
      length += nextLength
      end += 1
    }

    chunks.push(words.slice(start, end).join(' '))
    if (end >= words.length) break

    let nextStart = end
    let overlapLength = 0
    while (nextStart > start + 1 && overlapLength < overlapChars) {
      nextStart -= 1
      overlapLength += words[nextStart].length + 1
    }
    start = nextStart
  }

  return chunks
}

export const extractPdfPages = async (pdfPath) => {
  if (!pdfPath) throw new Error('RAG_REGULATION_PDF is not configured.')

  const bytes = await readFile(pdfPath)
  if (bytes.length === 0) throw new Error('The regulation PDF is empty.')
  if (bytes.length > 30 * 1024 * 1024) throw new Error('The regulation PDF exceeds the 30 MB limit.')

  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl,
    useSystemFonts: true
  })
  const pdf = await loadingTask.promise

  try {
    const pages = []
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber)
      const content = await page.getTextContent()
      const text = normalizeText(content.items
        .map((item) => ('str' in item ? item.str : ''))
        .filter(Boolean)
        .join(' '))

      pages.push({ page: pageNumber, text })
    }
    return pages
  } finally {
    await loadingTask.destroy()
  }
}

export const validateRegulation = (pages) => {
  const fullText = pages.map(({ text }) => text).join('\n')
  const articleNumbers = [...new Set(
    [...fullText.matchAll(/ART[ÍI]CULO\s+(\d{1,3})\s*[º°]?/gi)]
      .map((match) => Number(match[1]))
  )].sort((a, b) => a - b)
  const missingArticles = []

  if (articleNumbers.length > 0) {
    for (let article = articleNumbers[0]; article <= articleNumbers.at(-1); article += 1) {
      if (!articleNumbers.includes(article)) missingArticles.push(article)
    }
  }

  const emptyPages = pages.filter(({ text }) => !text).map(({ page }) => page)
  const hasTitle = /REGLAMENTO\s+ACAD[EÉ]MICO/i.test(fullText)
  const firstPageHeader = pages[0]?.text.slice(0, 250) || ''
  const dateMarker = firstPageHeader.match(/\b20\d{2}\b/)?.[0] || null

  return {
    valid: pages.length > 0
      && hasTitle
      && articleNumbers.length > 0
      && missingArticles.length === 0
      && emptyPages.length === 0,
    pageCount: pages.length,
    characterCount: fullText.length,
    emptyPages,
    articleCount: articleNumbers.length,
    articleRange: articleNumbers.length
      ? [articleNumbers[0], articleNumbers.at(-1)]
      : null,
    missingArticles,
    dateMarker,
    firstPageHeader
  }
}

export const extractCalendarYear = (html, year) => {
  const $ = load(html)
  $('script, style, noscript, nav, header, footer, aside').remove()

  const main = $('main').first()
  const body = $('.field--name-body').first()
  const root = main.length ? main : body
  const contentRoot = root.length ? root : $('body')
  const textBlocks = contentRoot
    .find('h1, h2, h3, h4, h5, p, li, td, th')
    .toArray()
    .map((element) => $(element).text())
    .filter(Boolean)
  const pageText = normalizeText(textBlocks.join('\n') || contentRoot.text())
  const headingPattern = new RegExp(`Calendario\\s+Acad[eé]mico\\s+${year}`, 'i')
  const heading = headingPattern.exec(pageText)

  if (!heading) {
    throw new Error(`The academic calendar page has no section for ${year}.`)
  }

  const start = heading.index
  const remainderStart = start + heading[0].length
  const remainingText = pageText.slice(remainderStart)
  const nextCalendar = [...remainingText.matchAll(/Calendario\s+Acad[eé]mico\s+(20\d{2})/gi)]
    .find((match) => Number(match[1]) !== Number(year))
  const text = normalizeText(`${heading[0]}${nextCalendar
    ? remainingText.slice(0, nextCalendar.index)
    : remainingText}`)
  const dateCount = [...text.matchAll(new RegExp(`\\b\\d{1,2}\\s+(?:de\\s+)?(?:${monthNames})\\b`, 'gi'))].length

  if (text.length < 500 || dateCount < 5) {
    throw new Error(`The ${year} calendar section is incomplete (${text.length} characters, ${dateCount} date expressions).`)
  }

  return { year, text, dateCount }
}

export const extractWebPageText = (html) => {
  const $ = load(html)
  $('script, style, noscript, nav, header, footer, aside, form, iframe').remove()
  const main = $('main').first()
  const article = $('article').first()
  const body = $('.field--name-body').first()
  const roots = [main, article, $('.region-content').first(), body, $('body')]
    .filter((root) => root.length)
  const textForRoot = (root) => {
    const textBlocks = root
      .find('h1, h2, h3, h4, h5, p, li, td, th')
      .toArray()
      .map((element) => $(element).text())
      .filter(Boolean)
    return normalizeText(textBlocks.join('\n') || root.text())
  }
  const candidates = roots.map(textForRoot)
  const text = candidates.find((candidate) => candidate.length >= 200) || candidates[0] || ''

  if (text.length < 200) {
    throw new Error(`The web page contains too little readable text (${text.length} characters).`)
  }
  return text
}

export const validatePdfDocument = (pages) => {
  const emptyPages = pages.filter(({ text }) => !text.trim()).map(({ page }) => page)
  const characterCount = pages.reduce((total, { text }) => total + text.length, 0)
  const readablePageCount = pages.length - emptyPages.length
  const minimumReadablePages = Math.max(1, Math.ceil(pages.length * 0.8))

  return {
    valid: pages.length > 0 && characterCount >= 500 && readablePageCount >= minimumReadablePages,
    pageCount: pages.length,
    characterCount,
    emptyPages
  }
}
