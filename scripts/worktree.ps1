[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Mandatory, Position = 0)]
    [ValidateSet('start', 'path', 'list', 'finish', 'launch')]
    [string]$Command,

    [ValidateRange(1, [int]::MaxValue)]
    [int]$Issue,

    [ValidateSet('feat', 'fix', 'spike', 'harness', 'docs')]
    [string]$Type = 'feat',

    [string]$Slug,

    [ValidateNotNullOrEmpty()]
    [string]$Base = 'main',

    [switch]$NoGh,
    [switch]$NoOrca,
    [switch]$Activate,
    [string]$Agent,
    [string]$Model,
    [string]$Effort,
    [string]$Prompt,
    [ValidateSet('', 'chat', 'terminal')]
    [string]$Surface = '',
    [switch]$DeleteBranch,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

# A redirected -File invocation needs plain UTF-8 lines outside the host formatter.
$writeToStdout = [Console]::IsOutputRedirected -and
    $MyInvocation.ScriptLineNumber -eq 0 -and $MyInvocation.InvocationName -eq $PSCommandPath
if ($writeToStdout) {
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
}

function Write-WorktreeResult {
    param([string]$Text)

    if ($writeToStdout) {
        [Console]::Out.WriteLine($Text)
    } else {
        $Text
    }
}

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

function Test-SamePath {
    param([string]$Left, [string]$Right)

    $separator = [IO.Path]::DirectorySeparatorChar
    $comparison = if ($separator -eq '\') { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
    [string]::Equals([IO.Path]::GetFullPath($Left).TrimEnd($separator), [IO.Path]::GetFullPath($Right).TrimEnd($separator), $comparison)
}

function Invoke-Orca {
    param([string[]]$Arguments)

    $nativeArgs = $Arguments
    if ($orcaExecutable.Extension -eq '.exe' -and ($PSVersionTable.PSVersion -lt [version]'7.3' -or $PSNativeCommandArgumentPassing -eq 'Legacy')) {
        # Legacy PowerShell passes embedded quotes through to the Windows command-line parser.
        $nativeArgs = foreach ($argument in $nativeArgs) {
            if ($argument -match '[\s"]') {
                '"' + ($argument -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
            } else {
                $argument
            }
        }
    }
    $json = (Invoke-Executable $orcaExecutable.Source $nativeArgs) -join "`n"
    $response = ConvertFrom-Json -InputObject $json
    if ($response.ok -ne $true -or $null -eq $response.result) {
        throw "Orca $($Arguments[0..1] -join ' ') did not return a successful result. $($response.error.message)"
    }
    $response.result
}

function Get-OrcaRepo {
    param([string]$PrimaryPath)

    if ($NoOrca -or -not $orcaExecutable) {
        return $null
    }
    try {
        $result = Invoke-Orca @('repo', 'list', '--json')
        $result.repos | Where-Object { $_.id -and $_.path -and (Test-SamePath $_.path $PrimaryPath) } | Select-Object -First 1
    } catch {
        return $null
    }
}

function Get-OrcaWorktree {
    param([string]$RepoId, [string]$Path)

    $result = Invoke-Orca @('worktree', 'list', '--repo', "id:$RepoId", '--json')
    if ($null -eq $result.worktrees) {
        throw 'Orca worktree list did not return a worktree list.'
    }
    $worktrees = @($result.worktrees | Where-Object { $_.id -and $_.path -and (Test-SamePath $_.path $Path) })
    if ($worktrees.Count -gt 1 -or ($worktrees.Count -eq 0 -and $result.truncated)) {
        throw "Could not uniquely resolve '$Path' in the Orca worktree list."
    }
    $worktrees | Select-Object -First 1
}

function Get-OrcaAgentArguments {
    if ($Model) { '--model'; $Model }
    if ($Effort) { '--effort'; $Effort }
    if ($Prompt) { '--prompt'; $Prompt }
    if ($Surface) { '--surface'; $Surface }
}

function Test-LocalBranch {
    param([string]$RepoRoot, [string]$Branch)

    $ref = "refs/heads/$Branch"
    (Invoke-Executable git @('-C', $RepoRoot, 'for-each-ref', '--format=%(refname)', $ref)) -ccontains $ref
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
    if ($Command -in 'start', 'launch' -and $Effort -and -not $Model) {
        throw '-Effort requires -Model.'
    }
    if ($Command -eq 'start') {
        $slug = ($Slug.ToLowerInvariant() -replace '[^a-z0-9]+', '-').Trim('-')
        if (-not $slug) {
            throw 'start requires -Slug containing at least one ASCII letter or digit.'
        }
    }

    $repoRoot = [IO.Path]::GetFullPath((Invoke-Executable git @('rev-parse', '--show-toplevel')))
    if ($Command -in 'start', 'finish', 'launch') {
        $orcaExecutable = if (-not $NoOrca) {
            Get-Command orca -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        }
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

    if ($Command -eq 'launch') {
        $orcaRepo = Get-OrcaRepo $primary.Path
        if (-not $orcaRepo) {
            throw 'launch requires an Orca-managed worktree. Register the repository in Orca and run without -NoOrca.'
        }
    }

    if ($Command -in 'path', 'finish', 'launch') {
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
            $name = "issue-$Issue-$slug"
            $branchExists = Test-LocalBranch $repoRoot $branch
            $orcaRepo = Get-OrcaRepo $primary.Path
            $orcaManaged = $orcaRepo -and -not $branchExists

            if ($orcaManaged) {
                $createArgs = @('worktree', 'create', '--repo', "id:$($orcaRepo.id)", '--name', $name, '--branch', $branch, '--base-branch', $Base, '--issue', "$Issue", '--json')
                if ($Activate) {
                    $createArgs += '--activate'
                }
                if ($Agent) {
                    $createArgs += @('--agent', $Agent) + @(Get-OrcaAgentArguments)
                }
                $created = (Invoke-Orca $createArgs).worktree
                if (-not $created.path -or -not $created.branch) {
                    throw 'Orca worktree create did not return a worktree path and branch.'
                }
                $path = [IO.Path]::GetFullPath($created.path)
                $branch = $created.branch -creplace '^refs/heads/', ''
            } else {
                if ($Agent -or $Model -or $Effort -or $Prompt -or $Surface) {
                    Write-Warning 'Orca session binding requires an Orca-managed worktree. Skipping agent launch.'
                }
                $path = Join-Path "$($primary.Path).worktrees" $name
                $addArgs = @('-C', $repoRoot, 'worktree', 'add')
                if ($branchExists) {
                    $addArgs += @('--', $path, $branch)
                } else {
                    $addArgs += @('-b', $branch, '--', $path, $Base)
                }
                $null = Invoke-Executable git $addArgs
            }
            Write-WorktreeResult "WORKTREE_PATH=$path"
            Write-WorktreeResult "BRANCH=$branch"
            if ($orcaManaged) {
                Write-WorktreeResult 'ORCA_MANAGED=true'
                if ($Agent) {
                    Write-WorktreeResult 'AGENT_LAUNCHED=true'
                }
            } else {
                Write-WorktreeResult 'ORCA_MANAGED=false'
            }
        }
        'launch' {
            $orcaWorktree = Get-OrcaWorktree $orcaRepo.id $target.Path
            if (-not $orcaWorktree) {
                throw "Issue #$Issue requires an Orca-managed worktree to launch an agent."
            }

            $agentId = if ($Agent) { $Agent } else { 'codex' }
            $launchArgs = @('agent', 'launch', '--agent', $agentId, '--worktree', "id:$($orcaWorktree.id)") + @(Get-OrcaAgentArguments)
            if ($Activate) {
                $launchArgs += '--focus'
            }
            $launched = Invoke-Orca ($launchArgs + '--json')
            Write-WorktreeResult "WORKTREE_PATH=$($target.Path)"
            Write-WorktreeResult "AGENT=$agentId"
            $sessionId = if ($launched.outcome.sessionId) { $launched.outcome.sessionId } else { $launched.sessionId }
            if ($sessionId) {
                Write-WorktreeResult "ORCA_SESSION_ID=$sessionId"
            }
        }
        'path' {
            Write-WorktreeResult $target.Path
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
            Write-WorktreeResult ($rows | Format-Table -AutoSize | Out-String -Width 4096).Trim()
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

            $orcaRepo = Get-OrcaRepo $primary.Path
            $orcaWorktree = if ($orcaRepo) { Get-OrcaWorktree $orcaRepo.id $target.Path }
            if ($orcaWorktree) {
                $removeArgs = @('worktree', 'rm', '--worktree', "id:$($orcaWorktree.id)")
                if ($Force) {
                    $removeArgs += '--force'
                }
                if ($DeleteBranch) {
                    $removeArgs += '--delete-branch'
                }
                $removed = Invoke-Orca ($removeArgs + '--json')
                if ($removed.removing -or $removed.removed -eq $false) {
                    throw "Orca has not confirmed removal of worktree '$($target.Path)'."
                }
            } else {
                $removeArgs = @('-C', $primary.Path, 'worktree', 'remove')
                if ($Force) {
                    $removeArgs += '--force'
                }
                $null = Invoke-Executable git ($removeArgs + @('--', $target.Path))
            }
            if ($DeleteBranch) {
                try {
                    if (-not $orcaWorktree -or (Test-LocalBranch $primary.Path $target.Branch)) {
                        $deleteFlag = if ($Force) { '-D' } else { '-d' }
                        $null = Invoke-Executable git @('-C', $primary.Path, 'branch', $deleteFlag, '--', $target.Branch)
                    }
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
            Write-WorktreeResult "ISSUE=$($metadata -join '')"
        } catch {
            Write-Warning "Could not look up issue #$Issue with gh. $($_.Exception.Message)"
        }
    } else {
        Write-Warning "gh is unavailable. Skipped metadata for issue #$Issue."
    }
}

exit 0
