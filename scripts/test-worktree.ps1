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

    $ErrorActionPreference = 'Continue'
    $output = & $powerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $worktreeScript @Arguments 2>&1
    [pscustomobject]@{
        ExitCode = $LASTEXITCODE
        Output = ($output | ForEach-Object { "$_" }) -join "`n"
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

$tempRoot = (Resolve-Path -LiteralPath $env:TEMP).ProviderPath
$sandbox = Join-Path $tempRoot "worktree-test-$([guid]::NewGuid().ToString('N'))"
$repo = Join-Path $sandbox ('repo with spaces ' + [char]0x52D5)
$worktreeRoot = "$repo.worktrees"
$expectedPath = Join-Path $worktreeRoot 'issue-42-camera-pose-v2'
$expectedBranch = 'feat/42-camera-pose-v2'
$worktreeScript = Join-Path $PSScriptRoot 'worktree.ps1'
$powerShell = (Get-Process -Id $PID).Path
$savedGitEnv = @{}
$consoleEncoding = [Console]::OutputEncoding

try {
    [Console]::OutputEncoding = [Text.Encoding]::UTF8
    foreach ($name in (Invoke-TestGit @('rev-parse', '--local-env-vars'))) {
        $savedGitEnv[$name] = [Environment]::GetEnvironmentVariable($name)
        [Environment]::SetEnvironmentVariable($name, $null)
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
        $result = Invoke-Worktree @('start', '-Issue', '42', '-Slug', '--Camera__POSE!!--V2---', '-NoGh')
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
        Assert-True ($result.Output -match "(?m)^-\s+main\s+$escapedRepo\s+clean\s*$") "Missing clean main worktree.`n$($result.Output)"
        Assert-True ($result.Output -match "(?m)^42\s+$escapedBranch\s+$escapedPath\s+clean\s*$") "Missing clean issue worktree.`n$($result.Output)"
        Write-Output 'PASS c) list shows both worktrees and their status'

        $result = Invoke-Worktree @('start', '-Issue', '42', '-Slug', 'different', '-NoGh')
        Assert-True ($result.ExitCode -ne 0 -and $result.Output -match 'already exists' -and $result.Output.Contains($expectedPath)) "Unexpected duplicate start result.`n$($result.Output)"
        Write-Output 'PASS d) duplicate start fails and identifies the existing worktree'

        $dirtyFile = Join-Path $expectedPath 'untracked.txt'
        Set-Content -LiteralPath $dirtyFile -Value 'Untracked test data'
        $result = Invoke-Worktree @('list')
        Assert-Success $result
        Assert-True ($result.Output -match "(?m)^42\s+$escapedBranch\s+$escapedPath\s+dirty\s*$") "Missing dirty issue worktree.`n$($result.Output)"
        $result = Invoke-Worktree @('finish', '-Issue', '42', '-DeleteBranch')
        Assert-True ($result.ExitCode -ne 0 -and $result.Output -match 'dirty' -and $result.Output -match '-Force') "Unexpected dirty finish result.`n$($result.Output)"
        Assert-True (Test-Path -LiteralPath $dirtyFile) 'Dirty finish removed the untracked file.'
        Write-Output 'PASS e) finish preserves a dirty worktree without -Force'

        Remove-Item -LiteralPath $dirtyFile
        if ([IO.Path]::DirectorySeparatorChar -eq '\') {
            Push-Location -LiteralPath $expectedPath
            try {
                $result = Invoke-Worktree @('finish', '-Issue', '42', '-DeleteBranch')
                Assert-True ($result.ExitCode -ne 0 -and $result.Output -match 'from outside') "Unexpected finish result from inside the worktree.`n$($result.Output)"
                $result = Invoke-Worktree @('path', '-Issue', '42')
                Assert-Success $result
                Assert-True ($result.Output -ceq $expectedPath) 'Finish from inside the worktree changed its registration.'
            } finally {
                Pop-Location
            }
        }
        $result = Invoke-Worktree @('finish', '-Issue', '42', '-DeleteBranch')
        Assert-Success $result
        Assert-True (-not (Test-Path -LiteralPath $expectedPath)) 'The worktree directory still exists.'
        $branches = Invoke-TestGit @('-C', $repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')
        Assert-True ($branches -cnotcontains $expectedBranch) 'The issue branch still exists.'
        $result = Invoke-Worktree @('path', '-Issue', '42')
        Assert-True ($result.ExitCode -ne 0 -and $result.Output -match 'No worktree') "Unexpected path result after finish.`n$($result.Output)"
        Write-Output 'PASS f) finish removes the clean worktree and deletes its branch'
    } finally {
        Pop-Location
    }
} finally {
    [Console]::OutputEncoding = $consoleEncoding
    foreach ($name in $savedGitEnv.Keys) {
        [Environment]::SetEnvironmentVariable($name, $savedGitEnv[$name])
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
Write-Output 'All worktree tests passed.'
exit 0
