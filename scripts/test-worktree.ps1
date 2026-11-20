$ErrorActionPreference = 'Stop'

function Invoke-TestGit {
    param([string[]]$Arguments)

    $output = & git @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "git $($Arguments -join ' ') failed (exit $LASTEXITCODE)."
    }
    $output
}

function Invoke-Worktree {
    param([string[]]$Arguments)

    $quotedArgs = ($Arguments | ForEach-Object { '"{0}"' -f $_ }) -join ' '
    $info = [Diagnostics.ProcessStartInfo]::new(
        $powerShell, "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$worktreeScript`" $quotedArgs"
    )
    $info.WorkingDirectory = (Get-Location).ProviderPath
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [Text.Encoding]::UTF8
    $info.StandardErrorEncoding = [Text.Encoding]::UTF8
    $process = [Diagnostics.Process]::Start($info)
    try {
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        $process.WaitForExit()
        [pscustomobject]@{
            ExitCode = $process.ExitCode
            Output = ($stdout.Result + $stderr.Result).TrimEnd("`r", "`n").Replace("`r`n", "`n")
        }
    } finally {
        $process.Dispose()
    }
}

function Assert-True {
    param([bool]$Condition, [string]$Message)

    if (-not $Condition) {
        throw $Message
    }
}

function Assert-Success {
    param($Result)

    Assert-True ($Result.ExitCode -eq 0) "Expected success, got exit $($Result.ExitCode).`n$($Result.Output)"
}

function Test-OrcaWorktree {
    $stubDir = Join-Path $sandbox 'orca-bin'
    $orcaPath = Join-Path $sandbox 'orca-workspaces\issue-43-orca'
    $null = New-Item -ItemType Directory -Path $stubDir
    Set-Content -LiteralPath (Join-Path $stubDir 'orca.cmd') -Encoding Ascii -Value @'
@echo off
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0orca.ps1" %*
exit /b %ERRORLEVEL%
'@
    Set-Content -LiteralPath (Join-Path $stubDir 'orca.ps1') -Encoding Ascii -Value @'
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config.json') -Encoding UTF8 -Raw | ConvertFrom-Json
$worktree = @{ id = $config.id; path = $config.path.Replace('\', '/'); branch = 'refs/heads/harness/43-orca' }
$command = "$($args[0]) $($args[1])"
Add-Content -LiteralPath (Join-Path $PSScriptRoot 'calls.log') -Value $command
$expected = switch ($command) {
    'repo list'       { 'repo|list|--json' }
    'worktree create' { 'worktree|create|--repo|id:test-repo|--name|issue-43-orca|--branch|harness/43-orca|--base-branch|main|--issue|43|--json|--activate|--agent|codex|--model|gpt-6.2-sol|--effort|high|--prompt|test|--surface|terminal' }
    'worktree list'   { 'worktree|list|--repo|id:test-repo|--json' }
    'agent launch'    { "agent|launch|--agent|codex|--worktree|id:$($worktree.id)|--model|gpt-6.2-sol|--effort|high|--prompt|check this|--surface|chat|--focus|--json" }
    'worktree rm'     { "worktree|rm|--worktree|id:$($worktree.id)|--delete-branch|--json" }
}
if (($args -join '|') -cne $expected) {
    throw "Unexpected Orca arguments: $($args -join '|')"
}
$result = switch ($command) {
    'repo list' {
        @{ repos = @(@{ id = 'test-repo'; path = $config.repo.ToUpperInvariant().Replace('\', '/') }) }
    }
    'worktree create' {
        git -C $config.repo worktree add --quiet -b 'harness/43-orca' -- $config.path main
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        @{ worktree = $worktree }
    }
    'worktree list' {
        @{ worktrees = @(if (Test-Path -LiteralPath $config.path) { $worktree }) }
    }
    'agent launch' {
        @{ outcome = @{ kind = 'structured'; handle = 'test-agent'; sessionId = 'test-session' } }
    }
    'worktree rm' {
        git -C $config.repo worktree remove -- $config.path
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        @{ removed = $true }
    }
}
@{ ok = $true; result = $result } | ConvertTo-Json -Compress -Depth 6
'@
    @{
        repo = $repo
        path = $orcaPath
        id = "test-repo::$($orcaPath.Replace('\', '/'))"
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stubDir 'config.json') -Encoding UTF8
    $callLog = Join-Path $stubDir 'calls.log'
    $savedPath = $env:PATH
    try {
        $env:PATH = "$stubDir$([IO.Path]::PathSeparator)$savedPath"
        $result = Invoke-Worktree @('start', '-Issue', '43', '-Slug', 'orca', '-Agent', 'codex', '-Effort', 'high', '-NoGh')
        Assert-True ($result.ExitCode -ne 0 -and $result.Output -match '-Effort requires -Model' -and -not (Test-Path -LiteralPath $callLog)) "Unexpected result for effort without model.`n$($result.Output)"

        $result = Invoke-Worktree @('start', '-Issue', '43', '-Type', 'harness', '-Slug', 'Orca', '-Agent', 'codex', '-Model', 'gpt-6.2-sol', '-Effort', 'high', '-Prompt', 'test', '-Surface', 'terminal', '-Activate', '-NoGh')
        Assert-Success $result
        foreach ($line in "WORKTREE_PATH=$orcaPath", 'BRANCH=harness/43-orca', 'ORCA_MANAGED=true', 'AGENT_LAUNCHED=true') {
            Assert-True (($result.Output -split "`n") -ccontains $line) "Missing $line.`n$($result.Output)"
        }
        Assert-True ((Invoke-TestGit @('-C', $orcaPath, 'branch', '--show-current')) -ceq 'harness/43-orca') 'Orca did not create the expected Git checkout.'

        $result = Invoke-Worktree @('launch', '-Issue', '43', '-Agent', 'codex', '-Model', 'gpt-6.2-sol', '-Effort', 'high', '-Prompt', 'check this', '-Surface', 'chat', '-Activate')
        Assert-Success $result
        foreach ($line in "WORKTREE_PATH=$orcaPath", 'AGENT=codex', 'ORCA_SESSION_ID=test-session') {
            Assert-True (($result.Output -split "`n") -ccontains $line) "Missing $line.`n$($result.Output)"
        }

        $result = Invoke-Worktree @('finish', '-Issue', '43', '-DeleteBranch')
        Assert-Success $result
        Assert-True (-not (Test-Path -LiteralPath $orcaPath)) 'The Orca worktree directory still exists.'
        $branches = Invoke-TestGit @('-C', $repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')
        Assert-True ($branches -cnotcontains 'harness/43-orca') 'The Orca issue branch still exists.'
        $calls = Get-Content -LiteralPath $callLog -Raw
        Assert-True ($calls -match '(?m)^worktree rm\r?$') 'Orca did not remove the worktree.'

        $result = Invoke-Worktree @('start', '-Issue', '44', '-Slug', 'git', '-Agent', 'codex', '-NoOrca', '-NoGh')
        Assert-Success $result
        Assert-True (($result.Output -split "`n") -ccontains 'ORCA_MANAGED=false') "Missing Git fallback output.`n$($result.Output)"
        Assert-True ($result.Output -match 'Orca-managed worktree' -and $result.Output -notmatch 'AGENT_LAUNCHED') "Missing agent binding warning.`n$($result.Output)"
        $result = Invoke-Worktree @('launch', '-Issue', '44', '-NoOrca')
        Assert-True ($result.ExitCode -ne 0 -and $result.Output -match 'Orca-managed worktree') "Unexpected launch with -NoOrca.`n$($result.Output)"
        $result = Invoke-Worktree @('finish', '-Issue', '44', '-DeleteBranch', '-NoOrca')
        Assert-Success $result
        Assert-True ((Get-Content -LiteralPath $callLog -Raw) -ceq $calls) '-NoOrca called the Orca CLI.'
    } finally {
        $env:PATH = $savedPath
    }
}

# Git reports long paths even when TEMP uses an 8.3 alias.
$tempRoot = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $env:TEMP).ProviderPath)
$sandbox = Join-Path $tempRoot "worktree-test-$([guid]::NewGuid().ToString('N'))"
$repo = Join-Path $sandbox ('repo with spaces ' + [char]0x52D5 + ' ' + ('x' * 48))
$worktreeRoot = "$repo.worktrees"
$expectedPath = Join-Path $worktreeRoot 'issue-42-camera-pose-v2'
Assert-True ($expectedPath.Length -gt 140) 'The redirected output fixture requires a path longer than 140 characters.'
$expectedBranch = 'feat/42-camera-pose-v2'
$worktreeScript = Join-Path $PSScriptRoot 'worktree.ps1'
$powerShell = (Get-Process -Id $PID).Path
$savedGitEnv = @{}
$consoleEncoding = [Console]::OutputEncoding

try {
    [Console]::OutputEncoding = [Text.Encoding]::UTF8
    foreach ($name in (Invoke-TestGit @('rev-parse', '--local-env-vars'))) {
        $savedGitEnv[$name] = [Environment]::GetEnvironmentVariable($name)
        Set-Item -LiteralPath "Env:$name" -Value $null
    }
    $savedGitEnv['GIT_CONFIG_NOSYSTEM'] = $env:GIT_CONFIG_NOSYSTEM
    $savedGitEnv['GIT_CONFIG_GLOBAL'] = $env:GIT_CONFIG_GLOBAL
    $savedGitEnv['GIT_TEMPLATE_DIR'] = $env:GIT_TEMPLATE_DIR
    $env:GIT_CONFIG_NOSYSTEM = '1'
    $env:GIT_CONFIG_GLOBAL = Join-Path $sandbox 'empty-git-config'
    $env:GIT_TEMPLATE_DIR = $null

    $null = New-Item -ItemType Directory -Path $repo
    $nested = Join-Path $repo 'nested'
    $null = New-Item -ItemType Directory -Path $nested
    $null = Invoke-TestGit @('-C', $repo, 'init', '--quiet', '--initial-branch=main')
    $null = Invoke-TestGit @('-C', $repo, 'config', 'user.name', 'Worktree Test')
    $null = Invoke-TestGit @('-C', $repo, 'config', 'user.email', 'worktree-test@example.invalid')
    $null = Invoke-TestGit @('-C', $repo, 'commit', '--quiet', '--allow-empty', '-m', 'Initial commit')

    Push-Location -LiteralPath $nested
    try {
        $result = Invoke-Worktree @('start', '-Issue', '42', '-Slug', '--Camera__POSE!!--V2---', '-NoGh', '-NoOrca')
        Assert-Success $result
        Assert-True (($result.Output -split "`n") -ccontains "WORKTREE_PATH=$expectedPath") "Unexpected start output.`n$($result.Output)"
        Assert-True (($result.Output -split "`n") -ccontains "BRANCH=$expectedBranch") "Unexpected start output.`n$($result.Output)"
        Assert-True (Test-Path -LiteralPath $expectedPath -PathType Container) "Missing worktree at $expectedPath."
        Assert-True ((Invoke-TestGit @('-C', $expectedPath, 'branch', '--show-current')) -ceq $expectedBranch) 'The worktree checked out the wrong branch.'
        Write-Output 'PASS a) start creates the expected worktree and branch'

        $result = Invoke-Worktree @('path', '-Issue', '42')
        Assert-Success $result
        Assert-True ($result.Output -ceq $expectedPath) "Unexpected path output.`n$($result.Output)"
        try {
            [Console]::OutputEncoding = [Text.Encoding]::GetEncoding(437)
            $legacyPath = & $worktreeScript path -Issue 42
            Assert-True ($LASTEXITCODE -eq 0 -and $legacyPath -ceq $expectedPath) 'Path resolution failed with a legacy Windows console code page.'
        } finally {
            [Console]::OutputEncoding = [Text.Encoding]::UTF8
        }
        Write-Output 'PASS b) path prints the exact worktree path'

        $result = Invoke-Worktree @('list')
        Assert-Success $result
        $escapedRepo = [regex]::Escape($repo)
        $escapedPath = [regex]::Escape($expectedPath)
        $escapedBranch = [regex]::Escape($expectedBranch)
        Assert-True ($result.Output -match '(?m)^IssueNumber\s+Branch\s+Path\s+Dirty\s*$') "Missing list headers.`n$($result.Output)"
        Assert-True ($result.Output -match "(?m)^- +main +$escapedRepo +clean *$") "Missing clean main worktree.`n$($result.Output)"
        Assert-True ($result.Output -match "(?m)^42 +$escapedBranch +$escapedPath +clean *$") "Missing clean issue worktree.`n$($result.Output)"
        Write-Output 'PASS c) list shows both worktrees and their status'

        $result = Invoke-Worktree @('start', '-Issue', '42', '-Slug', 'different', '-NoGh', '-NoOrca')
        Assert-True ($result.ExitCode -ne 0 -and $result.Output -match 'already exists' -and $result.Output.Contains($expectedPath)) "Unexpected duplicate start result.`n$($result.Output)"
        Write-Output 'PASS d) duplicate start fails and identifies the existing worktree'

        $dirtyFile = Join-Path $expectedPath 'untracked.txt'
        Set-Content -LiteralPath $dirtyFile -Value 'Untracked test data'
        $result = Invoke-Worktree @('list')
        Assert-Success $result
        Assert-True ($result.Output -match "(?m)^42\s+$escapedBranch\s+$escapedPath\s+dirty\s*$") "Missing dirty issue worktree.`n$($result.Output)"
        $result = Invoke-Worktree @('finish', '-Issue', '42', '-DeleteBranch', '-NoOrca')
        Assert-True ($result.ExitCode -ne 0 -and $result.Output -match 'dirty' -and $result.Output -match '-Force') "Unexpected dirty finish result.`n$($result.Output)"
        Assert-True (Test-Path -LiteralPath $dirtyFile) 'Dirty finish removed the untracked file.'
        Write-Output 'PASS e) finish preserves a dirty worktree without -Force'

        Remove-Item -LiteralPath $dirtyFile
        if ([IO.Path]::DirectorySeparatorChar -eq '\') {
            Push-Location -LiteralPath $expectedPath
            try {
                $result = Invoke-Worktree @('finish', '-Issue', '42', '-DeleteBranch', '-NoOrca')
                Assert-True ($result.ExitCode -ne 0 -and $result.Output -match 'from outside') "Unexpected finish result from inside the worktree.`n$($result.Output)"
                $result = Invoke-Worktree @('path', '-Issue', '42')
                Assert-Success $result
                Assert-True ($result.Output -ceq $expectedPath) 'Finish from inside the worktree changed its registration.'
            } finally {
                Pop-Location
            }
        }
        $result = Invoke-Worktree @('finish', '-Issue', '42', '-DeleteBranch', '-NoOrca')
        Assert-Success $result
        Assert-True (-not (Test-Path -LiteralPath $expectedPath)) 'The worktree directory still exists.'
        $branches = Invoke-TestGit @('-C', $repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')
        Assert-True ($branches -cnotcontains $expectedBranch) 'The issue branch still exists.'
        $result = Invoke-Worktree @('path', '-Issue', '42')
        Assert-True ($result.ExitCode -ne 0 -and $result.Output -match 'No worktree') "Unexpected path result after finish.`n$($result.Output)"
        Write-Output 'PASS f) finish removes the clean worktree and deletes its branch'
        Test-OrcaWorktree
    } finally {
        Pop-Location
    }
} finally {
    [Console]::OutputEncoding = $consoleEncoding
    foreach ($name in $savedGitEnv.Keys) {
        Set-Item -LiteralPath "Env:$name" -Value $savedGitEnv[$name]
    }
    if (Test-Path -LiteralPath $sandbox) {
        $resolvedSandbox = (Resolve-Path -LiteralPath $sandbox).ProviderPath
        if ($resolvedSandbox -ne $sandbox -or (Split-Path -Parent $resolvedSandbox) -ne $tempRoot) {
            throw "Refusing to clean up unexpected path '$resolvedSandbox'."
        }
        Remove-Item -LiteralPath $resolvedSandbox -Recurse -Force
    }
}

Assert-True (-not (Test-Path -LiteralPath $repo) -and -not (Test-Path -LiteralPath $worktreeRoot)) 'The temporary repository or worktree root still exists.'
Write-Output 'PASS g) temporary repository and worktree root were cleaned up'
Write-Output 'PASS h) Orca creates, binds, launches and removes worktrees, and -NoOrca uses Git'
Write-Output 'All worktree tests passed.'
exit 0
