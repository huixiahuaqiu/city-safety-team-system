<#
.SYNOPSIS
Safely updates an existing CitySafe checkout and deploys it on a Linux server.

.EXAMPLE
.\deploy-server.ps1 -Server deployer@server.example.com `
    -Domain safety.example.com `
    -RemotePath /opt/city-safety-team-system `
    -Ref main

.EXAMPLE
.\deploy-server.ps1 -Server deployer@server.example.com `
    -Domain safety.example.com `
    -RemotePath /opt/city-safety-team-system `
    -Ref refs/tags/v1.0.0 -PrepareOnly -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$Server,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$Domain,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$RemotePath,

    [ValidateNotNullOrEmpty()]
    [string]$Ref = 'main',

    [string]$EnvFile = '',

    [string]$TlsRoot = '',

    [switch]$IssueCert,

    [switch]$SelfSigned,

    [string]$Email = '',

    [switch]$PrepareOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Assert-DnsName {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value,

        [Parameter(Mandatory = $true)]
        [string]$ParameterName,

        [switch]$RequireDot
    )

    if ($Value.Length -gt 253 -or $Value -notmatch '^[A-Za-z0-9.-]+$') {
        throw "$ParameterName must be an ASCII DNS name without a scheme, port, path, or wildcard."
    }
    if ($Value.StartsWith('.') -or $Value.EndsWith('.') -or $Value.Contains('..')) {
        throw "$ParameterName is not a valid DNS name."
    }
    if ($RequireDot -and -not $Value.Contains('.')) {
        throw "$ParameterName must be a fully qualified DNS name."
    }

    foreach ($label in $Value.Split('.')) {
        if (
            $label.Length -lt 1 -or
            $label.Length -gt 63 -or
            $label -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$'
        ) {
            throw "$ParameterName contains an invalid DNS label."
        }
    }
}

function Assert-ServerTarget {
    param([Parameter(Mandatory = $true)][string]$Value)

    if ($Value.Length -gt 300 -or $Value -match '\s' -or $Value.StartsWith('-')) {
        throw 'Server must be a host or user@host value without options, whitespace, or a port.'
    }

    $atCount = ([regex]::Matches($Value, '@')).Count
    if ($atCount -gt 1) {
        throw 'Server must contain at most one @ separator.'
    }

    $hostPart = $Value
    if ($atCount -eq 1) {
        $parts = $Value.Split('@')
        if ($parts[0] -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$') {
            throw 'Server contains an invalid SSH user name.'
        }
        $hostPart = $parts[1]
    }

    if ($hostPart -match '^[0-9.]+$') {
        $parsedAddress = $null
        if (
            -not [System.Net.IPAddress]::TryParse($hostPart, [ref]$parsedAddress) -or
            $parsedAddress.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork
        ) {
            throw 'Server contains an invalid IPv4 address.'
        }
        return
    }

    Assert-DnsName -Value $hostPart -ParameterName 'Server host'
}

function Assert-LinuxAbsolutePath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value,

        [Parameter(Mandatory = $true)]
        [string]$ParameterName
    )

    if (
        $Value.Length -gt 512 -or
        $Value -eq '/' -or
        $Value -notmatch '^/(?:[A-Za-z0-9._-]+/)*[A-Za-z0-9._-]+$'
    ) {
        throw "$ParameterName must be a non-root absolute Linux path using only letters, numbers, dot, underscore, dash, and slash."
    }

    foreach ($segment in $Value.Split('/', [System.StringSplitOptions]::RemoveEmptyEntries)) {
        if ($segment -eq '.' -or $segment -eq '..') {
            throw "$ParameterName must not contain dot traversal segments."
        }
    }
}

function Assert-GitRef {
    param([Parameter(Mandatory = $true)][string]$Value)

    if ($Value.Length -gt 200 -or $Value -match '\s' -or $Value.StartsWith('-')) {
        throw 'Ref is not a safe branch, tag, or full commit identifier.'
    }

    if ($Value -match '^[0-9A-Fa-f]{40}(?:[0-9A-Fa-f]{24})?$') {
        return
    }

    $name = $Value
    if ($Value.StartsWith('refs/heads/')) {
        $name = $Value.Substring('refs/heads/'.Length)
    } elseif ($Value.StartsWith('refs/tags/')) {
        $name = $Value.Substring('refs/tags/'.Length)
    } elseif ($Value.StartsWith('refs/')) {
        throw 'Ref may use only refs/heads/... or refs/tags/... as a full ref.'
    }

    if (
        $name.Length -lt 1 -or
        $name -eq 'HEAD' -or
        $name -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]*$' -or
        $name.EndsWith('/') -or
        $name.EndsWith('.') -or
        $name.EndsWith('.lock') -or
        $name.Contains('..') -or
        $name.Contains('//') -or
        $name.Contains('@{')
    ) {
        throw 'Ref is not a safe Git branch or tag name.'
    }

    foreach ($segment in $name.Split('/')) {
        if ($segment.Length -eq 0 -or $segment.StartsWith('.') -or $segment.EndsWith('.lock')) {
            throw 'Ref contains an invalid Git name segment.'
        }
    }
}

function ConvertTo-RemoteSingleQuoted {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)

    # Every caller value has already passed a conservative allowlist. Keeping
    # this assertion here makes future parameter additions fail closed.
    if ($Value.Contains("'") -or $Value.Contains("`r") -or $Value.Contains("`n")) {
        throw 'A remote argument contains a forbidden character.'
    }
    return "'" + $Value + "'"
}

Assert-ServerTarget -Value $Server
$domainIsIpv4 = $false
if ($Domain -match '^[0-9.]+$') {
    $parsedDomainAddress = $null
    if (
        -not [System.Net.IPAddress]::TryParse($Domain, [ref]$parsedDomainAddress) -or
        $parsedDomainAddress.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork
    ) {
        throw 'Domain contains an invalid IPv4 address.'
    }
    $domainIsIpv4 = $true
} else {
    Assert-DnsName -Value $Domain -ParameterName 'Domain' -RequireDot
}
Assert-LinuxAbsolutePath -Value $RemotePath -ParameterName 'RemotePath'
Assert-GitRef -Value $Ref

if (-not [string]::IsNullOrWhiteSpace($EnvFile)) {
    Assert-LinuxAbsolutePath -Value $EnvFile -ParameterName 'EnvFile'
}
if (-not [string]::IsNullOrWhiteSpace($TlsRoot)) {
    Assert-LinuxAbsolutePath -Value $TlsRoot -ParameterName 'TlsRoot'
}
if ($IssueCert -and $SelfSigned) {
    throw 'IssueCert and SelfSigned are mutually exclusive.'
}
if ($IssueCert) {
    if ($domainIsIpv4) {
        throw 'IssueCert requires a DNS domain name, not an IPv4 address.'
    }
    if (
        [string]::IsNullOrWhiteSpace($Email) -or
        $Email.Length -gt 254 -or
        $Email -notmatch '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$'
    ) {
        throw 'Email must be a valid ASCII address when IssueCert is used.'
    }
} elseif (-not [string]::IsNullOrWhiteSpace($Email)) {
    throw 'Email is accepted only together with IssueCert.'
}

$deploymentMode = if ($PrepareOnly) { 'configuration only' } else { 'configuration and service rollout' }
$certificateMode = if ($IssueCert) {
    'request a certificate'
} elseif ($SelfSigned) {
    'use or create a self-signed certificate'
} else {
    'use the existing certificate'
}
$operationSummary = (
    "Fetch origin, update '$RemotePath' to '$Ref' only from a clean, " +
    "fast-forward-safe checkout, then run server bootstrap for '$Domain' " +
    "($deploymentMode; $certificateMode). Secret values remain on the server."
)

if (-not $PSCmdlet.ShouldProcess($Server, $operationSummary)) {
    return
}

$sshCommand = Get-Command ssh -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
if (-not $sshCommand) {
    throw 'The system OpenSSH client (ssh) was not found.'
}

$remoteScript = @'
#!/usr/bin/env bash
set -Eeuo pipefail

remote_path="$1"
requested_ref="$2"
domain="$3"
env_file="$4"
tls_root="$5"
issue_cert="$6"
email="$7"
prepare_only="$8"
self_signed="$9"

fail() {
  echo "[deploy] ERROR: $*" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || fail "git is not installed on the server"
command -v sudo >/dev/null 2>&1 || fail "sudo is not installed on the server"
command -v sed >/dev/null 2>&1 || fail "sed is not installed on the server"
command -v flock >/dev/null 2>&1 || fail "flock is not installed on the server"
command -v stat >/dev/null 2>&1 || fail "stat is not installed on the server"

[[ -d "${remote_path}/.git" ]] || fail "RemotePath is not a Git working tree"
cd -- "${remote_path}"

git remote get-url origin >/dev/null 2>&1 || fail "Git remote 'origin' is not configured"
if [[ -n "$(git status --porcelain=v1 --untracked-files=normal)" ]]; then
  fail "the server working tree has local changes; commit or preserve them before deployment"
fi

if [[ "${CITYSAFE_DEPLOY_LOCKED_INNER:-0}" != "1" ]]; then
  echo "[deploy] Fetching the requested release from origin..."
  if ! git fetch --quiet --prune --tags origin >/dev/null 2>&1; then
    fail "git fetch failed; inspect the server's repository credentials and remote state"
  fi
fi

target_commit=""
branch_name=""

case "${requested_ref}" in
  refs/heads/*)
    branch_name="${requested_ref#refs/heads/}"
    ;;
  refs/tags/*)
    tag_ref="${requested_ref}"
    git show-ref --verify --quiet "${tag_ref}" ||
      fail "the requested tag was not fetched from origin"
    target_commit="$(git rev-parse --verify "${tag_ref}^{commit}")"
    ;;
  *)
    if [[ "${requested_ref}" =~ ^[0-9A-Fa-f]{40}([0-9A-Fa-f]{24})?$ ]]; then
      if ! git cat-file -e "${requested_ref}^{commit}" 2>/dev/null; then
        if ! git fetch --quiet origin "${requested_ref}" >/dev/null 2>&1; then
          fail "the requested commit could not be fetched from origin"
        fi
      fi
      target_commit="$(git rev-parse --verify "${requested_ref}^{commit}")"
    else
      branch_name="${requested_ref}"
    fi
    ;;
esac

if [[ -n "${branch_name}" ]]; then
  git check-ref-format --branch "${branch_name}" >/dev/null 2>&1 ||
    fail "the requested branch name is invalid"
  remote_ref="refs/remotes/origin/${branch_name}"
  git show-ref --verify --quiet "${remote_ref}" ||
    fail "the requested branch does not exist on origin"
  target_commit="$(git rev-parse --verify "${remote_ref}^{commit}")"

  if git show-ref --verify --quiet "refs/heads/${branch_name}"; then
    local_commit="$(git rev-parse --verify "refs/heads/${branch_name}^{commit}")"
    if ! git merge-base --is-ancestor "${local_commit}" "${target_commit}"; then
      fail "the local server branch is not a fast-forward ancestor of origin; no files were changed"
    fi
  fi
fi

if [[ "${CITYSAFE_DEPLOY_LOCKED_INNER:-0}" != "1" ]]; then
  # Acquire the same root-private lock used by bootstrap and backup before
  # changing the checked-out source. The root wrapper retains the descriptor
  # while this script is re-entered as the original deployer, so Git files keep
  # their normal ownership and bootstrap can safely inherit the held-lock flag.
  sudo -v
  deploy_user="$(id -un)"
  set +e
  sudo bash -c '
    set -Eeuo pipefail
    deploy_user="$1"
    script_path="$2"
    shift 2
    lock_dir=/run/lock/citysafe
    lock_file="${lock_dir}/maintenance.lock"

    if [[ ! -e "${lock_dir}" && ! -L "${lock_dir}" ]]; then
      mkdir -- "${lock_dir}" 2>/dev/null || true
    fi
    [[ -d "${lock_dir}" && ! -L "${lock_dir}" ]] || {
      echo "[deploy] ERROR: maintenance lock directory is not a real directory" >&2
      exit 1
    }
    [[ "$(stat -c "%u" -- "${lock_dir}")" == "0" ]] || {
      echo "[deploy] ERROR: maintenance lock directory must be owned by root" >&2
      exit 1
    }
    chmod 0700 -- "${lock_dir}"
    [[ ! -L "${lock_file}" ]] || {
      echo "[deploy] ERROR: maintenance lock file may not be a symlink" >&2
      exit 1
    }
    [[ ! -e "${lock_file}" || -f "${lock_file}" ]] || {
      echo "[deploy] ERROR: maintenance lock path must be a regular file" >&2
      exit 1
    }
    umask 077
    exec 9>"${lock_file}"
    chmod 0600 -- "${lock_file}"
    flock -n 9 || {
      echo "[deploy] ERROR: another CitySafe deployment or backup is in progress" >&2
      exit 1
    }

    sudo -u "${deploy_user}" -- \
      env CITYSAFE_DEPLOY_LOCKED_INNER=1 bash "${script_path}" "$@"
  ' bash "${deploy_user}" "$0" "$@"
  locked_rc=$?
  set -e
  exit "${locked_rc}"
fi

if [[ -n "${branch_name}" ]]; then
  if git show-ref --verify --quiet "refs/heads/${branch_name}"; then
    git checkout --quiet "${branch_name}"
    git merge --quiet --ff-only "${target_commit}"
    git branch --set-upstream-to="${remote_ref}" "${branch_name}" >/dev/null 2>&1
  else
    git checkout --quiet -b "${branch_name}" --track "${remote_ref}"
  fi
else
  git checkout --quiet --detach "${target_commit}"
fi

deployed_commit="$(git rev-parse --verify HEAD)"
[[ "${deployed_commit}" == "${target_commit}" ]] ||
  fail "the checked-out commit does not match the requested release"
[[ -f deploy/scripts/bootstrap-server.sh ]] ||
  fail "the requested release does not contain deploy/scripts/bootstrap-server.sh"

echo "[deploy] Repository is ready at ${deployed_commit:0:12}."

bootstrap_args=(deploy/scripts/bootstrap-server.sh --domain "${domain}")
if [[ -n "${env_file}" ]]; then
  bootstrap_args+=(--env-file "${env_file}")
fi
if [[ -n "${tls_root}" ]]; then
  bootstrap_args+=(--tls-root "${tls_root}")
fi
if [[ "${issue_cert}" == "1" && "${self_signed}" == "1" ]]; then
  fail "IssueCert and SelfSigned are mutually exclusive"
fi
if [[ "${issue_cert}" == "1" ]]; then
  bootstrap_args+=(--issue-cert --email "${email}")
fi
if [[ "${self_signed}" == "1" ]]; then
  bootstrap_args+=(--self-signed)
fi
if [[ "${prepare_only}" == "1" ]]; then
  bootstrap_args+=(--prepare-only)
fi

# Validate sudo before the filtered pipeline so an interactive sudo policy can
# prompt through SSH's pseudo-terminal. Bootstrap output is filtered remotely:
# the initial generated password never crosses the SSH connection.
sudo -v
set +e
sudo env CITYSAFE_MAINTENANCE_LOCK_HELD=1 bash "${bootstrap_args[@]}" 2>&1 |
  sed -E \
    -e 's/^(\[bootstrap\] initial password:).*/\1 <redacted>/' \
    -e 's/^([A-Z0-9_]*(PASSWORD|SECRET|TOKEN|KEY)=).*/\1<redacted>/'
pipeline_status=("${PIPESTATUS[@]}")
set -e

if [[ "${pipeline_status[0]}" -ne 0 ]]; then
  fail "server bootstrap failed with exit code ${pipeline_status[0]}"
fi
if [[ "${pipeline_status[1]}" -ne 0 ]]; then
  fail "secure bootstrap output filtering failed"
fi

echo "[deploy] Server update completed successfully."
'@

$encodedScript = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remoteScript))
$remoteArguments = @(
    $RemotePath,
    $Ref,
    $Domain,
    $EnvFile,
    $TlsRoot,
    $(if ($IssueCert) { '1' } else { '0' }),
    $Email,
    $(if ($PrepareOnly) { '1' } else { '0' }),
    $(if ($SelfSigned) { '1' } else { '0' })
) | ForEach-Object { ConvertTo-RemoteSingleQuoted -Value ([string]$_) }

# The encoded payload contains only this public deployment routine. User
# values are allowlisted and single-quoted; no environment file contents or
# application secrets are sent from the workstation.
$remoteCommand = (
    'command -v base64 >/dev/null 2>&1 || { echo ''[deploy] ERROR: base64 is not installed'' >&2; exit 1; }; ' +
    'umask 077; _citysafe_tmp=$(mktemp) || exit 1; ' +
    'trap ''rm -f -- $_citysafe_tmp'' EXIT; trap ''exit 130'' HUP INT TERM; ' +
    'printf ''%s'' ''' + $encodedScript + ''' | base64 --decode > $_citysafe_tmp || exit 1; ' +
    'bash $_citysafe_tmp ' + ($remoteArguments -join ' ') + '; ' +
    '_citysafe_rc=$?; exit $_citysafe_rc'
)

Write-Host "Connecting to $Server..."
& $sshCommand.Source '-tt' $Server $remoteCommand
$sshExitCode = $LASTEXITCODE
if ($sshExitCode -ne 0) {
    throw "Server deployment failed with exit code $sshExitCode."
}

Write-Host "Deployment finished for https://$Domain"
