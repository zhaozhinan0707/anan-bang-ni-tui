export function parseSkillMarkdown(name, raw) {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > 40_000) throw new Error('SKILL.md 不能超过 40KB')
  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) throw new Error('SKILL.md 缺少 YAML 元信息（---、name、description）')
  const metadata = Object.fromEntries(match[1].split('\n').map((line) => {
    const found = line.match(/^(name|description):\s*(.*)$/)
    return found ? [found[1], found[2].trim().replace(/^['"]|['"]$/g, '')] : []
  }).filter((pair) => pair.length))
  const instruction = match[2].trim()
  const skillName = metadata.name?.trim()
  if (!skillName || skillName.length > 80) throw new Error('SKILL.md 的 name 不能为空或超过 80 字')
  if (!instruction || instruction.length > 12_000) throw new Error('SKILL.md 正文不能为空或超过 12000 字')
  return { name: skillName, description: metadata.description || '', instruction, source: `markdown:${name}` }
}
