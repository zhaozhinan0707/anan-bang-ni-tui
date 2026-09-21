param(
  [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
  [Parameter(Mandatory = $true)][string]$Notes
)

$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $appRoot
$keyRoot = Join-Path $env:USERPROFILE '.prompt-vault-updater'
$privateKey = Join-Path $keyRoot 'prompt-vault.key'
$passwordFile = Join-Path $keyRoot 'signing-password.dpapi'

if (!(Test-Path -LiteralPath $privateKey) -or !(Test-Path -LiteralPath $passwordFile)) {
  throw '未找到本机更新签名密钥，不能发布不受信任的更新。'
}
if (!(Get-Command gh -ErrorAction SilentlyContinue)) { throw '未安装 GitHub CLI（gh）。' }
& gh auth status | Out-Null

$remote = (& git -C $repoRoot remote get-url origin).Trim()
if ($remote -notmatch 'github\.com[/:]([^/]+/[^/.]+)(?:\.git)?$') { throw 'origin 不是有效的 GitHub 仓库。' }
$repository = $Matches[1]

$packagePath = Join-Path $appRoot 'package.json'
$tauriPath = Join-Path $appRoot 'src-tauri\tauri.conf.json'
$cargoPath = Join-Path $appRoot 'src-tauri\Cargo.toml'
$package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
$package.version = $Version
$package | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $packagePath -Encoding utf8
$tauri = Get-Content -LiteralPath $tauriPath -Raw | ConvertFrom-Json
$tauri.version = $Version
$tauri.plugins.updater.endpoints = @("https://github.com/$repository/releases/latest/download/latest.json")
$tauri | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $tauriPath -Encoding utf8
$cargo = Get-Content -LiteralPath $cargoPath -Raw
$cargo = $cargo -replace '(?m)^(version\s*=\s*")[^"]+("\s*)$', "`${1}$Version`${2}"
Set-Content -LiteralPath $cargoPath -Value $cargo -Encoding utf8

$secure = Get-Content -LiteralPath $passwordFile | ConvertTo-SecureString
$credential = [System.Management.Automation.PSCredential]::new('signer', $secure)
$env:TAURI_SIGNING_PRIVATE_KEY_PATH = $privateKey
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $credential.GetNetworkCredential().Password
try { Push-Location $appRoot; pnpm.cmd run build } finally { Pop-Location; Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue }

$bundle = Join-Path $appRoot 'src-tauri\target\release\bundle\nsis'
$archive = Get-ChildItem -LiteralPath $bundle -Filter '*.nsis.zip' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (!$archive) { throw '未找到 Tauri 更新包。' }
$signaturePath = "$($archive.FullName).sig"
if (!(Test-Path -LiteralPath $signaturePath)) { throw '未找到更新包签名。' }
$installer = Get-ChildItem -LiteralPath $bundle -Filter '*setup.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$manifestPath = Join-Path $bundle 'latest.json'
$manifest = [ordered]@{
  version = $Version
  notes = $Notes
  pub_date = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
  platforms = [ordered]@{
    'windows-x86_64' = [ordered]@{
      signature = (Get-Content -LiteralPath $signaturePath -Raw).Trim()
      url = "https://github.com/$repository/releases/download/v$Version/$($archive.Name)"
    }
  }
}
$manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $manifestPath -Encoding utf8

$assets = @($archive.FullName, $signaturePath, $manifestPath)
if ($installer) { $assets += $installer.FullName }
& gh release create "v$Version" @assets --repo $repository --title "Prompt Vault $Version" --notes $Notes --latest
Write-Host "发布完成：https://github.com/$repository/releases/tag/v$Version"
