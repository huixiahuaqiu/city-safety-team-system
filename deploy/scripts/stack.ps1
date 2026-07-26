[CmdletBinding()]
param(
    [ValidateSet('up', 'down', 'restart', 'status', 'logs', 'config', 'smoke')]
    [string]$Action = 'up',

    [string]$EnvFile = '',

    [switch]$WithMinioConsole
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$deployDir = [System.IO.Path]::GetFullPath((Join-Path $scriptDir '..'))
$baseCompose = Join-Path $deployDir 'compose.yaml'
$localCompose = Join-Path $deployDir 'compose.local.yaml'
$envTemplate = Join-Path $deployDir 'env\local.example'
$script:createdBootstrapPassword = ''

if ([string]::IsNullOrWhiteSpace($EnvFile)) {
    $EnvFile = Join-Path $deployDir 'env\.env.local'
} elseif (-not [System.IO.Path]::IsPathRooted($EnvFile)) {
    $EnvFile = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $EnvFile))
}

function New-RandomHex {
    param([int]$Length = 64)

    $byteCount = [int][Math]::Ceiling($Length / 2.0)
    $bytes = New-Object byte[] $byteCount
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    } finally {
        $rng.Dispose()
    }
    return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant().Substring(0, $Length)
}

function Align-LocalPublicUrls {
    param([Parameter(Mandatory = $true)][string]$Content)

    $portMatch = [regex]::Match($Content, '(?m)^CITYSAFE_HTTP_PORT=(\d+)$')
    $port = if ($portMatch.Success) { $portMatch.Groups[1].Value } else { '8080' }
    if ([int]$port -lt 1 -or [int]$port -gt 65535) {
        throw 'CITYSAFE_HTTP_PORT must be between 1 and 65535.'
    }
    $desired = @{
        'PUBLIC_ORIGIN'              = "http://127.0.0.1:$port"
        'CORS_ALLOW_ORIGINS'         = "http://127.0.0.1:$port,http://localhost:$port"
        'MINIO_PUBLIC_UPLOAD_PREFIX' = "http://127.0.0.1:$port/minio-upload"
    }
    foreach ($key in $desired.Keys) {
        $pattern = '(?m)^' + [regex]::Escape($key) + '=.*$'
        $line = $key + '=' + $desired[$key]
        if ([regex]::IsMatch($Content, $pattern)) {
            $Content = [regex]::Replace($Content, $pattern, $line)
        } else {
            $Content = $Content.TrimEnd() + "`r`n$line`r`n"
        }
    }
    return $Content
}

function Initialize-LocalEnvironment {
    if (Test-Path -LiteralPath $EnvFile) {
        # Repair environment files created by an older script version without
        # rotating existing database/storage secrets or touching data volumes.
        $existing = [System.IO.File]::ReadAllText($EnvFile)
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        if ($existing -notmatch '(?m)^BOOTSTRAP_ADMIN_USERNAME=.+$') {
            $existing = $existing.TrimEnd() + "`r`nBOOTSTRAP_ADMIN_USERNAME=admin`r`n"
        }
        $nameMatch = [regex]::Match($existing, '(?m)^BOOTSTRAP_ADMIN_NAME=(.*)$')
        if (-not $nameMatch.Success -or $nameMatch.Groups[1].Value.Length -gt 40) {
            if ($nameMatch.Success) {
                $existing = [regex]::Replace(
                    $existing,
                    '(?m)^BOOTSTRAP_ADMIN_NAME=.*$',
                    'BOOTSTRAP_ADMIN_NAME=Local Administrator'
                )
            } else {
                $existing = $existing.TrimEnd() + "`r`nBOOTSTRAP_ADMIN_NAME=Local Administrator`r`n"
            }
        }
        if ($existing -notmatch '(?m)^BOOTSTRAP_ADMIN_PASSWORD=.+$') {
            $bootstrapPassword = 'LocalA1!' + (New-RandomHex 24)
            if ($existing -match '(?m)^BOOTSTRAP_ADMIN_PASSWORD=.*$') {
                $existing = [regex]::Replace(
                    $existing,
                    '(?m)^BOOTSTRAP_ADMIN_PASSWORD=.*$',
                    'BOOTSTRAP_ADMIN_PASSWORD=' + $bootstrapPassword
                )
            } else {
                $existing = $existing.TrimEnd() + "`r`nBOOTSTRAP_ADMIN_PASSWORD=$bootstrapPassword`r`n"
            }
            $script:createdBootstrapPassword = $bootstrapPassword
        }
        if ($existing -notmatch '(?m)^MINIO_ROOT_USER=.+$') {
            if ($existing -match '(?m)^MINIO_ROOT_USER=.*$') {
                $existing = [regex]::Replace(
                    $existing,
                    '(?m)^MINIO_ROOT_USER=.*$',
                    'MINIO_ROOT_USER=citysafe_root'
                )
            } else {
                $existing = $existing.TrimEnd() + "`r`nMINIO_ROOT_USER=citysafe_root`r`n"
            }
        }
        if ($existing -notmatch '(?m)^MINIO_ROOT_PASSWORD=.+$') {
            $minioRootPassword = New-RandomHex 64
            if ($existing -match '(?m)^MINIO_ROOT_PASSWORD=.*$') {
                $existing = [regex]::Replace(
                    $existing,
                    '(?m)^MINIO_ROOT_PASSWORD=.*$',
                    'MINIO_ROOT_PASSWORD=' + $minioRootPassword
                )
            } else {
                $existing = $existing.TrimEnd() + "`r`nMINIO_ROOT_PASSWORD=$minioRootPassword`r`n"
            }
        }
        $existing = Align-LocalPublicUrls -Content $existing
        [System.IO.File]::WriteAllText($EnvFile, $existing, $utf8NoBom)
        return
    }

    if (-not (Test-Path -LiteralPath $envTemplate)) {
        throw "Environment template not found: $envTemplate"
    }

    $content = [System.IO.File]::ReadAllText($envTemplate)
    $bootstrapPassword = 'LocalA1!' + (New-RandomHex 24)
    $replacements = @{
        'CHANGE_ME_LOCAL_POSTGRES'       = New-RandomHex 64
        'CHANGE_ME_LOCAL_MINIO_ROOT'     = New-RandomHex 64
        'CHANGE_ME_LOCAL_MINIO_APP'      = New-RandomHex 64
        'CHANGE_ME_LOCAL_AUTH'           = New-RandomHex 64
        'CHANGE_ME_LOCAL_ADMIN_PASSWORD' = $bootstrapPassword
        'CHANGE_ME_LOCAL_MLOPS'          = New-RandomHex 64
        'CHANGE_ME_LOCAL_ANNOTATION'     = New-RandomHex 64
        'CHANGE_ME_LOCAL_DATASET'        = New-RandomHex 64
    }

    foreach ($placeholder in $replacements.Keys) {
        $content = $content.Replace($placeholder, $replacements[$placeholder])
    }
    $content = Align-LocalPublicUrls -Content $content

    $envDir = Split-Path -Parent $EnvFile
    [System.IO.Directory]::CreateDirectory($envDir) | Out-Null
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($EnvFile, $content, $utf8NoBom)
    $script:createdBootstrapPassword = $bootstrapPassword
    Write-Host "Created local environment: $EnvFile"
}

function Assert-EnvironmentReady {
    $unresolved = Get-Content -LiteralPath $EnvFile |
        Where-Object { $_ -match '^[^#]*CHANGE_ME_' }
    if ($unresolved) {
        throw "Unresolved CHANGE_ME value remains in $EnvFile"
    }
}

function Get-LocalHttpPort {
    $portLine = Get-Content -LiteralPath $EnvFile |
        Where-Object { $_ -match '^CITYSAFE_HTTP_PORT=' } |
        Select-Object -First 1
    if ($portLine) {
        return ($portLine -split '=', 2)[1].Trim()
    }
    return '8080'
}

function Invoke-CitysafeCompose {
    param([string[]]$CommandArguments)

    $composeArguments = @(
        'compose',
        '--env-file', $EnvFile,
        '-f', $baseCompose,
        '-f', $localCompose
    )
    if ($WithMinioConsole) {
        $composeArguments += @('--profile', 'console')
    }
    $composeArguments += $CommandArguments

    & docker @composeArguments
    if ($LASTEXITCODE -ne 0) {
        throw "docker compose failed with exit code $LASTEXITCODE"
    }
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker was not found. Install and start Docker Desktop first.'
}

& docker compose version | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw 'Docker Compose is unavailable.'
}

Initialize-LocalEnvironment
Assert-EnvironmentReady

switch ($Action) {
    'up' {
        Invoke-CitysafeCompose @('config', '--quiet')
        Invoke-CitysafeCompose @('up', '-d', '--build', '--wait')
        # Bind-mounted Nginx configuration changes do not alter the Compose
        # service hash, so always recreate the edge after an update.
        Invoke-CitysafeCompose @('up', '-d', '--no-deps', '--force-recreate', '--wait', 'edge')
        $httpPort = Get-LocalHttpPort
        Write-Host "CitySafe is ready at http://127.0.0.1:$httpPort"
        if ($WithMinioConsole) {
            Write-Host 'MinIO console is ready at http://127.0.0.1:9001'
        }
    }
    'down' {
        # Intentionally omit --volumes: application data must survive restarts.
        Invoke-CitysafeCompose @('down', '--remove-orphans')
    }
    'restart' {
        Invoke-CitysafeCompose @('restart', 'gateway', 'edge')
        Invoke-CitysafeCompose @('ps')
    }
    'status' {
        Invoke-CitysafeCompose @('ps')
    }
    'logs' {
        Invoke-CitysafeCompose @('logs', '--follow', '--tail', '200')
    }
    'config' {
        Invoke-CitysafeCompose @('config', '--quiet')
        Write-Host 'Compose configuration is valid.'
    }
    'smoke' {
        $port = Get-LocalHttpPort
        $healthUrl = "http://127.0.0.1:$port/api/health"
        $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 10
        if ($response.StatusCode -ne 200) {
            throw "Health check failed: HTTP $($response.StatusCode)"
        }
        Write-Host "Smoke check passed: $healthUrl"
    }
}

if (-not [string]::IsNullOrWhiteSpace($script:createdBootstrapPassword)) {
    Write-Host 'Initial administrator: admin'
    Write-Host "Initial password: $($script:createdBootstrapPassword)"
    Write-Host 'Change this password immediately after the first login.'
}
