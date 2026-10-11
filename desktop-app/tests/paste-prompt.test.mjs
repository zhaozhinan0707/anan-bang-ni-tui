import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizePastedPrompt, isMultilinePromptPaste, wrapPastedPromptForCanvas } from '../app/paste-prompt.js'

test('joins visual line breaks while keeping sections in one prompt', () => {
  const input = '画面类型与画幅：\r\n写实风格户外产品摄影，\r\n高清商业图册质感。\r\n\r\n环境场景：\r\n晴朗天气下的高山森林，\r\n两辆电动自行车。'
  assert.equal(normalizePastedPrompt(input), '画面类型与画幅：\n\n写实风格户外产品摄影，高清商业图册质感。\n\n环境场景：\n\n晴朗天气下的高山森林，两辆电动自行车。')
})

test('does not intercept images, canvas objects, or one-line text', () => {
  assert.equal(isMultilinePromptPaste({ text: '一句提示词' }), false)
  assert.equal(isMultilinePromptPaste({ text: '一行\n二行', files: { image: {} } }), false)
  assert.equal(isMultilinePromptPaste({ text: '一行\n二行', elements: [] }), false)
  assert.equal(isMultilinePromptPaste({ text: '一行\n二行', elements: [{}] }), false)
  assert.equal(isMultilinePromptPaste({ text: '一行\n二行' }), true)
})

test('wraps long prompts visually without creating another canvas element', () => {
  assert.equal(wrapPastedPromptForCanvas('画面描述：\n\n产品保持一致', 8), '画面描述\n：\n\n产品保持\n一致')
})
