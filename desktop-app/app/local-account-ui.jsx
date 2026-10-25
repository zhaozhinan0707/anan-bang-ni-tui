import React, { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { createLocalAccount, listLocalAccounts, localGenerationEvents, loginLocalAccount } from './local-account.js'
import './local-account.css'

export function LocalAccountGate({ onLogin }) {
  const [accounts, setAccounts] = useState(listLocalAccounts)
  const [creating, setCreating] = useState(accounts.length === 0)
  const [accountId, setAccountId] = useState(accounts[0]?.id || '')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (event) => {
    event.preventDefault()
    if (creating && password !== confirm) { setError('两次输入的密码不一致'); return }
    setBusy(true); setError('')
    try {
      const account = creating ? await createLocalAccount(name, password) : await loginLocalAccount(accountId, password)
      setAccounts(listLocalAccounts())
      onLogin(account)
    } catch (reason) { setError(reason?.message || '登录失败') }
    finally { setBusy(false) }
  }
  return <div className="local-account-screen">
    <section className="local-account-card" aria-labelledby="localAccountTitle">
      <img className="local-account-logo" src="/canvas-logo.svg" alt="" />
      <small>阿男帮你推 · 灵感画布</small>
      <h1 id="localAccountTitle">{creating ? '创建本机账号' : '登录画布'}</h1>
      <p>登录一次后，这台电脑会记住你的账号；注销后才需要重新登录。生图记录可在设置中查看。</p>
      <form onSubmit={submit}>
        {creating ? <label>账号名称<input autoFocus autoComplete="username" value={name} maxLength={32} onChange={(event) => setName(event.target.value)} placeholder="输入你的名称" /></label> : <label>选择账号<select value={accountId} onChange={(event) => setAccountId(event.target.value)}>{accounts.map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></label>}
        <label>密码<input type="password" autoComplete={creating ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={creating ? '至少 8 位' : '输入密码'} /></label>
        {creating && <label>确认密码<input type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} placeholder="再次输入密码" /></label>}
        {error && <p className="local-account-error" role="alert">{error}</p>}
        <button className="local-account-primary" disabled={busy || (creating ? !name.trim() || !password || !confirm : !accountId || !password)}>{busy ? '请稍候…' : creating ? '创建并进入画布' : '登录画布'}</button>
      </form>
      {accounts.length > 0 && <button className="local-account-switch" onClick={() => { setCreating(!creating); setPassword(''); setConfirm(''); setError('') }}>{creating ? '返回登录' : '在这台电脑新建账号'}</button>}
      <small className="local-account-note">本机账号用于区分个人记录。连接共享盘后，团队统计会同步到共享盘。</small>
    </section>
  </div>
}

const dayKey = (value) => new Date(value).toLocaleDateString('zh-CN')

export function PersonalStats({ account, onSwitchAccount, onLogout }) {
  const [events, setEvents] = useState(() => localGenerationEvents(account.id))
  const [switchOpen, setSwitchOpen] = useState(false)
  const [switchAccountId, setSwitchAccountId] = useState('')
  const [switchPassword, setSwitchPassword] = useState('')
  const [switchError, setSwitchError] = useState('')
  const [sharedReport, setSharedReport] = useState(null)
  const [sharedError, setSharedError] = useState('')
  const [sharedPeriod, setSharedPeriod] = useState('daily')
  const refreshShared = async () => {
    try { setSharedReport(await invoke('get_shared_usage_report')); setSharedError('') }
    catch (error) { setSharedReport(null); setSharedError(String(error)) }
  }
  useEffect(() => {
    const refresh = () => setEvents(localGenerationEvents(account.id))
    refresh()
    window.addEventListener('prompt-vault-local-generation-event', refresh)
    return () => window.removeEventListener('prompt-vault-local-generation-event', refresh)
  }, [account.id])
  const otherAccounts = listLocalAccounts().filter((item) => item.id !== account.id)
  const switchAccount = async (event) => {
    event.preventDefault()
    setSwitchError('')
    try {
      const next = await loginLocalAccount(switchAccountId, switchPassword)
      setSwitchOpen(false)
      setSwitchPassword('')
      onSwitchAccount(next)
    } catch (error) { setSwitchError(error?.message || '切换账号失败') }
  }
  useEffect(() => {
    if (!window.__TAURI__) return undefined
    void refreshShared()
    window.addEventListener('prompt-vault-shared-usage-updated', refreshShared)
    return () => window.removeEventListener('prompt-vault-shared-usage-updated', refreshShared)
  }, [])
  const summary = useMemo(() => {
    const today = dayKey(Date.now())
    const month = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit' })
    return {
      attempts: events.length,
      success: events.filter((item) => item.status === 'success').length,
      failed: events.filter((item) => item.status === 'failed').length,
      unknown: events.filter((item) => item.status === 'unknown').length,
      today: events.filter((item) => dayKey(item.createdAt) === today).length,
      month: events.filter((item) => new Date(item.createdAt).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit' }) === month).length,
    }
  }, [events])
  return <section className="local-stats-panel" aria-labelledby="localStatsTitle">
    <header><div><small>本机个人统计</small><h2 id="localStatsTitle">{account.name} 的生图记录</h2></div><div className="local-stats-account-actions"><button type="button" onClick={() => { setSwitchOpen((value) => !value); setSwitchAccountId(otherAccounts[0]?.id || ''); setSwitchError('') }}>切换账号</button><button type="button" onClick={onLogout}>注销账号</button></div></header>
    {switchOpen && <form className="local-stats-switch" onSubmit={switchAccount}>{otherAccounts.length ? <><label>切换到<select value={switchAccountId} onChange={(event) => setSwitchAccountId(event.target.value)}>{otherAccounts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>账号密码<input type="password" autoComplete="current-password" value={switchPassword} onChange={(event) => setSwitchPassword(event.target.value)} /></label><button type="submit" disabled={!switchAccountId || !switchPassword}>确认切换</button></> : <p>这台电脑还没有其他账号。注销后可以在登录页创建新账号。</p>}{switchError && <small role="alert">{switchError}</small>}</form>}
    <p className="local-stats-hint">从启用本机账号后开始记录；已同步记录在本机保留最近 5000 次，断线待补传记录会继续暂存。次数是客户端请求记录，不等于接口实际计费。</p>
    <div className="local-stats-grid"><span><b>{summary.attempts}</b><small>请求次数</small></span><span><b>{summary.success}</b><small>成功图片</small></span><span><b>{summary.failed}</b><small>失败请求</small></span><span><b>{summary.unknown}</b><small>待核查</small></span><span><b>{summary.today}</b><small>今日请求</small></span><span><b>{summary.month}</b><small>本月请求</small></span></div>
    <h3>最近记录</h3>
    <div className="local-stats-list">{events.length ? [...events].reverse().slice(0, 50).map((item) => <article key={item.id}><span><b>{item.status === 'success' ? '已完成' : item.status === 'failed' ? '失败' : item.status === 'unknown' ? '待核查' : '进行中'}</b><small>{new Date(item.createdAt).toLocaleString('zh-CN')}</small></span><span>{item.model || '生图模型'} · {item.quality || '—'} · {item.aspect || '—'}</span><small>{item.projectName || '画布项目'}</small></article>) : <p>还没有生图记录。生成图片后会显示在这里。</p>}</div>
    <div className="local-shared-heading"><h3>共享盘团队排行</h3><div><button className={sharedPeriod === 'daily' ? 'active' : ''} onClick={() => setSharedPeriod('daily')}>今日</button><button className={sharedPeriod === 'monthly' ? 'active' : ''} onClick={() => setSharedPeriod('monthly')}>本月</button><button onClick={refreshShared}>刷新</button></div></div>
    {sharedError ? <p className="local-shared-error">{sharedError}。请先在提示词收藏夹连接共享盘。</p> : sharedReport && <><p className="local-stats-hint">{sharedPeriod === 'daily' ? sharedReport.day : sharedReport.month} · 按成功张数排序。共享盘报表：{sharedPeriod === 'daily' ? sharedReport.dailyCsv : sharedReport.monthlyCsv}</p><div className="local-shared-table"><table><thead><tr><th>账号</th><th>请求</th><th>成功</th><th>失败</th><th>待核查</th></tr></thead><tbody>{sharedReport[sharedPeriod]?.length ? sharedReport[sharedPeriod].map((row) => <tr key={`${row.clientId}:${row.accountId}`}><td>{row.accountName}<small title={row.clientId}>设备 {row.clientId.slice(0, 8)}</small></td><td>{row.attempts}</td><td>{row.success}</td><td>{row.failed}</td><td>{row.unknown || 0}</td></tr>) : <tr><td colSpan="5">共享盘当前没有生图记录</td></tr>}</tbody></table></div></>}
  </section>
}
