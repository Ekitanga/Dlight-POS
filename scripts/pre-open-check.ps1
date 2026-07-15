[CmdletBinding()]
param(
    [string]$FrontendUrl = "http://localhost:3000",
    [string]$BackendUrl = "http://localhost:4000",
    [string]$Email,
    [SecureString]$Password,
    [string]$BackupDirectory = (Join-Path $PSScriptRoot "..\database\backups"),
    [int]$MaximumBackupAgeHours = 26,
    [switch]$SkipBackup,
    [switch]$SkipBrowserPrintCheck
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$failures = [System.Collections.Generic.List[string]]::new()

function Pass([string]$Message) { Write-Host "[PASS] $Message" -ForegroundColor Green }
function Fail([string]$Message) {
    Write-Host "[FAIL] $Message" -ForegroundColor Red
    $script:failures.Add($Message)
}
function Check([string]$Name, [scriptblock]$Action) {
    try {
        & $Action
        Pass $Name
    } catch {
        Fail "$Name - $($_.Exception.Message)"
    }
}

function Read-DotEnvValue([string]$Name) {
    $envFile = Join-Path $projectRoot ".env"
    if (-not (Test-Path $envFile)) { return $null }
    $line = Get-Content $envFile | Where-Object { $_ -match "^\s*$([regex]::Escape($Name))=" } | Select-Object -Last 1
    if (-not $line) { return $null }
    return ($line -split "=", 2)[1].Trim()
}

$databaseUrl = $env:DATABASE_URL
if (-not $databaseUrl) { $databaseUrl = Read-DotEnvValue "DATABASE_URL" }
if (-not $databaseUrl) { throw "DATABASE_URL is not set and was not found in .env" }

if (-not $Email) { $Email = Read-Host "Pre-opening login email" }
if (-not $Password) { $Password = Read-Host "Password" -AsSecureString }

$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Password)
try {
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)

    Check "Backend health endpoint" {
        $health = Invoke-RestMethod -Uri "$BackendUrl/health" -TimeoutSec 10
        if ($health.status -ne "ok") { throw "Unexpected health response" }
    }

    Check "Frontend is serving the application" {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $FrontendUrl -TimeoutSec 10
        if ($response.StatusCode -ne 200 -or $response.Content -notmatch '<div id="root">') {
            throw "Frontend root was not returned"
        }
    }

    Check "PostgreSQL connection" {
        $result = & psql $databaseUrl -v ON_ERROR_STOP=1 -Atc "SELECT 1" 2>&1
        if ($LASTEXITCODE -ne 0 -or ($result | Select-Object -Last 1) -ne "1") {
            throw ($result -join [Environment]::NewLine)
        }
    }

    $login = $null
    Check "Login works" {
        $loginBody = @{ email = $Email; password = $plainPassword } | ConvertTo-Json
        $script:login = Invoke-RestMethod -Method Post -Uri "$BackendUrl/api/auth/login" `
            -ContentType "application/json" -Body $loginBody -TimeoutSec 15
        if (-not $script:login.accessToken) { throw "No access token returned" }
    }

    if ($login -and $login.accessToken) {
        $headers = @{ Authorization = "Bearer $($login.accessToken)" }

        Check "Products load" {
            $products = Invoke-RestMethod -Uri "$BackendUrl/api/products" -Headers $headers -TimeoutSec 15
            if ($null -eq $products) { throw "Products response was empty" }
        }

        Check "Order creation route and permission" {
            if (-not ($login.user.role -in @("admin", "owner")) -and
                -not ($login.user.permissions -contains "orders.create")) {
                throw "This account does not have orders.create"
            }
            try {
                Invoke-RestMethod -Method Post -Uri "$BackendUrl/api/orders" -Headers $headers `
                    -ContentType "application/json" -Body '{"items":[]}' -TimeoutSec 15 | Out-Null
                throw "Invalid order probe was unexpectedly accepted"
            } catch {
                if ($_.Exception.Response.StatusCode.value__ -ne 400) { throw }
            }
        }

        Check "Receipts load" {
            $receipts = Invoke-RestMethod -Uri "$BackendUrl/api/receipts" -Headers $headers -TimeoutSec 15
            if ($null -eq $receipts) { throw "Receipts response was empty" }
        }

        Check "Dashboard loads" {
            $dashboard = Invoke-RestMethod -Uri "$BackendUrl/api/dashboard/stats" -Headers $headers -TimeoutSec 15
            if ($null -eq $dashboard.periodSales) { throw "Dashboard totals were not returned" }
        }
    }

    Check "Backup creation and archive validation" {
        New-Item -ItemType Directory -Force -Path $BackupDirectory | Out-Null
        if (-not $SkipBackup) {
            $stamp = Get-Date -Format "yyyyMMdd_HHmmss"
            $backupPath = Join-Path $BackupDirectory "dlight_pos_preopen_$stamp.dump"
            & pg_dump $databaseUrl --format=custom --file=$backupPath
            if ($LASTEXITCODE -ne 0) { throw "pg_dump failed" }
        }
        $latest = Get-ChildItem $BackupDirectory -Filter "*.dump" |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if (-not $latest) { throw "No PostgreSQL backup was found" }
        if (((Get-Date) - $latest.LastWriteTime).TotalHours -gt $MaximumBackupAgeHours) {
            throw "Latest backup is older than $MaximumBackupAgeHours hours"
        }
        & pg_restore --list $latest.FullName | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Latest backup archive is unreadable" }
    }

    if (-not $SkipBrowserPrintCheck) {
        Check "Browser pages and receipt print preview" {
            $env:PREOPEN_EMAIL = $Email
            $env:PREOPEN_PASSWORD = $plainPassword
            Push-Location $projectRoot
            try {
                & npx playwright test tests/uat/preopen.spec.ts --reporter=line
                if ($LASTEXITCODE -ne 0) { throw "Playwright pre-opening smoke test failed" }
            } finally {
                Pop-Location
                Remove-Item Env:PREOPEN_EMAIL -ErrorAction SilentlyContinue
                Remove-Item Env:PREOPEN_PASSWORD -ErrorAction SilentlyContinue
            }
        }
    }
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    $plainPassword = $null
}

Write-Host ""
if ($failures.Count -gt 0) {
    Write-Host "PRE-OPEN CHECK FAILED: $($failures.Count) issue(s) require attention." -ForegroundColor Red
    exit 1
}

Write-Host "PRE-OPEN CHECK PASSED: services, login, core screens, database, receipt preview, and backup are ready." -ForegroundColor Green
exit 0
