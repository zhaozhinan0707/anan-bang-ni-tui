param(
  [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
  [Parameter(Mandatory = $true)][string]$Notes
)

$ErrorActionPreference = 'Stop'
$systemModulePaths = @(
  (Join-Path $env:ProgramFiles 'WindowsPowerShell\Modules'),
  (Join-Path $env:WINDIR 'system32\WindowsPowerShell\v1.0\Modules')
)
$env:PSModulePath = $systemModulePaths -join [IO.Path]::PathSeparator
$appRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $appRoot
$keyRoot = Join-Path $env:USERPROFILE '.prompt-vault-updater'
$privateKey = Join-Path $keyRoot 'prompt-vault.key'
$passwordFile = Join-Path $keyRoot 'signing-password.dpapi'

if (!(Test-Path -LiteralPath $privateKey) -or !(Test-Path -LiteralPath $passwordFile)) {
  throw 'Updater signing key or password file was not found; refusing to publish an untrusted update.'
}
if (!(Get-Command gh -ErrorAction SilentlyContinue)) { throw 'GitHub CLI (gh) is not installed.' }
& gh auth status | Out-Null

$remote = (& git -C $repoRoot remote get-url origin).Trim()
if ($remote -notmatch 'github\.com[/:]([^/]+/[^/.]+)(?:\.git)?$') { throw 'origin is not a valid GitHub repository.' }
$repository = $Matches[1]

$packagePath = Join-Path $appRoot 'package.json'
$tauriPath = Join-Path $appRoot 'src-tauri\tauri.conf.json'
$cargoPath = Join-Path $appRoot 'src-tauri\Cargo.toml'
$utf8 = [System.Text.UTF8Encoding]::new($false)
$endpoint = "https://github.com/$repository/releases/latest/download/latest.json"
$versionPattern = [regex]::new('("version"\s*:\s*")[^"]+(")')
$packageRaw = [System.IO.File]::ReadAllText($packagePath, $utf8)
$packageNext = $versionPattern.Replace($packageRaw, "`${1}$Version`${2}", 1)
if ($packageNext -ne $packageRaw) { [System.IO.File]::WriteAllText($packagePath, $packageNext, $utf8) }
$tauriRaw = [System.IO.File]::ReadAllText($tauriPath, $utf8)
$tauriNext = $versionPattern.Replace($tauriRaw, "`${1}$Version`${2}", 1)
$endpointPattern = [regex]::new('("https://github\.com/[^"]+/releases/latest/download/latest\.json")')
$tauriNext = $endpointPattern.Replace($tauriNext, "`"$endpoint`"", 1)
if ($tauriNext -ne $tauriRaw) { [System.IO.File]::WriteAllText($tauriPath, $tauriNext, $utf8) }
$cargoRaw = [System.IO.File]::ReadAllText($cargoPath, $utf8)
$cargoNext = $cargoRaw -replace '(?m)^(version\s*=\s*")[^"]+("\s*)$', "`${1}$Version`${2}"
if ($cargoNext -ne $cargoRaw) { [System.IO.File]::WriteAllText($cargoPath, $cargoNext, $utf8) }

Import-Module Microsoft.PowerShell.Security -ErrorAction Stop
$secure = Get-Content -LiteralPath $passwordFile | ConvertTo-SecureString
$credential = [System.Management.Automation.PSCredential]::new('signer', $secure)
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -LiteralPath $privateKey -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $credential.GetNetworkCredential().Password
try { Push-Location $appRoot; pnpm.cmd run build } finally { Pop-Location; Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue; Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue }

$bundle = Join-Path $appRoot 'src-tauri\target\release\bundle\nsis'
$nativeInstaller = Get-ChildItem -LiteralPath $bundle -Filter '*setup.exe' | Where-Object Name -NotLike 'AnanBangNiTui_*' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (!$nativeInstaller) { throw 'Tauri Windows updater installer was not found.' }
$nativeSignature = "$($nativeInstaller.FullName).sig"
if (!(Test-Path -LiteralPath $nativeSignature)) { throw 'Updater package signature was not found.' }
$archivePath = Join-Path $bundle "AnanBangNiTui_${Version}_x64-setup.exe"
$signaturePath = "$archivePath.sig"
Copy-Item -LiteralPath $nativeInstaller.FullName -Destination $archivePath -Force
Copy-Item -LiteralPath $nativeSignature -Destination $signaturePath -Force
$archive = Get-Item -LiteralPath $archivePath
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
$previousErrorAction = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$null = & gh release view "v$Version" --repo $repository 2>$null
$releaseExists = $LASTEXITCODE -eq 0
$ErrorActionPreference = $previousErrorAction
if ($releaseExists) {
  & gh release upload "v$Version" @assets --repo $repository --clobber
  & gh release edit "v$Version" --repo $repository --title "AnanBangNiTui $Version" --notes $Notes --latest
} else {
  & gh release create "v$Version" @assets --repo $repository --title "AnanBangNiTui $Version" --notes $Notes --latest
}
Write-Host "Release published: https://github.com/$repository/releases/tag/v$Version"
