$ErrorActionPreference = 'Stop'

try {
    $repo = Split-Path -Parent $PSScriptRoot
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node -or [int](& $node.Source -p 'parseInt(process.versions.node, 10)') -lt 22) {
        throw 'Install Node.js 22 or later and make sure node.exe is on PATH.'
    }
    if (-not (Test-Path (Join-Path $repo 'node_modules/@modelcontextprotocol/sdk/package.json')) -or
        -not (Test-Path (Join-Path $repo 'node_modules/zod/package.json'))) {
        Push-Location $repo
        try {
            & npm.cmd ci
            if ($LASTEXITCODE -ne 0) { throw 'npm ci failed. See the output above.' }
        } finally {
            Pop-Location
        }
    }

    # The working directory stays where the user started, so a relative project path means what they expect.
    # 'Stop' would end this script, but not node, on the first line node writes to a redirected stderr.
    $ErrorActionPreference = 'Continue'
    & $node.Source (Join-Path $repo 'cloud/src/main.mjs') @args
    exit $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
