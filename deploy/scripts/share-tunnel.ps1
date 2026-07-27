<#
.SYNOPSIS
  用 Cloudflare 临时隧道把本机 Docker（127.0.0.1:8080）暴露成公网 HTTPS 链接，
  方便外地同事访问并共用同一套数据。

.EXAMPLE
  .\deploy\scripts\share-tunnel.ps1

.NOTES
  - 电脑必须保持开机、Docker 栈保持运行、本脚本窗口不要关
  - 每次启动临时隧道地址可能变化，需要把新地址重新发给同事
  - 仅适合演示/内测，正式长期使用请部署到云服务器
#>
[CmdletBinding()]
param(
    [string]$EnvFile = '',
    [int]$WaitSeconds = 90
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$deployDir = [System.IO.Path]::GetFullPath((Join-Path $scriptDir '..'))
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $deployDir '..'))
$stackScript = Join-Path $scriptDir 'stack.ps1'
$logFile = Join-Path $env:TEMP ('citysafe-cloudflared-' + [guid]::NewGuid().ToString('n').Substring(0, 8) + '.log')

if ([string]::IsNullOrWhiteSpace($EnvFile)) {
    $EnvFile = Join-Path $deployDir 'env\.env.local'
}

function Ensure-Cloudflared {
    $portable = Join-Path $deployDir 'bin\cloudflared.exe'
    if (Test-Path -LiteralPath $portable) {
        return $portable
    }

    $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    Write-Host '未检测到 cloudflared，正在下载便携版到 deploy\bin …'
    $binDir = Join-Path $deployDir 'bin'
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    $url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
    try {
        Invoke-WebRequest -Uri $url -OutFile $portable -UseBasicParsing
    } catch {
        throw ("下载 cloudflared 失败：$($_.Exception.Message)。也可手动放到：$portable")
    }
    if (-not (Test-Path -LiteralPath $portable)) {
        throw "cloudflared 下载失败：$portable"
    }
    return $portable
}

function Set-EnvLine {
    param(
        [Parameter(Mandatory = $true)][string]$Content,
        [Parameter(Mandatory = $true)][string]$Key,
        [Parameter(Mandatory = $true)][string]$Value
    )
    $pattern = '(?m)^' + [regex]::Escape($Key) + '=.*$'
    $line = $Key + '=' + $Value
    if ([regex]::IsMatch($Content, $pattern)) {
        return [regex]::Replace($Content, $pattern, $line)
    }
    return $Content.TrimEnd() + "`r`n$line`r`n"
}

function Update-PublicOrigin {
    param([Parameter(Mandatory = $true)][string]$PublicOrigin)

    if (-not (Test-Path -LiteralPath $EnvFile)) {
        throw "找不到环境文件：$EnvFile 。请先运行 .\deploy\scripts\stack.ps1"
    }
    $content = [System.IO.File]::ReadAllText($EnvFile)
    $origins = @(
        'http://127.0.0.1:8080',
        'http://localhost:8080',
        $PublicOrigin
    ) -join ','

    $content = Set-EnvLine -Content $content -Key 'PUBLIC_ORIGIN' -Value $PublicOrigin
    $content = Set-EnvLine -Content $content -Key 'CORS_ALLOW_ORIGINS' -Value $origins
    $content = Set-EnvLine -Content $content -Key 'MINIO_PUBLIC_UPLOAD_PREFIX' -Value ($PublicOrigin.TrimEnd('/') + '/minio-upload')

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($EnvFile, $content, $utf8NoBom)
}

function Wait-LocalStack {
    $deadline = (Get-Date).AddSeconds(45)
    do {
        try {
            $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8080/api/health' -UseBasicParsing -TimeoutSec 3
            if ($r.StatusCode -eq 200) { return }
        } catch {}
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
    throw '本机 http://127.0.0.1:8080 未就绪。请先执行：.\deploy\scripts\stack.ps1 -Action up'
}

function Restart-EdgeGateway {
    Push-Location $repoRoot
    try {
        & $stackScript -Action up -EnvFile $EnvFile | Out-Host
    } finally {
        Pop-Location
    }
}

Write-Host '=== CitySafe 本机公网分享（Cloudflare 临时隧道）==='
Write-Host '1) 确保本机 Docker 栈已启动…'
Wait-LocalStack
Write-Host '   本机入口正常：http://127.0.0.1:8080'

$cloudflared = Ensure-Cloudflared
Write-Host "2) 使用 cloudflared：$cloudflared"
Write-Host "3) 启动临时隧道，日志：$logFile"

# Windows 不允许 stdout/stderr 重定向到同一文件
$logOut = $logFile + '.out'
$logErr = $logFile + '.err'
foreach ($f in @($logFile, $logOut, $logErr)) {
    if (Test-Path $f) { Remove-Item -LiteralPath $f -Force }
}
$proc = Start-Process -FilePath $cloudflared `
    -ArgumentList @('tunnel', '--url', 'http://127.0.0.1:8080', '--no-autoupdate') `
    -RedirectStandardOutput $logOut `
    -RedirectStandardError $logErr `
    -PassThru `
    -WindowStyle Hidden

function Get-TunnelLogText {
    $parts = @()
    foreach ($f in @($logOut, $logErr)) {
        if (Test-Path -LiteralPath $f) {
            $parts += (Get-Content -LiteralPath $f -Raw -ErrorAction SilentlyContinue)
        }
    }
    return ($parts -join "`n")
}

$publicUrl = $null
$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    $text = Get-TunnelLogText
    if ([string]::IsNullOrWhiteSpace($text)) { continue }
    $m = [regex]::Match($text, 'https://[a-zA-Z0-9-]+\.trycloudflare\.com')
    if ($m.Success) {
        $publicUrl = $m.Value.TrimEnd('/')
        break
    }
    if ($proc.HasExited) {
        $text | Set-Content -LiteralPath $logFile -Encoding utf8
        throw "cloudflared 已退出。请查看日志：$logFile"
    }
}

if (-not $publicUrl) {
    try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
    throw "等待隧道地址超时。请查看日志：$logFile"
}

Write-Host "4) 隧道已就绪：$publicUrl"
Write-Host '5) 更新 PUBLIC_ORIGIN / CORS 并重启网关与入口…'
Update-PublicOrigin -PublicOrigin $publicUrl
Restart-EdgeGateway
Wait-LocalStack

Write-Host ''
Write-Host '========================================'
Write-Host "发给同事的地址：$publicUrl"
Write-Host '账号：用你本机 Docker 里的账号（如 admin）'
Write-Host '注意：'
Write-Host '  - 本窗口/进程不要关；电脑睡眠或断网后链接失效'
Write-Host '  - 每次重新运行脚本，公网地址可能变化'
Write-Host '  - 正式长期使用请部署到云服务器'
Write-Host "  - 停止分享：关闭本脚本对应的 cloudflared（pid=$($proc.Id)）"
Write-Host '========================================'
Write-Host ''
Write-Host '按 Ctrl+C 结束分享（将停止隧道进程）。'

try {
    Wait-Process -Id $proc.Id
} finally {
    if (-not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }
    Write-Host '隧道已停止。本机仍可通过 http://127.0.0.1:8080 访问。'
}
