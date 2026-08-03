#Requires -Version 5.1
<#
.SYNOPSIS
Sync local code to Aliyun ECS and rebuild the gateway (no GitHub pull on server).

.DESCRIPTION
只同步代码与部署配置，不会覆盖云上 PostgreSQL / MinIO 业务数据，也不会改 /etc/citysafe/server.env。

切勿把本脚本当成「数据恢复」。会覆盖线上账号、通知、上传文件的是：
  deploy/scripts/restore-production.sh
以及任何手工清库、删 Docker 数据卷、把本地空数据整包灌进云端的操作。

.EXAMPLE
.\deploy\scripts\sync-to-cloud.ps1

.EXAMPLE
.\deploy\scripts\sync-to-cloud.ps1 -Watch
#>
[CmdletBinding()]
param(
    [string]$Server = 'citysafe-ecs',
    [string]$RemotePath = '/opt/city-safety-team-system',
    [switch]$Watch,
    [int]$DebounceSeconds = 3,
    [switch]$SkipRebuild
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$LocalTar = ''
$RemoteTar = ''
$Syncing = $false
$Pending = $false

function Write-Step {
    param([string]$Message)
    Write-Host ('[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $Message) -ForegroundColor Cyan
}

function Write-DataSafetyBanner {
    Write-Host ''
    Write-Host '============================================================' -ForegroundColor Yellow
    Write-Host '  安全提示：本脚本只更新代码，不会清空同学已产生的数据' -ForegroundColor Yellow
    Write-Host '  保留：数据库账号/通知/任务等 + MinIO 上传文件' -ForegroundColor Yellow
    Write-Host '  危险（勿与日常部署混淆）：restore-production.sh、清库、删卷' -ForegroundColor Red
    Write-Host '============================================================' -ForegroundColor Yellow
    Write-Host ''
}

function Assert-Command {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Missing command: $Name (install OpenSSH client)"
    }
}

function New-SyncArchive {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $script:LocalTar = Join-Path $env:TEMP ("citysafe-sync-$stamp.tgz")
    $script:RemoteTar = "/tmp/citysafe-sync-$stamp.tgz"
    Write-Step "Packing local code -> $LocalTar"
    Push-Location $RepoRoot
    try {
        & tar -czf $LocalTar `
            --exclude='123123/uploads' `
            --exclude='123123/logs' `
            --exclude='123123/__pycache__' `
            --exclude='123123/**/__pycache__' `
            --exclude='123123/**/*.pyc' `
            --exclude='123123/.env' `
            --exclude='123123/mlops_store.json' `
            --exclude='deploy/env/.env.local' `
            --exclude='deploy/env/.env' `
            --exclude='deploy/backups' `
            --exclude='**/node_modules' `
            --exclude='**/.git' `
            123123 deploy/compose.yaml deploy/compose.server.yaml deploy/db deploy/nginx deploy/scripts
        if ($LASTEXITCODE -ne 0) { throw "tar failed (exit $LASTEXITCODE)" }
    }
    finally {
        Pop-Location
    }
}

function Invoke-CloudSync {
    if ($Syncing) {
        $script:Pending = $true
        Write-Step 'Sync already running; will run again after it finishes'
        return
    }
    $script:Syncing = $true
    $script:Pending = $false
    try {
        Write-DataSafetyBanner
        Assert-Command scp
        Assert-Command ssh
        Assert-Command tar

        New-SyncArchive
        $sizeMb = [math]::Round((Get-Item $LocalTar).Length / 1MB, 2)
        Write-Step ("Upload {0} MB -> {1}:{2}" -f $sizeMb, $Server, $RemoteTar)
        & scp $LocalTar "${Server}:$RemoteTar"
        if ($LASTEXITCODE -ne 0) { throw "scp failed (exit $LASTEXITCODE)" }

        $remoteLines = @(
            'set -euo pipefail'
            "mkdir -p '$RemotePath'"
            "tar -xzf '$RemoteTar' -C '$RemotePath'"
            "rm -f '$RemoteTar'"
        )
        if (-not $SkipRebuild) {
            $remoteLines += @(
                "cd '$RemotePath/deploy'"
                'docker compose --env-file /etc/citysafe/server.env -f compose.yaml -f compose.server.yaml build gateway'
                'docker compose --env-file /etc/citysafe/server.env -f compose.yaml -f compose.server.yaml up -d --no-deps --force-recreate gateway'
                'docker compose --env-file /etc/citysafe/server.env -f compose.yaml -f compose.server.yaml ps gateway'
            )
        }

        Write-Step "Extract on server and rebuild gateway..."
        $remoteCmd = ($remoteLines -join '; ')
        & ssh $Server $remoteCmd
        if ($LASTEXITCODE -ne 0) { throw "remote deploy failed (exit $LASTEXITCODE)" }
        Write-Step "Cloud code updated (business data untouched). Hard-refresh browser (Ctrl+F5)."
    }
    finally {
        if ($LocalTar -and (Test-Path -LiteralPath $LocalTar)) {
            Remove-Item -LiteralPath $LocalTar -Force -ErrorAction SilentlyContinue
        }
        $script:Syncing = $false
        if ($script:Pending) {
            $script:Pending = $false
            Write-Step 'Running queued sync'
            Invoke-CloudSync
        }
    }
}

function Start-CloudWatch {
    Write-Step ("Watch mode on: save under {0}\123123 or deploy to auto-upload (debounce {1}s)" -f $RepoRoot, $DebounceSeconds)
    Write-Host 'Press Ctrl+C to stop.' -ForegroundColor Yellow

    $global:CitySafeSyncDirtyAt = 0L
    $watchers = @()
    $subscribers = @()

    foreach ($rel in @('123123', 'deploy')) {
        $path = Join-Path $RepoRoot $rel
        if (-not (Test-Path $path)) { continue }
        $w = New-Object System.IO.FileSystemWatcher $path
        $w.IncludeSubdirectories = $true
        $w.EnableRaisingEvents = $true
        $w.NotifyFilter = [IO.NotifyFilters]'FileName, LastWrite, DirectoryName, Size'
        foreach ($evt in 'Changed', 'Created', 'Deleted', 'Renamed') {
            $subscribers += Register-ObjectEvent -InputObject $w -EventName $evt -Action {
                $name = [string]$Event.SourceEventArgs.Name
                if ($name -match '(^|[\\/])(uploads|logs|__pycache__|\.git|node_modules)([\\/]|$)') { return }
                if ($name -match '\.(pyc|log|tmp|swp)$') { return }
                if ($name -match '(^|[\\/])\.env(\.local)?$') { return }
                $global:CitySafeSyncDirtyAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            }
        }
        $watchers += $w
    }

    Invoke-CloudSync

    $debounceMs = [Math]::Max(1, $DebounceSeconds) * 1000
    try {
        while ($true) {
            Start-Sleep -Milliseconds 500
            $dirtyAt = [int64]$global:CitySafeSyncDirtyAt
            if ($dirtyAt -le 0) { continue }
            $age = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $dirtyAt
            if ($age -lt $debounceMs) { continue }
            $global:CitySafeSyncDirtyAt = 0L
            try {
                Invoke-CloudSync
            }
            catch {
                Write-Host $_.Exception.Message -ForegroundColor Red
            }
        }
    }
    finally {
        foreach ($sub in $subscribers) {
            Unregister-Event -SubscriptionId $sub.Id -Force -ErrorAction SilentlyContinue
        }
        foreach ($w in $watchers) {
            $w.EnableRaisingEvents = $false
            $w.Dispose()
        }
        $global:CitySafeSyncDirtyAt = 0L
    }
}

if ($Watch) {
    Start-CloudWatch
}
else {
    Invoke-CloudSync
}
