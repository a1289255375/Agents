$ErrorActionPreference = 'Stop'

function Test-WebUI($Url) {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 1
        return $response.Content.Contains('<title>Cursor ')
    } catch {
        return $false
    }
}

try {
    $port = 3210
    if ($env:CURSOR_WEB_PORT -and
        (-not [int]::TryParse($env:CURSOR_WEB_PORT, [ref]$port) -or $port -lt 1 -or $port -gt 65535)) {
        throw 'CURSOR_WEB_PORT must be a port number between 1 and 65535.'
    }
    $url = "http://127.0.0.1:$port/"
    if (Test-WebUI $url) {
        Start-Process $url
        exit 0
    }

    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node -or [int](& $node.Source -p 'parseInt(process.versions.node, 10)') -lt 22) {
        throw 'Install Node.js 22 or later and make sure node.exe is on PATH.'
    }
    if (-not (Test-Path 'node_modules/@modelcontextprotocol/sdk/package.json') -or
        -not (Test-Path 'node_modules/zod/package.json')) {
        & npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed. See the output above.' }
    }

    $server = Start-Process -FilePath $node.Source -ArgumentList 'src/index.mjs', '--web' -NoNewWindow -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while (-not (Test-WebUI $url)) {
        if ($server.HasExited) { throw 'The WebUI server exited. See the output above.' }
        if ([DateTime]::UtcNow -ge $deadline) { throw "The WebUI did not respond at $url." }
        Start-Sleep -Milliseconds 250
    }
    Start-Process $url
    $server.WaitForExit()
    exit $server.ExitCode
} catch {
    if ($server -and -not $server.HasExited) { $server.Kill() }
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
