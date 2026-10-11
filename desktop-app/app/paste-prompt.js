// Keep an externally written prompt as one canvas object without flattening its sections.
export function normalizePastedPrompt(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').split('\n')
  const paragraphs = []
  let current = ''
  const flush = () => { if (current) paragraphs.push(current); current = '' }
  for (const raw of lines) {
    const line = raw.replace(/[\t ]+/g, ' ').trim()
    if (!line) { flush(); continue }
    if (/^[^。！？.!?]{1,32}[：:]$/.test(line) && current) flush()
    if (current) {
      const chineseJoin = /[\u3400-\u9fff，。、；：！？）]$/.test(current) && /^[\u3400-\u9fff（]/.test(line)
      current += (chineseJoin ? '' : ' ') + line
    } else current = line
    if (/^[^。！？.!?]{1,32}[：:]$/.test(line)) flush()
  }
  flush()
  return paragraphs.join('\n\n')
}

export function isMultilinePromptPaste(data) {
  return typeof data?.text === 'string' && /\r|\n/.test(data.text) && data.text.trim().length > 0 && !data.elements && !data.files && !data.spreadsheet && !data.mixedContent
}

export function wrapPastedPromptForCanvas(text, maxUnits = 76) {
  return text.split('\n').map((line) => {
    if (!line) return ''
    let units = 0, output = ''
    for (const character of line) {
      const width = /[\u2e80-\u9fff\uff00-\uffef]/.test(character) ? 2 : 1
      if (units && units + width > maxUnits) { output += '\n'; units = 0 }
      output += character
      units += width
    }
    return output
  }).join('\n')
}
