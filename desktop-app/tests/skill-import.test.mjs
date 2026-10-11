import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSkillMarkdown } from '../app/skill-import.js'

test('SKILL.md is parsed as previewable text without running commands', () => {
  const skill = parseSkillMarkdown('SKILL.md', '---\nname: 产品场景\ndescription: 保留产品结构\n---\n先检查产品参考图。\n```sh\necho do-not-run\n```')
  assert.equal(skill.name, '产品场景')
  assert.equal(skill.source, 'markdown:SKILL.md')
  assert.match(skill.instruction, /echo do-not-run/)
})

test('invalid and oversized SKILL.md files are rejected', () => {
  assert.throws(() => parseSkillMarkdown('SKILL.md', '正文'), /元信息/)
  assert.throws(() => parseSkillMarkdown('SKILL.md', `---\nname: 大文件\n---\n${'字'.repeat(12001)}`), /40KB|12000/)
})
