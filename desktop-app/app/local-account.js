const ACCOUNTS_KEY = 'promptVault.localAccounts.v1'
const EVENTS_KEY = 'promptVault.localGenerationEvents.v1'
const SESSION_KEY = 'promptVault.localAccountSession.v1'

const read = (key, fallback) => {
  try { const value = JSON.parse(localStorage.getItem(key)); return Array.isArray(value) ? value : fallback } catch { return fallback }
}
const persistEvents = (all) => {
  const unsynced = all.filter((event) => event.sharedSyncedRevision !== event.revision)
  const recentSynced = all.filter((event) => event.sharedSyncedRevision === event.revision).slice(-5000)
  localStorage.setItem(EVENTS_KEY, JSON.stringify([...unsynced, ...recentSynced].sort((a, b) => a.createdAt - b.createdAt)))
}

export const listLocalAccounts = () => read(ACCOUNTS_KEY, [])
export const currentLocalAccount = () => {
  const id = localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY)
  const account = listLocalAccounts().find((item) => item.id === id) || null
  if (account && localStorage.getItem(SESSION_KEY) !== id) localStorage.setItem(SESSION_KEY, id)
  return account
}

const hashPassword = async (password, salt) => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const hash = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: Uint8Array.from(salt), iterations: 150000, hash: 'SHA-256' }, key, 256)
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export const createLocalAccount = async (name, password) => {
  const normalized = name.trim()
  if (normalized.length < 2 || normalized.length > 32) throw new Error('账号名称需要 2–32 个字')
  if (password.length < 8) throw new Error('密码至少需要 8 位')
  const accounts = listLocalAccounts()
  if (accounts.some((account) => account.name.toLocaleLowerCase() === normalized.toLocaleLowerCase())) throw new Error('账号名称已存在')
  const salt = Array.from(crypto.getRandomValues(new Uint8Array(16)))
  const account = { id: crypto.randomUUID(), name: normalized, salt, passwordHash: await hashPassword(password, salt), createdAt: Date.now() }
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify([...accounts, account]))
  localStorage.setItem(SESSION_KEY, account.id)
  sessionStorage.removeItem(SESSION_KEY)
  return account
}

export const loginLocalAccount = async (id, password) => {
  const account = listLocalAccounts().find((item) => item.id === id)
  if (!account || (await hashPassword(password, account.salt)) !== account.passwordHash) throw new Error('账号或密码不正确')
  localStorage.setItem(SESSION_KEY, account.id)
  sessionStorage.removeItem(SESSION_KEY)
  return account
}

export const logoutLocalAccount = () => {
  localStorage.removeItem(SESSION_KEY)
  sessionStorage.removeItem(SESSION_KEY)
}

export const localGenerationEvents = (accountId) => read(EVENTS_KEY, []).filter((event) => event.accountId === accountId)
export const pendingSharedGenerationEvents = () => {
  const all = read(EVENTS_KEY, [])
  const names = new Map(listLocalAccounts().map((account) => [account.id, account.name]))
  let changed = false
  for (const event of all) {
    if (!event.revision) { event.revision = 1; changed = true }
    if (!event.accountName) { event.accountName = names.get(event.accountId) || '未命名账号'; changed = true }
  }
  if (changed) persistEvents(all)
  return all.filter((event) => event.sharedSyncedRevision !== event.revision)
}
export const markSharedGenerationEventsSynced = (acknowledged) => {
  const revisions = new Map(acknowledged.map((item) => [item.id, item.revision]))
  if (!revisions.size) return
  const all = read(EVENTS_KEY, [])
  for (const event of all) if (revisions.get(event.id) === event.revision) event.sharedSyncedRevision = event.revision
  persistEvents(all)
}

export const saveLocalGenerationEvent = (event) => {
  const all = read(EVENTS_KEY, [])
  const index = all.findIndex((item) => item.id === event.id)
  const previous = index === -1 ? null : all[index]
  const next = { ...previous, ...event, revision: (previous?.revision || 0) + 1 }
  if (index === -1) all.push(next)
  else all[index] = next
  persistEvents(all)
  window.dispatchEvent(new Event('prompt-vault-local-generation-event'))
}
