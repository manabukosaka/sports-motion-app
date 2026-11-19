[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Mandatory, Position = 0)]
    [ValidateSet('start', 'path', 'list', 'finish')]
    [string]$Command,

    [ValidateRange(1, [int]::MaxValue)]
    [int]$Issue,

    [ValidateSet('feat', 'fix', 'spike', 'harness', 'docs')]
    [string]$Type = 'feat',

    [string]$Slug,

    [ValidateNotNullOrEmpty()]
    [string]$Base = 'main',

    [switch]$NoGh,
    [switch]$DeleteBranch,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Invoke-Executable {
    param([string]$Executable, [string[]]$Arguments)

    $ErrorActionPreference = 'Continue'
    $consoleEncoding = [Console]::OutputEncoding
    try {
        [Console]::OutputEncoding = [Text.Encoding]::UTF8
        $output = & $Executable @Arguments 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "$Executable $($Arguments -join ' ') failed (exit $LASTEXITCODE).`n$($output -join "`n")"
        }
        $output | Where-Object { $_ -is [string] }
    } finally {
        [Console]::OutputEncoding = $consoleEncoding
    }
}

function Get-Worktrees {
    param([string]$RepoRoot)

    $porcelain = (Invoke-Executable git @('-C', $RepoRoot, 'worktree', 'list', '--porcelain', '-z')) -join "`n"
    foreach ($record in ($porcelain -split '\x00\x00')) {
        if (-not $record.StartsWith('worktree ')) {
            continue
        }
        $fields = $record -split '\x00'
        $path = [IO.Path]::GetFullPath($fields[0].Substring('worktree '.Length))
        $branch = $fields | Where-Object { $_.StartsWith('branch refs/heads/') }
        [pscustomobject]@{
            Path = $path
            IssueNumber = if ((Split-Path -Leaf $path) -match '^issue-([0-9]+)-') { $Matches[1] } else { $null }
            Branch = if ($branch) { $branch.Substring('branch refs/heads/'.Length) } else { $null }
        }
    }
}

function Test-WorktreeDirty {
    param([string]$Path)

    $status = Invoke-Executable git @('-C', $Path, 'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none')
    return [bool]$status
}

$mutex = $null
$lockHeld = $false
try {
    if ($Command -ne 'list' -and -not $PSBoundParameters.ContainsKey('Issue')) {
        throw "$Command requires -Issue with a positive integer."
    }
    if ($Command -eq 'start') {
        $slug = ($Slug.ToLowerInvariant() -replace '[^a-z0-9]+', '-').Trim('-')
        if (-not $slug) {
            throw 'start requires -Slug containing at least one ASCII letter or digit.'
        }
    }

    $repoRoot = [IO.Path]::GetFullPath((Invoke-Executable git @('rev-parse', '--show-toplevel')))
    if ($Command -in 'start', 'finish') {
        $commonDir = [IO.Path]::GetFullPath((Invoke-Executable git @('-C', $repoRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir')))
        if ([IO.Path]::DirectorySeparatorChar -eq '\') {
            $commonDir = $commonDir.ToLowerInvariant()
        }
        $sha256 = [Security.Cryptography.SHA256]::Create()
        try {
            $repoKey = [BitConverter]::ToString($sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($commonDir)))
        } finally {
            $sha256.Dispose()
        }

        $mutex = [Threading.Mutex]::new($false, "sports-motion-worktree-$repoKey")
        try {
            $lockHeld = $mutex.WaitOne()
        } catch [Threading.AbandonedMutexException] {
            $lockHeld = $true
        }
    }

    $worktrees = @(Get-Worktrees $repoRoot)
    $primary = $worktrees[0]
    $issueWorktrees = @($worktrees | Where-Object { $_.IssueNumber -ceq [string]$Issue })

    if ($Command -in 'path', 'finish') {
        if ($issueWorktrees.Count -eq 0) {
            throw "No worktree found for issue #$Issue."
        }
        if ($issueWorktrees.Count -gt 1) {
            throw "Multiple worktrees found for issue #${Issue}: $($issueWorktrees.Path -join ', ')."
        }
        $target = $issueWorktrees[0]
    }

    switch ($Command) {
        'start' {
            if ($issueWorktrees.Count -gt 0) {
                throw "A worktree for issue #$Issue already exists at $($issueWorktrees.Path -join ', ')."
            }

            $branch = "$($Type.ToLowerInvariant())/$Issue-$slug"
            $worktreeRoot = "$($primary.Path).worktrees"
            $path = Join-Path $worktreeRoot "issue-$Issue-$slug"
            $ref = "refs/heads/$branch"
            $refs = Invoke-Executable git @('-C', $repoRoot, 'for-each-ref', '--format=%(refname)', $ref)
            if ($refs -ccontains $ref) {
                $null = Invoke-Executable git @('-C', $repoRoot, 'worktree', 'add', '--', $path, $branch)
            } else {
                $null = Invoke-Executable git @('-C', $repoRoot, 'worktree', 'add', '-b', $branch, '--', $path, $Base)
            }
            "WORKTREE_PATH=$path"
            "BRANCH=$branch"
        }
        'path' {
            $target.Path
        }
        'list' {
            $rows = foreach ($worktree in $worktrees) {
                [pscustomobject]@{
                    IssueNumber = if ($worktree -ne $primary -and $worktree.IssueNumber) { $worktree.IssueNumber } else { '-' }
                    Branch = if ($worktree.Branch) { $worktree.Branch } else { '(detached)' }
                    Path = $worktree.Path
                    Dirty = if (Test-WorktreeDirty $worktree.Path) { 'dirty' } else { 'clean' }
                }
            }
            ($rows | Format-Table -AutoSize | Out-String -Width 4096).Trim()
        }
        'finish' {
            if ($target -eq $primary) {
                throw "Cannot remove the primary worktree at '$($target.Path)'."
            }
            if ((Test-WorktreeDirty $target.Path) -and -not $Force) {
                throw "Worktree '$($target.Path)' is dirty. Use -Force to remove it anyway."
            }
            if ($DeleteBranch -and -not $target.Branch) {
                throw "Worktree '$($target.Path)' has no branch to delete."
            }
            if ([IO.Path]::DirectorySeparatorChar -eq '\' -and $repoRoot -eq $target.Path) {
                throw "Run finish from outside '$($target.Path)' on Windows. Use '$($primary.Path)'."
            }

            $removeArgs = @('-C', $primary.Path, 'worktree', 'remove')
            if ($Force) {
                $removeArgs += '--force'
            }
            $null = Invoke-Executable git ($removeArgs + @('--', $target.Path))
            if ($DeleteBranch) {
                $deleteFlag = if ($Force) { '-D' } else { '-d' }
                try {
                    $null = Invoke-Executable git @('-C', $primary.Path, 'branch', $deleteFlag, '--', $target.Branch)
                } catch {
                    throw "Removed worktree '$($target.Path)', but could not delete branch '$($target.Branch)'. $($_.Exception.Message)"
                }
            }
        }
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally {
    if ($lockHeld) {
        $mutex.ReleaseMutex()
    }
    if ($mutex) {
        $mutex.Dispose()
    }
}

if ($Command -eq 'start' -and -not $NoGh) {
    if (Get-Command gh -ErrorAction SilentlyContinue) {
        try {
            $metadata = Invoke-Executable gh @('issue', 'view', $Issue, '--json', 'number,title,state,url')
            "ISSUE=$($metadata -join '')"
        } catch {
            Write-Warning "Could not look up issue #$Issue with gh. $($_.Exception.Message)"
        }
    } else {
        Write-Warning "gh is unavailable. Skipped metadata for issue #$Issue."
    }
}

exit 0
