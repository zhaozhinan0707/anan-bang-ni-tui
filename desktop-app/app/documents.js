const MAX_FILE_BYTES = 50 * 1024 * 1024
const MAX_DOCUMENT_CHARS = 180000
const yieldToUI = () => new Promise((resolve) => setTimeout(resolve, 0))
const progress = async (report, stage, current, total) => {
  report?.({ stage, current, total })
  await yieldToUI()
}

const xmlNodes = (parent, name) => Array.from(parent?.getElementsByTagNameNS('*', name) || [])
const xmlText = (value) => xmlNodes(value, 't').map((node) => node.textContent || '').join('')
const parseXml = (value) => {
  const document = new DOMParser().parseFromString(value, 'application/xml')
  if (document.getElementsByTagName('parsererror').length) throw new Error('Office 文件中的 XML 无法读取')
  return document
}

async function extractOfficeSections(file, extension, report) {
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(await file.arrayBuffer())
  if (Object.keys(zip.files).length > 3000) throw new Error('Office 文件内部条目过多，请拆分后导入')
  const readXml = async (path) => {
    const entry = zip.file(path)
    if (!entry) return null
    if (entry._data?.uncompressedSize > 12 * 1024 * 1024) throw new Error(`${path} 内容过大，请拆分工作表或幻灯片后导入`)
    const xml = await entry.async('string')
    if (xml.length > 12 * 1024 * 1024) throw new Error(`${path} 内容过大，请拆分工作表或幻灯片后导入`)
    return parseXml(xml)
  }
  if (extension === 'pptx') {
    const slides = Object.keys(zip.files).map((path) => ({ path, match: /^ppt\/slides\/slide(\d+)\.xml$/.exec(path) })).filter((item) => item.match).sort((a, b) => Number(a.match[1]) - Number(b.match[1]))
    if (!slides.length || slides.length > 300) throw new Error('PPTX 未包含可读取的幻灯片，或超过 300 页')
    const sections = []
    for (const [index, { path, match }] of slides.entries()) {
      await progress(report, '读取幻灯片', index + 1, slides.length)
      const xml = await readXml(path)
      const paragraphs = Array.from(xml.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'p'))
      const text = paragraphs.map(xmlText).filter(Boolean).join('\n')
      if (text) sections.push({ page: Number(match[1]), text })
    }
    return sections
  }
  const workbookFile = zip.file('xl/workbook.xml')
  if (!workbookFile) throw new Error('XLSX 工作簿结构无法读取')
  const workbook = await readXml('xl/workbook.xml')
  const relationshipFile = zip.file('xl/_rels/workbook.xml.rels')
  const relationships = new Map(relationshipFile ? xmlNodes(await readXml('xl/_rels/workbook.xml.rels'), 'Relationship').map((item) => [item.getAttribute('Id'), item.getAttribute('Target')]) : [])
  const sharedFile = zip.file('xl/sharedStrings.xml')
  const shared = sharedFile ? xmlNodes(await readXml('xl/sharedStrings.xml'), 'si').map(xmlText) : []
  const sheets = xmlNodes(workbook, 'sheet')
  if (!sheets.length || sheets.length > 50) throw new Error('XLSX 未包含可读取的工作表，或超过 50 个工作表')
  const sections = []
  for (const [index, sheet] of sheets.entries()) {
    await progress(report, '读取工作表', index + 1, sheets.length)
    const id = sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || sheet.getAttribute('r:id')
    const target = relationships.get(id) || `worksheets/sheet${index + 1}.xml`
    const path = target.startsWith('/') ? target.slice(1) : target.startsWith('xl/') ? target : `xl/${target.replace(/^\.\//, '')}`
    const entry = zip.file(path)
    if (!entry) continue
    const xml = await readXml(path)
    const rows = xmlNodes(xml, 'row').map((row) => {
      const cells = xmlNodes(row, 'c').map((cell) => {
        const type = cell.getAttribute('t')
        const value = xmlNodes(cell, 'v')[0]?.textContent || ''
        const content = type === 's' ? shared[Number(value)] || '' : type === 'inlineStr' ? xmlText(xmlNodes(cell, 'is')[0]) : value || xmlNodes(cell, 'f')[0]?.textContent || ''
        return content ? `${cell.getAttribute('r') || ''}: ${content}` : ''
      }).filter(Boolean)
      return cells.length ? `第${row.getAttribute('r') || '?'}行 ${cells.join('；')}` : ''
    }).filter(Boolean)
    if (rows.length) sections.push({ page: null, label: `工作表「${sheet.getAttribute('name') || index + 1}」`, text: rows.join('\n') })
  }
  return sections
}

export async function extractProjectDocument(file, report) {
  if (!file || file.size > MAX_FILE_BYTES) throw new Error('文档不能超过 50MB；请拆分后导入')
  await progress(report, '打开文件', 0, 1)
  const extension = file.name.split('.').pop()?.toLowerCase()
  let sections = []
  if (['txt', 'md', 'csv', 'json'].includes(extension)) {
    sections = [{ page: null, text: await file.text() }]
  } else if (extension === 'docx') {
    const mammoth = await import('mammoth/mammoth.browser.js')
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })
    sections = [{ page: null, text: result.value }]
  } else if (extension === 'pdf') {
    const pdfjs = await import('pdfjs-dist')
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()
    const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise
    if (pdf.numPages > 300) throw new Error('PDF 超过 300 页，请拆分后导入')
    for (let page = 1; page <= pdf.numPages; page++) {
      await progress(report, '读取 PDF 页面', page, pdf.numPages)
      const content = await (await pdf.getPage(page)).getTextContent()
      sections.push({ page, text: content.items.map((item) => item.str || '').join(' ') })
    }
    await pdf.destroy()
  } else if (extension === 'xlsx' || extension === 'pptx') {
    sections = await extractOfficeSections(file, extension, report)
  } else throw new Error(`${file.name} 暂不能读取。支持 PDF、DOCX、XLSX、PPTX、TXT、Markdown、CSV 和 JSON；旧版 DOC/WPS/XLS/PPT 请先另存为新版格式`)
  await progress(report, '整理文字', 1, 1)
  sections = sections.map(({ page, label, text }) => ({ page, label, text: text.replace(/\s+/g, ' ').trim() })).filter(({ text }) => text)
  if (!sections.length) throw new Error('没有提取到文字；扫描版 PDF、纯图片幻灯片需先做 OCR')
  const total = sections.reduce((sum, section) => sum + section.text.length, 0)
  if (total > MAX_DOCUMENT_CHARS) throw new Error('文档文字超过 18 万字，请拆分后导入')
  return { id: crypto.randomUUID(), name: file.name, size: file.size, sections, enabled: true, createdAt: Date.now() }
}

const tokens = (value) => {
  const normalized = String(value || '').toLowerCase()
  const words = normalized.match(/[a-z0-9]{2,}|[\u4e00-\u9fff]{2,}/g) || []
  return [...new Set(words.flatMap((word) => /[\u4e00-\u9fff]/.test(word) && word.length > 2 ? Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2)) : [word]))]
}

export function selectDocumentExcerpts(documents, query, maxChars = 14000) {
  const terms = tokens(query)
  const chunks = documents.filter((doc) => doc.enabled).flatMap((doc) => doc.sections.flatMap(({ page, label, text }) => {
    const segments = text.match(/.{1,1400}/gu) || []
    return segments.map((segment, index) => ({ documentId: doc.id, name: doc.name, page, label, index, text: segment, score: terms.reduce((score, term) => score + (segment.toLowerCase().includes(term) ? 1 : 0), 0) }))
  }))
  if (!chunks.length) return []
  chunks.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name) || String(a.label || a.page || '').localeCompare(String(b.label || b.page || '')) || a.index - b.index)
  const chosen = [], used = new Set()
  let length = 0
  for (const chunk of chunks) {
    if (length + chunk.text.length > maxChars) continue
    const key = `${chunk.documentId}:${chunk.label || chunk.page}:${chunk.index}`
    if (used.has(key)) continue
    used.add(key); chosen.push(chunk); length += chunk.text.length
    if (length >= maxChars - 1400) break
  }
  return chosen
}

export function documentContext(excerpts) {
  return excerpts.map(({ name, page, label, text }) => `【${name} · ${label || (page == null ? '全文' : `${page}页`)}】${text}`).join('\n\n')
}
