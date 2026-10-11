import test from 'node:test'
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import { DOMParser } from '@xmldom/xmldom'
import { extractProjectDocument, documentContext, selectDocumentExcerpts } from '../app/documents.js'

globalThis.DOMParser = DOMParser

const fixture = async (name, entries) => {
  const zip = new JSZip()
  for (const [path, content] of Object.entries(entries)) zip.file(path, content)
  const bytes = await zip.generateAsync({ type: 'uint8array' })
  return { name, size: bytes.byteLength, arrayBuffer: async () => bytes.buffer }
}

test('XLSX extracts shared strings with sheet and cell locations', async () => {
  const file = await fixture('运营需求.xlsx', {
    'xl/workbook.xml': '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="产品卖点" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>车架必须保持一致</t></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2"><v>16</v></c></row></sheetData></worksheet>',
  })
  const document = await extractProjectDocument(file)
  assert.match(document.sections[0].text, /A2: 车架必须保持一致/)
  assert.match(documentContext(selectDocumentExcerpts([document], '车架')), /工作表「产品卖点」/)
})

test('PPTX extracts text with slide number', async () => {
  const file = await fixture('营销方案.pptx', {
    'ppt/slides/slide1.xml': '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>暖色麦田广告</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
  })
  const document = await extractProjectDocument(file)
  assert.equal(document.sections[0].page, 1)
  assert.match(document.sections[0].text, /暖色麦田广告/)
  assert.match(documentContext(selectDocumentExcerpts([document], '麦田')), /1页/)
})

test('files over the former 20MB limit can be read with progress', async () => {
  const file = await fixture('运营需求.xlsx', {
    'xl/workbook.xml': '<workbook><sheets><sheet name="需求"/></sheets></workbook>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>新品拍摄</t></is></c></row></sheetData></worksheet>',
  })
  file.size = 21 * 1024 * 1024
  const updates = []
  const document = await extractProjectDocument(file, (update) => updates.push(update))
  assert.match(document.sections[0].text, /新品拍摄/)
  assert.ok(updates.some((update) => update.stage === '读取工作表'))
})
