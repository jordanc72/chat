import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const emptyState = () => ({ version: 1, chunks: [], sources: [] })

export class VectorStore {
  constructor(filePath) {
    this.filePath = resolve(filePath)
    this.state = emptyState()
  }

  async load() {
    try {
      const contents = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(contents)
      if (parsed.version !== 1 || !Array.isArray(parsed.chunks) || !Array.isArray(parsed.sources)) {
        throw new Error('The RAG index has an unsupported or invalid structure.')
      }
      this.state = parsed
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
  }

  async replaceSource(sourceId, chunks, sourceMetadata) {
    const nextState = {
      version: 1,
      chunks: [
        ...this.state.chunks.filter((chunk) => chunk.sourceId !== sourceId),
        ...chunks
      ],
      sources: [
        ...this.state.sources.filter((source) => source.id !== sourceId),
        { id: sourceId, ...sourceMetadata, chunkCount: chunks.length }
      ]
    }
    await this.persist(nextState)
    this.state = nextState
  }

  async updateSource(sourceId, sourceMetadata) {
    const existing = this.state.sources.find((source) => source.id === sourceId)
    if (!existing) throw new Error(`Cannot update missing source metadata: ${sourceId}`)

    const nextState = {
      ...this.state,
      sources: this.state.sources.map((source) => source.id === sourceId
        ? { ...source, ...sourceMetadata }
        : source)
    }
    await this.persist(nextState)
    this.state = nextState
  }

  getSource(sourceId) {
    return this.state.sources.find((source) => source.id === sourceId) || null
  }

  search(vector, limit) {
    return this.state.chunks
      .map((chunk) => ({ ...chunk, score: cosineSimilarity(vector, chunk.embedding) }))
      .filter((chunk) => Number.isFinite(chunk.score))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  get chunkCount() {
    return this.state.chunks.length
  }

  get sources() {
    return this.state.sources.map((source) => ({
      id: source.id,
      title: source.title,
      url: source.url || null,
      lastCheckedAt: source.lastCheckedAt,
      indexedAt: source.indexedAt,
      chunkCount: source.chunkCount
    }))
  }

  async persist(state) {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, JSON.stringify(state), 'utf8')

    try {
      await rename(temporaryPath, this.filePath)
    } catch (error) {
      if (process.platform !== 'win32' || !['EEXIST', 'EPERM'].includes(error.code)) throw error
      await rm(this.filePath, { force: true })
      await rename(temporaryPath, this.filePath)
    } finally {
      await rm(temporaryPath, { force: true })
    }
  }
}

const cosineSimilarity = (left, right) => {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || left.length === 0) {
    return Number.NaN
  }

  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]
    leftNorm += left[index] * left[index]
    rightNorm += right[index] * right[index]
  }

  return leftNorm && rightNorm ? dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm)) : Number.NaN
}
