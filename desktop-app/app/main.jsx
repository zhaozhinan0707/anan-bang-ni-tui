import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { check } from '@tauri-apps/plugin-updater'
import { Excalidraw, MainMenu } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import './style.css'
import './assets.css'
import './stability.css'
import './update.css'

const LEGACY_KEY = 'promptVault.excalidraw.v1'
const PROJECTS_KEY = 'promptVault.projects.v1'
// 灵感空间固定使用白色画布，不提供主题切换，避免项目之间产生不一致的背景状态。
const CANVAS_BACKGROUND = '#ffffff'
const emptyScene = { elements: [], files: {}, appState: { viewBackgroundColor: CANVAS_BACKGROUND } }
const uid = () => crypto.randomUUID()
const nonce = () => Math.floor(Math.random() * 2 ** 31)
const errorMessage = (error, fallback = '操作失败') => {
  if (typeof error === 'string' && error.trim() && error !== '[object Event]') return error
  if (error instanceof Error && error.message) return error.message
  return fallback
}
const sceneKey = (projectId) => `promptVault.excalidraw.project.${projectId}`
const normalizeScene = (scene = {}) => ({
  elements: Array.isArray(scene.elements) ? scene.elements : [],
  files: scene.files && typeof scene.files === 'object' ? scene.files : {},
  // A browser/app restart cannot safely resume an in-memory request or poll loop.
  // Clear stale busy flags so completed old jobs never reopen as “generating”.
  workflowNodes: Array.isArray(scene.workflowNodes) ? scene.workflowNodes.map((node) => node.generationBusy ? { ...node, generationBusy: false, generationStatus: 'interrupted', generationTaskId: null, generationTaskIds: [], generationRunId: null, generationStartedAt: null } : node) : [],
  // 历史项目无论保存过何种颜色，都统一迁移为固定白色画布。
  appState: { viewBackgroundColor: CANVAS_BACKGROUND },
})
const wrapCanvasText = (value, width = 32) => (value || '').match(new RegExp(`.{1,${width}}`, 'g'))?.join('\n') || ''
const GENERATION_DEFAULTS = {
  generationAspect: '16:9',
  generationQuality: '2K',
  generationCount: 1,
  productConsistency: true,
  generationMultiAngleEnabled: false,
  generationAngleMode: 'camera',
  generationRotate: 0,
  generationTilt: 0,
  generationScale: 'medium',
  generationBacksideReference: null,
  generationActionLock: true,
}
const MULTI_ANGLE_DEFAULTS = {
  generationMultiAngleEnabled: false,
  generationAngleMode: 'camera',
  generationRotate: 0,
  generationTilt: 0,
  generationScale: 'medium',
  generationBacksideReference: null,
  generationActionLock: true,
}
const GENERATION_ASPECTS = ['9:16', '2:3', '3:4', '4:5', '1:1', '5:4', '4:3', '3:2', '16:9', '21:9']
const angleScaleLabel = (value) => ({ close: '近景', medium: '中景', wide: '远景' }[value] || '中景')
const signedAngle = (value) => {
  const number = Number(value) || 0
  return `${number > 0 ? '+' : ''}${number}°`
}
const describeCameraRotation = (value) => {
  const number = clampNumber(value, -180, 180)
  const absolute = Math.abs(number)
  if (absolute < 15) return '保持原始水平视角，不改变主体左右朝向'
  const side = number > 0 ? '右' : '左'
  if (absolute >= 165) return `绕主体向${side}旋转约 ${absolute}°，目标为主体背面视角`
  if (absolute >= 105) return `绕主体向${side}旋转约 ${absolute}°，目标为${side}后方三分之四视角`
  if (absolute >= 60) return `绕主体向${side}旋转约 ${absolute}°，目标为${side}侧面视角`
  return `绕主体向${side}旋转约 ${absolute}°，目标为${side}前方三分之四视角`
}
const describeCameraTilt = (value) => {
  const number = clampNumber(value, -60, 60)
  if (number >= 35) return `高机位俯视约 ${number}°，露出产品顶部和车架上表面`
  if (number >= 15) return `略高机位俯视约 ${number}°`
  if (number <= -35) return `低机位仰视约 ${Math.abs(number)}°，露出产品底部和轮胎接地关系`
  if (number <= -15) return `略低机位仰视约 ${Math.abs(number)}°`
  return '保持接近平视的垂直机位'
}
const describeCameraScale = (value) => {
  if (value === 'close') return '极近景产品特写：摄像机明显靠近主体，产品主体占画面高度约 75%–90%，减少环境留白和远处背景；允许裁切环境，但不得裁掉产品的车把、前后轮、轮胎和关键结构。禁止输出与原图相同的中远景构图。'
  if (value === 'wide') return '远景：摄像机后退，主体约占画面高度 35%–55%，保留更多环境空间和完整场景关系。'
  return '中景：主体约占画面高度 55%–75%，同时保留适量环境和完整产品结构。'
}
const describeAngleEvidence = (node = {}) => {
  const rotation = clampNumber(node.generationRotate, -180, 180)
  const tilt = clampNumber(node.generationTilt, -60, 60)
  const evidence = []
  if (Math.abs(rotation) >= 75) {
    const side = rotation < 0 ? '左' : '右'
    evidence.push(`这是明显的${side}侧大角度换机位，不是轻微旋转或水平翻转；原图正面不能继续正对镜头，正面文字、开口或主立面必须明显变窄并产生强烈侧向透视，${side}侧面、侧壁和遮挡关系必须展开可见，画面消失点与背景透视也要同步偏移`)
  } else if (Math.abs(rotation) >= 35) {
    const side = rotation < 0 ? '左' : '右'
    evidence.push(`这是${side}侧三分之四换机位；主体正面要明显变斜，必须露出对应${side}侧面，不能只改变颜色、光影或做轻微裁切`)
  } else {
    evidence.push('水平视角变化较小，但仍要保持主体结构和场景空间真实，不得把角度变化伪装成单纯缩放或裁切')
  }
  if (tilt >= 18) evidence.push(`这是高机位俯视，必须明显看到主体顶部、上表面或盒体内侧的深度；地面在画面中的位置和垂直线透视要随镜头升高重新计算`)
  else if (tilt <= -18) evidence.push(`这是低机位仰视，必须明显看到主体底部、下表面或接地结构；地面接触和垂直线透视要随镜头降低重新计算`)
  else evidence.push('垂直机位接近平视，不要额外夸大俯视或仰视')
  return `【目标视角可见证据｜必须满足】角度数值是相对于输入原图当前机位的变化量。${evidence.join('；')}。生成后应一眼看出机位已经移动；如果正面宽度、侧面可见度、顶部可见度和背景消失点几乎没有变化，则视为没有执行目标视角，必须重新构图。`
}
const buildMultiAngleInstruction = (node = {}) => {
  if (node.generationMultiAngleEnabled !== true) return ''
  const mode = node.generationAngleMode === 'subject' ? '主体' : '摄像机'
  const rotation = Number(node.generationRotate) || 0
  const tilt = Number(node.generationTilt) || 0
  const extreme = Math.abs(rotation) >= 120 || Math.abs(tilt) >= 45
  const actionLock = node.generationActionLock !== false
  const backsideReference = node.generationBacksideReference?.dataURL ? '【产品背面参考图已上传｜高优先级】本次请求附带的这张图片是当前产品的同一型号、另一面（背面）参考，不是新产品、不是场景参考，也不是要替换的产品。目标视角接近背面时，必须优先依据它还原背面的车架、轮组、灯具、接口、贴花、走线和结构关系；正面图与背面图共有的结构必须保持一致，若文字描述与背面图可见结构冲突，以背面图的可见结构为准。' : ''
  const motion = mode === '主体'
    ? '调整产品主体的朝向，背景可以保持大体构图和光线稳定，但产品、人物和地面的接触关系必须真实'
    : '让虚拟摄像机围绕整个场景运动，人物、产品、地面和背景都按同一个摄像机位置重新投影，保持透视、接地和空间关系自然'
  const sceneLock = mode === '摄像机'
    ? '【整场景联动｜高优先级】摄像机模式不是只把产品翻面，也不是对产品局部做左右镜像；它表示摄像机移动到目标位置后重新拍摄同一个物理场景。人物、产品、地面、建筑和背景文字必须一起随新机位改变画面位置、可见侧面、透视和遮挡关系。不要把人物和背景原封不动地留在原正面构图里，也不要把背景当成贴图固定在原像素位置；原图看不到的背景区域按场景逻辑自然补全。'
    : '【主体模式】只改变产品主体朝向，人物和背景尽量保持原构图；仍需重新计算产品与人物、地面和环境之间的遮挡与接触，不得把产品穿过人物或地面。'
  const poseLock = actionLock
    ? '【人物动作锁定｜高优先级】如果原场景包含人物或骑行者，必须保持原图的人物身份、人数、当前姿势、头部朝向、身体重心、四肢骨架、手脚位置、抓握关系、骑行动作、服装和人与产品的相对关系。动作锁定表示保持人物在真实空间中的姿态，只允许因摄像机移动而改变画面中的投影、可见侧面和遮挡；禁止把人物改成另一种动作、重新站立、抬手、迈步、骑行状态，禁止增加或减少人物和肢体，禁止改变人与产品的接触点。'
    : mode === '摄像机'
      ? '如果原场景包含人物或骑行者，保持原图的人物身份、人数、动作意图、身体重心、四肢骨架、手脚位置、抓握关系、骑行动作和服装；这些关系在真实空间中保持不变，但必须从目标摄像机方向重新呈现，允许看到人物的侧面或背面，禁止把原图正面人物直接贴回新背景。'
      : '如果原场景包含人物或骑行者，必须保持原图的人物身份、人数、头部朝向、身体重心、四肢骨架、手脚位置、抓握关系、骑行动作、服装和人与产品的相对关系；不得因为换视角而改成另一种姿势、增加或减少肢体、改变人物与产品的接触点。'
  const depthLock = '【空间与遮挡锁定】先判断人物、产品、地面和背景的前后深度，再生成画面；手必须真实握住车把，脚必须真实踩地或与踏板接触，车轮必须落在地面上。禁止手脚、车把、车架、轮胎穿过身体、衣服、地面或彼此重叠成不可能的结构；遮挡边界要自然连续，不能出现肢体断裂、双重车把、悬空车轮或穿模。'
  const extremeNote = extreme ? '这是极端视角变化。即使目标方向需要补全原图看不到的背面，也要优先保持整个人物动作、场景空间和产品结构，允许只对不可见区域做最小必要补全；不得为了补全背面而只重画产品、固定原背景，或重画整个人物。' : ''
  return `【多角度视角控制｜最高优先级】\n这是同一场景的视角变体生成，不是只修改产品，也不是重新设计产品。控制模式：${mode}。目标水平视角：${describeCameraRotation(node.generationRotate)}；目标垂直机位：${describeCameraTilt(node.generationTilt)}；目标旋转数值：${signedAngle(rotation)}；目标倾斜数值：${signedAngle(tilt)}；取景距离：${angleScaleLabel(node.generationScale)}。${describeCameraScale(node.generationScale)}${motion}。必须严格执行上述数值对应的目标机位，让人物和产品的可见侧面、背景透视、主体占画面比例、地面接触和遮挡关系发生与目标视角一致的明显变化；不要只改变颜色、产品姿势、背景或轻微裁切。尤其是近景和远景模式，必须先改变镜头距离和主体占画面比例，再处理人物、产品和背景的透视；不要把景别理解成只放大或缩小画布。${describeAngleEvidence(node)}${sceneLock}${poseLock}${depthLock}${extremeNote}${backsideReference}严格保持产品型号、车架结构、车把、立管、踏板、前后轮、轮毂、轮胎、挡泥板、灯具、走线、贴花、Logo、颜色、材质和各部件比例完全一致；目标视角看不到的区域按产品参考图和产品结构合理补全，禁止变成其他型号、通用款或新增删减部件。`
}
const formatGenerationDuration = (milliseconds = 0) => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  return seconds >= 60 ? `${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, '0')}秒` : `${seconds}秒`
}
const formatPhaseDuration = (milliseconds = 0) => milliseconds >= 60_000 ? formatGenerationDuration(milliseconds) : `${(Math.max(0, milliseconds) / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)}秒`
const PRODUCT_CONSISTENCY_INSTRUCTION = '以输入的产品参考图为唯一外观依据，严格保持产品身份与外观一致：不得改变车架几何结构、车把、立管、踏板、前后轮、轮毂、轮胎、挡泥板、灯具、走线、折叠机构、接口、配色、材质、贴花、Logo及各部件比例。根据后续完整提示词生成新场景，不要重新设计产品，不要添加或删除部件。'
const GENERATION_SIZES = {
  '1K': { '9:16': '576x1024', '2:3': '683x1024', '3:4': '768x1024', '4:5': '819x1024', '1:1': '1024x1024', '5:4': '1024x819', '4:3': '1024x768', '3:2': '1024x683', '16:9': '1024x576', '21:9': '1024x439' },
  '2K': { '9:16': '1152x2048', '2:3': '1365x2048', '3:4': '1536x2048', '4:5': '1638x2048', '1:1': '2048x2048', '5:4': '2048x1638', '4:3': '2048x1536', '3:2': '2048x1365', '16:9': '2048x1152', '21:9': '2048x878' },
  '4K': { '9:16': '2160x3840', '2:3': '2731x4096', '3:4': '3072x4096', '4:5': '3277x4096', '1:1': '4096x4096', '5:4': '4096x3277', '4:3': '4096x3072', '3:2': '4096x2731', '16:9': '3840x2160', '21:9': '4096x1755' },
}
const GENERATION_COMPATIBLE_SIZES = { '9:16': '1024x1792', '2:3': '1024x1536', '3:4': '1024x1365', '4:5': '1024x1280', '1:1': '1024x1024', '5:4': '1280x1024', '4:3': '1024x768', '3:2': '1536x1024', '16:9': '1792x1024', '21:9': '1792x768' }
const generationModelFor = (baseModel, quality) => {
  if (!baseModel?.startsWith('nano-banana-pro')) return baseModel
  return quality === '1K' ? 'nano-banana-pro_1K' : quality === '4K' ? 'nano-banana-pro_4k' : 'nano-banana-pro_2k'
}
const parseGenerationCommand = (value, node) => {
  const normalized = value.replace(/：/g, ':').toUpperCase()
  if (!/(生成|生图|出图|方案)/.test(normalized)) return null
  const aspect = normalized.match(/(?:21:9|16:9|9:16|5:4|4:5|3:2|2:3|4:3|3:4|1:1)/)?.[0] || node?.generationAspect || GENERATION_DEFAULTS.generationAspect
  const quality = normalized.match(/(?:1K|2K|4K)/)?.[0] || node?.generationQuality || GENERATION_DEFAULTS.generationQuality
  const countMatch = normalized.match(/生成\s*(\d)\s*(?:张|个|套|款|幅|方案)?/) || normalized.match(/(\d)\s*(?:张|个方案|套方案|款方案|幅)/)
  const count = Math.max(1, Math.min(4, Number(countMatch?.[1] || node?.generationCount || GENERATION_DEFAULTS.generationCount)))
  return { aspect, quality, count }
}
const promptWithoutGenerationCommand = (value) => value.replace(/：/g, ':')
  .replace(/(?:^|[，,；;。\n]\s*)(?:21:9|16:9|9:16|5:4|4:5|3:2|2:3|4:3|3:4|1:1)?\s*[，,、\s]*(?:1K|2K|4K)?\s*[，,、\s]*(?:生成|生图|出图)\s*\d?\s*(?:张|个|套|款|幅|方案)*\s*[。！!]?$/i, '')
  .replace(/[，,；;。\s]+$/, '')
  .trim()

async function compressForVision(dataURL) {
  const rawBytes = Math.ceil((dataURL.length - dataURL.indexOf(',') - 1) * 0.75)
  // 仅供视觉模型理解：降低上传体积可缩短反推等待，不影响画布或下载的原始文件。
  if (rawBytes <= 2 * 1024 * 1024) return dataURL
  const image = await new Promise((resolve, reject) => { const source = new Image(); source.onload = () => resolve(source); source.onerror = () => reject(new Error('参考图解码失败，请重新上传')); source.src = dataURL })
  const maxSide = 1600, ratio = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight))
  const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio)); canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio))
  const context = canvas.getContext('2d'); context.drawImage(image, 0, 0, canvas.width, canvas.height)
  let quality = 0.9, output = canvas.toDataURL('image/jpeg', quality)
  while (output.length > 6_000_000 && quality > 0.45) { quality -= 0.1; output = canvas.toDataURL('image/jpeg', quality) }
  return output
}

const dataUrlBytes = (value) => Math.ceil((value.length - value.indexOf(',') - 1) * 0.75)

const readImageFile = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(reader.result)
  reader.onerror = () => reject(new Error(`无法读取参考图：${file?.name || '未命名图片'}`))
  reader.readAsDataURL(file)
})

// 素材原图由桌面端按项目单独保存；这里仅做一个轻量缩略图，用于素材抽屉预览。
async function makeAssetThumbnail(dataURL) {
  const image = await new Promise((resolve, reject) => { const source = new Image(); source.onload = () => resolve(source); source.onerror = reject; source.src = dataURL })
  const max = 360, scale = Math.min(1, max / Math.max(image.naturalWidth, image.naturalHeight))
  const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.76)
}
const persistedFiles = (files = {}) => Object.fromEntries(Object.entries(files).map(([id, file]) => file?.assetId ? [id, { ...file, dataURL: undefined }] : [id, file]))
const serializableScene = (scene = {}) => ({ elements: scene.elements || [], appState: { viewBackgroundColor: CANVAS_BACKGROUND }, files: persistedFiles(scene.files), workflowNodes: scene.workflowNodes || [] })

// 仅生成请求使用这个副本：画布、剪贴板及“下载原图”仍始终保留原始文件。
// 多张 Base64 图片会被 JSON 再次放大；此处给每张图片硬性限额，避免被网关以 413 拦截。
async function prepareGenerationReference(dataURL, maxBytes) {
  if (dataUrlBytes(dataURL) <= maxBytes) return dataURL
  const image = await new Promise((resolve, reject) => { const source = new Image(); source.onload = () => resolve(source); source.onerror = () => reject(new Error('产品参考图解码失败，请重新上传')); source.src = dataURL })
  const canvas = document.createElement('canvas')
  const maxSide = 1280
  let scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight))
  let quality = 0.88
  let output = dataURL
  for (let attempt = 0; attempt < 10; attempt += 1) {
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    const context = canvas.getContext('2d')
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    output = canvas.toDataURL('image/jpeg', quality)
    if (dataUrlBytes(output) <= maxBytes) return output
    if (quality > 0.52) quality -= 0.08
    else { scale *= 0.8; quality = 0.8 }
  }
  return output
}

async function createInpaintMask(dataURL, boxes = []) {
  const usable = boxes.filter((box) => box && Number(box.width) > 0 && Number(box.height) > 0)
  if (!usable.length) return null
  const image = await new Promise((resolve, reject) => { const source = new Image(); source.onload = () => resolve(source); source.onerror = () => reject(new Error('无法为文字区域生成编辑遮罩')); source.src = dataURL })
  const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
  const context = canvas.getContext('2d'); context.fillStyle = '#000'; context.fillRect(0, 0, canvas.width, canvas.height)
  context.globalCompositeOperation = 'destination-out'
  usable.forEach((box) => {
    const x = Math.max(0, Math.min(1, Number(box.x) || 0)) * canvas.width
    const y = Math.max(0, Math.min(1, Number(box.y) || 0)) * canvas.height
    const width = Math.max(1, Math.min(1, Number(box.width) || 0)) * canvas.width
    const height = Math.max(1, Math.min(1, Number(box.height) || 0)) * canvas.height
    const padding = Math.max(8, Math.round(Math.min(width, height) * 0.18))
    context.clearRect(Math.max(0, x - padding), Math.max(0, y - padding), Math.min(canvas.width - Math.max(0, x - padding), width + padding * 2), Math.min(canvas.height - Math.max(0, y - padding), height + padding * 2))
  })
  return canvas.toDataURL('image/png')
}

// 文字编辑是局部操作：生成模型只负责文字框内的替换，框外直接保留原图像素。
// 这样可以避免模型顺手改变人物、产品、背景或整张图的版式。
async function compositeMaskedEdit(originalDataURL, generatedDataURL, boxes = []) {
  const usable = boxes.filter((box) => box && Number(box.width) > 0 && Number(box.height) > 0)
  const load = (dataURL) => new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error('文字编辑结果无法合成')); image.src = dataURL })
  const [original, generated] = await Promise.all([load(originalDataURL), load(generatedDataURL)])
  // 最终输出尺寸以原图为准，而不是以接口返回的 2048/4096 图为准。
  const canvas = document.createElement('canvas'); canvas.width = original.naturalWidth; canvas.height = original.naturalHeight
  const context = canvas.getContext('2d')
  if (!usable.length) {
    context.drawImage(generated, 0, 0, canvas.width, canvas.height)
  } else {
    context.drawImage(original, 0, 0, canvas.width, canvas.height)
    context.save()
    context.beginPath()
    usable.forEach((box) => {
      const x = Math.max(0, Math.min(1, Number(box.x) || 0)) * canvas.width
      const y = Math.max(0, Math.min(1, Number(box.y) || 0)) * canvas.height
      const width = Math.max(1, Math.min(1, Number(box.width) || 0)) * canvas.width
      const height = Math.max(1, Math.min(1, Number(box.height) || 0)) * canvas.height
      context.rect(x, y, width, height)
    })
    context.clip()
    context.drawImage(generated, 0, 0, canvas.width, canvas.height)
    context.restore()
  }
  return canvas.toDataURL('image/png')
}

async function imageAspect(dataURL) {
  const image = await new Promise((resolve, reject) => { const source = new Image(); source.onload = () => resolve(source); source.onerror = () => reject(new Error('无法读取编辑原图尺寸')); source.src = dataURL })
  return image.naturalWidth / Math.max(1, image.naturalHeight)
}

const closestGenerationAspect = (ratio) => GENERATION_ASPECTS.reduce((closest, value) => {
  const [width, height] = value.split(':').map(Number)
  return Math.abs(width / height - ratio) < Math.abs(closest[0] / closest[1] - ratio) ? [width, height, value] : closest
}, [16, 9, '16:9'])[2]

async function prepareGenerationReferences(images) {
  const usable = images.filter((image) => image?.dataURL).slice(0, 8)
  if (!usable.length) return []
  // 为图片预留约 2.2MB 的二进制空间，连同 JSON/Base64 后仍低于常见的 4MB 网关上限。
  const perImageBudget = Math.max(240 * 1024, Math.min(700 * 1024, Math.floor((2.2 * 1024 * 1024) / usable.length)))
  return Promise.all(usable.map((image) => prepareGenerationReference(image.dataURL, perImageBudget)))
}

async function composeVisionReferences(primary, references = []) {
  const sources = [primary, ...references].filter((item) => item?.dataURL).slice(0, 8)
  if (!sources.length) throw new Error('没有可用的原图或参考图')
  if (sources.length === 1) return compressForVision(sources[0].dataURL)
  const results = await Promise.allSettled(sources.map((item, index) => new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve({ image, role: item.role || '参考图片' }); image.onerror = () => reject(new Error(`${index === 0 ? '原图' : `参考图${index}`}无法加载`)); image.src = item.dataURL })))
  const images = results.filter((result) => result.status === 'fulfilled').map((result) => result.value)
  if (!images.length) throw new Error('原图和参考图都无法加载，请删除后重新上传')
  if (images.length === 1) return compressForVision(images[0].image.src)
  const cellWidth = 720, cellHeight = 520, columns = Math.min(2, images.length), rows = Math.ceil(images.length / columns)
  const canvas = document.createElement('canvas'); canvas.width = cellWidth * columns; canvas.height = cellHeight * rows
  const context = canvas.getContext('2d'); context.fillStyle = '#202124'; context.fillRect(0, 0, canvas.width, canvas.height)
  context.font = '24px Microsoft YaHei, sans-serif'; context.textBaseline = 'top'
  images.forEach(({ image, role }, index) => {
    const column = index % columns, row = Math.floor(index / columns), x = column * cellWidth, y = row * cellHeight
    const scale = Math.min((cellWidth - 24) / image.naturalWidth, (cellHeight - 62) / image.naturalHeight)
    const width = image.naturalWidth * scale, height = image.naturalHeight * scale
    context.drawImage(image, x + (cellWidth - width) / 2, y + 44 + (cellHeight - 44 - height) / 2, width, height)
    context.fillStyle = '#111827cc'; context.fillRect(x, y, cellWidth, 40); context.fillStyle = '#ffffff'; context.fillText(`${index === 0 ? '主图' : `参考图 ${index}`} · ${role}`, x + 12, y + 8)
  })
  return compressForVision(canvas.toDataURL('image/jpeg', 0.88))
}

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null } }
  static getDerivedStateFromError(error) { return { error } }
  render() { return this.state.error ? <main className="startup-error"><h1>画布启动失败</h1><p>请将错误信息发给开发者；本地文件不会丢失。</p><pre>{String(this.state.error.stack || this.state.error)}</pre><button onClick={() => location.reload()}>重新加载</button></main> : this.props.children }
}

function loadProjects() {
  try { const data = JSON.parse(localStorage.getItem(PROJECTS_KEY)); if (Array.isArray(data) && data.length) return data } catch {}
  return [{ id: 'default', name: '未命名项目', createdAt: Date.now() }]
}
function loadScene(projectId) {
  try {
    const saved = localStorage.getItem(sceneKey(projectId)) || (projectId === 'default' ? localStorage.getItem(LEGACY_KEY) : null)
    if (!saved) return emptyScene
    const scene = JSON.parse(saved)
    if (!Array.isArray(scene.elements) || !scene.files || typeof scene.files !== 'object') throw new Error('画布数据结构损坏')
    return normalizeScene(scene)
  } catch (error) {
    const raw = localStorage.getItem(sceneKey(projectId))
    if (raw) localStorage.setItem(`promptVault.recovery.${projectId}.${Date.now()}`, raw)
    console.error('项目启动自检发现损坏数据，已隔离原始副本', error)
    return emptyScene
  }
}

function GenerationTimer({ node }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!node.generationBusy || !node.generationStartedAt) return undefined
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [node.generationBusy, node.generationStartedAt])
  const elapsed = node.generationBusy ? now - Number(node.generationStartedAt || now) : Number(node.generationElapsedMs || 0)
  if (!node.generationBusy && !node.generationElapsedMs) return null
  return <span className={`generation-timer ${node.generationBusy ? 'running' : ''}`} title={node.generationBusy ? '本次生图正在计时' : '本次生图耗时'}>⏱ {formatGenerationDuration(elapsed)}</span>
}

function GenerationTimingBreakdown({ timing }) {
  if (!timing || !Number.isFinite(timing.preparationMs)) return null
  const items = [
    ['本地处理', timing.preparationMs],
    ['提交服务', timing.submitMs],
    ['服务端排队/生成', timing.serverMs],
    ['下载写入', timing.downloadMs],
  ].filter(([, value]) => Number.isFinite(value))
  return <section className="generation-timing" title={timing.taskCount > 1 ? `按 ${timing.taskCount} 张成功图片的平均耗时汇总` : '本次生图耗时分段'}><b>本次耗时分段{timing.taskCount > 1 ? ` · ${timing.taskCount} 张平均` : ''}</b><div>{items.map(([label, value]) => <span key={label}><small>{label}</small>{formatPhaseDuration(value)}</span>)}</div></section>
}

const clampNumber = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0))

function CameraOrbitControl({ rotate = 0, tilt = 0, previewUrl = '', onChange, disabled = false }) {
  const orbitRef = useRef(null)
  const draggingRef = useRef(false)
  const pointFor = (horizontal, vertical) => {
    const x = 140 + (clampNumber(horizontal, -180, 180) / 180) * 102
    const y = 112 - (clampNumber(vertical, -60, 60) / 60) * 72
    return { x, y }
  }
  const updateFromPointer = (event) => {
    const rect = orbitRef.current?.getBoundingClientRect()
    if (!rect) return
    const x = clampNumber(event.clientX - rect.left, 18, rect.width - 18)
    const y = clampNumber(event.clientY - rect.top, 18, rect.height - 18)
    onChange?.({ generationRotate: Math.round(clampNumber(((x - rect.width / 2) / (rect.width * 0.42)) * 180, -180, 180)), generationTilt: Math.round(clampNumber(((rect.height / 2 - y) / (rect.height * 0.32)) * 60, -60, 60)) })
  }
  const start = (event) => {
    if (disabled) return
    event.preventDefault(); event.stopPropagation(); draggingRef.current = true
    event.currentTarget.setPointerCapture?.(event.pointerId)
    updateFromPointer(event)
  }
  const move = (event) => { if (draggingRef.current) { event.preventDefault(); updateFromPointer(event) } }
  const stop = (event) => { draggingRef.current = false; event.currentTarget.releasePointerCapture?.(event.pointerId) }
  const point = pointFor(rotate, tilt)
  return <div ref={orbitRef} className={`camera-orbit ${disabled ? 'disabled' : ''}`} onPointerDown={start} onPointerMove={move} onPointerUp={stop} onPointerCancel={stop} title="拖动摄像机调整视角">
    <svg viewBox="0 0 280 224" role="img" aria-label="摄像机视角控制球">
      <ellipse cx="140" cy="112" rx="102" ry="72" className="orbit-ring orbit-ring-horizontal" />
      <ellipse cx="140" cy="112" rx="102" ry="32" className="orbit-ring orbit-ring-depth" />
      <ellipse cx="140" cy="112" rx="48" ry="72" className="orbit-ring orbit-ring-vertical" />
      <path d="M38 112h204M140 40v144" className="orbit-axis" />
      <circle cx="140" cy="112" r="24" className="orbit-subject" />
      {previewUrl && <image href={previewUrl} x="116" y="94" width="48" height="36" preserveAspectRatio="xMidYMid slice" className="orbit-preview" />}
      <g className="orbit-camera" transform={`translate(${point.x} ${point.y})`}>
        <rect x="-15" y="-10" width="30" height="20" rx="4" />
        <path d="M-8-10l4-6h8l4 6M15-4l9-5v18l-9-5z" />
        <circle cx="0" cy="0" r="5" />
      </g>
      <text x="140" y="207" className="orbit-hint">拖动摄像机</text>
    </svg>
  </div>
}

function MultiAngleDialog({ value = {}, previewUrl = '', onUse, onClose, disabled = false }) {
  const initial = { ...MULTI_ANGLE_DEFAULTS, ...value, generationMultiAngleEnabled: true }
  const [draft, setDraft] = useState(initial)
  const [referenceError, setReferenceError] = useState('')
  useEffect(() => setDraft({ ...MULTI_ANGLE_DEFAULTS, ...value, generationMultiAngleEnabled: true }), [value?.generationAngleMode, value?.generationRotate, value?.generationTilt, value?.generationScale, value?.generationBacksideReference?.id, value?.generationBacksideReference?.dataURL, value?.generationActionLock])
  const patch = (changes) => setDraft((current) => ({ ...current, ...changes, generationMultiAngleEnabled: true }))
  const scaleLabel = angleScaleLabel(draft.generationScale)
  const extreme = Math.abs(Number(draft.generationRotate) || 0) >= 120 || Math.abs(Number(draft.generationTilt) || 0) >= 45
  const backsideReference = draft.generationBacksideReference?.dataURL ? draft.generationBacksideReference : null
  const selectBacksideReference = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const dataURL = await readImageFile(file)
      setReferenceError('')
      patch({ generationBacksideReference: { id: uid(), dataURL, name: file.name || '产品背面参考图', mimeType: file.type || 'image/png', role: '同一产品的背面参考图' } })
    } catch (error) {
      setReferenceError(errorMessage(error, '背面参考图读取失败，请重试'))
    }
  }
  return <div className="multi-angle-backdrop" onMouseDown={onClose}>
    <section className="multi-angle-dialog" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><small>MULTI-ANGLE</small><h3>多角度</h3></div><button type="button" onClick={onClose}>×</button></header>
      <div className="multi-angle-tabs"><button type="button" className={draft.generationAngleMode === 'subject' ? 'active' : ''} onClick={() => patch({ generationAngleMode: 'subject' })}>主体</button><button type="button" className={draft.generationAngleMode !== 'subject' ? 'active' : ''} onClick={() => patch({ generationAngleMode: 'camera' })}>摄像机</button></div>
      <div className="multi-angle-orbit-wrap"><CameraOrbitControl rotate={draft.generationRotate} tilt={draft.generationTilt} previewUrl={previewUrl} disabled={disabled || draft.generationAngleMode === 'subject'} onChange={patch} /></div>
      <div className="multi-angle-sliders">
        <label><span>旋转 <output>{signedAngle(draft.generationRotate)}</output></span><input type="range" min="-180" max="180" value={Number(draft.generationRotate) || 0} disabled={disabled} onChange={(event) => patch({ generationRotate: Number(event.target.value) })} /></label>
        <label><span>倾斜 <output>{signedAngle(draft.generationTilt)}</output></span><input type="range" min="-60" max="60" value={Number(draft.generationTilt) || 0} disabled={disabled} onChange={(event) => patch({ generationTilt: Number(event.target.value) })} /></label>
        <label><span>缩放 <output>{scaleLabel}</output></span><select value={draft.generationScale || 'medium'} disabled={disabled} onChange={(event) => patch({ generationScale: event.target.value })}><option value="close">近景</option><option value="medium">中景</option><option value="wide">远景</option></select></label>
      </div>
       <small className="multi-angle-note">拖动摄像机后，旋转和倾斜数值会同步更新。第一版通过现有生图模型生成视角变体。</small>{extreme && <small className="multi-angle-warning">当前是极端视角：模型会补全原图看不到的区域，已自动优先锁定人物动作和产品结构；如仍需更稳定，建议先用 60°–90° 的中等变化。</small>}
       <label className="multi-angle-action-lock"><input type="checkbox" checked={draft.generationActionLock !== false} disabled={disabled} onChange={(event) => patch({ generationActionLock: event.target.checked })} /><span><b>锁定人物当前动作</b><small>只改变镜头投影，不重新摆姿势；关闭后人物可能随场景重新生成。</small></span></label>
       <section className="multi-angle-reference">
         <div className="multi-angle-reference-heading"><div><b>背面参考图（可选）</b><small>正面切换背面时上传同一产品的背面图，帮助模型还原真实结构。</small></div>{backsideReference && <button type="button" onClick={() => { setReferenceError(''); patch({ generationBacksideReference: null }) }} disabled={disabled}>删除</button>}</div>
         {backsideReference ? <figure><img src={backsideReference.dataURL} alt="产品背面参考图" /><figcaption><strong>{backsideReference.name || '已上传背面参考图'}</strong><span>将作为同一产品的另一面结构依据发送</span></figcaption><label className="multi-angle-reference-replace">重新选择<input type="file" accept="image/*" onChange={selectBacksideReference} disabled={disabled} /></label></figure> : <label className="multi-angle-reference-upload"><span>＋ 上传产品背面图</span><small>建议使用同一产品、相近比例的白底图或清晰实拍图</small><input type="file" accept="image/*" onChange={selectBacksideReference} disabled={disabled} /></label>}
         {referenceError && <small className="multi-angle-reference-error">{referenceError}</small>}
       </section>
       <footer><button type="button" onClick={onClose}>取消</button><button type="button" className="primary" disabled={disabled} onClick={() => onUse(draft)}>立即使用 ↗</button></footer>
    </section>
  </div>
}

function QuickEditPopover({ value, onChange, onSubmit, onClose, busy = false, error = '', position, title = '', placeholder = '描述你想修改的内容，例如：把天空改成夕阳，保留人物动作和产品结构…', hint = '只修改你明确点名的一个或两个元素，其他内容会按原图锁定。', submitLabel = '生成' }) {
  return <section className="quick-edit-popover" style={position} onPointerDown={(event) => event.stopPropagation()}>
    {title && <b className="quick-edit-title">{title}</b>}
    <textarea autoFocus value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) onSubmit() }} placeholder={placeholder} disabled={busy} />
    <div className="quick-edit-hint">{hint}</div>
    {error && <p className="quick-edit-error">{error}</p>}
    <footer><button type="button" onClick={onClose} disabled={busy}>取消</button><button type="button" className="primary" onClick={onSubmit} disabled={busy || !value.trim()}>{busy ? '正在生成局部编辑…' : submitLabel}</button></footer>
  </section>
}

const parseRecognizedText = (raw) => {
  const cleaned = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  let parsed = null
  try { parsed = JSON.parse(cleaned) } catch {
    const start = Math.min(...[cleaned.indexOf('{'), cleaned.indexOf('[')].filter((value) => value >= 0))
    const end = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'))
    if (Number.isFinite(start) && start >= 0 && end > start) { try { parsed = JSON.parse(cleaned.slice(start, end + 1)) } catch {} }
  }
  const values = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.texts) ? parsed.texts : [])
  const normalized = values.map((item, index) => {
    const text = typeof item === 'string' ? item : item?.text
    if (!text || !String(text).trim()) return null
    const rawBox = item?.box || item?.bbox || item?.boundingBox
    const values = Array.isArray(rawBox) ? rawBox : [rawBox?.x, rawBox?.y, rawBox?.width, rawBox?.height]
    const box = values.length === 4 && values.every((value) => Number.isFinite(Number(value))) ? { x: Math.max(0, Math.min(1, Number(values[0]))), y: Math.max(0, Math.min(1, Number(values[1]))), width: Math.max(0, Math.min(1, Number(values[2]))), height: Math.max(0, Math.min(1, Number(values[3]))) } : null
    return { id: uid(), original: String(text).trim(), value: String(text).trim(), box, location: item?.location || `文字区域 ${index + 1}`, style: item?.style || '' }
  }).filter(Boolean)
  if (normalized.length) return normalized
  return cleaned.split(/\r?\n/).map((line) => line.replace(/^[-*\d.、]+\s*/, '').trim()).filter((line) => line && !/^识别|^图片中|^没有/.test(line)).map((text, index) => ({ id: uid(), original: text, value: text, box: null, location: `文字区域 ${index + 1}`, style: '' }))
}

function TextEditDialog({ items, onChange, onGenerate, onClose, busy = false, error = '', recognizing = false }) {
  return <div className="text-edit-backdrop" onMouseDown={() => !busy && onClose()}>
    <section className="text-edit-dialog" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><small>TEXT EDIT</small><h2>{recognizing ? '正在识别图片文字…' : '识别图片文字'}</h2></div><button type="button" onClick={onClose} disabled={busy}>×</button></header>
      {recognizing ? <div className="text-edit-loading">AI 正在读取图片中的标题、参数、卖点和其他可见文字，请稍候…</div> : items.length ? <><p className="text-edit-description">已识别到 {items.length} 处文字。只修改你需要替换的内容，位置、字体、颜色、透视和其他画面会保持不变。</p><div className="text-edit-list">{items.map((item, index) => <label key={item.id}><span>文字 {index + 1}<small>{item.location}{item.style ? ` · ${item.style}` : ''}</small></span><textarea value={item.value} onChange={(event) => onChange(item.id, event.target.value)} disabled={busy} /></label>)}</div></> : <div className="text-edit-empty">没有识别到清晰文字。请关闭窗口后换一张更清晰的图片重试。</div>}
      {error && <p className="text-edit-error">{error}</p>}
      <footer><button type="button" onClick={onClose} disabled={busy}>取消</button><button type="button" className="primary" onClick={onGenerate} disabled={busy || recognizing || !items.some((item) => item.value.trim() && item.value.trim() !== item.original.trim())}>{busy ? '正在生成文字修改…' : '生成修改结果'}</button></footer>
    </section>
  </div>
}

function WorkflowNodes({ nodes, elements, viewport, layerRef, templates, selectedIds, onSelect, onBeginMove, onMoveMany, onRegenerate, onModify, onGenerate, onCancelGeneration, onUpdate, onAttachImage, onRemoveImage, onDelete, onDisconnect }) {
  const drag = useRef(null)
  const generationGuardUntil = useRef(0)
  const zoom = viewport.zoom?.value || viewport.zoom || 1
  const toScreen = (x, y) => ({ x: (x + (viewport.scrollX || 0)) * zoom, y: (y + (viewport.scrollY || 0)) * zoom })
  const startDrag = (event, node) => {
    const ids = selectedIds.includes(node.id) ? selectedIds : [node.id]
    if (!selectedIds.includes(node.id)) onSelect(node.id, event.shiftKey)
    onBeginMove()
    drag.current = { ids, startClientX: event.clientX, startClientY: event.clientY, positions: Object.fromEntries(nodes.filter((item) => ids.includes(item.id)).map((item) => [item.id, { x: item.x, y: item.y }])) }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    event.preventDefault()
    event.stopPropagation()
  }
  const moveDrag = (event) => {
    if (!drag.current) return
    const dx = (event.clientX - drag.current.startClientX) / zoom, dy = (event.clientY - drag.current.startClientY) / zoom
    onMoveMany(drag.current.ids, drag.current.positions, dx, dy)
  }
  const stopDrag = () => { drag.current = null }
  const changeGenerationSetting = (event, node, key, value) => {
    event.stopPropagation()
    generationGuardUntil.current = Date.now() + 650
    onUpdate(node.id, { [key]: value })
  }
  const runGeneration = (event, node) => {
    event.stopPropagation()
    if (Date.now() < generationGuardUntil.current) return
    onGenerate(node)
  }
  const elementById = new Map(elements.filter((element) => !element.isDeleted).map((element) => [element.id, element]))
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const grouped = Object.values(nodes.reduce((groups, node) => {
    if (!node.workflowGroupId) return groups
    const source = elementById.get(node.sourceElementId)
    const boxes = [{ x: node.x, y: node.y, width: node.width, height: node.height }]
    if (source) boxes.push(source)
    const entry = groups[node.workflowGroupId] || { id: node.workflowGroupId, name: node.workflowGroupName || '分组', boxes: [] }
    entry.boxes.push(...boxes); groups[node.workflowGroupId] = entry
    return groups
  }, {})).map((group) => {
    const left = Math.min(...group.boxes.map((box) => box.x)) - 36, top = Math.min(...group.boxes.map((box) => box.y)) - 56
    const right = Math.max(...group.boxes.map((box) => box.x + box.width)) + 36, bottom = Math.max(...group.boxes.map((box) => box.y + box.height)) + 36
    return { ...group, left, top, width: right - left, height: bottom - top }
  })
  const connector = (fromBox, toBox) => {
    const fromCenter = { x: fromBox.x + fromBox.width / 2, y: fromBox.y + fromBox.height / 2 }
    const toCenter = { x: toBox.x + toBox.width / 2, y: toBox.y + toBox.height / 2 }
    const fromRight = toCenter.x >= fromCenter.x
    const from = toScreen(fromRight ? fromBox.x + fromBox.width : fromBox.x, fromCenter.y)
    const to = toScreen(fromRight ? toBox.x : toBox.x + toBox.width, toCenter.y)
    const bend = Math.max(54, Math.min(180, Math.abs(to.x - from.x) * .46)) * (fromRight ? 1 : -1)
    return { from, to, middle: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, path: `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}` }
  }
  return <div ref={layerRef} className="workflow-layer">
    <svg className="workflow-links">{grouped.map((group) => { const point = toScreen(group.left, group.top); return <g className="workflow-group" key={group.id}><rect x={point.x} y={point.y} width={group.width * zoom} height={group.height * zoom} rx={16 * zoom} /><text x={point.x + 14 * zoom} y={point.y + 27 * zoom}>{group.name}</text></g> })}{nodes.map((node) => {
      const source = elementById.get(node.sourceElementId)
      const parent = nodeById.get(node.parentNodeId)
      if (!source && !parent) return null
      const link = connector(parent || source, node)
      const relation = parent ? 'parent' : 'source'
      const relationLabel = parent ? '断开两个提示词节点' : '断开图片与提示词节点'
      return <g className="workflow-link" key={node.id}><path d={link.path} /><circle className="workflow-port" cx={link.from.x} cy={link.from.y} r="5" /><circle className="workflow-port" cx={link.to.x} cy={link.to.y} r="5" /><g className="workflow-link-control" role="button" aria-label={relationLabel} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation() }} onClick={(event) => { event.preventDefault(); event.stopPropagation(); onDisconnect(node.id, relation) }}><circle cx={link.middle.x} cy={link.middle.y} r="12" /><text x={link.middle.x} y={link.middle.y + 4}>×</text></g></g>
    })}{nodes.flatMap((node) => (node.generatedElementIds || []).map((id) => {
      const target = elementById.get(id)
      if (!target) return null
      const link = connector(node, target)
      return <g className="workflow-link generation-link" key={`${node.id}-${id}`}><path d={link.path} /><circle className="workflow-port" cx={link.from.x} cy={link.from.y} r="5" /><circle className="workflow-port" cx={link.to.x} cy={link.to.y} r="5" /></g>
    }))}</svg>
    {nodes.map((node) => {
      const position = toScreen(node.x, node.y), text = node.kind === 'modify' ? (node.output || node.prompt) : node.prompt
      const references = node.referenceImages || (node.referenceImage ? [{ ...node.referenceImage, id: `legacy-${node.id}`, role: '补充参考' }] : [])
      return <article key={node.id} className={`workflow-node ${node.kind} ${node.collapsed ? 'collapsed' : ''} ${selectedIds.includes(node.id) ? 'selected' : ''}`} style={{ width: node.width, minHeight: node.collapsed ? 0 : node.height, transform: `translate(${position.x}px, ${position.y}px) scale(${zoom})` }} onPointerDown={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onSelect(node.id, event.shiftKey) }}>
        <header className="node-drag-handle" onPointerDown={(event) => startDrag(event, node)} onPointerMove={moveDrag} onPointerUp={stopDrag} onPointerCancel={stopDrag} title="按住此处拖动节点"><span className={`node-status ${node.status || (node.busy ? 'running' : 'completed')}`} /> <span>{node.kind === 'compose' ? 'IMG' : node.kind === 'skill' ? 'SKILL' : 'LLM'}</span><b>{node.kind === 'modify' ? '提示词修改' : node.kind === 'compose' ? '组合生图' : node.kind === 'skill' ? node.skillName || 'Skill 工作流' : '提示词反推'}</b><GenerationTimer node={node} /><small>{node.model}</small><button title={node.collapsed ? '展开节点' : '折叠节点'} onPointerDown={(event) => event.stopPropagation()} onClick={() => onUpdate(node.id, { collapsed: !node.collapsed })}>{node.collapsed ? '＋' : '－'}</button></header>
        {!node.collapsed && <>
        {node.workflowGroupName && <div className="node-group-name">分组：{node.workflowGroupName}</div>}
        {node.kind !== 'skill' && <label className="node-template">{node.kind === 'modify' ? '修改所用模板' : '重新生成模板'}<select value={node.templateId || ''} onChange={(event) => { const template = templates.find((item) => item.id === event.target.value); onUpdate(node.id, { templateId: event.target.value, templateLabel: template?.label || event.target.value }) }}>{templates.map((template) => <option key={template.id} value={template.id}>{template.label}</option>)}</select><small>上次实际使用：{node.templateLabel || '默认视觉反推模板'}</small></label>}
        {node.kind === 'skill' && <small className="node-composition-note">Skill v{node.skillVersion || 1} · 输入：{(node.skillRequires || []).join('、') || '无'} · 输出：{node.skillOutputType === 'analysis' ? '分析与建议' : '完整提示词'}</small>}
        {node.kind === 'modify' && <><label>原版提示词<textarea value={node.prompt || ''} onChange={(event) => onUpdate(node.id, { prompt: event.target.value })} /></label><label>修改要求<textarea placeholder="描述你要修改的画面内容…" value={node.instruction || ''} onChange={(event) => onUpdate(node.id, { instruction: event.target.value })} /></label><label className="node-reference">补充参考图片（最多 8 张）<input type="file" multiple accept="image/*" onChange={(event) => onAttachImage(node.id, event.target.files)} /><div className="node-reference-grid">{references.map((image) => <figure key={image.id}><img src={image.dataURL} alt={image.name || '修改参考图'} /><input value={image.role || ''} placeholder="用途，如：产品外观" onChange={(event) => onUpdate(node.id, { referenceImages: references.map((item) => item.id === image.id ? { ...item, role: event.target.value } : item), referenceImage: null })} /><button onClick={() => onRemoveImage(node.id, image.id)}>删除</button></figure>)}</div></label></>}
        {node.kind === 'compose' && <small className="node-composition-note">已关联 {references.length} 张产品参考图{node.promptReferenceImages?.length ? `，另有 ${node.promptReferenceImages.length} 张提示词参考图` : ''}；编辑提示词或重新生成均会保留产品参考。</small>}
        <label>{node.kind === 'modify' ? '修改结果（可直接编辑）' : node.kind === 'compose' ? '组合提示词（可直接编辑）' : node.kind === 'skill' ? 'Skill 结果（可直接编辑）' : '提示词（可直接编辑）'}<textarea className="node-output" value={node.kind === 'skill' ? (node.output || '') : (text || '')} onChange={(event) => onUpdate(node.id, { [node.kind === 'modify' || node.kind === 'skill' ? 'output' : 'prompt']: event.target.value })} /></label>
        {!!node.versionHistory?.length && <details className="node-versions"><summary>历史版本（{node.versionHistory.length}）</summary>{[...node.versionHistory].reverse().map((version, index) => <button key={version.id || index} onClick={() => onUpdate(node.id, { [node.kind === 'modify' || node.kind === 'skill' ? 'output' : 'prompt']: version.prompt, model: version.model || node.model, templateId: version.templateId || node.templateId, templateLabel: version.templateLabel || node.templateLabel })}><b>{new Date(version.createdAt || Date.now()).toLocaleString()}</b><span>{version.templateLabel || version.model || '历史结果'}</span></button>)}</details>}
        {node.error && <p className="node-error">提示词处理：{node.error === '[object Event]' ? '历史图片加载记录已失效，请重试' : node.error}</p>}
        {node.generationError && <p className="node-error">图像生成：{node.generationError === '[object Event]' ? '生成结果无法解码，请重试' : node.generationError}</p>}
        <GenerationTimingBreakdown timing={node.generationTiming} />
        <section className="node-generation-settings" onPointerDown={(event) => event.stopPropagation()} onPointerUp={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}><label>比例<select value={node.generationAspect || GENERATION_DEFAULTS.generationAspect} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onChange={(event) => changeGenerationSetting(event, node, 'generationAspect', event.target.value)}>{GENERATION_ASPECTS.map((value) => <option key={value}>{value}</option>)}</select></label><label>清晰度<select value={node.generationQuality || GENERATION_DEFAULTS.generationQuality} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onChange={(event) => changeGenerationSetting(event, node, 'generationQuality', event.target.value)}>{['2K','1K','4K'].map((value) => <option key={value}>{value}</option>)}</select></label><label>张数<select value={node.generationCount || GENERATION_DEFAULTS.generationCount} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onChange={(event) => changeGenerationSetting(event, node, 'generationCount', Number(event.target.value))}>{[1,2,3,4].map((value) => <option key={value} value={value}>{value} 张</option>)}</select></label><label className="consistency-toggle"><input type="checkbox" checked={node.productConsistency !== false} onChange={(event) => changeGenerationSetting(event, node, 'productConsistency', event.target.checked)} />保持产品一致</label></section>
         <footer>{node.kind === 'prompt' ? <><button onClick={() => onRegenerate(node)} disabled={node.busy}>↻ {node.busy ? '生成中…' : '重新生成'}</button><button className="node-primary" onClick={() => onModify(node)}>✎ 用于提示词修改</button><button onPointerDown={(event) => event.stopPropagation()} onClick={(event) => runGeneration(event, node)} disabled={node.generationBusy}>◉ {node.generationBusy ? '生成中…' : '生成预览'}</button></> : node.kind === 'compose' ? <button className="node-primary" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => runGeneration(event, node)} disabled={node.generationBusy}>◉ {node.generationBusy ? '生成中…' : '按组合生图'}</button> : node.kind === 'skill' ? <>{node.skillOutputType === 'prompt' && <button className="node-primary" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => runGeneration(event, { ...node, prompt: node.output, output: node.output })} disabled={node.generationBusy || !node.output}>◉ {node.generationBusy ? '生成中…' : '用结果生成预览'}</button>}<button onClick={() => navigator.clipboard.writeText(node.output || '')}>复制结果</button></> : <><button className="node-primary" onClick={() => onRegenerate(node, true)} disabled={node.busy}>▶ {node.busy ? '生成中…' : '生成修改提示词'}</button><button onPointerDown={(event) => event.stopPropagation()} onClick={(event) => runGeneration(event, node)} disabled={node.generationBusy || !node.output}>◉ {node.generationBusy ? '改图中…' : '验证改图'}</button></>}{node.generationBusy && <button className="node-cancel-generation" onClick={() => onCancelGeneration(node)}>取消生图</button>}<button onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.preventDefault(); event.stopPropagation(); onDelete(node.id) }}>删除节点</button></footer>
        </>}
      </article>
    })}
  </div>
}

function SkillLibrary({ skills, context, onUse, onSave, onDelete, onExport, onImport, onClose }) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('全部')
  const [editing, setEditing] = useState(null)
  const fileInput = useRef(null)
  const categories = ['全部', ...new Set(skills.map((item) => item.category || '未分类'))]
  const matches = skills.filter((item) => (category === '全部' || item.category === category) && `${item.name} ${item.description} ${item.tags.join(' ')}`.toLowerCase().includes(query.trim().toLowerCase()))
  const missing = (skill) => (skill.requires || []).filter((key) => !context[key])
  const names = { image: '图片', text: '提示词文本', node: '提示词节点', product: '产品参考图' }
  const blank = { id: '', name: '', description: '', category: '自建 Skill', tags: [], requires: ['text'], instruction: '', outputType: 'prompt', favorite: false, version: 1, trainingExamples: [] }
  return <div className="skill-library-backdrop" onMouseDown={onClose}><section className="skill-library" onMouseDown={(event) => event.stopPropagation()}>
    <header><div><small>LOCAL SKILL LIBRARY</small><h2>Skill 库</h2></div><button onClick={onClose}>×</button></header>
    <div className="skill-library-tools"><input type="search" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Skill、分类或标签…" /><select value={category} onChange={(event) => setCategory(event.target.value)}>{categories.map((item) => <option key={item}>{item}</option>)}</select><button className="primary" onClick={() => setEditing(blank)}>＋ 新建</button><button onClick={() => fileInput.current?.click()}>导入</button><button onClick={() => onExport([])}>导出全部</button><input ref={fileInput} hidden type="file" accept=".json" onChange={async (event) => { const file = event.target.files?.[0]; if (file) await onImport(await file.text()); event.target.value = '' }} /></div>
    {editing ? <section className="skill-editor"><h3>{editing.id ? `编辑：${editing.name}` : '新建 Skill'}</h3><label>名称<input value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} /></label><label>简介<input value={editing.description} onChange={(event) => setEditing({ ...editing, description: event.target.value })} /></label><div><label>分类<input value={editing.category} onChange={(event) => setEditing({ ...editing, category: event.target.value })} /></label><label>标签（逗号分隔）<input value={editing.tags.join(', ')} onChange={(event) => setEditing({ ...editing, tags: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} /></label></div><label>所需上下文<span className="skill-requires">{Object.entries(names).map(([key, label]) => <label key={key}><input type="checkbox" checked={(editing.requires || []).includes(key)} onChange={(event) => setEditing({ ...editing, requires: event.target.checked ? [...new Set([...(editing.requires || []), key])] : editing.requires.filter((item) => item !== key) })} />{label}</label>)}</span></label><label>输出类型<select value={editing.outputType} onChange={(event) => setEditing({ ...editing, outputType: event.target.value })}><option value="prompt">完整提示词</option><option value="analysis">分析与建议</option></select></label><label>执行指令<textarea value={editing.instruction} onChange={(event) => setEditing({ ...editing, instruction: event.target.value })} placeholder="告诉 AI 如何利用当前上下文完成工作…" /></label><footer><button onClick={() => setEditing(null)}>取消</button><button className="primary" onClick={async () => { await onSave(editing); setEditing(null) }}>保存 Skill</button></footer></section> : <div className="skill-grid">{matches.map((skill) => { const unavailable = missing(skill); return <article key={skill.id} className={unavailable.length ? 'unavailable' : ''}><header><span>{skill.category}</span><button title={skill.favorite ? '取消收藏' : '收藏'} onClick={() => onSave({ ...skill, favorite: !skill.favorite })}>{skill.favorite ? '★' : '☆'}</button></header><h3>{skill.name}</h3><p>{skill.description}</p><div className="skill-tags">{skill.tags.map((tag) => <span key={tag}>{tag}</span>)}</div><small>需要：{(skill.requires || []).map((key) => names[key]).join('、') || '无'} · {skill.outputType === 'analysis' ? '分析结果' : '提示词节点'}</small>{unavailable.length ? <em>缺少：{unavailable.map((key) => names[key]).join('、')}</em> : <button className="primary" onClick={() => onUse(skill)}>使用 Skill</button>}<footer><button onClick={() => setEditing({ ...skill, builtIn: false, id: '', name: `${skill.name} 副本` })}>复制</button>{!skill.builtIn && <button onClick={() => setEditing(skill)}>编辑</button>}<button className="danger" onClick={() => onDelete(skill.id)}>删除</button></footer></article>})}{!matches.length && <p className="skill-empty">没有匹配的 Skill。你可以新建一个，或调整搜索与分类。</p>}</div>}
  </section></div>
}

function ProjectSkillTraining({ project, scene, skills, onEnable, onSave, onClose }) {
  const existing = skills.find((skill) => skill.id === project.trainingSkillId)
  const [name, setName] = useState(existing?.name || `${project.name} 工作流`)
  const [description, setDescription] = useState(existing?.description || `从「${project.name}」项目沉淀的可复用创作流程。`)
  const [category, setCategory] = useState(existing?.category || '项目训练')
  const [tags, setTags] = useState((existing?.tags || ['项目训练']).join(', '))
  const [requires, setRequires] = useState(existing?.requires || ['image', 'text'])
  const elements = (scene.elements || []).filter((item) => !item.isDeleted)
  const texts = elements.filter((item) => item.type === 'text' && item.text?.trim())
  const images = elements.filter((item) => item.type === 'image' && item.fileId)
  const nodes = scene.workflowNodes || []
  const usableNodes = nodes.filter((item) => (item.output || item.prompt || '').trim())
  const labels = { image: '图片', text: '提示词文本', node: '提示词节点', product: '产品参考图' }
  const createExample = () => {
    const textSamples = texts.slice(0, 8).map((item, index) => `文本 ${index + 1}：${item.text.trim().slice(0, 700)}`)
    const nodeSamples = usableNodes.slice(0, 10).map((item, index) => `节点 ${index + 1}（${item.kind === 'skill' ? item.skillName || 'Skill' : item.kind === 'modify' ? '提示词修改' : item.kind === 'compose' ? '组合生图' : '提示词反推'}）：${(item.output || item.prompt || '').trim().slice(0, 1100)}`)
    return { projectId: project.id, projectName: project.name, createdAt: Date.now(), summary: [`这是一个已确认的项目训练画布。`, `素材统计：${images.length} 张图片、${texts.length} 段画布文本、${nodes.length} 个工作流节点、${usableNodes.length} 个可复用结果节点。`, ...textSamples, ...nodeSamples].join('\n\n').slice(0, 12000) }
  }
  const toggleRequire = (key, checked) => setRequires((current) => checked ? [...new Set([...current, key])] : current.filter((item) => item !== key))
  if (!project.skillTraining) return <div className="skill-library-backdrop" onMouseDown={onClose}><section className="project-training-dialog" onMouseDown={(event) => event.stopPropagation()}><header><div><small>PROJECT SKILL TRAINING</small><h2>将项目设为训练画布</h2></div><button onClick={onClose}>×</button></header><p>启用后，当前项目会成为可持续沉淀工作流的训练画布。它不会训练底层模型，也不会上传整张项目文件；保存时只提取你画布中的提示词、节点结果和结构化素材统计，作为本机 Skill 的示范案例。</p><div className="project-training-stats"><span>图片 {images.length}</span><span>文本 {texts.length}</span><span>节点 {nodes.length}</span></div><footer><button onClick={onClose}>暂不设置</button><button className="primary" onClick={onEnable}>设为训练画布</button></footer></section></div>
  return <div className="skill-library-backdrop" onMouseDown={onClose}><section className="project-training-dialog" onMouseDown={(event) => event.stopPropagation()}><header><div><small>PROJECT SKILL TRAINING</small><h2>训练 Skill · {project.name}</h2></div><button onClick={onClose}>×</button></header><p>当前项目已是训练画布。确认下面条件后，系统会创建或更新本机 Skill，并将本项目作为一条可追溯示范案例。</p><div className="project-training-stats"><span>图片 {images.length}</span><span>文本 {texts.length}</span><span>节点 {nodes.length}</span><span>已训练案例 {existing?.trainingExamples?.length || 0}</span></div><section className="project-training-form"><label>Skill 名称<input value={name} onChange={(event) => setName(event.target.value)} /></label><label>简介<input value={description} onChange={(event) => setDescription(event.target.value)} /></label><div><label>分类<input value={category} onChange={(event) => setCategory(event.target.value)} /></label><label>标签（逗号分隔）<input value={tags} onChange={(event) => setTags(event.target.value)} /></label></div><label>运行时需要的上下文<span className="skill-requires">{Object.entries(labels).map(([key, label]) => <label key={key}><input type="checkbox" checked={requires.includes(key)} onChange={(event) => toggleRequire(key, event.target.checked)} />{label}</label>)}</span></label><label>执行指令<textarea defaultValue={existing?.instruction || '参考已确认的项目训练案例与当前上下文，提炼可复用的创作策略；保持产品事实与用户明确要求一致，直接输出本 Skill 指定的结果。'} id="project-training-instruction" /></label></section><footer><button onClick={onClose}>取消</button><button className="primary" disabled={!name.trim()} onClick={() => onSave({ ...(existing || {}), id: existing?.id || '', name: name.trim(), description: description.trim(), category: category.trim() || '项目训练', tags: tags.split(',').map((item) => item.trim()).filter(Boolean), requires, instruction: document.getElementById('project-training-instruction')?.value || '', outputType: existing?.outputType || 'prompt', favorite: existing?.favorite || false, version: existing?.version || 1, trainingExamples: [...(existing?.trainingExamples || []).filter((item) => item.projectId !== project.id), createExample()] })}>保存训练 Skill</button></footer></section></div>
}

function App() {
  const [mode, setMode] = useState('canvas')
  const [vaultLoaded, setVaultLoaded] = useState(false)
  const [projects, setProjects] = useState(loadProjects)
  const [activeProjectId, setActiveProjectId] = useState(() => loadProjects()[0].id)
  const [drawerOpen, setDrawerOpen] = useState(true)
  const [selected, setSelected] = useState(null)
  const [multiAngleOpen, setMultiAngleOpen] = useState(false)
  const [multiAnglePreparing, setMultiAnglePreparing] = useState(false)
  const [quickEditOpen, setQuickEditOpen] = useState(false)
  const [quickEditText, setQuickEditText] = useState('')
  const [quickEditBusy, setQuickEditBusy] = useState(false)
  const [quickEditError, setQuickEditError] = useState('')
  const [textEditOpen, setTextEditOpen] = useState(false)
  const [textEditText, setTextEditText] = useState('')
  const [textEditItems, setTextEditItems] = useState([])
  const [textEditRecognizing, setTextEditRecognizing] = useState(false)
  const [textEditBusy, setTextEditBusy] = useState(false)
  const [textEditError, setTextEditError] = useState('')
  const [aiStatus, setAiStatus] = useState(null)
  const [reverseBusy, setReverseBusy] = useState(false)
  const [reversePrompt, setReversePrompt] = useState('')
  const [reverseError, setReverseError] = useState('')
  const [selectedTemplateId, setSelectedTemplateId] = useState('')
  const [canvasSearch, setCanvasSearch] = useState('')
  const [backups, setBackups] = useState([])
  const [showBackups, setShowBackups] = useState(false)
  const [rightTab, setRightTab] = useState('assistant')
  const [detailOpen, setDetailOpen] = useState(true)
  const [detailWidth, setDetailWidth] = useState(() => Number(localStorage.getItem('promptVault.detailWidth')) || 420)
  const [assistantInput, setAssistantInput] = useState('')
  const [assistantBusy, setAssistantBusy] = useState(false)
  const [chatMessages, setChatMessages] = useState([])
  const [compositionReferences, setCompositionReferences] = useState([])
  const [compositionInstruction, setCompositionInstruction] = useState('')
  const [compositionPromptResult, setCompositionPromptResult] = useState('')
  const [compositionPromptBusy, setCompositionPromptBusy] = useState(false)
  const [compositionPromptError, setCompositionPromptError] = useState('')
  const [imageService, setImageService] = useState({ configured: false, baseUrl: '', model: '', mode: 'openai', generatePath: '/images/generations', editPath: '/images/edits', statusPath: '', cancelPath: '', defaultSize: '1024x1024', downloadDirectory: '', apiKey: '' })
  const [imageServiceMessage, setImageServiceMessage] = useState('')
  const [directoryDialogBusy, setDirectoryDialogBusy] = useState(false)
  const [skills, setSkills] = useState([])
  const [projectAssets, setProjectAssets] = useState([])
  const [assetDrawerOpen, setAssetDrawerOpen] = useState(false)
  const [assetFilter, setAssetFilter] = useState('')
  const [assetKind, setAssetKind] = useState('all')
  const [skillLibraryOpen, setSkillLibraryOpen] = useState(false)
  const [projectTrainingOpen, setProjectTrainingOpen] = useState(false)
  const [appUpdate, setAppUpdate] = useState(null)
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false)
  const [updateChecking, setUpdateChecking] = useState(false)
  const [updateInstalling, setUpdateInstalling] = useState(false)
  const [updateProgress, setUpdateProgress] = useState(null)
  const [updateError, setUpdateError] = useState('')
  const sceneRef = useRef(loadScene(activeProjectId))
  const [canvasTheme, setCanvasTheme] = useState(() => sceneRef.current.appState?.viewBackgroundColor === '#ffffff' ? 'light' : 'dark')
  // Excalidraw 的 initialData 是非受控初始化值。背景切换时递增此版本，
  // 让实例从我们已保存的场景重新挂载，避免其内部旧 appState 覆盖新背景。
  const [canvasInstanceVersion, setCanvasInstanceVersion] = useState(0)
  const [workflowNodes, setWorkflowNodes] = useState(() => sceneRef.current.workflowNodes || [])
  const [selectedNodeIds, setSelectedNodeIds] = useState([])
  const [selectedCanvasIds, setSelectedCanvasIds] = useState([])
  const [, setHistoryVersion] = useState(0)
  const [viewport, setViewport] = useState({ scrollX: 0, scrollY: 0, zoom: 1 })
  const viewportRef = useRef({ scrollX: 0, scrollY: 0, zoom: 1 })
  const viewportFrameRef = useRef(0)
  const pendingViewportRef = useRef(null)
  const renderedViewportRef = useRef({ scrollX: 0, scrollY: 0, zoom: 1 })
  const viewportSettleTimerRef = useRef(null)
  const workflowLayerRef = useRef(null)
  const canvasElementRevisionRef = useRef([])
  const sourcePositionsRef = useRef(Object.fromEntries((sceneRef.current.elements || []).filter((element) => !element.isDeleted).map((element) => [element.id, { x: element.x, y: element.y }])))
  const workflowFrameRef = useRef(0)
  const pendingWorkflowNodesRef = useRef(null)
  const activeProjectRef = useRef(activeProjectId)
  const initialScene = sceneRef.current
  const api = useRef(null)
  const saveTimer = useRef(null)
  const saveRevisionRef = useRef(0)
  const aiStatusSignatureRef = useRef('')
  const input = useRef(null)
  const projectInput = useRef(null)
  const compositionReferenceInput = useRef(null)
  const boardRef = useRef(null)
  const canvasSelectionRef = useRef('')
  const nodeHistoryRef = useRef({ past: [], future: [] })
  const detailResizeRef = useRef(null)
  // Only the active run token may update a node. This prevents an old cancelled
  // network request from turning a newly edited node back into “generating”.
  const generationRunsRef = useRef(new Map())
  const projectSwitchingRef = useRef(false)
  const assetSyncInFlightRef = useRef(new Set())

  // Excalidraw 本身也支持粘贴、拖放和工具栏导入。无论图片从哪条入口进入，
  // 都在这里补齐项目素材记录，不能只依赖顶部“导入图片”按钮。
  const syncCanvasFilesToAssets = async (files = sceneRef.current.files, projectId = activeProjectRef.current) => {
    if (!window.__TAURI__ || projectId !== activeProjectRef.current) return 0
    let synced = 0
    for (const [fileId, file] of Object.entries(files || {})) {
      if (!file?.dataURL || file.assetId || assetSyncInFlightRef.current.has(fileId)) continue
      assetSyncInFlightRef.current.add(fileId)
      try {
        const thumbnailDataUrl = await makeAssetThumbnail(file.dataURL)
        const record = await invoke('save_project_asset', { projectId, asset: { id: uid(), dataURL: file.dataURL, name: file.name || '画布图片', mimeType: file.mimeType || 'image/png', kind: 'image', tags: ['画布素材'], sourceUrl: null, thumbnailDataUrl } })
        file.assetId = record.id
        synced += 1
      } catch (error) { console.warn('画布素材同步失败', error) }
      finally { assetSyncInFlightRef.current.delete(fileId) }
    }
    if (synced) {
      sceneRef.current = { ...sceneRef.current, files: { ...sceneRef.current.files, ...files } }
      persist(sceneRef.current.elements, sceneRef.current.appState || emptyScene.appState, sceneRef.current.files, sceneRef.current.workflowNodes || [])
      refreshProjectAssets(projectId)
    }
    return synced
  }

  const refreshProjectAssets = async (projectId = activeProjectRef.current) => {
    if (!window.__TAURI__) return []
    try {
      let items = await invoke('list_project_assets', { projectId })
      // 兼容你已经画在旧项目里的图片：第一次打开素材库时自动入库，无需重新导入。
      if (projectId === activeProjectRef.current) { await syncCanvasFilesToAssets(sceneRef.current.files, projectId); items = await invoke('list_project_assets', { projectId }) }
      if (projectId === activeProjectRef.current) setProjectAssets(items)
      return items
    } catch (error) { console.warn('读取项目素材失败', error); return [] }
  }
  const hydrateSceneAssets = async (scene, projectId) => {
    if (!window.__TAURI__) return scene
    const entries = Object.entries(scene.files || {}).filter(([, file]) => file?.assetId && !file.dataURL)
    if (!entries.length) return scene
    const contents = await Promise.all(entries.map(async ([id, file]) => {
      try { const content = await invoke('read_project_asset', { projectId, assetId: file.assetId }); return [id, { ...file, dataURL: content.dataUrl, mimeType: content.asset.mimeType || file.mimeType }] } catch (error) { console.warn('素材原图读取失败', file.assetId, error); return [id, file] }
    }))
    return { ...scene, files: { ...scene.files, ...Object.fromEntries(contents) } }
  }
  const storeProjectAsset = async ({ id = uid(), dataURL, name = '画布图片', mimeType = 'image/png', kind = 'image', tags = [], sourceUrl = null }) => {
    if (!window.__TAURI__) return { id, assetId: null, thumbnailDataUrl: null }
    const thumbnailDataUrl = await makeAssetThumbnail(dataURL)
    const record = await invoke('save_project_asset', { projectId: activeProjectRef.current, asset: { id, dataURL, name, mimeType, kind, tags, sourceUrl, thumbnailDataUrl } })
    refreshProjectAssets()
    return { ...record, assetId: record.id }
  }

  const renderWorkflowOnFrame = (nodes) => {
    pendingWorkflowNodesRef.current = nodes
    if (workflowFrameRef.current) return
    workflowFrameRef.current = requestAnimationFrame(() => {
      workflowFrameRef.current = 0
      const latest = pendingWorkflowNodesRef.current
      pendingWorkflowNodesRef.current = null
      if (latest) setWorkflowNodes(latest)
    })
  }

  // 节点层在平移时用合成层直接位移，避免每个鼠标事件都重建所有节点、缩略图和 SVG 连线。
  // 缩放或停止平移后才回写 React 坐标，视觉保持跟手，计算则只发生一次。
  const settleViewport = () => {
    const latest = pendingViewportRef.current
    if (!latest) return
    setViewport((current) => current.scrollX === latest.scrollX && current.scrollY === latest.scrollY && current.zoom === latest.zoom ? current : latest)
  }
  useEffect(() => {
    renderedViewportRef.current = viewport
    const layer = workflowLayerRef.current
    if (layer) { layer.style.transform = ''; layer.style.willChange = '' }
  }, [viewport])
  useEffect(() => () => { clearTimeout(viewportSettleTimerRef.current); if (viewportFrameRef.current) cancelAnimationFrame(viewportFrameRef.current) }, [])

  const beginDetailResize = (event) => {
    detailResizeRef.current = { startX: event.clientX, width: detailWidth }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    event.preventDefault()
  }
  const resizeDetail = (event) => {
    if (!detailResizeRef.current) return
    const width = Math.max(340, Math.min(560, detailResizeRef.current.width + detailResizeRef.current.startX - event.clientX))
    setDetailWidth(width)
  }
  const endDetailResize = () => {
    if (!detailResizeRef.current) return
    detailResizeRef.current = null
  }

  const chatKey = (projectId) => `promptVault.promptAssistant.${projectId}`
  const chatHistoryKey = (projectId) => `promptVault.promptAssistantHistory.${projectId}`
  const saveChat = (messages) => { setChatMessages(messages); localStorage.setItem(chatKey(activeProjectRef.current), JSON.stringify(messages.slice(-100))) }
  const startNewChat = () => {
    if (chatMessages.length) {
      const projectId = activeProjectRef.current
      let history = []
      try { history = JSON.parse(localStorage.getItem(chatHistoryKey(projectId))) || [] } catch {}
      history.push({ id: uid(), createdAt: Date.now(), messages: chatMessages })
      localStorage.setItem(chatHistoryKey(projectId), JSON.stringify(history.slice(-20)))
    }
    saveChat([])
    setAssistantInput('')
  }
  const clearCurrentChat = () => {
    if (!chatMessages.length || window.confirm('确定清空当前项目的提示词助手对话吗？当前节点和提示词不会被删除。')) saveChat([])
  }

  const saveProjects = (next) => { setProjects(next); localStorage.setItem(PROJECTS_KEY, JSON.stringify(next)) }
  const persist = (elements, appState, files, nodes = sceneRef.current.workflowNodes || []) => {
    clearTimeout(saveTimer.current)
    const targetProject = activeProjectRef.current
    const revision = ++saveRevisionRef.current
    saveTimer.current = setTimeout(() => {
      const write = () => {
        if (revision !== saveRevisionRef.current) return
        const data = JSON.stringify(serializableScene({ elements, appState, files, workflowNodes: nodes }))
        if (window.__TAURI__) invoke('save_canvas_scene', { projectId: targetProject, data }).then(() => localStorage.removeItem(sceneKey(targetProject))).catch((error) => console.warn('桌面项目保存失败', error))
        else localStorage.setItem(sceneKey(targetProject), data)
      }
      if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(write, { timeout: 1800 })
      else setTimeout(write, 0)
    }, 650)
  }
  const flushPersist = () => {
    clearTimeout(saveTimer.current)
    ++saveRevisionRef.current
    const scene = sceneRef.current
    const projectId = activeProjectRef.current
    const data = JSON.stringify(serializableScene(scene))
    if (window.__TAURI__) invoke('save_canvas_scene', { projectId, data }).then(() => localStorage.removeItem(sceneKey(projectId))).catch((error) => console.warn('桌面项目保存失败', error))
    else localStorage.setItem(sceneKey(projectId), data)
  }
  const recordNodeHistory = () => {
    const history = nodeHistoryRef.current
    history.past.push(structuredClone(sceneRef.current.workflowNodes || []))
    if (history.past.length > 50) history.past.shift()
    history.future = []
    setHistoryVersion((value) => value + 1)
  }
  const restoreNodeHistory = (direction) => {
    const history = nodeHistoryRef.current, source = direction === 'undo' ? history.past : history.future
    if (!source.length) return
    const target = source.pop()
    const destination = direction === 'undo' ? history.future : history.past
    destination.push(structuredClone(sceneRef.current.workflowNodes || []))
    sceneRef.current = { ...sceneRef.current, workflowNodes: target }
    setWorkflowNodes(target); setSelectedNodeIds([]); setHistoryVersion((value) => value + 1)
    persist(sceneRef.current.elements, sceneRef.current.appState || emptyScene.appState, sceneRef.current.files, target)
  }
  const selectProject = async (projectId) => {
    if (projectId === activeProjectRef.current) return
    // 插件收件箱是全局队列；加载项目期间绝不能提前取走图片并写入旧项目。
    projectSwitchingRef.current = true
    // 项目切换不再同步序列化包含图片的大场景，交给空闲保存，避免点击时卡顿。
    persist(sceneRef.current.elements, sceneRef.current.appState || emptyScene.appState, sceneRef.current.files, sceneRef.current.workflowNodes || [])
    let nextScene = loadScene(projectId)
    if (window.__TAURI__) {
      try { const raw = await invoke('read_canvas_scene', { projectId }); if (raw) nextScene = normalizeScene(JSON.parse(raw)) } catch (error) { console.warn('读取桌面项目失败，尝试旧版数据', error) }
    }
    nextScene = await hydrateSceneAssets(nextScene, projectId)
    activeProjectRef.current = projectId
    setActiveProjectId(projectId)
    sceneRef.current = nextScene
    sourcePositionsRef.current = Object.fromEntries((nextScene.elements || []).filter((element) => !element.isDeleted).map((element) => [element.id, { x: element.x, y: element.y }]))
    setCanvasTheme(nextScene.appState?.viewBackgroundColor === '#ffffff' ? 'light' : 'dark')
    setCanvasInstanceVersion((version) => version + 1)
    setWorkflowNodes(nextScene.workflowNodes || [])
    nodeHistoryRef.current = { past: [], future: [] }
    setSelectedNodeIds([])
    api.current?.addFiles(Object.values(nextScene.files || {}))
    api.current?.updateScene({ elements: nextScene.elements, appState: nextScene.appState })
    setSelected(null)
    try { setChatMessages(JSON.parse(localStorage.getItem(chatKey(projectId))) || []) } catch { setChatMessages([]) }
    refreshProjectAssets(projectId)
    projectSwitchingRef.current = false
  }
  useEffect(() => { try { setChatMessages(JSON.parse(localStorage.getItem(chatKey(activeProjectId))) || []) } catch { setChatMessages([]) } }, [])
  useEffect(() => {
    if (!window.__TAURI__) return
    invoke('read_canvas_scene', { projectId: activeProjectRef.current }).then(async (raw) => {
      if (!raw) return
      const nextScene = await hydrateSceneAssets(normalizeScene(JSON.parse(raw)), activeProjectRef.current)
      sceneRef.current = nextScene; setWorkflowNodes(nextScene.workflowNodes || [])
      setCanvasTheme(nextScene.appState?.viewBackgroundColor === '#ffffff' ? 'light' : 'dark')
      setCanvasInstanceVersion((version) => version + 1)
      api.current?.addFiles(Object.values(nextScene.files || {})); api.current?.updateScene({ elements: nextScene.elements, appState: nextScene.appState })
    }).catch((error) => console.warn('启动时读取桌面项目失败', error))
  }, [])
  useEffect(() => { refreshProjectAssets() }, [])
  useEffect(() => { invoke('get_image_service_status').then((status) => setImageService((current) => ({ ...current, ...status, apiKey: '' }))).catch(() => {}) }, [])
  useEffect(() => {
    if (!window.__TAURI__) return undefined
    let disposed = false
    const timer = setTimeout(async () => {
      try {
        const available = await check()
        if (!disposed && available) { setAppUpdate(available); setUpdateDialogOpen(true) }
      } catch (error) { console.warn('自动检查更新失败', error) }
    }, 2500)
    return () => { disposed = true; clearTimeout(timer) }
  }, [])
  const refreshSkills = () => invoke('list_skills').then((items) => setSkills(items)).catch((error) => console.warn('Skill 库读取失败', error))
  useEffect(() => { refreshSkills() }, [])
  useEffect(() => { localStorage.setItem('promptVault.detailWidth', String(detailWidth)) }, [detailWidth])
  useEffect(() => {
    const saveNow = () => flushPersist()
    window.addEventListener('pagehide', saveNow)
    window.addEventListener('beforeunload', saveNow)
    return () => { window.removeEventListener('pagehide', saveNow); window.removeEventListener('beforeunload', saveNow) }
  }, [])
  const createProject = () => {
    const name = window.prompt('项目名称', '新项目')?.trim()
    if (!name) return
    const project = { id: uid(), name, createdAt: Date.now() }
    saveProjects([...projects, project])
    selectProject(project.id)
  }
  const renameProject = (project) => {
    const name = window.prompt('重命名项目', project.name)?.trim()
    if (name) saveProjects(projects.map((item) => item.id === project.id ? { ...item, name } : item))
  }
  const deleteProject = (project) => {
    if (projects.length === 1) return alert('至少保留一个项目。')
    if (!window.confirm(`删除“${project.name}”及其画布内容？`)) return
    const next = projects.filter((item) => item.id !== project.id)
    localStorage.removeItem(sceneKey(project.id))
    if (window.__TAURI__) { invoke('delete_canvas_scene', { projectId: project.id }).catch((error) => console.warn('删除桌面项目失败', error)); invoke('delete_project_assets', { projectId: project.id }).catch((error) => console.warn('删除项目素材失败', error)) }
    saveProjects(next)
    if (activeProjectRef.current === project.id) selectProject(next[0].id)
  }
  const enableProjectSkillTraining = () => {
    const projectId = activeProjectRef.current
    saveProjects(projects.map((item) => item.id === projectId ? { ...item, skillTraining: true, skillTrainingEnabledAt: Date.now() } : item))
  }
  const exportProject = async () => {
    const project = projects.find((item) => item.id === activeProjectId)
    const data = JSON.stringify({ format: 'prompt-vault-canvas', version: 3, exportedAt: Date.now(), project: { ...project, scene: normalizeScene(sceneRef.current) } })
    try {
      const result = await invoke('export_canvas_project', { projectName: project?.name || '画布项目', data })
      alert(`项目已导出到：\n${result.path}`)
    } catch (error) {
      alert(`导出失败：${String(error)}`)
    }
  }
  const importProject = async (file) => {
    if (!file) return
    try {
      const data = JSON.parse(await file.text())
      if (data.format !== 'prompt-vault-canvas' || !data.project?.scene?.elements) throw new Error('不是有效的画布项目文件')
      const project = { id: uid(), name: `${data.project.name || '导入项目'}（导入）`, createdAt: Date.now() }
      const sceneData = JSON.stringify(normalizeScene(data.project.scene))
      if (window.__TAURI__) await invoke('save_canvas_scene', { projectId: project.id, data: sceneData }); else localStorage.setItem(sceneKey(project.id), sceneData)
      saveProjects([...projects, project]); selectProject(project.id)
    } catch (error) { alert(`导入失败：${String(error.message || error)}`) }
  }
  const loadBackups = async () => {
    try { setBackups(await invoke('list_canvas_backups')); setShowBackups(true) } catch (error) { alert(`读取备份失败：${String(error)}`) }
  }
  const restoreBackup = async (name) => {
    if (!window.confirm('将此备份恢复为一个新项目？当前项目不会被覆盖。')) return
    try {
      const data = JSON.parse(await invoke('read_canvas_backup', { name }))
      const project = { id: uid(), name: `${data.project?.name || '备份项目'}（恢复）`, createdAt: Date.now() }
      const sceneData = JSON.stringify(normalizeScene(data.project.scene))
      if (window.__TAURI__) await invoke('save_canvas_scene', { projectId: project.id, data: sceneData }); else localStorage.setItem(sceneKey(project.id), sceneData)
      saveProjects([...projects, project]); setShowBackups(false); selectProject(project.id)
    } catch (error) { alert(`恢复失败：${String(error)}`) }
  }
  const removeBackup = async (name) => {
    if (!window.confirm('删除这份历史备份？')) return
    try { await invoke('delete_canvas_backup', { name }); await loadBackups() } catch (error) { alert(`删除失败：${String(error)}`) }
  }
  useEffect(() => {
    if (!window.__TAURI__) return undefined
    const backup = () => {
      const project = projects.find((item) => item.id === activeProjectRef.current)
      invoke('backup_canvas_project', { projectName: project?.name || '未命名项目', data: JSON.stringify({ format: 'prompt-vault-canvas', version: 3, savedAt: Date.now(), project: { ...project, scene: normalizeScene(sceneRef.current) } }) }).catch((error) => console.warn('自动备份失败', error))
    }
    const timer = setInterval(backup, 5 * 60 * 1000)
    const initial = setTimeout(backup, 8000)
    return () => { clearInterval(timer); clearTimeout(initial) }
  }, [projects])
  const selectedFile = useMemo(() => selected?.type === 'image' ? (selected.file || sceneRef.current.files[selected.fileId]) : null, [selected])
  const syncSelectedFileToAssets = async () => {
    if (!selectedFile?.dataURL || selectedFile.assetId) return 0
    const fileId = selected?.fileId || selectedFile.id || uid()
    const files = { ...sceneRef.current.files, [fileId]: { ...selectedFile, id: selectedFile.id || fileId } }
    sceneRef.current = { ...sceneRef.current, files }
    return syncCanvasFilesToAssets(files)
  }
  const selectedCanvasElements = useMemo(() => selectedCanvasIds.map((id) => sceneRef.current.elements.find((element) => element.id === id && !element.isDeleted)).filter(Boolean), [selectedCanvasIds, workflowNodes])
  const selectedCanvasPrompt = useMemo(() => selectedCanvasElements.filter((element) => element.type === 'text').map((element) => element.text || '').join('\n').trim(), [selectedCanvasElements])
  const selectedProductElements = useMemo(() => selectedCanvasElements.filter((element) => element.type === 'image' && element.fileId), [selectedCanvasElements])
  const selectedProductReferences = useMemo(() => selectedProductElements.map((element) => {
    const file = sceneRef.current.files[element.fileId]
    return file?.dataURL ? { id: element.id, dataURL: file.dataURL, name: `画布产品图`, mimeType: file.mimeType || 'image/png', role: '产品外观' } : null
  }).filter(Boolean), [selectedProductElements, workflowNodes])
  const canComposeGeneration = Boolean(selectedCanvasPrompt && selectedProductReferences.length)
  useEffect(() => {
    setCompositionReferences([])
    setCompositionInstruction('')
    setCompositionPromptResult('')
    setCompositionPromptError('')
  }, [selectedCanvasPrompt])
  useEffect(() => {
    const refresh = () => invoke('get_ai_config_status').then((status) => {
      const signature = JSON.stringify(status)
      if (signature === aiStatusSignatureRef.current) return
      aiStatusSignatureRef.current = signature
      setAiStatus(status); setSelectedTemplateId((current) => current || status.promptTemplateId || status.promptTemplates?.[0]?.id || '')
    }).catch(() => {
      if (aiStatusSignatureRef.current !== 'error') { aiStatusSignatureRef.current = 'error'; setAiStatus(null) }
    })
    refresh()
    const timer = setInterval(refresh, 2500)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    const installFrameButton = () => {
      const arrow = document.querySelector('.board [data-testid="toolbar-arrow"]')
      if (!arrow || document.querySelector('.pv-frame-tool')) return Boolean(arrow)
      const anchorButton = arrow.closest('label,button,div')
      if (!anchorButton?.parentElement) return false
      const tool = document.createElement('label')
      tool.className = 'ToolIcon pv-frame-tool'
      tool.title = '画框工具 — F'
      tool.innerHTML = '<button type="button" class="ToolIcon_type_button" aria-label="画框工具"><div class="ToolIcon__icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="4" width="16" height="16" rx="1"/><path d="M8 4v4M16 4v4M8 16v4M16 16v4"/></svg></div></button>'
      tool.querySelector('button')?.addEventListener('click', () => api.current?.setActiveTool({ type: 'frame' }))
      anchorButton.parentElement.insertBefore(tool, anchorButton)
      return true
    }
    const observer = new MutationObserver(installFrameButton)
    observer.observe(document.body, { childList: true, subtree: true })
    installFrameButton()
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const installImageSearchAction = () => {
      const existing = document.querySelector('.pv-image-search-action')
      if (!selectedFile) { existing?.remove(); return }
      if (existing) return
      const actions = [...document.querySelectorAll('.board .panelColumn fieldset')]
        .find((field) => field.querySelector('legend')?.textContent?.trim() === '操作')
      const list = actions?.querySelector('.buttonList')
      if (!list) return
      const action = document.createElement('button')
      action.type = 'button'
      action.className = 'pv-image-search-action'
      action.textContent = '⌕ 以图搜图'
      action.title = '复制当前图片并打开 Pinterest 以图搜图'
      action.addEventListener('pointerdown', (event) => event.stopPropagation())
      action.addEventListener('click', startImageSearch)
      list.appendChild(action)
    }
    const observer = new MutationObserver(installImageSearchAction)
    observer.observe(document.body, { childList: true, subtree: true })
    installImageSearchAction()
    return () => observer.disconnect()
  }, [selectedFile])

  // Excalidraw uses canvas coordinates, while browser drag events provide viewport
  // coordinates. Convert at the boundary so imported images land exactly where the
  // pointer was released, regardless of pan or zoom.
  const clientPointToCanvas = (clientX, clientY) => {
    const rect = boardRef.current?.getBoundingClientRect()
    const zoom = viewportRef.current.zoom?.value || viewportRef.current.zoom || 1
    if (!rect) return { x: 120, y: 120 }
    return {
      x: (clientX - rect.left) / zoom - (viewportRef.current.scrollX || 0),
      y: (clientY - rect.top) / zoom - (viewportRef.current.scrollY || 0),
    }
  }
  const visibleCanvasCenter = () => {
    const rect = boardRef.current?.getBoundingClientRect()
    if (!rect) return { x: 320, y: 240 }
    return clientPointToCanvas(rect.left + rect.width / 2, rect.top + rect.height / 2)
  }
  const importFiles = async (list, dropPoint = null) => {
    const imageFiles = [...list].filter((file) => file.type.startsWith('image/'))
    if (!imageFiles.length) return
    const anchor = dropPoint || visibleCanvasCenter()
    const items = await Promise.all(imageFiles.map(async (file, index) => {
      const dataURL = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file) })
      const image = await new Promise((resolve, reject) => { const source = new Image(); source.onload = () => resolve(source); source.onerror = reject; source.src = dataURL })
      const fileId = uid(), scale = Math.min(1, 900 / Math.max(image.naturalWidth, image.naturalHeight))
      const width = Math.round(image.naturalWidth * scale), height = Math.round(image.naturalHeight * scale)
      const asset = await storeProjectAsset({ id: fileId, dataURL, name: file.name || '导入图片', mimeType: file.type || 'image/png', kind: 'image' })
      // Keep multiple dropped files visible rather than perfectly stacked.
      const offset = index * 36
      return { fileId, file: { id: fileId, assetId: asset.assetId, dataURL, mimeType: file.type, created: Date.now(), lastRetrieved: Date.now(), version: 1 }, element: { id: uid(), type: 'image', x: Math.round(anchor.x - width / 2 + offset), y: Math.round(anchor.y - height / 2 + offset), width, height, angle: 0, strokeColor: 'transparent', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid', roughness: 0, opacity: 100, groupIds: [], frameId: null, seed: nonce(), version: 1, versionNonce: nonce(), isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false, fileId, status: 'saved', scale: [1, 1], crop: null } }
    }))
    const current = sceneRef.current, files = { ...current.files }
    items.forEach((item) => { files[item.fileId] = item.file })
    const elements = [...current.elements, ...items.map((item) => item.element)]
    sceneRef.current = { ...current, elements, files }
    // updateScene 不会接管二进制文件；必须先注册到 Excalidraw 的文件仓库，否则只显示占位图。
    api.current?.addFiles(items.map((item) => item.file))
    api.current?.updateScene({ elements })
    persist(elements, current.appState || emptyScene.appState, files)
  }
  const placeProjectAsset = async (asset) => {
    try {
      const content = await invoke('read_project_asset', { projectId: activeProjectRef.current, assetId: asset.id })
      const image = await new Promise((resolve, reject) => { const source = new Image(); source.onload = () => resolve(source); source.onerror = reject; source.src = content.dataUrl })
      const point = visibleCanvasCenter(), scale = Math.min(1, 900 / Math.max(image.naturalWidth, image.naturalHeight)), width = Math.round(image.naturalWidth * scale), height = Math.round(image.naturalHeight * scale)
      const file = { id: asset.id, assetId: asset.id, dataURL: content.dataUrl, mimeType: asset.mimeType, created: Date.now(), lastRetrieved: Date.now(), version: 1 }
      const element = { id: uid(), type: 'image', x: Math.round(point.x - width / 2), y: Math.round(point.y - height / 2), width, height, angle: 0, strokeColor: 'transparent', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid', roughness: 0, opacity: 100, groupIds: [], frameId: null, seed: nonce(), version: 1, versionNonce: nonce(), isDeleted: false, boundElements: null, updated: Date.now(), link: asset.sourceUrl || null, locked: false, fileId: asset.id, status: 'saved', scale: [1, 1], crop: null }
      const current = sceneRef.current, files = { ...current.files, [asset.id]: file }, elements = [...current.elements, element]
      sceneRef.current = { ...current, files, elements }; api.current?.addFiles([file]); api.current?.updateScene({ elements }); persist(elements, current.appState || emptyScene.appState, files)
      setAssetDrawerOpen(false)
    } catch (error) { alert(`放回画布失败：${errorMessage(error)}`) }
  }
  useEffect(() => {
    if (!window.__TAURI__) return undefined
    let unlisten = null
    let disposed = false
    getCurrentWebview().onDragDropEvent(async (event) => {
      if (event.payload.type !== 'drop' || !event.payload.paths?.length) return
      try {
        const dropped = await invoke('read_dropped_images', { paths: event.payload.paths })
        if (disposed || !dropped.length) return
        const files = await Promise.all(dropped.map(async (item) => {
          const blob = await (await fetch(item.dataUrl)).blob()
          return new File([blob], item.name, { type: item.mimeType })
        }))
        // Tauri reports physical pixels; DOM coordinates are CSS pixels.
        const scale = window.devicePixelRatio || 1
        const position = event.payload.position
        const dropPoint = position ? clientPointToCanvas(position.x / scale, position.y / scale) : null
        await importFiles(files, dropPoint)
      } catch (error) {
        console.error('原生拖放导入失败', error)
      }
    }).then((stop) => { if (disposed) stop(); else unlisten = stop })
    return () => { disposed = true; unlisten?.() }
  }, [])
  const setCanvasBackground = (viewBackgroundColor) => {
    const current = sceneRef.current
    const appState = { ...current.appState, viewBackgroundColor }
    sceneRef.current = { ...current, appState }
    setCanvasTheme('light')
    persist(current.elements, appState, current.files)
    setCanvasInstanceVersion((version) => version + 1)
  }
  const allowImageDrop = (event) => {
    if ([...event.dataTransfer.types].includes('Files')) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    }
  }
  const importDroppedImages = (event) => {
    if ([...event.dataTransfer.types].includes('Files')) {
      event.preventDefault()
      importFiles(event.dataTransfer.files, clientPointToCanvas(event.clientX, event.clientY))
    }
  }
  const copyImage = async () => {
    if (!selectedFile) return
    // Windows WebView 的 ClipboardItem 只稳定支持 image/png；JPG/WebP 必须先转码。
    const image = await new Promise((resolve, reject) => { const source = new Image(); source.onload = () => resolve(source); source.onerror = () => reject(new Error('图片无法解码')); source.src = selectedFile.dataURL })
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
    canvas.getContext('2d').drawImage(image, 0, 0)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('图片转换为 PNG 失败')
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
  }
  useEffect(() => {
    const copySelectedOriginal = (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'c' || !selectedFile) return
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target?.tagName)) return
      event.preventDefault()
      copyImage().catch((error) => alert(`原图复制失败：${errorMessage(error)}`))
    }
    window.addEventListener('keydown', copySelectedOriginal)
    return () => window.removeEventListener('keydown', copySelectedOriginal)
  }, [selectedFile])
  const openExternalUrl = async (url) => {
    if (!/^https?:\/\//i.test(url || '')) throw new Error('链接格式无效')
    if (window.__TAURI__) return invoke('open_external_url', { url })
    window.open(url, '_blank', 'noopener,noreferrer')
  }
  const startImageSearch = async () => {
    if (!selectedFile) return alert('请先选择一张图片。')
    try {
      await copyImage()
      // /lens-search/ 旧直链已被 Pinterest 下线，常会直接显示“出了点问题”。
      // 从首页进入 Lens 才能使用当前登录态的正式上传入口，剪贴板中已保留原图。
      await openExternalUrl('https://www.pinterest.com/')
    } catch (error) { alert(`以图搜图启动失败：${errorMessage(error)}`) }
  }
  const addPromptNode = (prompt, model, mode = 'reverse', source = selected, usedTemplate = null, parentNodeId = null) => {
    if (!source || source.type !== 'image') return
    recordNodeHistory()
    const isModify = mode === 'modify', nodeX = source.x + source.width + 160, nodeY = isModify ? source.y + source.height + 120 : source.y
    const template = aiStatus?.promptTemplates?.find((item) => item.id === selectedTemplateId)
    const node = { id: uid(), kind: isModify ? 'modify' : 'prompt', sourceElementId: source.id, parentNodeId, x: nodeX, y: nodeY, width: 620, height: isModify ? 660 : 560, model, templateId: usedTemplate?.id || selectedTemplateId, templateLabel: usedTemplate?.label || template?.label || '默认视觉反推模板', prompt, instruction: '', output: '', busy: false, status: 'completed', referenceImages: [], versionHistory: [], ...GENERATION_DEFAULTS }
    const nodes = [...(sceneRef.current.workflowNodes || []), node]
    sceneRef.current = { ...sceneRef.current, workflowNodes: nodes }
    setWorkflowNodes(nodes)
    persist(sceneRef.current.elements, sceneRef.current.appState || emptyScene.appState, sceneRef.current.files, nodes)
    return node.id
  }
  const createCompositionNode = (promptOverride = '', promptReferenceImages = []) => {
    if (!canComposeGeneration) { alert('请同时选中至少一段提示词文本和一张产品参考图。'); return null }
    const source = selectedProductElements[0]
    recordNodeHistory()
    const node = {
      id: uid(), kind: 'compose', sourceElementId: source.id, parentNodeId: null,
      x: source.x + source.width + 160, y: source.y, width: 620, height: 520,
      model: imageService.model || '当前生图模型', templateId: '', templateLabel: '画布组合生图',
      prompt: promptOverride.trim() || selectedCanvasPrompt, instruction: compositionInstruction.trim(), output: '', busy: false, status: 'completed',
      referenceImages: selectedProductReferences, promptReferenceImages, versionHistory: [], ...GENERATION_DEFAULTS,
    }
    const nodes = [...(sceneRef.current.workflowNodes || []), node]
    sceneRef.current = { ...sceneRef.current, workflowNodes: nodes }
    setWorkflowNodes(nodes); setSelectedNodeIds([node.id])
    persist(sceneRef.current.elements, sceneRef.current.appState || emptyScene.appState, sceneRef.current.files, nodes)
    return node
  }
  const generateComposition = (promptOverride = '', promptReferenceImages = []) => {
    if (!imageService.configured) return alert('请先完成图像服务设置。')
    const node = createCompositionNode(promptOverride, promptReferenceImages)
    if (node) generatePreview(node)
  }
  const addCompositionReferences = async (fileList) => {
    const files = [...(fileList || [])].filter((file) => file?.type?.startsWith('image/'))
    if (!files.length) return
    const remaining = Math.max(0, 8 - compositionReferences.length)
    if (!remaining) return setCompositionPromptError('最多只能添加 8 张额外参考图。')
    try {
      const additions = await Promise.all(files.slice(0, remaining).map(async (file) => ({ id: uid(), dataURL: await readImageFile(file), name: file.name, mimeType: file.type || 'image/png', role: '场景、构图或风格参考' })))
      setCompositionReferences((current) => [...current, ...additions].slice(0, 8))
      setCompositionPromptError('')
    } catch (error) { setCompositionPromptError(errorMessage(error, '参考图读取失败，请重试')) }
  }
  const updateCompositionReference = (id, patch) => setCompositionReferences((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item))
  const removeCompositionReference = (id) => setCompositionReferences((current) => current.filter((item) => item.id !== id))
  const modifyCompositionPrompt = async () => {
    if (!canComposeGeneration || compositionPromptBusy) return
    if (!compositionReferences.length) return setCompositionPromptError('请先上传至少 1 张额外参考图，再让 AI 修改组合提示词。')
    setCompositionPromptBusy(true)
    setCompositionPromptError('')
    try {
      const productReferences = selectedProductReferences.map((item) => ({ ...item, role: '产品白底图，只用于锁定产品外观，不用于改变产品型号' }))
      const visualReferences = compositionReferences.map((item) => ({ ...item, role: item.role || '场景、构图或风格参考' }))
      const visionImage = await composeVisionReferences(productReferences[0], [...productReferences.slice(1), ...visualReferences])
      const referenceRoles = visualReferences.map((item, index) => `额外参考图${index + 1}用途：${item.role}`).join('；')
      const instruction = [
        '这是“文案＋产品白底图”的组合生图提示词修改任务。保留原文案的商业目标、产品事实和核心画面意图；产品白底图只作为产品外观唯一依据。',
        '请吸收额外参考图中的场景、构图、镜头、光线、色彩和氛围，不要照搬额外参考图中的产品，不要把额外参考图误认为产品型号。',
        referenceRoles,
        compositionInstruction.trim() || '根据额外参考图优化当前文案，输出一段完整、可直接用于生图的中文提示词。不要解释过程，不要输出前言。',
      ].filter(Boolean).join('\n')
      const result = await invoke('reverse_image_prompt', { imageDataUrl: visionImage, templateId: selectedTemplateId || null, originalPrompt: selectedCanvasPrompt, instruction })
      if (!result?.prompt) throw new Error('AI 没有返回可用的修改后提示词')
      setCompositionPromptResult(result.prompt)
    } catch (error) { setCompositionPromptError(errorMessage(error, '组合提示词修改失败，请重试')) }
    finally { setCompositionPromptBusy(false) }
  }
  const generateModifiedComposition = () => {
    const prompt = compositionPromptResult.trim()
    if (!prompt) return alert('请先生成或填写修改后的组合提示词。')
    generateComposition(prompt, compositionReferences)
  }
  const importCanvasPayload = async (payload) => {
    if (!payload?.imageDataUrl?.startsWith('data:image/')) return
    const dataURL = payload.imageDataUrl
    const image = await new Promise((resolve, reject) => { const source = new Image(); source.onload = () => resolve(source); source.onerror = reject; source.src = dataURL })
    const fileId = uid(), elementId = uid(), scale = Math.min(1, 900 / Math.max(image.naturalWidth, image.naturalHeight))
    const zoom = viewportRef.current.zoom?.value || viewportRef.current.zoom || 1
    const baseX = -(viewportRef.current.scrollX || 0) + 120 / zoom
    const baseY = -(viewportRef.current.scrollY || 0) + 130 / zoom
    const mimeType = dataURL.match(/^data:([^;]+)/)?.[1] || 'image/png'
    const file = { id: fileId, dataURL, mimeType, created: Date.now(), lastRetrieved: Date.now(), version: 1 }
    const element = { id: elementId, type: 'image', x: baseX, y: baseY, width: Math.max(80, Math.round(image.naturalWidth * scale)), height: Math.max(80, Math.round(image.naturalHeight * scale)), angle: 0, strokeColor: 'transparent', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid', roughness: 0, opacity: 100, groupIds: [], frameId: null, seed: nonce(), version: 1, versionNonce: nonce(), isDeleted: false, boundElements: null, updated: Date.now(), link: payload.sourceUrl || null, locked: false, fileId, status: 'saved', scale: [1, 1], crop: null }
    const current = sceneRef.current
    const files = { ...current.files, [fileId]: file }
    const elements = [...current.elements, element]
    sceneRef.current = { ...current, elements, files }
    api.current?.addFiles([file])
    api.current?.updateScene({ elements, appState: { selectedElementIds: { [elementId]: true } } })
    setSelected({ ...element, file })
    persist(elements, current.appState || emptyScene.appState, files)
    if (payload.prompt?.trim()) addPromptNode(payload.prompt, payload.model || '插件当前模型', 'reverse', element, { id: payload.templateId || '', label: payload.templateLabel || '插件当前模板' })
  }
  useEffect(() => {
    if (!window.__TAURI__) return undefined
    let disposed = false, busy = false
    const receive = async () => {
      if (disposed || busy || projectSwitchingRef.current) return
      busy = true
      try {
        let payload = await invoke('take_canvas_import')
        while (payload && !disposed) {
          await importCanvasPayload(payload)
          payload = await invoke('take_canvas_import')
        }
      } catch (error) { console.error('接收插件画布内容失败', error) }
      finally { busy = false }
    }
    receive()
    const timer = setInterval(receive, 900)
    return () => { disposed = true; clearInterval(timer) }
  }, [activeProjectId])
  const updateWorkflowNode = (id, patch) => {
    const nodes = (sceneRef.current.workflowNodes || []).map((node) => node.id === id ? { ...node, ...patch } : node)
    sceneRef.current = { ...sceneRef.current, workflowNodes: nodes }
    setWorkflowNodes(nodes)
    persist(sceneRef.current.elements, sceneRef.current.appState || emptyScene.appState, sceneRef.current.files, nodes)
  }
  const selectWorkflowNode = (id, additive = false) => {
    setSelectedNodeIds((current) => additive ? (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]) : [id])
  }
  const moveWorkflowNodes = (ids, positions, dx, dy) => {
    const nodes = (sceneRef.current.workflowNodes || []).map((node) => ids.includes(node.id) && positions[node.id] ? { ...node, x: positions[node.id].x + dx, y: positions[node.id].y + dy } : node)
    sceneRef.current = { ...sceneRef.current, workflowNodes: nodes }
    setWorkflowNodes(nodes)
    persist(sceneRef.current.elements, sceneRef.current.appState || emptyScene.appState, sceneRef.current.files, nodes)
  }
  const disconnectWorkflowNode = (id, relation = 'source') => {
    recordNodeHistory()
    const patch = relation === 'parent' ? { parentNodeId: null } : { sourceElementId: null }
    const nodes = (sceneRef.current.workflowNodes || []).map((node) => node.id === id ? { ...node, ...patch } : node)
    sceneRef.current = { ...sceneRef.current, workflowNodes: nodes }
    setWorkflowNodes(nodes)
    persist(sceneRef.current.elements, sceneRef.current.appState || emptyScene.appState, sceneRef.current.files, nodes)
  }
  const deleteWorkflowNode = (id) => {
    recordNodeHistory()
    const nodes = (sceneRef.current.workflowNodes || []).filter((node) => node.id !== id).map((node) => node.parentNodeId === id ? { ...node, parentNodeId: null } : node)
    sceneRef.current = { ...sceneRef.current, workflowNodes: nodes }
    setWorkflowNodes(nodes)
    setSelectedNodeIds((current) => current.filter((item) => item !== id))
    saveChat(chatMessages.filter((message) => message.nodeId !== id))
    persist(sceneRef.current.elements, sceneRef.current.appState || emptyScene.appState, sceneRef.current.files, nodes)
  }
  const deleteSelectedWorkflowNodes = () => {
    if (!selectedNodeIds.length) return
    recordNodeHistory()
    const nodes = (sceneRef.current.workflowNodes || []).filter((node) => !selectedNodeIds.includes(node.id))
    sceneRef.current = { ...sceneRef.current, workflowNodes: nodes }
    setWorkflowNodes(nodes); setSelectedNodeIds([])
    saveChat(chatMessages.filter((message) => !selectedNodeIds.includes(message.nodeId)))
    persist(sceneRef.current.elements, sceneRef.current.appState || emptyScene.appState, sceneRef.current.files, nodes)
  }
  const duplicateSelectedWorkflowNodes = () => {
    if (!selectedNodeIds.length) return
    recordNodeHistory()
    const copies = (sceneRef.current.workflowNodes || []).filter((node) => selectedNodeIds.includes(node.id)).map((node) => ({ ...node, id: uid(), x: node.x + 44, y: node.y + 44, busy: false }))
    const nodes = [...(sceneRef.current.workflowNodes || []), ...copies]
    sceneRef.current = { ...sceneRef.current, workflowNodes: nodes }
    setWorkflowNodes(nodes); setSelectedNodeIds(copies.map((node) => node.id))
    persist(sceneRef.current.elements, sceneRef.current.appState || emptyScene.appState, sceneRef.current.files, nodes)
  }
  const groupSelectedWorkflowNodes = () => {
    if (!selectedNodeIds.length) return alert('请先选择至少一张已关联提示词节点的图片或节点。')
    const name = window.prompt('分组名称', '新分组')?.trim()
    if (!name) return
    recordNodeHistory()
    const groupId = uid()
    const nodes = (sceneRef.current.workflowNodes || []).map((node) => selectedNodeIds.includes(node.id) ? { ...node, workflowGroupId: groupId, workflowGroupName: name } : node)
    sceneRef.current = { ...sceneRef.current, workflowNodes: nodes }; setWorkflowNodes(nodes)
    persist(sceneRef.current.elements, sceneRef.current.appState || emptyScene.appState, sceneRef.current.files, nodes)
  }
  const selectedWorkflowNodes = workflowNodes.filter((node) => selectedNodeIds.includes(node.id))
  const renameSelectedGroup = () => {
    const groupId = selectedWorkflowNodes.find((node) => node.workflowGroupId)?.workflowGroupId
    if (!groupId) return
    const name = window.prompt('新的分组名称', selectedWorkflowNodes.find((node) => node.workflowGroupId === groupId)?.workflowGroupName || '分组')?.trim()
    if (!name) return
    recordNodeHistory(); const nodes = workflowNodes.map((node) => node.workflowGroupId === groupId ? { ...node, workflowGroupName: name } : node)
    sceneRef.current = { ...sceneRef.current, workflowNodes: nodes }; setWorkflowNodes(nodes); persist(sceneRef.current.elements, sceneRef.current.appState || emptyScene.appState, sceneRef.current.files, nodes)
  }
  const ungroupSelected = () => {
    if (!selectedWorkflowNodes.some((node) => node.workflowGroupId)) return
    recordNodeHistory(); const groupIds = new Set(selectedWorkflowNodes.map((node) => node.workflowGroupId).filter(Boolean))
    const nodes = workflowNodes.map((node) => groupIds.has(node.workflowGroupId) ? { ...node, workflowGroupId: null, workflowGroupName: '' } : node)
    sceneRef.current = { ...sceneRef.current, workflowNodes: nodes }; setWorkflowNodes(nodes); persist(sceneRef.current.elements, sceneRef.current.appState || emptyScene.appState, sceneRef.current.files, nodes)
  }
  const collapseSelected = () => {
    if (!selectedWorkflowNodes.length) return
    recordNodeHistory(); const collapse = selectedWorkflowNodes.some((node) => !node.collapsed)
    const nodes = workflowNodes.map((node) => selectedNodeIds.includes(node.id) ? { ...node, collapsed: collapse } : node)
    sceneRef.current = { ...sceneRef.current, workflowNodes: nodes }; setWorkflowNodes(nodes); persist(sceneRef.current.elements, sceneRef.current.appState || emptyScene.appState, sceneRef.current.files, nodes)
  }
  const reorderSelected = (front) => {
    if (!selectedNodeIds.length) return
    recordNodeHistory(); const chosen = workflowNodes.filter((node) => selectedNodeIds.includes(node.id)), rest = workflowNodes.filter((node) => !selectedNodeIds.includes(node.id)); const nodes = front ? [...rest, ...chosen] : [...chosen, ...rest]
    sceneRef.current = { ...sceneRef.current, workflowNodes: nodes }; setWorkflowNodes(nodes); persist(sceneRef.current.elements, sceneRef.current.appState || emptyScene.appState, sceneRef.current.files, nodes)
  }
  const connectSelectedToImage = () => {
    if (!selected?.id || selected.type !== 'image' || !selectedNodeIds.length) return alert('请先选择图片，再按住 Shift 选择需要连接的节点。')
    recordNodeHistory(); const nodes = workflowNodes.map((node) => selectedNodeIds.includes(node.id) ? { ...node, sourceElementId: selected.id } : node)
    sceneRef.current = { ...sceneRef.current, workflowNodes: nodes }; setWorkflowNodes(nodes); persist(sceneRef.current.elements, sceneRef.current.appState || emptyScene.appState, sceneRef.current.files, nodes)
  }
  const focusWorkflowNode = (node) => {
    const zoom = viewportRef.current.zoom?.value || viewportRef.current.zoom || 1
    const width = boardRef.current?.clientWidth || 900, height = boardRef.current?.clientHeight || 700
    api.current?.updateScene({ appState: { scrollX: width / (2 * zoom) - node.x - node.width / 2, scrollY: height / (2 * zoom) - node.y - 100 } })
    setSelectedNodeIds([node.id])
  }
  const searchResults = canvasSearch.trim() ? workflowNodes.filter((node) => [node.prompt, node.output, node.instruction, node.model, node.templateLabel, node.workflowGroupName].some((value) => String(value || '').toLowerCase().includes(canvasSearch.trim().toLowerCase()))).slice(0, 20) : []
  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setSkillLibraryOpen(true); return }
      if (mode !== 'canvas' || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target?.tagName)) return
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedNodeIds.length) { event.preventDefault(); deleteSelectedWorkflowNodes() }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd' && selectedNodeIds.length) { event.preventDefault(); duplicateSelectedWorkflowNodes() }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && selectedNodeIds.length) { event.preventDefault(); restoreNodeHistory(event.shiftKey ? 'redo' : 'undo') }
      if (event.key === 'Escape' && selectedNodeIds.length) setSelectedNodeIds([])
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [mode, selectedNodeIds])
  const sourceFileForNode = (node) => {
    const source = sceneRef.current.elements.find((element) => element.id === node.sourceElementId)
    return source?.fileId ? sceneRef.current.files[source.fileId] : null
  }
  const attachNodeImage = async (id, fileList) => {
    const files = [...(fileList || [])].filter((file) => file?.type?.startsWith('image/'))
    if (!files.length) return
    const node = (sceneRef.current.workflowNodes || []).find((item) => item.id === id)
    const existing = node?.referenceImages || (node?.referenceImage ? [{ ...node.referenceImage, id: uid(), role: '补充参考' }] : [])
    const remaining = Math.max(0, 8 - existing.length)
    const additions = await Promise.all(files.slice(0, remaining).map(async (file) => ({ id: uid(), dataURL: await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error(`无法读取参考图：${file.name}`)); reader.readAsDataURL(file) }), name: file.name, mimeType: file.type, role: '补充参考' })))
    updateWorkflowNode(id, { referenceImages: [...existing, ...additions], referenceImage: null, error: '', generationError: '' })
  }
  const removeNodeImage = (id, imageId) => {
    const node = (sceneRef.current.workflowNodes || []).find((item) => item.id === id)
    updateWorkflowNode(id, { referenceImages: (node?.referenceImages || []).filter((image) => image.id !== imageId), referenceImage: null })
  }
  const runNode = async (node, modification = false) => {
    const file = sourceFileForNode(node)
    if (!file || node.busy) return
    const previousOutput = modification ? (node.output || '') : (node.prompt || '')
    const history = previousOutput ? [...(node.versionHistory || []), { id: uid(), prompt: previousOutput, model: node.model, templateId: node.templateId, templateLabel: node.templateLabel, createdAt: Date.now() }].slice(-20) : (node.versionHistory || [])
    updateWorkflowNode(node.id, { busy: true, status: 'running', error: '', generationError: '', versionHistory: history })
    try {
      const references = node.referenceImages || (node.referenceImage ? [node.referenceImage] : [])
      const roles = references.map((image, index) => `参考图${index + 1}用途：${image.role || '补充参考'}`).join('；')
      const instruction = modification ? [node.instruction, roles].filter(Boolean).join('\n') : null
      const result = await invoke('reverse_image_prompt', { imageDataUrl: await composeVisionReferences(file, references), templateId: node.templateId || null, originalPrompt: modification ? node.prompt : null, instruction })
      updateWorkflowNode(node.id, modification ? { busy: false, status: 'completed', error: '', output: result.prompt, model: result.model, templateId: result.templateId, templateLabel: result.templateLabel } : { busy: false, status: 'completed', error: '', prompt: result.prompt, model: result.model, templateId: result.templateId, templateLabel: result.templateLabel })
    } catch (error) { updateWorkflowNode(node.id, { busy: false, status: 'failed', error: errorMessage(error, '图片处理失败，请删除后重新上传参考图') }) }
  }
  const runReversePrompt = async () => {
    if (!selectedFile || reverseBusy) return
    setReverseBusy(true); setReverseError(''); setReversePrompt('')
    try {
      const compressed = await compressForVision(selectedFile.dataURL)
      const result = await invoke('reverse_image_prompt', { imageDataUrl: compressed, templateId: selectedTemplateId || null })
      setReversePrompt(result.prompt || '')
      setAiStatus((previous) => ({ ...previous, model: result.model, configured: true }))
      const nodeId = addPromptNode(result.prompt || '', result.model || aiStatus?.model || '当前模型', 'reverse', selected, { id: result.templateId, label: result.templateLabel })
      if (nodeId) setSelectedNodeIds([nodeId])
    } catch (error) {
      setReverseError(typeof error === 'string' ? error : String(error))
    } finally { setReverseBusy(false) }
  }
  const saveReversePrompt = async () => {
    if (!selectedFile || !reversePrompt.trim()) return
    const type = selectedFile.mimeType || selectedFile.dataURL.match(/^data:(image\/[^;]+)/)?.[1] || 'image/png'
    const extension = type.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
    try {
      const result = await invoke('create_card_manual', { imageBase64: selectedFile.dataURL, imageExt: extension, prompt: reversePrompt.trim(), negativePrompt: '', category: '灵感空间', tags: '[]' })
      if (!result.ok) throw new Error(result.reason || '保存失败')
      alert('已保存到提示词库，并保留原图关联。')
    } catch (error) { alert(`保存失败：${String(error)}`) }
  }

  const selectedWorkflowNode = workflowNodes.find((node) => selectedNodeIds.includes(node.id)) || null
  // 生成结果图片也带有 promptNodeId；选中它时，允许沿用原提示词继续做视角变体。
  const selectedImageNode = selected?.type === 'image' && selected?.customData?.promptNodeId
    ? workflowNodes.find((node) => node.id === selected.customData.promptNodeId) || null
    : null
  const assistantGenerationNode = selectedWorkflowNode || selectedImageNode
  const ensureAssistantGenerationNode = (options = {}) => {
    // 图片工具栏上的“多角度”针对的是当前图片本身。若这张图片同时挂着
    // “提示词修改”节点，不能把修改结果当成原图提示词再次生成。
    if (options.preferOriginalImage && selected?.type === 'image') {
      const sourceNode = selectedImageNode || selectedWorkflowNode
      const originalPrompt = sourceNode?.kind === 'modify'
        ? (sourceNode.prompt || selected?.customData?.prompt || '')
        : (selected?.customData?.prompt || sourceNode?.prompt || '')
      if (sourceNode && originalPrompt.trim()) return { ...sourceNode, kind: 'prompt', prompt: originalPrompt.trim(), output: '', instruction: '' }
    }
    if (assistantGenerationNode) return assistantGenerationNode
    if (!selectedFile?.dataURL || selected?.type !== 'image') return null
    // 图片工具栏的多角度不能误用提示词助手里上一张图的反推结果。
    // 只有图片自身携带的提示词元数据才属于当前图片；纯图片交给多角度专用上下文处理。
    const prompt = selected?.customData?.prompt || selected?.customData?.generation?.effectivePrompt || (options.preferOriginalImage ? '' : reversePrompt)
    if (!prompt?.trim()) return null
    const generation = selected?.customData?.generation || {}
    const nodeId = addPromptNode(prompt, generation.model || imageService.model || aiStatus?.model || '当前模型', 'reverse', selected, null)
    const node = (sceneRef.current.workflowNodes || []).find((item) => item.id === nodeId) || null
    if (node) setSelectedNodeIds([node.id])
    return node
  }
  const resolveMultiAngleNode = async () => {
    const existing = ensureAssistantGenerationNode({ preferOriginalImage: true })
    if (existing || !selectedFile?.dataURL || selected?.type !== 'image') return existing
    setMultiAnglePreparing(true)
    try {
      // 直接拖入画布的图片不反推整段提示词。这里仅建立一个本地占位节点，
      // 真正提交时把原图和 buildMultiAngleInstruction 生成的角度指令直接送入图生图接口。
      const prompt = '同一张输入图片的视角变体；原图中的人物、产品、动作、结构、背景、光线和空间关系都是事实，只改变后续指定的摄像机位置、透视和取景。'
      const nodeId = addPromptNode(prompt, imageService.model || aiStatus?.model || '当前图像模型', 'reverse', selected, { id: 'image-angle', label: '原图多角度编辑' })
      const node = (sceneRef.current.workflowNodes || []).find((item) => item.id === nodeId) || null
      if (node) setSelectedNodeIds([node.id])
      return node
    } finally {
      setMultiAnglePreparing(false)
    }
  }
  const openMultiAngleForSelection = async () => {
    if (multiAnglePreparing) return
    try {
      const node = await resolveMultiAngleNode()
      if (!node) { alert('这张图片没有关联提示词，无法建立视角变体。'); return }
      setMultiAngleOpen(true)
    } catch (error) {
      alert(`读取原图提示词失败：${errorMessage(error, '请检查 AI 配置后重试')}`)
    }
  }
  const openQuickEditForSelection = () => {
    if (!selectedFile?.dataURL || selected?.type !== 'image') return alert('请先选择一张图片。')
    setQuickEditText('')
    setQuickEditError('')
    setQuickEditOpen(true)
  }
  const openTextEditForSelection = () => {
    if (!selectedFile?.dataURL || selected?.type !== 'image') return alert('请先选择一张图片。')
    setTextEditText('')
    setTextEditItems([])
    setTextEditRecognizing(true)
    setTextEditError('')
    setTextEditOpen(true)
    void recognizeTextForSelection()
  }
  const recognizeTextForSelection = async () => {
    if (!selectedFile?.dataURL || selected?.type !== 'image') return
    setTextEditRecognizing(true)
    setTextEditBusy(true)
    setTextEditError('')
    try {
      const result = await invoke('extract_image_text', { imageDataUrl: await compressForVision(selectedFile.dataURL) })
      const items = parseRecognizedText(result.text || '')
      setTextEditItems(items)
      if (!items.length) setTextEditError('没有识别到清晰文字，请换一张更清晰的图片重试。')
    } catch (error) {
      setTextEditError(errorMessage(error, '文字识别失败，请重试。'))
    } finally {
      setTextEditRecognizing(false)
      setTextEditBusy(false)
    }
  }
  const runQuickEdit = async () => {
    if (quickEditBusy || !quickEditText.trim() || !selectedFile?.dataURL || selected?.type !== 'image') return
    setQuickEditBusy(true)
    setQuickEditError('')
    try {
      const imageDataUrl = await compressForVision(selectedFile.dataURL)
      let node = assistantGenerationNode
      let basePrompt = selected?.customData?.prompt || (node ? (node.kind === 'modify' ? (node.output || node.prompt) : node.prompt) : reversePrompt || '')
      let baseModel = node?.model || selected?.customData?.generation?.model || aiStatus?.model || '当前模型'
      const templateId = node?.templateId || selectedTemplateId || null
      if (!basePrompt.trim()) {
        const reversed = await invoke('reverse_image_prompt', { imageDataUrl, templateId })
        basePrompt = reversed.prompt || ''
        baseModel = reversed.model || baseModel
      }
      if (!basePrompt.trim()) throw new Error('无法从当前图片得到基础提示词，请先反推提示词后再试。')
      if (!node) {
        const nodeId = addPromptNode(basePrompt, baseModel, 'reverse', selected, null)
        node = (sceneRef.current.workflowNodes || []).find((item) => item.id === nodeId) || null
        if (!node) throw new Error('快速编辑节点创建失败，请重试。')
        setSelectedNodeIds([node.id])
      }
      const editInstruction = `【局部编辑】只修改用户明确点名的区域或对象，未点名的内容必须保持原图不变。用户编辑要求：${quickEditText.trim()}`
      const currentMessages = [...chatMessages, { id: uid(), role: 'user', text: `快速编辑：${quickEditText.trim()}`, source: 'quick-edit', createdAt: Date.now(), nodeId: node.id }, { id: uid(), role: 'assistant', text: editInstruction, model: baseModel, isPrompt: true, source: 'quick-edit', linkedToNode: false, templateLabel: '局部编辑指令', createdAt: Date.now(), nodeId: node.id }]
      saveChat(currentMessages)
      setQuickEditOpen(false)
      await generateAssistantPreview(node, null, { mode: 'quick-edit', editInstruction })
    } catch (error) {
      setQuickEditError(errorMessage(error, '快速编辑失败，请重试。'))
    } finally { setQuickEditBusy(false) }
  }
  const runTextEdit = async () => {
    const changes = textEditItems.filter((item) => item.value.trim() && item.value.trim() !== item.original.trim())
    if (textEditBusy || !changes.length || !selectedFile?.dataURL || selected?.type !== 'image') return
    const editRequest = changes.map((item, index) => {
      const box = item.box ? `；图像相对位置：左${Math.round(item.box.x * 100)}%、上${Math.round(item.box.y * 100)}%、宽${Math.round(item.box.width * 100)}%、高${Math.round(item.box.height * 100)}%` : ''
      return `文字${index + 1}：将“${item.original}”改为“${item.value.trim()}”；位置：${item.location}${box}${item.style ? `；样式：${item.style}` : ''}`
    }).join('\n')
    setTextEditBusy(true)
    setTextEditError('')
    try {
      const imageDataUrl = await compressForVision(selectedFile.dataURL)
      let node = assistantGenerationNode
      let basePrompt = selected?.customData?.prompt || (node ? (node.kind === 'modify' ? (node.output || node.prompt) : node.prompt) : reversePrompt || '')
      let baseModel = node?.model || selected?.customData?.generation?.model || aiStatus?.model || '当前模型'
      const templateId = node?.templateId || selectedTemplateId || null
      if (!basePrompt.trim()) {
        const reversed = await invoke('reverse_image_prompt', { imageDataUrl, templateId })
        basePrompt = reversed.prompt || ''
        baseModel = reversed.model || baseModel
      }
      if (!basePrompt.trim()) throw new Error('无法从当前图片得到基础提示词，请先反推提示词后再试。')
      if (!node) {
        const nodeId = addPromptNode(basePrompt, baseModel, 'reverse', selected, null)
        node = (sceneRef.current.workflowNodes || []).find((item) => item.id === nodeId) || null
        if (!node) throw new Error('文字编辑节点创建失败，请重试。')
        setSelectedNodeIds([node.id])
      }
       const editInstruction = `【文字局部编辑】只把下面列出的原文字替换成目标文字：\n${editRequest}\n【文字框几何锁定】每段文字的左上角、右下角、占用宽高、行数、基线和对齐方式必须与原图完全一致，目标文字必须完整落在同一个原文字框内；禁止因为目标文字变长而放大字号、扩大文字框、改变换行或挤压周围内容，必要时只在原文字框内部压缩字距或字宽。保持原来的字体风格、字号、颜色、透视、遮挡、边缘和光照关系。文字框以外的像素必须保持原图不变；禁止修改人物动作、产品结构、背景、天空、地面、构图、光线或其他未列出的内容。不要重排版，不要新增文字，不要删除其他文字。`
      const currentMessages = [...chatMessages, { id: uid(), role: 'user', text: `编辑文字：${editRequest}`, source: 'text-edit', createdAt: Date.now(), nodeId: node.id }, { id: uid(), role: 'assistant', text: editInstruction, model: baseModel, isPrompt: true, source: 'text-edit', linkedToNode: false, templateLabel: '文字局部编辑指令', createdAt: Date.now(), nodeId: node.id }]
      saveChat(currentMessages)
      setTextEditOpen(false)
       await generateAssistantPreview(node, null, { mode: 'quick-edit', editInstruction, editMaskBoxes: changes.map((item) => item.box).filter(Boolean), preserveSourceDimensions: true })
    } catch (error) {
      setTextEditError(errorMessage(error, '文字编辑失败，请重试。'))
    } finally { setTextEditBusy(false) }
  }
  const applyMultiAngleAndGenerate = async (draft) => {
    try {
      const node = await resolveMultiAngleNode()
      if (!node) { alert('这张图片没有关联提示词，无法建立视角变体。'); return }
      // 直接把对话框草稿传给生成函数，避免先 setState 再读取旧节点导致“点击后没有反应”。
      const nextNode = { ...node, ...draft, generationMultiAngleEnabled: true }
      updateWorkflowNode(node.id, draft)
      setMultiAngleOpen(false)
      await generateAssistantPreview(nextNode, null, { mode: 'multi-angle' })
    } catch (error) {
      alert(`准备多角度生成失败：${errorMessage(error, '请重试')}`)
    }
  }
  const runAssistantGeneration = async () => {
    const node = ensureAssistantGenerationNode()
    if (!node) { alert('请先选中一张已有生图，或选择一个提示词节点。'); return }
    await generateAssistantPreview(node, null, { mode: 'normal' })
  }
  const selectedImageGeneration = selected?.customData?.generation || {}
  const assistantGenerationValue = assistantGenerationNode || {
    ...GENERATION_DEFAULTS,
    generationMultiAngleEnabled: selectedImageGeneration.multiAngle === true,
    generationAngleMode: selectedImageGeneration.angleMode || 'camera',
    generationRotate: Number(selectedImageGeneration.rotate || 0),
    generationTilt: Number(selectedImageGeneration.tilt || 0),
    generationScale: selectedImageGeneration.scale || 'medium',
  }
  const assistantContext = selectedWorkflowNode ? (selectedWorkflowNode.kind === 'modify' || selectedWorkflowNode.kind === 'skill' ? (selectedWorkflowNode.output || selectedWorkflowNode.prompt) : selectedWorkflowNode.prompt) : reversePrompt
  const assistantContextTitle = selectedWorkflowNode ? `${selectedWorkflowNode.kind === 'modify' ? '提示词修改' : selectedWorkflowNode.kind === 'compose' ? '组合生图' : selectedWorkflowNode.kind === 'skill' ? (selectedWorkflowNode.skillName || 'Skill') : '提示词反推'}节点` : canComposeGeneration ? '已选提示词与产品图' : selectedFile ? '已选图片' : '未选择内容'
  const assistantTemplate = selectedWorkflowNode?.templateLabel || aiStatus?.promptTemplates?.find((item) => item.id === selectedTemplateId)?.label || '当前默认模板'
  const assistantVersionCount = selectedWorkflowNode ? (selectedWorkflowNode.versionHistory?.length || 0) + 1 : 0
  const skillContext = {
    image: Boolean(selectedFile || selectedProductReferences.length),
    text: Boolean((selectedCanvasPrompt || assistantContext || '').trim()),
    node: Boolean(selectedWorkflowNode),
    product: Boolean(selectedProductReferences.length),
  }
  const skillMissing = (skill) => (skill.requires || []).filter((key) => !skillContext[key])
  const saveSkill = async (skill) => { const saved = await invoke('save_skill', { skill }); await refreshSkills(); return saved }
  const saveProjectTrainingSkill = async (skill) => {
    try {
      const saved = await saveSkill(skill)
      const projectId = activeProjectRef.current
      saveProjects(projects.map((item) => item.id === projectId ? { ...item, skillTraining: true, trainingSkillId: saved.id, trainedAt: Date.now() } : item))
      setProjectTrainingOpen(false)
      alert(`训练 Skill「${saved.name}」已保存。以后执行时会参考本项目的示范流程。`)
    } catch (error) { alert(`保存训练 Skill 失败：${errorMessage(error)}`) }
  }
  const importSkills = async (data) => { const result = await invoke('import_skills', { data }); await refreshSkills(); alert(`已导入 ${result.count} 个 Skill`) }
  const exportSkills = async (ids = []) => { const result = await invoke('export_skills', { ids }); alert(`Skill 已导出到：\n${result.path}`) }
  const deleteSkill = async (id) => { if (!window.confirm('确定删除这个自建 Skill？')) return; await invoke('delete_skill', { id }); await refreshSkills() }
  const runSkill = async (skill) => {
    const missing = skillMissing(skill)
    if (missing.length) return alert(`此 Skill 还需要：${missing.map((key) => ({ image: '图片', text: '提示词文本', node: '提示词节点', product: '产品参考图' }[key])).join('、')}`)
    const source = selectedProductElements[0] || selectedCanvasElements.find((element) => element.type === 'image') || (selectedWorkflowNode?.sourceElementId ? sceneRef.current.elements.find((element) => element.id === selectedWorkflowNode.sourceElementId) : null)
    const contextPrompt = (selectedCanvasPrompt || assistantContext || '').trim()
    const node = { id: uid(), kind: 'skill', sourceElementId: source?.id || null, parentNodeId: selectedWorkflowNode?.id || null, x: source ? source.x + source.width + 150 : 160, y: source ? source.y : 160, width: 620, height: 500, model: aiStatus?.model || '', prompt: contextPrompt, output: '', busy: true, status: 'running', skillId: skill.id, skillVersion: skill.version, skillName: skill.name, skillOutputType: skill.outputType, skillRequires: skill.requires || [], referenceImages: selectedProductReferences, versionHistory: [], ...GENERATION_DEFAULTS }
    recordNodeHistory()
    const nodes = [...(sceneRef.current.workflowNodes || []), node]
    sceneRef.current = { ...sceneRef.current, workflowNodes: nodes }; setWorkflowNodes(nodes); setSelectedNodeIds([node.id]); persist(sceneRef.current.elements, sceneRef.current.appState || emptyScene.appState, sceneRef.current.files, nodes)
    try {
      const imageDataUrl = selectedFile?.dataURL || selectedProductReferences[0]?.dataURL || null
      const summary = `已选图片：${skillContext.image ? '是' : '否'}；已选文本：${skillContext.text ? '是' : '否'}；当前节点：${selectedWorkflowNode?.kind || '无'}；产品参考图：${selectedProductReferences.length} 张。`
      const result = await invoke('run_skill', { request: { skillId: skill.id, contextPrompt: contextPrompt || null, imageDataUrl, contextSummary: summary } })
      updateWorkflowNode(node.id, { busy: false, status: 'completed', output: result.text, prompt: contextPrompt, model: result.model, skillVersion: result.skill.version })
      saveChat([...chatMessages, { id: uid(), role: 'assistant', text: result.text, model: result.model, isPrompt: skill.outputType === 'prompt', source: 'skill', skillId: skill.id, templateLabel: `Skill · ${skill.name}`, createdAt: Date.now(), nodeId: node.id }])
      refreshSkills()
    } catch (error) { updateWorkflowNode(node.id, { busy: false, status: 'failed', error: errorMessage(error, 'Skill 执行失败') }) }
  }
  useEffect(() => {
    if (!selectedWorkflowNode || !assistantContext) return
    let changed = false
    const next = chatMessages.map((message) => {
      if (message.nodeId !== selectedWorkflowNode.id || !message.linkedToNode || message.text === assistantContext) return message
      changed = true
      return { ...message, text: assistantContext, model: selectedWorkflowNode.model, templateId: selectedWorkflowNode.templateId, templateLabel: selectedWorkflowNode.templateLabel, syncedAt: Date.now() }
    })
    if (changed) saveChat(next)
  }, [selectedWorkflowNode?.id, assistantContext])
  const sendAssistant = async () => {
    const message = assistantInput.trim(); if (!message || assistantBusy) return
    const user = { id: uid(), role: 'user', text: message, createdAt: Date.now(), nodeId: selectedWorkflowNode?.id || null }
    const pending = [...chatMessages, user]; saveChat(pending); setAssistantInput(''); setAssistantBusy(true)
    try {
      if (message.replace(/\s/g, '').includes('以图搜图')) {
        if (!selectedFile) throw new Error('请先在画布中选择一张图片。')
        await startImageSearch()
        saveChat([...pending, { id: uid(), role: 'assistant', text: '已复制当前图片并打开 Pinterest 首页。点击搜索框右侧的 Lens 相机，选择上传图片后可直接粘贴（Ctrl+V）当前原图开始搜索；左键打开图片详情，右键选择“发送图片到阿男帮你推画布”即可把图片和来源网址送回当前画布。', source: 'image-search', createdAt: Date.now() }])
        return
      }
      const generation = parseGenerationCommand(message, selectedWorkflowNode)
      if (generation) {
        if (!imageService?.configured) throw new Error('请先完成图像服务设置。')
        let generationNode = selectedWorkflowNode
        if (!generationNode) {
          if (!selectedFile || selected?.type !== 'image') throw new Error('请先选择一张图片，或选择一个已有提示词节点。')
          const manualPrompt = promptWithoutGenerationCommand(message)
          if (!manualPrompt) throw new Error('请在生图参数前写入你想生成的画面内容。')
          const nodeId = addPromptNode(manualPrompt, '手动提示词', 'reverse', selected, { id: 'manual', label: '手动输入' })
          generationNode = (sceneRef.current.workflowNodes || []).find((node) => node.id === nodeId)
          if (!generationNode) throw new Error('手动提示词节点创建失败，请重试。')
          setSelectedNodeIds([nodeId])
        }
        generationNode = { ...generationNode, generationAspect: generation.aspect, generationQuality: generation.quality, generationCount: generation.count }
        updateWorkflowNode(generationNode.id, { generationAspect: generation.aspect, generationQuality: generation.quality, generationCount: generation.count })
        saveChat([...pending, { id: uid(), role: 'assistant', text: `已按 ${generation.aspect} · ${generation.quality} · ${generation.count} 张启动生成，${selectedWorkflowNode ? '结果会自动连接到当前提示词节点' : '已先建立手动提示词节点并连接生成结果'}。`, model: imageService.model, source: 'generation', createdAt: Date.now(), nodeId: generationNode.id }])
        generatePreview(generationNode)
        return
      }
      const sourceFile = selectedWorkflowNode ? sourceFileForNode(selectedWorkflowNode) : selectedFile
      const imageDataUrl = sourceFile ? await compressForVision(sourceFile.dataURL) : null
      const wantsReverse = message.replace(/\s/g, '').includes('反推提示词')
      if (wantsReverse && imageDataUrl) {
        const templateId = selectedWorkflowNode?.templateId || selectedTemplateId || null
        const result = await invoke('reverse_image_prompt', { imageDataUrl, templateId })
        let nodeId = selectedWorkflowNode?.id || null
        if (selectedWorkflowNode) {
          const key = selectedWorkflowNode.kind === 'modify' || selectedWorkflowNode.kind === 'skill' ? 'output' : 'prompt'
          updateWorkflowNode(selectedWorkflowNode.id, { [key]: result.prompt, model: result.model, templateId: result.templateId, templateLabel: result.templateLabel })
        } else if (selected?.type === 'image') nodeId = addPromptNode(result.prompt, result.model, 'reverse', selected, { id: result.templateId, label: result.templateLabel })
        saveChat([...pending, { id: uid(), role: 'assistant', text: result.prompt, model: result.model, isPrompt: true, source: 'reverse', linkedToNode: Boolean(nodeId), templateId: result.templateId, templateLabel: result.templateLabel, createdAt: Date.now(), nodeId }])
      } else {
        const result = await invoke('prompt_assistant', { message, contextPrompt: assistantContext || null, imageDataUrl })
        saveChat([...pending, { id: uid(), role: 'assistant', text: result.text, model: result.model, isPrompt: result.isPrompt, source: result.isPrompt ? 'assistant-edit' : 'assistant', linkedToNode: false, templateLabel: result.isPrompt ? '助手修改版本' : '', createdAt: Date.now(), nodeId: selectedWorkflowNode?.id || null }])
      }
    } catch (error) { saveChat([...pending, { id: uid(), role: 'error', text: String(error), createdAt: Date.now() }]) }
    finally { setAssistantBusy(false) }
  }
  const applyAssistantResult = (message, asVersion = false) => {
    if (selectedWorkflowNode) {
      const key = selectedWorkflowNode.kind === 'modify' || selectedWorkflowNode.kind === 'skill' ? 'output' : 'prompt'
      const previous = selectedWorkflowNode[key]
      const history = asVersion && previous ? [...(selectedWorkflowNode.versionHistory || []), { id: uid(), prompt: previous, model: selectedWorkflowNode.model, templateId: selectedWorkflowNode.templateId, templateLabel: selectedWorkflowNode.templateLabel, createdAt: Date.now() }].slice(-20) : selectedWorkflowNode.versionHistory
      updateWorkflowNode(selectedWorkflowNode.id, { [key]: message.text, model: message.model || selectedWorkflowNode.model, versionHistory: history })
      saveChat(chatMessages.map((item) => item.id === message.id ? { ...item, linkedToNode: true, nodeId: selectedWorkflowNode.id, templateId: selectedWorkflowNode.templateId, templateLabel: selectedWorkflowNode.templateLabel } : item))
    } else if (selected?.type === 'image') addPromptNode(message.text, message.model || aiStatus?.model || '当前模型', 'reverse', selected)
  }
  const saveImageService = async () => {
    setImageServiceMessage('正在保存…')
    try { const status = await invoke('save_image_service_config', { config: imageService }); setImageService((current) => ({ ...current, ...status, apiKey: '' })); setImageServiceMessage('设置已安全保存到桌面端') }
    catch (error) { setImageServiceMessage(`保存失败：${String(error)}`) }
  }
  const testImageService = async () => { try { const result = await invoke('test_image_service'); setImageServiceMessage(result.ok ? `连接成功（HTTP ${result.status}）` : `连接异常（HTTP ${result.status}）`) } catch (error) { setImageServiceMessage(String(error)) } }
  const chooseDownloadDirectory = async () => {
    if (directoryDialogBusy) return
    setDirectoryDialogBusy(true)
    try {
      const directory = await invoke('select_download_directory')
      if (!directory) { setImageServiceMessage('未修改原图下载目录'); return }
      const status = await invoke('set_image_download_directory', { downloadDirectory: directory })
      setImageService((current) => ({ ...current, ...status, apiKey: '' }))
      setImageServiceMessage(`原图将下载到：${directory}`)
    } catch (error) { setImageServiceMessage(`设置下载目录失败：${errorMessage(error)}`) }
    finally { setDirectoryDialogBusy(false) }
  }
  const resetDownloadDirectory = async () => {
    try {
      const status = await invoke('set_image_download_directory', { downloadDirectory: '' })
      setImageService((current) => ({ ...current, ...status, apiKey: '' }))
      setImageServiceMessage('已恢复默认：下载/PromptVault 原图')
    } catch (error) { setImageServiceMessage(`恢复默认目录失败：${errorMessage(error)}`) }
  }
  const addGeneratedImage = async (dataURL, node, taskMeta = {}) => {
    if (typeof dataURL !== 'string' || !dataURL.startsWith('data:image/')) throw new Error('图像服务返回的不是有效图片数据')
    const image = await new Promise((resolve, reject) => { const value = new Image(); value.onload = () => resolve(value); value.onerror = () => reject(new Error('生成图片解码失败，返回的文件可能不是有效图片')); value.src = dataURL })
    const fileId = uid(), elementId = uid(), scale = Math.min(1, 800 / Math.max(image.naturalWidth, image.naturalHeight)), source = sceneRef.current.elements.find((element) => element.id === node.sourceElementId)
    const mimeType = dataURL.match(/^data:([^;]+)/)?.[1] || 'image/png'
    const asset = await storeProjectAsset({ id: fileId, dataURL, name: `生成图 ${new Date().toLocaleString()}`, mimeType, kind: 'generated', tags: ['生图', taskMeta.aspect, taskMeta.quality].filter(Boolean), sourceUrl: taskMeta.sourceUrl || null })
    const file = { id: fileId, assetId: asset.assetId, dataURL, mimeType, created: Date.now(), lastRetrieved: Date.now(), version: 1 }
    const width = Math.round(image.naturalWidth * scale), height = Math.round(image.naturalHeight * scale), resultIndex = Number(taskMeta.resultIndex || 0)
    const element = { id: elementId, type: 'image', x: node.x + node.width + 140 + (resultIndex % 2) * (width + 40), y: node.y + Math.floor(resultIndex / 2) * (height + 40), width, height, angle: 0, strokeColor: 'transparent', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid', roughness: 0, opacity: 100, groupIds: [], frameId: null, seed: nonce(), version: 1, versionNonce: nonce(), isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false, fileId, status: 'saved', scale: [1, 1], crop: null, customData: { promptNodeId: node.id, prompt: node.kind === 'modify' ? (node.output || node.prompt) : node.prompt, generation: taskMeta } }
    const files = { ...sceneRef.current.files, [fileId]: file }, elements = [...sceneRef.current.elements, element]
    sceneRef.current = { ...sceneRef.current, files, elements }; api.current?.addFiles([file]); api.current?.updateScene({ elements }); persist(elements, sceneRef.current.appState || emptyScene.appState, files)
    if (source) { const currentNode = (sceneRef.current.workflowNodes || []).find((item) => item.id === node.id) || node; updateWorkflowNode(node.id, { generatedElementIds: [...(currentNode.generatedElementIds || []), elementId], generationModel: taskMeta.model || imageService.model }) }
  }
  const cancelGeneration = async (node) => {
    const current = (sceneRef.current.workflowNodes || []).find((item) => item.id === node.id)
    if (!current?.generationBusy) return
    generationRunsRef.current.delete(node.id)
    const finishedAt = Date.now()
    const taskIds = [...new Set([current.generationTaskId, ...(current.generationTaskIds || [])].filter(Boolean))]
    updateWorkflowNode(node.id, { generationBusy: false, generationStatus: `已取消 · 已完成 ${current.generationCompletedCount || 0}/${current.generationCount || 1}`, generationTaskId: null, generationTaskIds: [], generationFinishedAt: finishedAt, generationElapsedMs: Math.max(0, finishedAt - Number(current.generationStartedAt || finishedAt)), generationError: '' })
    await Promise.all(taskIds.map((taskId) => invoke('cancel_generation', { taskId }).catch((error) => console.warn(`服务端任务 ${taskId} 取消未确认，已停止本地等待`, error))))
  }
  const generateAssistantPreview = async (node, promptOverride = null, options = {}) => {
    if (!node) return
    const multiAngleRun = options.mode === 'multi-angle'
    const quickEditRun = options.mode === 'quick-edit'
    const localEditInstruction = options.editInstruction?.trim() || ''
    // 视角变体时，当前选中的已生成场景图是“编辑底图”，不是产品参考图。
    // 只有白底/产品参考图进入 referenceImages，避免模型把整张旧场景锁死。
    const selectedCanvasImage = selectedFile?.dataURL ? {
      id: selected?.fileId || selectedFile.id || uid(),
      dataURL: selectedFile.dataURL,
      name: '当前选中场景底图',
      mimeType: selectedFile.mimeType || 'image/png',
      role: '仅用于保持场景、光线和构图的编辑底图',
    } : null
    const existingReferences = (node.referenceImages?.length ? node.referenceImages : (node.referenceImage ? [node.referenceImage] : [])).filter((image) => image?.dataURL)
    const selectedGeneratedScene = Boolean(selectedImageNode && selectedCanvasImage)
    // 多角度是对画布上当前图片做视角变体。无论图片是刚拖入的原图，还是已经
    // 生成过的场景图，都要作为编辑底图发送；不能把纯图片误当成产品参考图。
    const selectedImageAsEdit = Boolean(selectedCanvasImage && (quickEditRun || multiAngleRun))
    const referenceImages = selectedImageAsEdit
      ? existingReferences
      : selectedGeneratedScene
        ? existingReferences
      : selectedCanvasImage
        ? [selectedCanvasImage, ...existingReferences.filter((image) => image.dataURL !== selectedCanvasImage.dataURL)].slice(0, 8)
        : existingReferences
    const previewNode = {
      ...node,
      ...(promptOverride && !localEditInstruction ? { prompt: promptOverride, output: promptOverride } : {}),
      referenceImages,
      referenceImage: null,
      generationEditImage: selectedImageAsEdit ? selectedCanvasImage : null,
      generationEditMaskBoxes: options.editMaskBoxes || node.generationEditMaskBoxes || null,
      productConsistency: selectedImageAsEdit ? (existingReferences.length ? true : node.productConsistency) : (selectedCanvasImage ? true : node.productConsistency),
    }
    // 节点本身仍保存产品参考图；已生成场景底图只存在于本次请求中。
    if (selectedCanvasImage && !selectedImageAsEdit) updateWorkflowNode(node.id, { referenceImages, referenceImage: null, productConsistency: true })
    await generatePreview(previewNode, { mode: multiAngleRun ? 'multi-angle' : quickEditRun ? 'quick-edit' : 'normal', editInstruction: localEditInstruction, editMaskBoxes: options.editMaskBoxes || null, preserveSourceDimensions: options.preserveSourceDimensions === true })
  }
  const generateAssistantMessagePreview = async (message) => {
    let node = selectedWorkflowNode
    if (!node) {
      if (!selectedFile || selected?.type !== 'image') return alert('请先选中要作为产品参考的图片。')
      const nodeId = addPromptNode(message.text, message.model || aiStatus?.model || '当前模型', 'reverse', selected, null)
      node = (sceneRef.current.workflowNodes || []).find((item) => item.id === nodeId) || null
      if (!node) return
      setSelectedNodeIds([node.id])
    }
    await generateAssistantPreview(node, message.text, { mode: 'normal' })
  }
  const generatePreview = async (node, options = {}) => {
    if ((sceneRef.current.workflowNodes || []).find((item) => item.id === node.id)?.generationBusy) return
    const multiAngleRun = options.mode === 'multi-angle'
    const quickEditRun = options.mode === 'quick-edit'
    const editInstruction = options.editInstruction?.trim() || ''
    const preserveSourceDimensions = options.preserveSourceDimensions === true
    // 多角度状态保存在节点上，便于下次打开时继续编辑；但普通“生成预览”
    // 必须使用原提示词，不能把上一次的角度指令、背面图或场景底图带进去。
    const generationNode = (multiAngleRun || quickEditRun)
      ? node
      : { ...node, generationMultiAngleEnabled: false, generationBacksideReference: null, generationEditImage: null, generationEditMaskBoxes: null }
    const basePrompt = generationNode.kind === 'modify' ? (generationNode.output || generationNode.prompt) : generationNode.prompt; if (!basePrompt?.trim()) return
    const keepProduct = generationNode.productConsistency !== false
    const multiAngleInstruction = multiAngleRun ? buildMultiAngleInstruction(generationNode) : ''
      const prompt = [keepProduct ? PRODUCT_CONSISTENCY_INSTRUCTION : '', basePrompt, editInstruction, multiAngleInstruction].filter(Boolean).join('\n\n')
      const quality = generationNode.generationQuality || GENERATION_DEFAULTS.generationQuality, aspect = generationNode.generationAspect || GENERATION_DEFAULTS.generationAspect
      const count = Math.max(1, Math.min(4, Number(generationNode.generationCount || GENERATION_DEFAULTS.generationCount))), requestedSize = GENERATION_SIZES[quality]?.[aspect] || '2048x1152', size = GENERATION_COMPATIBLE_SIZES[aspect] || '1792x1024'
    const generationModel = generationModelFor(imageService.model, quality)
    const runId = uid(), startedAt = Date.now()
    generationRunsRef.current.set(node.id, runId)
    const active = () => generationRunsRef.current.get(node.id) === runId
    const cancelError = () => Object.assign(new Error('已取消生图'), { cancelled: true })
    const ensureActive = () => { if (!active()) throw cancelError() }
    const updateActive = (changes) => { if (active()) updateWorkflowNode(node.id, changes) }
    updateActive({ generationBusy: true, generationRunId: runId, generationStartedAt: startedAt, generationFinishedAt: null, generationElapsedMs: 0, generationTiming: null, generationStatus: `准备提交 0/${count}`, generationTaskId: null, generationTaskIds: [], generationCompletedCount: 0, generationFailedCount: 0, error: '', generationError: '', generationAspect: aspect, generationQuality: quality, generationCount: count })
    try {
      // A reference explicitly attached to a node is always a product reference,
      // including ordinary prompt nodes started from the assistant.  Previously
      // prompt nodes silently discarded it and fell back to their source scene.
      const replacementReferences = (generationNode.referenceImages?.length ? generationNode.referenceImages : (generationNode.referenceImage ? [generationNode.referenceImage] : [])).filter((image) => image?.dataURL)
      const backsideReference = multiAngleRun && generationNode.generationBacksideReference?.dataURL ? generationNode.generationBacksideReference : null
      const requestProductReferences = replacementReferences.slice(0, backsideReference ? 7 : 8)
      const replacementReference = replacementReferences[0] || null
      const sourceImage = sourceFileForNode(generationNode)
      const explicitEditImage = (multiAngleRun || quickEditRun) && generationNode.generationEditImage?.dataURL ? generationNode.generationEditImage : null
      const editImage = explicitEditImage || replacementReference || (keepProduct ? sourceImage : null)
      if (generationNode.kind === 'modify' && !replacementReference && !quickEditRun) throw new Error('请添加产品参考图；生成不会使用原场景图')
      const referenceRoles = requestProductReferences.map((item, index) => `产品参考图${index + 1}用途：${item.role || '产品外观'}`).join('；')
      const backsideReferenceRole = backsideReference ? '【背面参考图已上传】本次请求的最后一张参考图就是当前产品的背面/另一面。请把它视为同一型号的结构事实，用来补全目标视角中可见的背面，不得把它当成另一款产品或场景风格参考。' : ''
      const editRole = explicitEditImage
        ? multiAngleRun
          ? '当前选中的第一张输入图是同一场景的编辑底图，用于识别人物、产品、背景、光线和真实空间关系；它不是要锁死的原构图。摄像机模式下必须对整张场景重新构图，让人物、产品和背景一起随目标机位改变；若开启人物动作锁定，人物只允许改变投影、可见侧面和遮挡，不得重新摆姿势或把原人物贴回原背景位置。'
          : '当前选中的第一张输入图是本次快速编辑的原图底稿。只执行用户明确提出的编辑，不要重新设计未提及的主体、人物动作、产品结构、场景、构图、光线和画面比例；不要把原图当成新的产品型号参考。'
        : ''
      const finalAnglePriority = multiAngleRun ? `【最终镜头执行指令】必须优先执行目标镜头，不得复用原图的取景距离和构图。目标水平视角：${describeCameraRotation(generationNode.generationRotate)}；目标垂直机位：${describeCameraTilt(generationNode.generationTilt)}；${describeCameraScale(generationNode.generationScale)}${describeAngleEvidence(generationNode)}如果原图是中远景而目标是近景，输出必须明显收紧取景，让产品成为画面主体。` : ''
      const quickEditPriority = quickEditRun ? '【快速编辑最高优先级：原图局部编辑】这是在当前图片上做局部修改，不是重新生成一张新图。上面的局部编辑指令是唯一需要改变的内容，不需要再次改写或扩展成完整场景提示词；只允许改变用户明确点名的区域或对象。未提及的主体身份、人物动作、产品结构、背景、天空以外的环境、构图、镜头、光线方向、文字和画面比例全部锁定，必须与原图保持一致。若用户只修改天空，就只编辑天空及其自然反射，严禁重做人物、产品、地面和背景；禁止额外发挥、换场景、改动作或改变取景。' : ''
      const generationPrompt = [
        prompt,
        editRole,
        referenceRoles ? `【产品参考图锁定】${referenceRoles}。这些图片才是本次生成的产品外观事实来源；当文字描述与产品参考图存在冲突时，以产品参考图为准。必须复刻其中产品的车架、车把、立管、踏板、前后轮、轮毂、灯具、折叠结构、配色、材质、贴花与比例，不得替换成通用款或重新设计产品。` : '',
        backsideReferenceRole,
        multiAngleRun && explicitEditImage ? `【视角变体最终覆盖指令】必须实际改变摄像机位置，并让人物、产品、背景透视和遮挡关系同步改变；不能只复用原图构图，也不能只翻转产品。原提示词中关于旧视角、旧机位、旧景别和旧构图的描述仅作为场景事实，不得覆盖当前目标角度。${generationNode.generationActionLock !== false ? '人物当前动作是锁定项，只能重新投影，不能改动作。' : ''}` : '',
        finalAnglePriority,
        quickEditPriority,
      ].filter(Boolean).join('\n\n')
      const productReferenceImages = requestProductReferences.length ? await prepareGenerationReferences(requestProductReferences) : []
      const backsideReferenceDataUrl = backsideReference ? await prepareGenerationReference(backsideReference.dataURL, 700 * 1024) : null
      const editImageDataUrl = editImage ? await prepareGenerationReference(editImage.dataURL, 700 * 1024) : null
      const editMaskBoxes = quickEditRun ? (options.editMaskBoxes || generationNode.generationEditMaskBoxes || []).filter(Boolean) : []
      const editMaskDataUrl = editImageDataUrl && editMaskBoxes.length ? await createInpaintMask(editImageDataUrl, editMaskBoxes) : null
      let requestAspect = aspect
      let requestSize = size
      let requestRequestedSize = requestedSize
      if (quickEditRun && editImage?.dataURL) {
        requestAspect = closestGenerationAspect(await imageAspect(editImage.dataURL))
        requestSize = GENERATION_COMPATIBLE_SIZES[requestAspect] || size
        requestRequestedSize = GENERATION_SIZES[quality]?.[requestAspect] || requestedSize
      }
      const requestReferenceImages = explicitEditImage
        ? [editImageDataUrl, ...productReferenceImages, backsideReferenceDataUrl].filter(Boolean).slice(0, 8)
        : productReferenceImages.length ? [...productReferenceImages, backsideReferenceDataUrl].filter(Boolean).slice(0, 8) : [editImageDataUrl, backsideReferenceDataUrl].filter(Boolean).slice(0, 8)
      ensureActive()
      const preparationMs = Date.now() - startedAt
      if (replacementReference) updateActive({ generationStatus: `正在锁定${node.kind === 'compose' ? `${replacementReferences.length} 张产品参考图` : `产品参考图“${replacementReference.name || replacementReference.role || '当前选中产品'}”`}生成` })
      else if (explicitEditImage) updateActive({ generationStatus: quickEditRun ? '正在以当前图片为编辑底图，准备生成快速编辑结果…' : '正在以当前生成场景为编辑底图，准备生成目标视角…' })
      let submittedCount = 0, completedCount = 0, failedCount = 0, nextIndex = 0
      const failureDetails = []
      const taskIds = new Set(), taskTimings = []
      const summarizeTiming = () => {
        const average = (key) => taskTimings.length ? Math.round(taskTimings.reduce((sum, item) => sum + item[key], 0) / taskTimings.length) : undefined
        return { preparationMs, submitMs: average('submitMs'), serverMs: average('serverMs'), downloadMs: average('downloadMs'), taskCount: taskTimings.length }
      }
      const pollDelay = (attempt) => attempt < 3 ? 1200 : attempt < 10 ? 2200 : 3500
      const generateOne = async (resultIndex) => {
        let taskId = null
        try {
          updateActive({ generationStatus: `正在提交 ${submittedCount + 1}/${count} · 已完成 ${completedCount}/${count}` })
          const submitStartedAt = Date.now()
           let task = await invoke('submit_generation', { request: { prompt: generationPrompt, size: requestSize, requestedSize: requestRequestedSize, aspectRatio: requestAspect, imageSize: quality, model: generationModel, imageDataUrl: editImageDataUrl, maskDataUrl: editMaskDataUrl, referenceImages: requestReferenceImages } })
          const submittedAt = Date.now()
          taskId = task.taskId || null
          if (!active()) { if (taskId) invoke('cancel_generation', { taskId }).catch(() => {}); throw cancelError() }
          submittedCount += 1
          if (taskId) taskIds.add(taskId)
          updateActive({ generationTaskId: taskId, generationTaskIds: [...taskIds], generationStatus: `已提交 ${submittedCount}/${count} · 生成中 ${Math.max(0, submittedCount - completedCount - failedCount)} · 已完成 ${completedCount}/${count}` })
          for (let attempt = 0; !task.imageUrl && taskId && attempt < 180; attempt += 1) {
            ensureActive()
            if (['failed', 'failure', 'error', 'cancelled'].includes(task.status)) throw new Error(`任务 ${resultIndex + 1}（${taskId}）生成失败：${task.error?.message || task.error || task.message || task.status}`)
            await new Promise((resolve) => setTimeout(resolve, pollDelay(attempt)))
            ensureActive()
            task = await invoke('get_generation_status', { taskId, model: generationModel })
            updateActive({ generationStatus: `已提交 ${submittedCount}/${count} · 等待服务端 ${task.status || '运行中'} · 已完成 ${completedCount}/${count}` })
          }
          if (!task.imageUrl) throw new Error(taskId ? `任务 ${resultIndex + 1} 等待图片超时` : `任务 ${resultIndex + 1} 未返回任务编号或图片`)
          const downloadStartedAt = Date.now()
          updateActive({ generationStatus: `正在下载第 ${resultIndex + 1}/${count} 张 · 已完成 ${completedCount}/${count}` })
          const downloaded = await invoke('download_generation_result', { source: task.imageUrl })
          ensureActive()
           let generatedDataUrl = downloaded.dataUrl
           if (preserveSourceDimensions && editImage?.dataURL) generatedDataUrl = await compositeMaskedEdit(editImage.dataURL, generatedDataUrl, editMaskBoxes)
           await addGeneratedImage(generatedDataUrl, generationNode, { taskId, model: generationModel, effectivePrompt: generationPrompt, resultIndex, requestedSize: requestRequestedSize, aspect: requestAspect, quality, sourceUrl: task.imageUrl, multiAngle: multiAngleRun, quickEdit: quickEditRun, editMask: Boolean(editMaskDataUrl), preservedSourceDimensions: preserveSourceDimensions, angleMode: multiAngleRun ? (generationNode.generationAngleMode || 'camera') : 'camera', rotate: multiAngleRun ? Number(generationNode.generationRotate || 0) : 0, tilt: multiAngleRun ? Number(generationNode.generationTilt || 0) : 0, scale: multiAngleRun ? (generationNode.generationScale || 'medium') : 'medium', backsideReference: multiAngleRun && Boolean(backsideReference) })
          const finishedImageAt = Date.now()
          taskTimings.push({ submitMs: submittedAt - submitStartedAt, serverMs: downloadStartedAt - submittedAt, downloadMs: finishedImageAt - downloadStartedAt })
          completedCount += 1
          if (taskId) taskIds.delete(taskId)
          updateActive({ generationTaskIds: [...taskIds], generationCompletedCount: completedCount, generationTiming: summarizeTiming(), generationStatus: `已提交 ${submittedCount}/${count} · 已完成 ${completedCount}/${count}` })
        } catch (error) {
          if (error?.cancelled) throw error
          failedCount += 1
          if (taskId) taskIds.delete(taskId)
          const detail = errorMessage(error, '请重试')
          failureDetails.push(detail)
          updateActive({ generationTaskIds: [...taskIds], generationFailedCount: failedCount, generationStatus: `已提交 ${submittedCount}/${count} · 已完成 ${completedCount}/${count} · 失败 ${failedCount}`, generationError: `${failedCount} 张生成失败：${failureDetails.join('；')}` })
        }
      }
      const workerCount = Math.min(2, count)
      const workers = Array.from({ length: workerCount }, async () => {
        while (active() && nextIndex < count) {
          const resultIndex = nextIndex
          nextIndex += 1
          await generateOne(resultIndex)
        }
      })
      await Promise.all(workers)
      ensureActive()
      const finishedAt = Date.now()
      updateActive({ generationBusy: false, generationStatus: failedCount ? `已完成 ${completedCount}/${count} · ${failedCount} 张失败` : `已完成 ${completedCount}/${count}`, generationTaskId: null, generationTaskIds: [], generationCompletedCount: completedCount, generationFailedCount: failedCount, generationFinishedAt: finishedAt, generationElapsedMs: finishedAt - startedAt, generationTiming: summarizeTiming(), generationError: failedCount ? `${failedCount} 张未生成成功：${failureDetails.join('；') || '服务端没有返回具体原因'}` : '', generationModel })
    } catch (error) {
      if (active() && !error?.cancelled) { const finishedAt = Date.now(); updateWorkflowNode(node.id, { generationBusy: false, generationStatus: 'failed', generationTaskId: null, generationFinishedAt: finishedAt, generationElapsedMs: finishedAt - startedAt, generationError: errorMessage(error, '图像生成失败，请重试') }) }
    } finally { if (active()) generationRunsRef.current.delete(node.id) }
  }
  const saveGeneratedImageToVault = async () => {
    if (!selectedFile || !selected?.customData?.promptNodeId) return
    const node = (sceneRef.current.workflowNodes || []).find((item) => item.id === selected.customData.promptNodeId)
    const prompt = node ? (node.kind === 'modify' ? (node.output || node.prompt) : node.prompt) : selected.customData.prompt
    if (!prompt?.trim()) return alert('未找到这张生成图片对应的提示词。')
    const type = selectedFile.mimeType || selectedFile.dataURL.match(/^data:(image\/[^;]+)/)?.[1] || 'image/png'
    const extension = type.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
    const generation = selected.customData.generation || {}
    const tags = JSON.stringify(['生图验证', generation.aspect, generation.quality, generation.model].filter(Boolean))
    try {
      const result = await invoke('create_card_manual', { imageBase64: selectedFile.dataURL, imageExt: extension, prompt: prompt.trim(), negativePrompt: '', category: '生图验证', tags })
      if (!result.ok) throw new Error(result.reason || '保存失败')
      alert('已将生成图片和对应提示词收藏到提示词库。')
    } catch (error) { alert(`收藏失败：${String(error)}`) }
  }
  const downloadGeneratedOriginal = async () => {
    if (!selectedFile || !selected?.customData?.promptNodeId) return
    try {
      const source = selected.customData?.generation?.sourceUrl || selectedFile.dataURL
      const result = await invoke('save_generation_original', { source })
      alert(`原图已下载到：${result.path}`)
    } catch (error) { alert(`原图下载失败：${errorMessage(error)}`) }
  }
  const selectedImageToolbarPosition = selected?.type === 'image' ? { left: Math.max(12, (selected.x + (viewport.scrollX || 0)) * (viewport.zoom || 1)), top: Math.max(54, (selected.y + (viewport.scrollY || 0)) * (viewport.zoom || 1) - 48) } : null
  const quickEditPosition = selectedImageToolbarPosition ? { left: Math.max(12, Math.min(selectedImageToolbarPosition.left, Math.max(12, (boardRef.current?.clientWidth || 720) - 560))), top: selectedImageToolbarPosition.top + 54 } : null
  const openPromptVault = () => {
    // 切换立即发生；大场景保存移到浏览器空闲时段，避免阻塞按钮反馈。
    persist(sceneRef.current.elements, sceneRef.current.appState || emptyScene.appState, sceneRef.current.files, sceneRef.current.workflowNodes || [])
    setMode('prompts')
    requestAnimationFrame(() => setVaultLoaded(true))
  }

  const checkAppUpdate = async () => {
    if (!window.__TAURI__) return alert('浏览器预览模式不支持检查桌面更新。')
    setUpdateChecking(true)
    setUpdateError('')
    try {
      const available = await check()
      if (!available) return alert('当前已经是最新版本。')
      setAppUpdate(available)
      setUpdateDialogOpen(true)
    } catch (error) {
      setUpdateError(errorMessage(error, '检查更新失败，请稍后重试。'))
      setUpdateDialogOpen(true)
    } finally { setUpdateChecking(false) }
  }

  const installAppUpdate = async () => {
    if (!appUpdate || updateInstalling) return
    setUpdateInstalling(true)
    setUpdateError('')
    setUpdateProgress({ downloaded: 0, total: 0, percent: 0, label: '准备下载…' })
    try {
      let downloaded = 0
      let total = 0
      await appUpdate.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          total = Number(event.data?.contentLength || 0)
          setUpdateProgress({ downloaded, total, percent: 0, label: '正在下载更新…' })
        } else if (event.event === 'Progress') {
          downloaded += Number(event.data?.chunkLength || 0)
          const percent = total ? Math.min(100, Math.round(downloaded / total * 100)) : 0
          setUpdateProgress({ downloaded, total, percent, label: total ? `正在下载更新 ${percent}%` : '正在下载更新…' })
        } else if (event.event === 'Finished') {
          setUpdateProgress({ downloaded, total, percent: 100, label: '下载完成，正在启动安装程序…' })
        }
      })
    } catch (error) {
      setUpdateError(errorMessage(error, '更新安装失败，请稍后重试。'))
      setUpdateInstalling(false)
    }
  }

  return <div className={`app ${canvasTheme === 'light' ? 'light-theme' : ''}`}>
    <header className="bar"><b>阿男帮你推</b><nav className="mode-switch"><button className={mode === 'canvas' ? 'active' : ''} onClick={() => setMode('canvas')}>灵感空间</button><button className={mode === 'prompts' ? 'active' : ''} onClick={openPromptVault}>提示词库</button></nav>{mode === 'canvas' && <><span /><button className={appUpdate ? 'app-update-ready' : ''} disabled={updateChecking} onClick={appUpdate ? () => setUpdateDialogOpen(true) : checkAppUpdate}>{updateChecking ? '检查中…' : appUpdate ? `可更新 ${appUpdate.version}` : '检查更新'}</button><button onClick={() => setDetailOpen((value) => !value)}>{detailOpen ? '收起侧栏' : '展开侧栏'}</button><button onClick={() => input.current?.click()}>导入图片</button><input ref={input} hidden type="file" multiple accept="image/*" onChange={(event) => importFiles(event.target.files)} /></>}</header>
    {updateDialogOpen && <div className="app-update-backdrop" onMouseDown={() => !updateInstalling && setUpdateDialogOpen(false)}><section className="app-update-dialog" onMouseDown={(event) => event.stopPropagation()}><header><div><small>安全更新</small><h2>{appUpdate ? `发现新版本 ${appUpdate.version}` : '检查更新失败'}</h2></div><button disabled={updateInstalling} onClick={() => setUpdateDialogOpen(false)}>×</button></header>{appUpdate && <><p className="app-update-date">当前版本 1.3.6{appUpdate.date ? ` · 发布于 ${new Date(appUpdate.date).toLocaleString()}` : ''}</p><div className="app-update-notes">{appUpdate.body || '本次版本包含功能优化与问题修复。'}</div></>}{updateProgress && <div className="app-update-progress"><div style={{ width: `${updateProgress.percent || 0}%` }} /><span>{updateProgress.label}</span></div>}{updateError && <p className="app-update-error">{updateError}</p>}<footer>{!updateInstalling && <button onClick={() => setUpdateDialogOpen(false)}>稍后提醒</button>}{appUpdate && <button className="primary" disabled={updateInstalling} onClick={installAppUpdate}>{updateInstalling ? '正在更新…' : '一键升级并安装'}</button>}{!appUpdate && <button className="primary" onClick={checkAppUpdate}>重新检查</button>}</footer><small className="app-update-security">更新包来自官方 GitHub Releases，并在安装前验证数字签名。</small></section></div>}
    {vaultLoaded && <iframe className={`vault-frame ${mode === 'prompts' ? 'active' : ''}`} title="提示词库" src="/prompt-vault.html" />}
    <main className={`${detailOpen ? '' : 'right-closed'} ${mode === 'prompts' ? 'canvas-hidden' : ''}`}>
      <aside className={`projects ${drawerOpen ? '' : 'collapsed'}`}>
        <button className="collapse" title={drawerOpen ? '收起项目库' : '展开项目库'} onClick={() => setDrawerOpen(!drawerOpen)}>{drawerOpen ? '‹' : '›'}</button>
        {drawerOpen && <div className="project-content"><div className="project-title"><b>项目库</b><button title="新建项目" onClick={createProject}>＋</button></div><p>双击名称可重命名</p><div className="project-actions"><button onClick={exportProject}>导出项目</button><button onClick={() => projectInput.current?.click()}>导入项目</button><button onClick={loadBackups}>历史备份</button><button className="project-training-button" onClick={() => setProjectTrainingOpen(true)}>{projects.find((item) => item.id === activeProjectId)?.skillTraining ? '训练 Skill' : '设为训练画布'}</button><input ref={projectInput} hidden type="file" accept=".json,.prompt-canvas.json" onChange={(event) => importProject(event.target.files?.[0])} /></div>{showBackups && <div className="backup-list"><header><b>最近备份</b><button onClick={() => setShowBackups(false)}>×</button></header>{backups.length ? backups.map((backup) => <div key={backup.name}><span>{new Date(backup.modifiedAt).toLocaleString()}</span><button onClick={() => restoreBackup(backup.name)}>恢复</button><button onClick={() => removeBackup(backup.name)}>删除</button></div>) : <p>暂无自动备份</p>}</div>}<div className="project-list">{projects.map((project) => <div key={project.id} className={`project-row ${project.id === activeProjectId ? 'active' : ''}`} onClick={() => selectProject(project.id)} onDoubleClick={() => renameProject(project)}><span>{project.name}{project.skillTraining ? ' · 训练' : ''}</span><button title="删除项目" onClick={(event) => { event.stopPropagation(); deleteProject(project) }}>×</button></div>)}</div></div>}
      </aside>
      <section ref={boardRef} className="board" onDragEnterCapture={allowImageDrop} onDragOverCapture={allowImageDrop} onDropCapture={importDroppedImages}>
        <button className="asset-library-trigger" style={{ left: 16, right: 'auto' }} title="项目素材（不占用画布面积）" onClick={() => { setAssetDrawerOpen((value) => !value); if (!assetDrawerOpen) { void syncSelectedFileToAssets().finally(() => refreshProjectAssets()) } }}>▣ 素材</button>
        {assetDrawerOpen && <aside className="asset-library-drawer"><header><div><small>PROJECT ASSETS</small><b>项目素材</b></div><button title="收起素材库" onClick={() => setAssetDrawerOpen(false)}>×</button></header><div className="asset-library-filters"><input value={assetFilter} onChange={(event) => setAssetFilter(event.target.value)} placeholder="搜索名称、标签…" /><select value={assetKind} onChange={(event) => setAssetKind(event.target.value)}><option value="all">全部类型</option><option value="image">导入图片</option><option value="generated">生成结果</option></select></div><p>原图保存在本机项目素材中；画布只保存引用与缩略图。</p><div className="asset-library-list">{projectAssets.filter((asset) => (assetKind === 'all' || asset.kind === assetKind) && `${asset.name} ${(asset.tags || []).join(' ')}`.toLowerCase().includes(assetFilter.toLowerCase())).map((asset) => { const usage = (sceneRef.current.elements || []).filter((item) => item.fileId === asset.id && !item.isDeleted).length; return <article key={asset.id}><img src={asset.thumbnailDataUrl || ''} alt="" /><div><b>{asset.name}</b><small>{asset.kind === 'generated' ? '生成结果' : '图片'} · 已用 {usage} 次</small>{asset.tags?.length > 0 && <span>{asset.tags.join(' · ')}</span>}{asset.sourceUrl && <a onClick={() => openExternalUrl(asset.sourceUrl)}>来源链接</a>}</div><button onClick={() => placeProjectAsset(asset)}>放回画布</button></article> })}{!projectAssets.length && <div className="asset-library-empty">本项目还没有素材。导入图片、插件发送图片和生图结果会自动收录到这里。</div>}</div></aside>}
        <div className="canvas-search"><input value={canvasSearch} onChange={(event) => setCanvasSearch(event.target.value)} placeholder="搜索提示词、模板、模型或分组…" />{canvasSearch && <div className="canvas-search-results">{searchResults.length ? searchResults.map((node) => <button key={node.id} onClick={() => focusWorkflowNode(node)}><b>{node.kind === 'modify' ? '提示词修改' : '提示词反推'}</b><span>{node.workflowGroupName || node.templateLabel || node.model}</span></button>) : <p>没有匹配节点</p>}</div>}</div>
        <div className="workflow-history-bar"><button title="撤销节点操作" disabled={!nodeHistoryRef.current.past.length} onClick={() => restoreNodeHistory('undo')}>↶</button><button title="重做节点操作" disabled={!nodeHistoryRef.current.future.length} onClick={() => restoreNodeHistory('redo')}>↷</button></div>
        <button className="fit-canvas" style={{ position: 'absolute', zIndex: 6, right: 'calc(min(340px, 42%) + 24px)', top: 10, height: 34, border: '1px solid #d4cce7', borderRadius: 9, background: '#fff', color: '#393445', padding: '0 11px', cursor: 'pointer', whiteSpace: 'nowrap' }} onMouseDown={(event) => event.preventDefault()} onClick={() => api.current?.scrollToContent(sceneRef.current.elements, { fitToViewport: true, viewportZoomFactor: 0.85 })}>查看全部</button>
        {(selectedNodeIds.length > 0 || canComposeGeneration) && <div className="workflow-selection-bar" style={{ top: 64, maxWidth: 'calc(100% - 32px)', whiteSpace: 'nowrap', overflowX: 'auto' }}>{selectedNodeIds.length > 0 && <><b>已选 {selectedNodeIds.length} 个节点</b><button onClick={duplicateSelectedWorkflowNodes}>复制</button><button onClick={groupSelectedWorkflowNodes}>分组</button><button onClick={renameSelectedGroup}>改名</button><button onClick={ungroupSelected}>解散</button><button onClick={collapseSelected}>折叠/展开</button><button onClick={connectSelectedToImage}>连接图片</button><button onClick={() => reorderSelected(false)}>置底</button><button onClick={() => reorderSelected(true)}>置顶</button><button onClick={deleteSelectedWorkflowNodes}>删除</button></>}{canComposeGeneration && <button className="primary" onClick={generateComposition}>用提示词＋产品图生图</button>}</div>}
        <Excalidraw key={`${activeProjectId}:${canvasInstanceVersion}`} theme={canvasTheme === 'light' ? 'light' : 'dark'} excalidrawAPI={(instance) => {
          api.current = instance
          // initialData 会先被 Excalidraw 内部默认状态覆盖一次；实例就绪后的下一帧再同步，
          // 才能保证实际绘制的 canvas 与项目保存的背景一致。
          const background = CANVAS_BACKGROUND
          requestAnimationFrame(() => instance.updateScene({ appState: { viewBackgroundColor: background } }))
        }} initialData={initialScene} langCode="zh-CN" onLinkOpen={(element, event) => { event.preventDefault(); openExternalUrl(element.link).catch((error) => alert(`链接打开失败：${errorMessage(error)}`)) }} onChange={(elements, incomingAppState, files) => {
          // 以项目状态为唯一真源，拒绝 Excalidraw 异步恢复时携带的陈旧背景值。
          const expectedBackground = CANVAS_BACKGROUND
          const appState = incomingAppState.viewBackgroundColor === expectedBackground
            ? incomingAppState
            : { ...incomingAppState, viewBackgroundColor: expectedBackground }
          if (appState !== incomingAppState) requestAnimationFrame(() => api.current?.updateScene({ appState: { viewBackgroundColor: expectedBackground } }))
          const nextTheme = appState.viewBackgroundColor === '#ffffff' ? 'light' : 'dark'
          if ((nextTheme === 'light') !== (canvasTheme === 'light')) setCanvasTheme(nextTheme)
          const scene = sceneRef.current
          const nextViewport = { scrollX: appState.scrollX || 0, scrollY: appState.scrollY || 0, zoom: appState.zoom?.value || appState.zoom || 1 }
          const previousViewport = viewportRef.current
          const viewportChanged = previousViewport.scrollX !== nextViewport.scrollX || previousViewport.scrollY !== nextViewport.scrollY || previousViewport.zoom !== nextViewport.zoom
          if (viewportChanged) {
            viewportRef.current = nextViewport
            pendingViewportRef.current = nextViewport
            const rendered = renderedViewportRef.current
            const sameZoom = rendered.zoom === nextViewport.zoom
            const layer = workflowLayerRef.current
            if (sameZoom && layer) {
              const dx = (nextViewport.scrollX - rendered.scrollX) * rendered.zoom
              const dy = (nextViewport.scrollY - rendered.scrollY) * rendered.zoom
              layer.style.willChange = 'transform'
              layer.style.transform = `translate3d(${dx}px, ${dy}px, 0)`
              clearTimeout(viewportSettleTimerRef.current)
              viewportSettleTimerRef.current = setTimeout(settleViewport, 90)
            } else if (!viewportFrameRef.current) {
              viewportFrameRef.current = requestAnimationFrame(() => { viewportFrameRef.current = 0; settleViewport() })
            }
          }
          // Excalidraw 在纯平移时也会新建 elements 数组；不能用数组引用判断画布变化。
          // 仅比较元素修订号，避免平移过程中误触发序列化保存和节点位置重算。
          const elementRevisions = elements.map((element) => `${element.id}:${element.version}:${element.versionNonce}:${element.isDeleted ? 1 : 0}`)
          const canvasChanged = elementRevisions.length !== canvasElementRevisionRef.current.length || elementRevisions.some((revision, index) => revision !== canvasElementRevisionRef.current[index])
          if (!canvasChanged) {
            sceneRef.current = { ...scene, appState }
            const selectedCanvasIds = Object.keys(appState.selectedElementIds || {}).filter((id) => appState.selectedElementIds[id]).sort()
            const selectionKey = selectedCanvasIds.join('|')
            if (selectionKey !== canvasSelectionRef.current) {
              canvasSelectionRef.current = selectionKey
              setSelectedCanvasIds(selectedCanvasIds)
              setSelectedNodeIds((scene.workflowNodes || []).filter((node) => selectedCanvasIds.includes(node.sourceElementId)).map((node) => node.id))
              const hit = selectedCanvasIds.length ? elements.find((element) => element.id === selectedCanvasIds[0]) : null
              const file = hit?.fileId ? files[hit.fileId] : null
              setSelected(hit ? { ...hit, file } : null)
            }
            return
          }
          canvasElementRevisionRef.current = elementRevisions
          const originalNodes = scene.workflowNodes || []
          // 只追踪真正绑定到节点的图片，避免拖动时每一帧为整张画布建立位置索引。
          // 节点的 DOM 更新也合并到下一动画帧，图片与连线会一起平滑移动。
          const linkedSourceIds = new Set(originalNodes.map((node) => node.sourceElementId).filter(Boolean))
          const previousPositions = sourcePositionsRef.current
          const nextPositions = {}
          const liveElementIds = new Set()
          for (const element of elements) {
            if (element.isDeleted) continue
            liveElementIds.add(element.id)
            if (linkedSourceIds.has(element.id)) nextPositions[element.id] = { x: element.x, y: element.y }
          }
          const nodes = originalNodes.filter((node) => !node.sourceElementId || liveElementIds.has(node.sourceElementId)).map((node) => {
            const before = previousPositions[node.sourceElementId], after = nextPositions[node.sourceElementId]
            return before && after && (before.x !== after.x || before.y !== after.y) ? { ...node, x: node.x + after.x - before.x, y: node.y + after.y - before.y } : node
          })
          const nodesMoved = nodes.length !== originalNodes.length || nodes.some((node, index) => node.x !== originalNodes[index]?.x || node.y !== originalNodes[index]?.y)
          sourcePositionsRef.current = nextPositions
          sceneRef.current = { elements, appState, files, workflowNodes: nodes }
          if (nodesMoved) renderWorkflowOnFrame(nodes)
          persist(elements, appState, files, nodes)
          // Covers Excalidraw's own paste / drag-drop importer as well as our buttons.
          void syncCanvasFilesToAssets(files)
          const hit = elements.find((element) => appState.selectedElementIds?.[element.id])
          const selectedCanvasIds = Object.keys(appState.selectedElementIds || {}).filter((id) => appState.selectedElementIds[id]).sort()
          const selectionKey = selectedCanvasIds.join('|')
          if (selectionKey !== canvasSelectionRef.current) {
            canvasSelectionRef.current = selectionKey
            setSelectedCanvasIds(selectedCanvasIds)
            setSelectedNodeIds(nodes.filter((node) => selectedCanvasIds.includes(node.sourceElementId)).map((node) => node.id))
          }
          setSelected((previous) => {
            if (!hit) return null
            const file = files[hit.fileId]
            return previous?.id === hit.id && previous.file?.dataURL === file?.dataURL ? previous : { ...hit, file }
          })
        }} UIOptions={{ tools: { diamond: false, ellipse: false }, canvasActions: { loadScene: false, saveToActiveFile: false, export: false, toggleTheme: false } }} validateEmbeddable={() => false} aiEnabled={false}>
          <MainMenu><MainMenu.DefaultItems.SaveAsImage /></MainMenu>
        </Excalidraw>
        <WorkflowNodes nodes={workflowNodes} elements={sceneRef.current.elements || []} viewport={viewport} layerRef={workflowLayerRef} templates={aiStatus?.promptTemplates || []} selectedIds={selectedNodeIds} onSelect={selectWorkflowNode} onBeginMove={recordNodeHistory} onMoveMany={moveWorkflowNodes} onRegenerate={runNode} onGenerate={generatePreview} onCancelGeneration={cancelGeneration} onModify={(node) => { const source = sceneRef.current.elements.find((element) => element.id === node.sourceElementId); if (source) addPromptNode(node.prompt, node.model, 'modify', source, { id: node.templateId, label: node.templateLabel }, node.id) }} onUpdate={updateWorkflowNode} onAttachImage={attachNodeImage} onRemoveImage={removeNodeImage} onDelete={deleteWorkflowNode} onDisconnect={disconnectWorkflowNode} />
         {selectedImageToolbarPosition && <div className="generated-image-toolbar" style={selectedImageToolbarPosition} onPointerDown={(event) => event.stopPropagation()}>
           <button className="text-edit-primary" onClick={openTextEditForSelection}>▣ 编辑文字</button>
           <button className="quick-edit-primary" onClick={openQuickEditForSelection}>✦ 快速编辑</button>
           {selected?.customData?.promptNodeId && <><button onClick={downloadGeneratedOriginal}>⇩ 下载原图</button><button onClick={saveGeneratedImageToVault}>★ 收藏到提示词库</button></>}
           <button className="primary" onClick={openMultiAngleForSelection} disabled={multiAnglePreparing}>{multiAnglePreparing ? '正在读取原图…' : '◇ 多角度'}</button>
           <button onClick={() => setSkillLibraryOpen(true)}>✦ Skill</button>
           <button onClick={() => { setSelected(null); setSelectedCanvasIds([]); setSelectedNodeIds([]); api.current?.updateScene({ appState: { selectedElementIds: {} } }) }}>取消</button>
         </div>}
         {textEditOpen && <TextEditDialog items={textEditItems} onChange={(id, value) => setTextEditItems((current) => current.map((item) => item.id === id ? { ...item, value } : item))} onGenerate={runTextEdit} onClose={() => !textEditBusy && setTextEditOpen(false)} busy={textEditBusy} recognizing={textEditRecognizing} error={textEditError} />}
         {quickEditOpen && selectedImageToolbarPosition && <QuickEditPopover value={quickEditText} onChange={setQuickEditText} onSubmit={runQuickEdit} onClose={() => !quickEditBusy && setQuickEditOpen(false)} busy={quickEditBusy} error={quickEditError} position={quickEditPosition} />}
         {multiAngleOpen && <MultiAngleDialog value={assistantGenerationValue} previewUrl={selectedFile?.dataURL || ''} onClose={() => setMultiAngleOpen(false)} onUse={applyMultiAngleAndGenerate} />}
      </section>
      <aside className={`detail assistant-detail ${rightTab === 'assistant' ? 'assistant-workbench' : ''}`} style={{ flexBasis: detailWidth }}>
        <div className="detail-resizer" onPointerDown={beginDetailResize} onPointerMove={resizeDetail} onPointerUp={endDetailResize} onPointerCancel={endDetailResize} title="拖动调整侧栏宽度" />
        <header className="detail-header">
          <nav className="detail-tabs"><button className="active">提示词助手</button></nav>
          <button className={`detail-settings ${rightTab === 'service' ? 'active' : ''}`} title="图像服务设置" onClick={() => setRightTab(rightTab === 'service' ? 'assistant' : 'service')}>⚙</button>
        </header>
        {rightTab === 'assistant' && <section className="prompt-assistant">
          <header className="assistant-title"><div><span>提示词工作台</span><h3>提示词助手</h3></div><section className="assistant-title-actions"><button onClick={() => setSkillLibraryOpen(true)}>✦ Skill 库</button><button onClick={startNewChat} disabled={!chatMessages.length}>新建对话</button><button onClick={clearCurrentChat} disabled={!chatMessages.length}>清空</button><span className="model-badge">{aiStatus?.model || '等待模型同步'}</span></section></header>
          <section className="assistant-context">
            {selectedFile ? <img src={selectedFile.dataURL} alt="当前关联图片" /> : <div className="context-placeholder">无图片</div>}
            <div><small>当前上下文</small><strong>{assistantContextTitle}</strong><span>{assistantTemplate}{assistantVersionCount ? ` · V${assistantVersionCount}` : ''}</span></div>
          </section>
          {selectedFile && !selectedWorkflowNode && <section className="assistant-reverse-controls"><label>反推模板<select value={selectedTemplateId} onChange={(event) => setSelectedTemplateId(event.target.value)} disabled={!aiStatus?.promptTemplates?.length}>{aiStatus?.promptTemplates?.length ? aiStatus.promptTemplates.map((template) => <option key={template.id} value={template.id}>{template.label}</option>) : <option value="">等待插件同步模板…</option>}</select></label><button className="assistant-reverse-action primary" onClick={runReversePrompt} disabled={reverseBusy || !aiStatus?.promptTemplates?.length}>{reverseBusy ? '正在压缩并反推…' : '反推这张图片的提示词'}</button><small>已选图片可按 Ctrl/Cmd + C，复制全尺寸原图到其他软件。</small></section>}
          {reverseError && !selectedWorkflowNode && <p className="assistant-inline-error">{reverseError}</p>}
          {canComposeGeneration && !selectedWorkflowNode && <section className="assistant-composition-panel"><header><b>组合生图</b><span>画布上下文</span></header><p>使用当前文案和产品白底图。额外参考图仅在点击“AI 修改组合提示词”时发送给当前 AI 服务，不会作为产品型号参考。</p><div className="composition-tags"><span>提示词已就绪</span><span>产品参考 ×{selectedProductReferences.length}</span>{compositionReferences.length > 0 && <span>额外参考 ×{compositionReferences.length}</span>}</div><div className="composition-reference-upload"><b>补充参考图（最多 8 张）</b><button type="button" onClick={() => compositionReferenceInput.current?.click()} disabled={compositionReferences.length >= 8}>选择图片</button><input ref={compositionReferenceInput} hidden type="file" multiple accept="image/*" onChange={(event) => { void addCompositionReferences(event.target.files); event.target.value = '' }} /></div>{compositionReferences.length > 0 && <div className="composition-reference-grid">{compositionReferences.map((image) => <figure key={image.id}><img src={image.dataURL} alt={image.name || '额外参考图'} /><input value={image.role || ''} placeholder="用途，如：场景构图" onChange={(event) => updateCompositionReference(image.id, { role: event.target.value })} /><button type="button" onClick={() => removeCompositionReference(image.id)}>删除</button></figure>)}</div>}<textarea className="composition-instruction" value={compositionInstruction} onChange={(event) => setCompositionInstruction(event.target.value)} placeholder="告诉 AI 你要参考什么，例如：借鉴图中的城市道路、双人骑行构图和暖色光线，但保留当前产品…" /><button className="composition-ai-action" onClick={modifyCompositionPrompt} disabled={compositionPromptBusy || !compositionReferences.length}>{compositionPromptBusy ? '正在结合参考图修改…' : '✦ AI 修改组合提示词'}</button>{compositionPromptError && <p className="composition-error">{compositionPromptError}</p>}{compositionPromptResult && <section className="composition-result"><label>修改后的提示词（可直接编辑）<textarea value={compositionPromptResult} onChange={(event) => setCompositionPromptResult(event.target.value)} /></label><div><button className="primary" onClick={generateModifiedComposition}>按修改后提示词组合生图</button><button onClick={() => setCompositionPromptResult('')}>恢复当前文案</button></div></section>}{!compositionPromptResult && <button className="primary" onClick={generateComposition}>按当前文案＋产品图生图</button>}</section>}
          <section className="assistant-generation-panel">
            <header><b>生图验证</b><span>参数与当前节点同步</span></header>
            <div><label>比例<select value={assistantGenerationNode?.generationAspect || GENERATION_DEFAULTS.generationAspect} disabled={!assistantGenerationNode} onChange={(event) => updateWorkflowNode(assistantGenerationNode.id, { generationAspect: event.target.value })}>{GENERATION_ASPECTS.map((value) => <option key={value}>{value}</option>)}</select></label><label>清晰度<select value={assistantGenerationNode?.generationQuality || GENERATION_DEFAULTS.generationQuality} disabled={!assistantGenerationNode} onChange={(event) => updateWorkflowNode(assistantGenerationNode.id, { generationQuality: event.target.value })}>{['2K','1K','4K'].map((value) => <option key={value}>{value}</option>)}</select></label><label>张数<select value={assistantGenerationNode?.generationCount || GENERATION_DEFAULTS.generationCount} disabled={!assistantGenerationNode} onChange={(event) => updateWorkflowNode(assistantGenerationNode.id, { generationCount: Number(event.target.value) })}>{[1,2,3,4].map((value) => <option key={value} value={value}>{value} 张</option>)}</select></label></div>
            <label className="assistant-consistency-toggle"><input type="checkbox" checked={assistantGenerationNode?.productConsistency !== false} disabled={!assistantGenerationNode} onChange={(event) => updateWorkflowNode(assistantGenerationNode.id, { productConsistency: event.target.checked })} />保持产品一致（{selectedFile ? '当前选中图片将作为产品参考' : '使用关联原图'}）</label>
             {assistantGenerationNode?.generationBusy ? <button className="node-cancel-generation" onClick={() => cancelGeneration(assistantGenerationNode)}>取消生图 · {formatGenerationDuration(Date.now() - Number(assistantGenerationNode.generationStartedAt || Date.now()))}</button> : <button className="primary" disabled={!assistantGenerationNode && !selectedFile} onClick={runAssistantGeneration}>{selectedFile ? '按当前图片生成视角预览' : '生成预览'}{assistantGenerationNode?.generationElapsedMs ? ` · 上次 ${formatGenerationDuration(assistantGenerationNode.generationElapsedMs)}` : ''}</button>}
             <small>也可以输入：16:9，2K，生成2个方案。调整已生成图片的视角请使用图片上方的“多角度”工具。</small>
          </section>
          <div className="chat-list">
            {selectedWorkflowNode && assistantContext && <article className="current-node-card"><header><b>当前节点提示词</b><span className="sync-badge">实时同步</span></header><div className="result-meta"><span>{selectedWorkflowNode.model || aiStatus?.model || '当前模型'}</span><span>{selectedWorkflowNode.templateLabel || assistantTemplate}</span><span>V{assistantVersionCount}</span></div><p>{assistantContext}</p><footer><button onClick={() => navigator.clipboard.writeText(assistantContext)}>复制当前提示词</button></footer></article>}
            {chatMessages.map((message) => <article key={message.id} className={`${message.role} ${message.role === 'assistant' && message.isPrompt ? 'prompt-card' : ''}`}><header><b>{message.role === 'user' ? '你' : message.role === 'error' ? '处理失败' : message.source === 'reverse' ? '同步反推结果' : message.isPrompt ? '助手修改版本' : message.model || '助手'}</b><time>{new Date(message.createdAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></header>{message.role === 'assistant' && message.isPrompt && <div className="result-meta"><span>{message.model || aiStatus?.model || '当前模型'}</span><span>{message.templateLabel || '助手修改版本'}</span>{message.linkedToNode && <span>已同步节点</span>}</div>}<p>{message.text}</p>{message.role === 'assistant' && message.isPrompt && <footer><button className="primary" onClick={() => applyAssistantResult(message)}>写入节点</button><button onClick={() => applyAssistantResult(message, true)}>保存新版本</button><button onClick={() => generateAssistantMessagePreview(message)} disabled={!selectedWorkflowNode && !selectedFile}>{selectedFile ? '按当前产品图生成预览' : '生成预览'}</button><button onClick={() => navigator.clipboard.writeText(message.text)}>复制</button></footer>}</article>)}
          </div>
          <footer className="assistant-composer"><div className="composer-context"><span>{selectedFile ? '图片 ×1' : '未关联图片'}</span><span>{selectedWorkflowNode ? `${assistantContextTitle} · V${assistantVersionCount}` : '未关联节点'}</span></div><div className="composer-input"><textarea value={assistantInput} onChange={(event) => setAssistantInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) sendAssistant() }} placeholder="描述你想分析、反推或修改的内容…" /><button className="send-button" title="发送（Ctrl+Enter）" onClick={sendAssistant} disabled={assistantBusy || !assistantInput.trim()}>{assistantBusy ? '…' : '➤'}</button></div></footer>
        </section>}
        {rightTab === 'service' && <section className="image-service-form"><h3>图像服务设置</h3><p>独立于插件模型配置，API Key 仅保存在本机后端。</p>{[['baseUrl','中转站地址'],['apiKey',imageService.hasApiKey ? 'API Key（留空保持原密钥）' : 'API Key'],['model','生图模型'],['generatePath','文生图路径'],['editPath','图生图路径'],['statusPath','任务查询路径（用 {taskId}）'],['cancelPath','取消任务路径（用 {taskId}）'],['defaultSize','默认尺寸']].map(([key,label]) => <label key={key}>{label}<input type={key === 'apiKey' ? 'password' : 'text'} value={imageService[key] || ''} onChange={(event) => setImageService({ ...imageService, [key]: event.target.value })} /></label>)}<section className="download-directory"><label>原图下载目录<input title={imageService.downloadDirectory || '默认：下载/PromptVault 原图'} value={imageService.downloadDirectory || '默认：下载/PromptVault 原图'} readOnly /></label><div><button disabled={directoryDialogBusy} onClick={chooseDownloadDirectory}>{directoryDialogBusy ? '正在选择…' : '选择文件夹'}</button><button disabled={directoryDialogBusy} onClick={resetDownloadDirectory}>恢复默认</button></div></section><label>接口模式<select value={imageService.mode || 'openai'} onChange={(event) => setImageService({ ...imageService, mode: event.target.value })}><option value="openai">OpenAI 兼容 / 通用 JSON</option></select></label><div className="service-actions"><button className="primary" onClick={saveImageService}>保存设置</button><button onClick={testImageService}>测试连接</button></div>{imageServiceMessage && <p className="service-message">{imageServiceMessage}</p>}</section>}
      </aside>
    </main>
    {skillLibraryOpen && <SkillLibrary skills={skills} context={skillContext} onUse={async (skill) => { setSkillLibraryOpen(false); await runSkill(skill) }} onSave={saveSkill} onDelete={deleteSkill} onExport={exportSkills} onImport={importSkills} onClose={() => setSkillLibraryOpen(false)} />}
    {projectTrainingOpen && <ProjectSkillTraining project={projects.find((item) => item.id === activeProjectId)} scene={sceneRef.current} skills={skills} onEnable={enableProjectSkillTraining} onSave={saveProjectTrainingSkill} onClose={() => setProjectTrainingOpen(false)} />}
  </div>
}
createRoot(document.getElementById('root')).render(<ErrorBoundary><App /></ErrorBoundary>)
