$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$ExpectedReleaseTitle = 'release: FileGram v1.0.0 local'
$DisposableBranches = @(
  'feature/bulk-channel-uploads',
  'backup/claude-bf455-20260819',
  'rescue/legacy-modernization'
)

Push-Location $Root
try {
  $dirty = @(git status --porcelain --untracked-files=normal)
  if ($LASTEXITCODE -ne 0) { throw 'This folder is not a healthy Git checkout.' }
  if ($dirty.Count -gt 0) {
    throw "The working tree has uncommitted files. Commit or move them before cleanup.`n$($dirty -join "`n")"
  }

  git fetch --prune origin
  if ($LASTEXITCODE -ne 0) { throw 'git fetch failed.' }

  git switch main
  if ($LASTEXITCODE -ne 0) { throw 'Could not switch to main.' }

  git pull --ff-only origin main
  if ($LASTEXITCODE -ne 0) { throw 'Could not fast-forward local main to origin/main.' }

  $releaseCommit = @(git log --format='%H%x09%s' origin/main | Select-String -SimpleMatch $ExpectedReleaseTitle | Select-Object -First 1)
  if ($releaseCommit.Count -eq 0) {
    throw "origin/main does not contain the expected FileGram v1.0.0 release commit: $ExpectedReleaseTitle"
  }

  foreach ($branch in $DisposableBranches) {
    $localExists = git branch --list $branch
    if ($localExists) {
      git branch -D $branch | Out-Host
      if ($LASTEXITCODE -ne 0) { throw "Could not delete local branch $branch" }
    }

    git ls-remote --exit-code --heads origin $branch *> $null
    if ($LASTEXITCODE -eq 0) {
      git push origin --delete $branch | Out-Host
      if ($LASTEXITCODE -ne 0) { throw "Could not delete remote branch $branch" }
    }
  }

  git fetch --prune origin | Out-Host

  foreach ($path in @('test-results', 'playwright-report', 'coverage', '.tmp', 'tmp')) {
    $target = Join-Path $Root $path
    if (Test-Path $target) { Remove-Item -Recurse -Force $target }
  }

  Write-Host ''
  Write-Host 'Repository cleanup complete.' -ForegroundColor Green
  Write-Host 'Kept main and agent/saas-foundation. The SaaS branch has unique unmerged work and was intentionally preserved.'
  Write-Host 'Preserved .td_database, .td_files, .filegram_state, downloads, config.json and settings.json.'
} finally {
  Pop-Location
}
