<#
.SYNOPSIS
  Create a CitySafe formatVersion-2 backup from the Windows local Compose stack.

.DESCRIPTION
  Mirrors deploy/scripts/backup.sh for citysafe-local:
  stop gateway -> pg_dump -> stop minio -> archive volumes -> package.
  Does not copy deploy/env/.env.local into the archive.
#>
[CmdletBinding()]
param(
    [string]$EnvFile = '',
    [string]$BackupRoot = '',
    [int]$QuiesceTimeoutSeconds = 60,
    [int]$HealthTimeoutSeconds = 180
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$deployDir = [System.IO.Path]::GetFullPath((Join-Path $scriptDir '..'))
$baseCompose = Join-Path $deployDir 'compose.yaml'
$localCompose = Join-Path $deployDir 'compose.local.yaml'

if ([string]::IsNullOrWhiteSpace($EnvFile)) {
    $EnvFile = Join-Path $deployDir 'env\.env.local'
}
if ([string]::IsNullOrWhiteSpace($BackupRoot)) {
    $BackupRoot = Join-Path $deployDir 'backups'
}

foreach ($path in @($baseCompose, $localCompose, $EnvFile)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required file is missing: $path"
    }
}

New-Item -ItemType Directory -Force -Path $BackupRoot | Out-Null
$BackupRoot = [System.IO.Path]::GetFullPath($BackupRoot)

function Write-Log {
    param([string]$Message)
    $ts = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
    Write-Host "[$ts] $Message"
}

function Invoke-Compose {
    param([Parameter(Mandatory = $true)][string[]]$ComposeArgs)
    $dockerArgs = @(
        'compose',
        '--env-file', $EnvFile,
        '-f', $baseCompose,
        '-f', $localCompose
    ) + $ComposeArgs
    & docker @dockerArgs
    if ($LASTEXITCODE -ne 0) {
        throw "docker compose failed: $($ComposeArgs -join ' ')"
    }
}

function Get-RunningServiceId {
    param([string]$Service)
    $cid = (& docker @(
        'compose', '--env-file', $EnvFile, '-f', $baseCompose, '-f', $localCompose,
        'ps', '--status', 'running', '-q', $Service
    ) | Select-Object -First 1)
    if ([string]::IsNullOrWhiteSpace($cid)) {
        throw "Compose service is not running: $Service"
    }
    return $cid.Trim()
}

function Get-MountVolumeName {
    param([string]$ContainerId, [string]$Destination)
    # Only request Mounts JSON — full inspect can contain non-UTF8 env values that
    # break ConvertFrom-Json on Windows PowerShell.
    $mountsJson = & docker inspect --format '{{json .Mounts}}' $ContainerId
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($mountsJson)) {
        throw "docker inspect Mounts failed for $ContainerId"
    }
    $mounts = $mountsJson | ConvertFrom-Json
    $mount = @($mounts) | Where-Object { $_.Destination -eq $Destination } | Select-Object -First 1
    $volume = if ($null -ne $mount) { [string]$mount.Name } else { '' }
    if ([string]::IsNullOrWhiteSpace($volume) -or $volume -notmatch '^[A-Za-z0-9_.-]+$') {
        throw "Could not resolve named volume for $Destination"
    }
    return $volume.Trim()
}

function Wait-ServiceHealthy {
    param([string]$Service)
    $deadline = [DateTime]::UtcNow.AddSeconds($HealthTimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $cid = (& docker @(
            'compose', '--env-file', $EnvFile, '-f', $baseCompose, '-f', $localCompose,
            'ps', '-q', $Service
        ) | Select-Object -First 1)
        if (-not [string]::IsNullOrWhiteSpace($cid)) {
            $status = (& docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' $cid.Trim())
            if ($status -eq 'healthy' -or $status -eq 'running') { return }
            if ($status -in @('unhealthy', 'exited', 'dead')) {
                throw "Service $Service entered state $status"
            }
        }
        Start-Sleep -Seconds 2
    }
    throw "Timed out waiting for $Service"
}

function Archive-Volume {
    param(
        [string]$LogicalName,
        [string]$VolumeName,
        [string]$OutputPath,
        [string]$ArchiverImage
    )
    Write-Log "archiving $LogicalName volume"
    $outDir = Split-Path -Parent $OutputPath
    $outName = Split-Path -Leaf $OutputPath
    # Write gzip inside the container so PowerShell never touches the binary stream.
    & docker run --rm --network none --entrypoint sh `
        --mount "type=volume,src=$VolumeName,dst=/source,readonly" `
        --mount "type=bind,src=$outDir,dst=/out" `
        $ArchiverImage `
        -ceu "tar -C /source -czf /out/$outName ."
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to archive volume $LogicalName"
    }
    if (-not (Test-Path -LiteralPath $OutputPath) -or (Get-Item -LiteralPath $OutputPath).Length -le 0) {
        throw "Volume archive is empty: $LogicalName"
    }
}

docker compose version | Out-Null
Invoke-Compose -ComposeArgs @('config', '--quiet')

$dbCid = Get-RunningServiceId 'db'
$gatewayCid = Get-RunningServiceId 'gateway'
$minioCid = Get-RunningServiceId 'minio'
Wait-ServiceHealthy 'db'
Wait-ServiceHealthy 'gateway'
Wait-ServiceHealthy 'minio'

$minioVolume = Get-MountVolumeName $minioCid '/data'
$stateVolume = Get-MountVolumeName $gatewayCid '/data'
$uploadsVolume = Get-MountVolumeName $gatewayCid '/data/uploads'
$logsVolume = Get-MountVolumeName $gatewayCid '/data/logs'
$archiverImage = (& docker inspect --format '{{.Config.Image}}' $dbCid).Trim()

$createdAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
$backupId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '_' + `
    ([Guid]::NewGuid().ToString('N').Substring(0, 8))
$work = Join-Path $BackupRoot ('.citysafe-backup-' + $backupId)
$payload = Join-Path $work ("citysafe-backup-" + $backupId)
New-Item -ItemType Directory -Force -Path (Join-Path $payload 'postgres') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $payload 'volumes') | Out-Null

$gatewayStopped = $false
$minioStopped = $false

function Resume-Services {
    if ($minioStopped) {
        Write-Log 'restarting MinIO'
        Invoke-Compose -ComposeArgs @('start', 'minio')
        Wait-ServiceHealthy 'minio'
        $script:minioStopped = $false
    }
    if ($gatewayStopped) {
        Write-Log 'restarting gateway'
        Invoke-Compose -ComposeArgs @('start', 'gateway')
        Wait-ServiceHealthy 'gateway'
        $script:gatewayStopped = $false
    }
}

try {
    Write-Log 'quiescing gateway before the coordinated backup'
    Invoke-Compose -ComposeArgs @('stop', '--timeout', "$QuiesceTimeoutSeconds", 'gateway')
    $gatewayStopped = $true

    Write-Log 'creating transaction-consistent PostgreSQL dump'
    $dumpPath = Join-Path $payload 'postgres\database.dump'
    # Native stdout redirect via cmd avoids PowerShell mangling the custom dump.
    $composeCmd = @(
        'docker compose',
        '--env-file', ('"' + $EnvFile + '"'),
        '-f', ('"' + $baseCompose + '"'),
        '-f', ('"' + $localCompose + '"'),
        'exec -T db sh -ceu',
        '"exec pg_dump --format=custom --compress=6 --no-owner --no-privileges --username=\"${POSTGRES_USER}\" --dbname=\"${POSTGRES_DB}\""',
        '>',
        ('"' + $dumpPath + '"')
    ) -join ' '
    cmd.exe /c $composeCmd
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $dumpPath) -or (Get-Item -LiteralPath $dumpPath).Length -le 0) {
        throw 'PostgreSQL dump is empty or failed'
    }

    Write-Log 'stopping MinIO before its volume snapshot'
    Invoke-Compose -ComposeArgs @('stop', '--timeout', "$QuiesceTimeoutSeconds", 'minio')
    $minioStopped = $true

    Archive-Volume -LogicalName 'minio' -VolumeName $minioVolume `
        -OutputPath (Join-Path $payload 'volumes\minio.tar.gz') -ArchiverImage $archiverImage
    Archive-Volume -LogicalName 'state' -VolumeName $stateVolume `
        -OutputPath (Join-Path $payload 'volumes\state.tar.gz') -ArchiverImage $archiverImage
    Archive-Volume -LogicalName 'uploads' -VolumeName $uploadsVolume `
        -OutputPath (Join-Path $payload 'volumes\uploads.tar.gz') -ArchiverImage $archiverImage
    Archive-Volume -LogicalName 'logs' -VolumeName $logsVolume `
        -OutputPath (Join-Path $payload 'volumes\logs.tar.gz') -ArchiverImage $archiverImage

    Resume-Services

    $manifest = @"
{
  "formatVersion": 2,
  "backupId": "$backupId",
  "createdAtUtc": "$createdAt",
  "database": {
    "format": "postgres-custom",
    "consistentSnapshot": true
  },
  "volumes": ["minio", "state", "uploads", "logs"],
  "environmentFileIncluded": false,
  "encryptionKeyFileIncluded": false
}
"@
    [System.IO.File]::WriteAllText(
        (Join-Path $payload 'manifest.json'),
        $manifest,
        [System.Text.UTF8Encoding]::new($false)
    )

    # Build SHA256SUMS with paths relative to payload (POSIX-style for Linux restore).
    $sums = New-Object System.Collections.Generic.List[string]
    $relativePaths = @(
        'manifest.json',
        'postgres/database.dump',
        'volumes/minio.tar.gz',
        'volumes/state.tar.gz',
        'volumes/uploads.tar.gz',
        'volumes/logs.tar.gz'
    )
    Push-Location $payload
    try {
        foreach ($rel in $relativePaths) {
            $winRel = $rel.Replace('/', '\')
            $hash = (Get-FileHash -LiteralPath $winRel -Algorithm SHA256).Hash.ToLowerInvariant()
            $sums.Add("$hash  $rel")
        }
        Set-Content -LiteralPath 'SHA256SUMS' -Value ($sums -join "`n") -Encoding ascii -NoNewline
        Add-Content -LiteralPath 'SHA256SUMS' -Value "`n" -Encoding ascii
    } finally {
        Pop-Location
    }

    $archiveName = "citysafe_$backupId.tar.gz"
    $plainArchive = Join-Path $work $archiveName
    Write-Log "packaging $archiveName"
    # Prefer tar if available (Git / Windows tar); produce Linux-readable gzip.
    $payloadLeaf = Split-Path -Leaf $payload
    & tar -C $work -czf $plainArchive $payloadLeaf
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $plainArchive)) {
        throw 'Failed to create backup archive with tar'
    }

    $finalArchive = Join-Path $BackupRoot $archiveName
    $finalChecksum = "$finalArchive.sha256"
    $finalMarker = "$finalArchive.verified"
    if ((Test-Path -LiteralPath $finalArchive) -or (Test-Path -LiteralPath $finalChecksum) -or (Test-Path -LiteralPath $finalMarker)) {
        throw "Backup target already exists: $finalArchive"
    }

    $archiveSha = (Get-FileHash -LiteralPath $plainArchive -Algorithm SHA256).Hash.ToLowerInvariant()
    Move-Item -LiteralPath $plainArchive -Destination $finalArchive
    Set-Content -LiteralPath $finalChecksum -Value "$archiveSha  $archiveName`n" -Encoding ascii -NoNewline
    $marker = @"
format=citysafe-backup-v2
archive=$archiveName
sha256=$archiveSha
verified_at_utc=$([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'))
"@
    Set-Content -LiteralPath $finalMarker -Value $marker -Encoding ascii

    Write-Log "backup complete: $finalArchive"
    Write-Host "BACKUP_ARCHIVE=$finalArchive"
}
catch {
    try { Resume-Services } catch { Write-Log "ERROR while resuming services: $($_.Exception.Message)" }
    throw
}
finally {
    if (Test-Path -LiteralPath $work) {
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }
}
